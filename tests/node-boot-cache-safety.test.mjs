import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { PixelBrightnessNode } from "../runtime/node/daemon.mjs";
import { NodeStateStore } from "../runtime/node/state-store.mjs";
import { COMMAND, createCommand, defaultProject, normalizeProject } from "../runtime/shared/protocol.mjs";

const hostTelemetry = {
  collect: async ({ renderer }) => ({ schemaVersion: 2, host: { hostname: "cache-test" }, renderer }),
};

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

class BootCacheEngine {
  constructor() {
    this.adapters = new Map();
    this.externalCadence = true;
    this.events = [];
    this.projectRevision = null;
    this.blankEnabled = false;
    this.releaseCalls = 0;
    this.discardCalls = 0;
  }

  async initialize() { this.events.push("initialize"); }

  async configure(project) {
    this.projectRevision = project.revision;
    this.events.push("configure");
  }

  async prepare({ assets }) {
    this.events.push("prepare");
    this.preparedAssets = structuredClone(assets);
  }

  async blank(enabled) {
    this.blankEnabled = enabled === true;
    this.events.push(`blank:${this.blankEnabled}`);
  }

  async clearPattern() { this.events.push("clear-pattern"); }

  async releaseBootBlack() {
    this.releaseCalls += 1;
    this.events.push("release");
  }

  discardBootBlackAuthorization() {
    this.discardCalls += 1;
    this.events.push("discard");
  }

  renderFrame() { return []; }

  async stop() { this.events.push("stop"); }

  diagnostics() {
    return {
      backend: "boot-cache-test",
      ready: this.releaseCalls === 1,
      connected: true,
      projectRevision: this.projectRevision,
      droppedFrames: 0,
      framesRendered: 0,
      outputs: [],
    };
  }
}

function config(directory) {
  return {
    protocolVersion: 1,
    nodeId: "node-cache-boot",
    name: "Cache Boot Node",
    version: "0.3.0-test",
    serverUrl: "http://127.0.0.1:4100",
    dataDir: directory,
    outputs: [{
      id: "A",
      connector: "DP-1",
      enabled: true,
      resolution: { width: 320, height: 180, refreshNum: 60, refreshDen: 1 },
    }],
    heartbeatMs: 10_000,
    hostTelemetryMs: 10_000,
    clockSyncMs: 10_000,
    clockSyncRounds: 1,
    pollWaitMs: 10_000,
    requestTimeoutMs: 500,
    maxAssetBytes: 1_000_000,
    maxCacheBytes: 2_000_000,
    hostActionsDryRun: true,
    platform: "linux",
    logLevel: "error",
    nodeToken: null,
  };
}

function quietClient({
  download,
  register = async () => ({
    protocolVersion: 1,
    node: { ackSequence: 0, commandSequence: 0 },
    commandSequence: 0,
    project: null,
  }),
  state = async () => ({ timeline: { status: "idle", targetNodeIds: [] }, media: [] }),
}) {
  let aborted = false;
  let releasePoll;
  const client = {
    downloadCalls: 0,
    time: async () => ({ serverTimeNs: `${BigInt(Date.now()) * 1_000_000n}` }),
    register,
    state,
    heartbeat: async () => ({
      serverTimeNs: `${BigInt(Date.now()) * 1_000_000n}`,
      acknowledgedActionResultIds: [],
    }),
    pollCommands: async () => new Promise((resolve) => {
      if (aborted) resolve({ protocolVersion: 1, commands: [] });
      else releasePoll = () => resolve({ protocolVersion: 1, commands: [] });
    }),
    assetUrl: (sha256) => `/v1/assets/${sha256}`,
    download: async (...args) => {
      client.downloadCalls += 1;
      return download(...args);
    },
    abort: () => {
      aborted = true;
      releasePoll?.();
    },
  };
  return client;
}

function preparedProject(sha256) {
  const input = defaultProject();
  input.timeline = {
    cues: [{
      id: "boot-cue",
      assetSha256: sha256,
      startFrame: 0,
      durationFrames: 60,
      loop: true,
      outputIds: ["A"],
    }],
  };
  return normalizeProject(input);
}

async function persistPreparedState(directory, {
  project,
  sha256,
  transportState = "ready",
  retainPreparedReceipt = true,
}) {
  const store = new NodeStateStore(join(directory, "state.json"));
  await store.initialize();
  store.state.project = project;
  store.state.transport = {
    state: transportState,
    startNs: null,
    baseFrame: "0",
    pausedFrame: "0",
    frameRateNum: project.canvas.frameRateNum,
    frameRateDen: project.canvas.frameRateDen,
  };
  store.state.preparedAssetSha256 = retainPreparedReceipt ? sha256 : null;
  store.state.preparedAssets = retainPreparedReceipt ? [{ sha256 }] : [];
  await store.save(store.state);
  await store.flush();
}

function cachePath(directory, sha256) {
  return join(directory, "cache", "sha256", sha256.slice(0, 2), sha256);
}

function createNode(directory, engine, client, dependencies = {}) {
  const node = new PixelBrightnessNode(config(directory), {
    hostTelemetryCollector: hostTelemetry,
    renderEngineFactory: () => engine,
    ...dependencies,
  });
  node.client = client;
  node.cache.client = client;
  return node;
}

test("display LKG recovery durably engages startup black before any reconciliation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-boot-display-recovery-"));
  const displayConfig = {
    schemaVersion: 2,
    backend: "kms",
    outputs: [{
      id: "A",
      connector: "DP-1",
      enabled: true,
      primary: true,
      x: 0,
      y: 0,
      resolution: { width: 320, height: 180, refreshNum: 60, refreshDen: 1 },
      rotation: "normal",
    }],
    updatedAt: "2026-08-25T00:00:00.000Z",
  };
  const recovery = {
    status: "active",
    code: "DISPLAY_CONFIG_RECOVERY_REQUIRED",
    reason: "primary-restored-from-lkg",
    recoveredConfigSha256: "a".repeat(64),
    intendedConfigSha256: "b".repeat(64),
    detectedAt: "2026-08-25T00:00:01.000Z",
  };
  let executeCalls = 0;
  const displayStore = {
    snapshot: () => structuredClone(displayConfig),
    recoverySnapshot: () => structuredClone(recovery),
    flush: async () => {},
  };
  const hostActionExecutor = {
    platform: "linux",
    dryRun: false,
    allowPowerActions: false,
    allowXrandrFallback: false,
    displayStore,
    initialize: async () => ({ displayConfig: displayStore.snapshot(), dryRun: false }),
    execute: async () => {
      executeCalls += 1;
      throw new Error("recovered display intent must not be applied as authoritative");
    },
  };
  const client = quietClient({ download: async () => { throw new Error("unexpected download"); } });
  const engine = new BootCacheEngine();
  const node = createNode(directory, engine, client, { hostActionExecutor });
  try {
    await node.start();
    await waitFor(
      () => node.store.snapshot().stateRecoverySafetyLock?.reason?.code
        === "DISPLAY_CONFIG_RECOVERY_REQUIRED",
      "display recovery did not durably engage the startup lock",
    );
    const diagnostics = node.diagnostics();
    assert.equal(executeCalls, 0, "startup must not re-save or apply rolled-back display bytes");
    assert.equal(engine.releaseCalls, 0);
    assert.equal(engine.blankEnabled, true);
    assert.ok(engine.discardCalls >= 1);
    assert.equal(diagnostics.displayConfigRecovery.reason, "primary-restored-from-lkg");
    assert.equal(diagnostics.display.status, "recovery-required");
    assert.equal(diagnostics.stateRecoverySafetyLock.reason.code, "DISPLAY_CONFIG_RECOVERY_REQUIRED");
    const persisted = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
    assert.equal(persisted.stateRecoverySafetyLock.reason.code, "DISPLAY_CONFIG_RECOVERY_REQUIRED");
  } finally {
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("idle project with a corrupt cue stays boot-black through delayed re-download and durable prepare", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-boot-cache-delayed-"));
  const content = Buffer.from("verified boot media\n");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const gate = deferred();
  const client = quietClient({
    download: async () => ({
      headers: { get: (name) => name.toLowerCase() === "content-length" ? String(content.length) : null },
      body: {
        async *[Symbol.asyncIterator]() {
          await gate.promise;
          yield content;
        },
        cancel: async () => {},
      },
    }),
  });
  const engine = new BootCacheEngine();
  const node = createNode(directory, engine, client);
  try {
    await persistPreparedState(directory, {
      project: preparedProject(sha256),
      sha256,
      transportState: "idle",
      retainPreparedReceipt: false,
    });
    const pathname = cachePath(directory, sha256);
    await mkdir(dirname(pathname), { recursive: true });
    await writeFile(pathname, "corrupt", "utf8");

    const starting = node.start();
    await waitFor(() => client.downloadCalls === 1, "startup did not verify and replace corrupt cache");
    assert.equal(engine.releaseCalls, 0, "boot latch released while verified bytes were still unavailable");
    assert.equal(node.diagnostics().cacheReady, false);
    assert.equal(engine.events.includes("prepare"), false);

    gate.resolve();
    await starting;
    await waitFor(() => engine.releaseCalls === 1,
      "authoritative registration did not release verified boot black");
    assert.equal(engine.releaseCalls, 1);
    assert.ok(engine.events.indexOf("prepare") < engine.events.indexOf("release"));
    assert.equal(node.diagnostics().cacheReady, true);
    assert.deepEqual(await readFile(pathname), content);
    assert.equal(node.store.snapshot().preparedAssets[0].sha256, sha256,
      "release must follow a durable prepared-asset receipt");
  } finally {
    gate.resolve();
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("authoritative idle transport replaces a locally restored pause before boot release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-boot-authoritative-idle-"));
  const content = Buffer.from("paused boot media\n");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const project = preparedProject(sha256);
  const client = quietClient({
    download: async () => { throw new Error("unexpected download"); },
    register: async () => ({
      protocolVersion: 1,
      node: { ackSequence: 0, commandSequence: 1 },
      commandSequence: 1,
      project,
    }),
  });
  const engine = new BootCacheEngine();
  const node = createNode(directory, engine, client);
  try {
    await persistPreparedState(directory, { project, sha256, transportState: "paused" });
    const pendingStore = new NodeStateStore(join(directory, "state.json"));
    await pendingStore.initialize();
    pendingStore.state.pendingActions = [createCommand(
      COMMAND.PAUSE_AT,
      { frame: "240" },
      {
        id: "server-reconcile-pause",
        sequence: 0,
        createdAtNs: null,
        effectiveAtNs: `${BigInt(Date.now() + 60_000) * 1_000_000n}`,
      },
    )];
    await pendingStore.save(pendingStore.state);
    await pendingStore.flush();
    const pathname = cachePath(directory, sha256);
    await mkdir(dirname(pathname), { recursive: true });
    await writeFile(pathname, content);

    await node.start();
    await waitFor(() => engine.releaseCalls === 1,
      "authoritative idle state did not release the reconciled boot latch");
    assert.equal(node.diagnostics().transport.state, "idle");
    assert.deepEqual(node.store.snapshot().pendingActions, [],
      "a stale locally retained pause must not re-arm after authoritative idle reconciliation");
    const cleared = engine.events.lastIndexOf("clear-pattern");
    assert.ok(cleared >= 0 && cleared < engine.events.indexOf("release"),
      "restored transport must become idle before boot release");
  } finally {
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("a timeline targeting another node never widens startup asset access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-boot-nontarget-media-"));
  const project = normalizeProject({ ...defaultProject(), timeline: { cues: [] } });
  const unrelatedSha256 = "a".repeat(64);
  const client = quietClient({
    download: async () => { throw new Error("non-target prepared asset was requested"); },
    register: async () => ({
      protocolVersion: 1,
      node: { ackSequence: 0, commandSequence: 1 },
      commandSequence: 1,
      project,
    }),
    state: async () => ({
      timeline: {
        status: "prepared",
        targetNodeIds: ["another-node"],
        preparedAssetSha256: unrelatedSha256,
        baseFrame: "0",
        frameRateNum: 60,
        frameRateDen: 1,
      },
      media: [{ sha256: unrelatedSha256 }],
    }),
  });
  const engine = new BootCacheEngine();
  const node = createNode(directory, engine, client);
  try {
    await node.start();
    await waitFor(() => engine.releaseCalls === 1,
      "non-target authoritative reconciliation did not complete");
    assert.equal(client.downloadCalls, 0);
    assert.deepEqual(engine.preparedAssets, []);
    assert.equal(node.diagnostics().transport.state, "idle");
  } finally {
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("idle project with a missing cue and failed download can never release boot black", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-boot-cache-failed-"));
  const content = Buffer.from("missing boot media\n");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const client = quietClient({ download: async () => { throw new Error("asset server unavailable"); } });
  const engine = new BootCacheEngine();
  const node = createNode(directory, engine, client);
  try {
    await persistPreparedState(directory, {
      project: preparedProject(sha256),
      sha256,
      transportState: "idle",
      retainPreparedReceipt: false,
    });
    await assert.rejects(node.start(), /asset server unavailable/);
    assert.equal(engine.releaseCalls, 0);
    assert.equal(engine.events.includes("prepare"), false);
    assert.equal(engine.blankEnabled, true);
    assert.equal(engine.discardCalls, 1);
    assert.equal(node.diagnostics().cacheReady, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale scoped cue 403 waits boot-black for authoritative project reassignment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-boot-cache-stale-scope-"));
  const staleContent = Buffer.from("cue formerly assigned to this output\n");
  const staleSha256 = createHash("sha256").update(staleContent).digest("hex");
  const authoritativeProject = normalizeProject({
    ...defaultProject(),
    revision: 2,
    timeline: { cues: [] },
  });
  const registrationGate = deferred();
  const client = quietClient({
    download: async () => {
      const error = new Error("Server returned HTTP 403 for stale scoped cue");
      error.status = 403;
      throw error;
    },
    register: async () => {
      await registrationGate.promise;
      return {
        protocolVersion: 1,
        node: { ackSequence: 0, commandSequence: 1 },
        commandSequence: 1,
        project: authoritativeProject,
      };
    },
  });
  const engine = new BootCacheEngine();
  const node = createNode(directory, engine, client);
  try {
    await persistPreparedState(directory, {
      project: preparedProject(staleSha256),
      sha256: staleSha256,
      transportState: "idle",
      retainPreparedReceipt: false,
    });

    await node.start();
    assert.equal(client.downloadCalls, 1,
      "startup must first prove the stale cue is no longer authorized");
    assert.equal(engine.releaseCalls, 0);
    assert.equal(node.diagnostics().cacheReady, false);
    assert.equal(node.diagnostics().bootBlackReleasePending, true);

    registrationGate.resolve();
    await waitFor(() => engine.releaseCalls === 1,
      "authoritative scoped project did not reconcile and release boot black");
    assert.equal(client.downloadCalls, 1,
      "Node must not retry or broaden access to the stale cue after reassignment");
    assert.deepEqual(node.store.snapshot().project.timeline.cues, []);
    assert.equal(node.diagnostics().cacheReady, true);
    assert.equal(node.diagnostics().bootBlackReleasePending, false);
    assert.ok(engine.events.lastIndexOf("prepare") < engine.events.indexOf("release"));
  } finally {
    registrationGate.resolve();
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("prepared bytes without a durable Node-state commit never release boot black", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-boot-cache-durability-"));
  const content = Buffer.from("durable boot media\n");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const client = quietClient({ download: async () => { throw new Error("unexpected download"); } });
  const engine = new BootCacheEngine();
  const node = createNode(directory, engine, client);
  try {
    await persistPreparedState(directory, { project: preparedProject(sha256), sha256 });
    const pathname = cachePath(directory, sha256);
    await mkdir(dirname(pathname), { recursive: true });
    await writeFile(pathname, content);
    node.store.save = async () => { throw new Error("simulated state fsync failure"); };

    await assert.rejects(node.start(), /simulated state fsync failure/);
    assert.equal(engine.events.includes("prepare"), true);
    assert.equal(engine.releaseCalls, 0);
    assert.equal(engine.blankEnabled, true);
    assert.equal(engine.discardCalls, 1);
    assert.equal(node.diagnostics().cacheReady, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable cursor rollback engages recovery black without rewinding either cursor", async (t) => {
  for (const scenario of [
    {
      name: "local state is behind Server durable acknowledgement",
      localSequence: 2,
      serverAckSequence: 3,
      serverCommandSequence: 4,
      code: "NODE_COMMAND_CURSOR_ROLLBACK",
    },
    {
      name: "Server command history is behind local durable state",
      localSequence: 5,
      serverAckSequence: 0,
      serverCommandSequence: 4,
      code: "SERVER_COMMAND_CURSOR_ROLLBACK",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const directory = await mkdtemp(join(tmpdir(), "pb-boot-cursor-rollback-"));
      const durable = new NodeStateStore(join(directory, "state.json"));
      await durable.initialize();
      durable.state.lastSequence = scenario.localSequence;
      await durable.save(durable.state);
      await durable.flush();

      const client = quietClient({
        download: async () => { throw new Error("unexpected download"); },
        register: async () => ({
          protocolVersion: 1,
          node: {
            ackSequence: scenario.serverAckSequence,
            commandSequence: scenario.serverCommandSequence,
          },
          commandSequence: scenario.serverCommandSequence,
          project: null,
        }),
      });
      const engine = new BootCacheEngine();
      const node = createNode(directory, engine, client);
      try {
        await node.start();
        await waitFor(
          async () => {
            try {
              const persisted = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
              return persisted.stateRecoverySafetyLock?.reason?.code === scenario.code
                && node.store.snapshot().stateRecoverySafetyLock?.reason?.code === scenario.code;
            } catch {
              return false;
            }
          },
          "cursor rollback did not durably engage the recovery lock",
        );
        const snapshot = node.store.snapshot();
        assert.equal(snapshot.lastSequence, scenario.localSequence,
          "cursor mismatch must never reset or skip the durable local cursor");
        assert.equal(snapshot.stateRecoverySafetyLock.reason.code, scenario.code);
        assert.equal(engine.releaseCalls, 0);
        assert.equal(engine.blankEnabled, true);
        assert.ok(engine.discardCalls >= 1);
        const disk = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
        assert.equal(disk.lastSequence, scenario.localSequence);
        assert.equal(disk.stateRecoverySafetyLock.reason.code, scenario.code);
      } finally {
        await node.stop().catch(() => {});
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("registration requires canonical durable cursor proof before releasing boot black", async (t) => {
  for (const scenario of [
    { name: "missing acknowledgement", nodeCursor: { commandSequence: 1 } },
    { name: "malformed authoritative latest cursor", nodeCursor: { ackSequence: 0, commandSequence: "1" } },
  ]) {
    await t.test(scenario.name, async () => {
      const directory = await mkdtemp(join(tmpdir(), "pb-boot-cursor-invalid-proof-"));
      const client = quietClient({
        download: async () => { throw new Error("unexpected download"); },
        register: async () => ({
          protocolVersion: 1,
          node: scenario.nodeCursor,
          commandSequence: 1,
          project: null,
        }),
      });
      const engine = new BootCacheEngine();
      const node = createNode(directory, engine, client);
      try {
        await node.start();
        await waitFor(
          () => node.store.snapshot().stateRecoverySafetyLock?.reason?.code
            === "SERVER_COMMAND_CURSOR_INVALID",
          "invalid Server cursor proof did not engage recovery black",
        );
        assert.equal(engine.releaseCalls, 0);
        assert.equal(engine.blankEnabled, true);
        assert.equal(node.diagnostics().bootBlackReleasePending, false);
      } finally {
        await node.stop().catch(() => {});
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("forged local cursor cannot skip a queued HOST_ACTION before Server acknowledgement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-boot-cursor-forged-host-action-"));
  const durable = new NodeStateStore(join(directory, "state.json"));
  await durable.initialize();
  // Valid JSON and a cursor equal to the Server's latest command used to pass
  // boot validation even though the Server had never acknowledged execution.
  durable.state.lastSequence = 1;
  await durable.save(durable.state);
  await durable.flush();
  const queuedHostAction = createCommand(COMMAND.HOST_ACTION, {
    action: { id: "queued-host-action", type: "COLLECT_DIAGNOSTICS", payload: {} },
  }, { id: "queued-host-command", sequence: 1 });
  let pollCalls = 0;
  const heartbeatPayloads = [];
  const client = quietClient({
    download: async () => { throw new Error("unexpected download"); },
    register: async () => ({
      protocolVersion: 1,
      node: { ackSequence: 0, commandSequence: queuedHostAction.sequence },
      commandSequence: queuedHostAction.sequence,
      project: null,
    }),
  });
  client.pollCommands = async () => {
    pollCalls += 1;
    return { protocolVersion: 1, commands: [queuedHostAction] };
  };
  client.heartbeat = async (payload) => {
    heartbeatPayloads.push(payload);
    return { serverTimeNs: `${BigInt(Date.now()) * 1_000_000n}`, acknowledgedActionResultIds: [] };
  };
  const engine = new BootCacheEngine();
  const node = createNode(directory, engine, client);
  try {
    await node.start();
    await waitFor(() => node.store.snapshot().stateRecoverySafetyLock?.reason?.code
      === "NODE_COMMAND_CURSOR_UNACKNOWLEDGED",
    "unacknowledged forged cursor did not engage recovery black");
    assert.equal(node.store.snapshot().lastSequence, 1);
    assert.equal(engine.releaseCalls, 0);
    assert.equal(engine.blankEnabled, true);
    assert.equal(pollCalls, 0, "Node must lock before polling past the queued HOST_ACTION");
    assert.equal(heartbeatPayloads.length, 0,
      "Node must never advertise the forged cursor as an acknowledgement");
  } finally {
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
