import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DisplayConfigStore, createXrandrArgs, validateDisplayConfig } from "../runtime/node/display-config.mjs";
import { HOST_ACTIONS, HostActionExecutor } from "../runtime/node/host-actions.mjs";
import { SafeCommandRunner } from "../runtime/node/safe-exec.mjs";
import { loadNodeConfig } from "../runtime/node/config.mjs";

const uiDisplayPayload = {
  outputs: [
    {
      id: "A",
      connector: "DP-1",
      enabled: true,
      primary: true,
      x: 0,
      y: 0,
      resolution: { width: 1920, height: 1080, refreshNum: 60_000, refreshDen: 1000 },
    },
    {
      id: "B",
      connector: "DP-2",
      enabled: true,
      x: 1920,
      y: 0,
      resolution: { width: 1920, height: 1080, refreshNum: 60, refreshDen: 1 },
    },
  ],
};

class MemoryDisplayStore {
  constructor() { this.value = null; this.saved = 0; }
  async initialize() { return null; }
  async save(value) { this.value = validateDisplayConfig(value); this.saved += 1; return this.value; }
  snapshot() { return this.value; }
  async flush() {}
}

class RecordingRunner {
  constructor({ failHostControl = false } = {}) { this.calls = []; this.failHostControl = failHostControl; }
  async run(executable, args, options = {}) {
    this.calls.push({ executable, args, options });
    if (this.failHostControl && executable.includes("hostctl")) throw Object.assign(new Error("helper missing"), { code: "EXECUTABLE_NOT_FOUND" });
    return { stdout: "ok\n", stderr: "", durationMs: 1, exitCode: 0 };
  }
}

test("node config parses host safety flags without truthy-string mistakes", async () => {
  const config = await loadNodeConfig({
    argv: ["--allow-power-actions", "--host-actions-dry-run", "--allow-xrandr-fallback"],
    env: { PIXEL_BRIGHTNESS_POWER_CONFIRMATION_TOKEN: "node-local-secret" },
    cwd: "/tmp/pixel-config-test",
  });
  assert.equal(config.allowPowerActions, true);
  assert.equal(config.hostActionsDryRun, true);
  assert.equal(config.allowXrandrFallback, true);
  assert.equal(config.powerConfirmationToken, "node-local-secret");

  const disabled = await loadNodeConfig({
    argv: [],
    env: { PIXEL_BRIGHTNESS_ALLOW_POWER_ACTIONS: "false", PIXEL_BRIGHTNESS_HOST_ACTIONS_DRY_RUN: "false" },
    cwd: "/tmp/pixel-config-test",
  });
  assert.equal(disabled.allowPowerActions, false);
  assert.equal(disabled.hostActionsDryRun, false);
});

test("display config accepts Fleet UI shape and builds argv-only xrandr plan", () => {
  const normalized = validateDisplayConfig(uiDisplayPayload);
  assert.equal(normalized.backend, "kms");
  assert.equal(normalized.outputs[0].resolution.refreshNum, 60_000);
  const args = createXrandrArgs({ ...normalized, backend: "xrandr" });
  assert.deepEqual(args.slice(0, 11), [
    "--output", "DP-1", "--mode", "1920x1080", "--rate", "60", "--pos", "0x0", "--rotate", "normal", "--primary",
  ]);
  assert.ok(args.includes("--primary"));
  assert.throws(
    () => validateDisplayConfig({ outputs: [{ id: "A", connector: "DP-1; reboot" }] }),
    /Invalid connector/,
  );
});

test("DisplayConfigStore persists validated configuration atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-display-store-"));
  const pathname = join(directory, "display.json");
  const store = new DisplayConfigStore(pathname);
  await store.initialize();
  await store.save(uiDisplayPayload);
  const saved = JSON.parse(await readFile(pathname, "utf8"));
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.outputs[1].connector, "DP-2");
  assert.deepEqual(
    JSON.parse(await readFile(`${pathname}.last-known-good.json`, "utf8")),
    saved,
    "the first durable commit must leave a recoverable LKG",
  );
  assert.equal(store.recoverySnapshot(), null);
  assert.equal(JSON.parse(await readFile(`${pathname}.commit.json`, "utf8")).status, "committed");

  const first = saved;
  await store.save({
    ...uiDisplayPayload,
    outputs: uiDisplayPayload.outputs.map((output, index) => ({
      ...output,
      x: index === 0 ? 32 : output.x + 32,
    })),
  });
  assert.deepEqual(
    JSON.parse(await readFile(`${pathname}.last-known-good.json`, "utf8")),
    first,
    "a later commit must retain the exact prior configuration",
  );

  await writeFile(pathname, "{corrupt", "utf8");
  const recovered = new DisplayConfigStore(pathname);
  const recoveredSnapshot = await recovered.initialize();
  assert.deepEqual(recoveredSnapshot, first,
    "a corrupt primary must be quarantined and restored from the flushed LKG");
  assert.equal(recovered.recoverySnapshot()?.status, "active");
  assert.equal(recovered.recoverySnapshot()?.reason, "primary-restored-from-lkg");

  const stillLocked = new DisplayConfigStore(pathname);
  assert.deepEqual(await stillLocked.initialize(), first);
  assert.equal(stillLocked.recoverySnapshot()?.status, "active",
    "restoring the primary must not erase the durable recovery boundary");

  await stillLocked.save(uiDisplayPayload);
  assert.equal(stillLocked.recoverySnapshot(), null,
    "only a new durable authoritative save resolves the display intent marker");

  await rename(pathname, `${pathname}.removed`);
  const recoveredMissing = new DisplayConfigStore(pathname);
  assert.deepEqual(await recoveredMissing.initialize(), first,
    "a missing primary must be restored from the flushed LKG");
  assert.equal(recoveredMissing.recoverySnapshot()?.status, "active");

  await writeFile(pathname, "{corrupt", "utf8");
  await writeFile(`${pathname}.last-known-good.json`, "{also-corrupt", "utf8");
  const unrecoverable = new DisplayConfigStore(pathname);
  await assert.rejects(
    unrecoverable.initialize(),
    (error) => error?.code === "DISPLAY_CONFIG_RECOVERY_FAILED",
  );
});

test("display recovery marker is durable before a corrupt primary is replaced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-display-recovery-order-"));
  const pathname = join(directory, "display.json");
  const initial = new DisplayConfigStore(pathname);
  await initial.initialize();
  const authoritative = await initial.save(uiDisplayPayload);
  await writeFile(pathname, "{corrupt", "utf8");

  const interrupted = new DisplayConfigStore(pathname, {
    faultInjector: async (stage) => {
      if (stage === "after-recovery-marker") throw new Error("simulated stop after recovery marker");
    },
  });
  await assert.rejects(interrupted.initialize(), /simulated stop after recovery marker/);
  assert.equal(JSON.parse(await readFile(`${pathname}.commit.json`, "utf8")).status, "recovery-required");
  assert.equal(await readFile(pathname, "utf8"), "{corrupt",
    "the primary must remain untouched until recovery evidence is durable");

  const restarted = new DisplayConfigStore(pathname);
  assert.deepEqual(await restarted.initialize(), authoritative);
  assert.equal(restarted.recoverySnapshot()?.status, "active");
  assert.equal(restarted.recoverySnapshot()?.reason, "primary-restored-from-lkg");
});

test("SafeCommandRunner never invokes a shell and preserves hostile text as one argv item", async () => {
  let invocation;
  const runner = new SafeCommandRunner({
    allowedExecutables: ["/bin/echo"],
    execFileImpl: (executable, args, options, callback) => {
      invocation = { executable, args, options };
      callback(null, `${args.join("|")}\n`, "");
    },
  });
  const hostile = "$(touch /tmp/should-never-exist); reboot";
  const result = await runner.run("/bin/echo", [hostile]);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.args, [hostile]);
  assert.equal(result.stdout.trim(), hostile);
  assert.throws(() => runner.run("/bin/sh", ["-c", "reboot"]), /not allowlisted/);
});

test("power actions require both node opt-in and timing-safe confirmation token", async () => {
  const runner = new RecordingRunner();
  const disabled = new HostActionExecutor({
    nodeId: "node-01",
    dataDir: "/tmp/node-01",
    allowPowerActions: false,
    powerConfirmationToken: "secret",
    dryRun: false,
    runner,
    displayStore: new MemoryDisplayStore(),
  });
  await disabled.initialize();
  const denied = await disabled.execute({
    commandId: "cmd-1",
    sequence: 1,
    action: { id: "action-1", type: HOST_ACTIONS.REBOOT_HOST, confirmationToken: "secret" },
  });
  assert.equal(denied.status, "denied");
  assert.equal(denied.error.code, "POWER_ACTIONS_DISABLED");

  const enabled = new HostActionExecutor({
    nodeId: "node-01",
    dataDir: "/tmp/node-01",
    allowPowerActions: true,
    powerConfirmationToken: "secret",
    dryRun: false,
    runner,
    displayStore: new MemoryDisplayStore(),
  });
  await enabled.initialize();
  const wrong = await enabled.execute({
    commandId: "cmd-2",
    sequence: 2,
    action: { id: "action-2", type: HOST_ACTIONS.REBOOT_HOST, confirmationToken: "not-secret" },
  });
  assert.equal(wrong.status, "denied");
  assert.equal(wrong.error.code, "CONFIRMATION_REQUIRED");
  const accepted = await enabled.execute({
    commandId: "cmd-3",
    sequence: 3,
    action: { id: "action-3", type: HOST_ACTIONS.REBOOT_HOST, confirmationToken: "secret" },
  });
  assert.equal(accepted.status, "succeeded");
  assert.deepEqual(runner.calls.at(-1).args, ["reboot", "--delay-ms", "3000"]);
});

test("APPLY_DISPLAY_CONFIG prefers KMS helper and persists before invocation", async () => {
  const store = new MemoryDisplayStore();
  const runner = new RecordingRunner();
  const executor = new HostActionExecutor({
    nodeId: "node-01",
    dataDir: "/tmp/node-01",
    displayConfigPath: "/tmp/node-01/display.json",
    dryRun: false,
    runner,
    displayStore: store,
  });
  await executor.initialize();
  const result = await executor.execute({
    commandId: "cmd-display",
    sequence: 4,
    action: { type: HOST_ACTIONS.APPLY_DISPLAY_CONFIG, payload: uiDisplayPayload },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.result.backend, "kms");
  assert.equal(store.saved, 1);
  assert.deepEqual(runner.calls[0].args, [
    "apply-display-config", "--backend", "kms", "--config", "/tmp/node-01/display.json",
  ]);
});

test("backend=auto uses explicitly enabled xrandr fallback when KMS helper fails", async () => {
  const runner = new RecordingRunner({ failHostControl: true });
  const executor = new HostActionExecutor({
    nodeId: "node-01",
    dataDir: "/tmp/node-01",
    dryRun: false,
    allowXrandrFallback: true,
    platform: "linux",
    runner,
    displayStore: new MemoryDisplayStore(),
    displayEnvironment: { DISPLAY: ":0", XAUTHORITY: "/run/user/1000/Xauthority" },
  });
  await executor.initialize();
  const result = await executor.execute({
    commandId: "cmd-auto",
    sequence: 5,
    action: { type: HOST_ACTIONS.APPLY_DISPLAY_CONFIG, payload: { ...uiDisplayPayload, backend: "auto" } },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.result.backend, "xrandr");
  assert.equal(result.result.fallbackFrom, "kms");
  assert.equal(runner.calls[1].executable, "/usr/bin/xrandr");
  assert.equal(runner.calls[1].options.env.DISPLAY, ":0");
});

test("unknown action is denied and diagnostics collection creates a bounded JSON artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-host-actions-"));
  const runner = new RecordingRunner();
  const executor = new HostActionExecutor({
    nodeId: "node-test",
    dataDir: directory,
    diagnosticsDir: join(directory, "diagnostics"),
    dryRun: true,
    runner,
    displayStore: new MemoryDisplayStore(),
    diagnosticsProvider: async () => ({ kernel: "test" }),
  });
  await executor.initialize();
  const unknown = await executor.execute({ commandId: "bad", action: { type: "RUN_SHELL", payload: { command: "reboot" } } });
  assert.equal(unknown.status, "denied");
  assert.equal(unknown.error.code, "ACTION_NOT_ALLOWED");
  const collected = await executor.execute({ commandId: "diag", action: { type: HOST_ACTIONS.COLLECT_DIAGNOSTICS } });
  assert.equal(collected.status, "succeeded");
  const artifact = JSON.parse(await readFile(collected.result.path, "utf8"));
  assert.equal(artifact.nodeId, "node-test");
  assert.equal(artifact.host.kernel, "test");
  assert.equal(collected.result.sha256.length, 64);
});
