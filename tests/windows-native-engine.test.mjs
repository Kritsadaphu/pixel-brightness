import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PixelBrightnessNode } from "../runtime/node/daemon.mjs";
import { loadNodeConfig } from "../runtime/node/config.mjs";
import { WindowsNativeRenderEngine } from "../runtime/node/windows-native-engine.mjs";
import { normalizeProject } from "../runtime/shared/protocol.mjs";

const ADAPTER_LUID = "00000000:00000001";

function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function fakeCorrectionBinding(config) {
  const outputs = (config.outputs || []).filter((output) => output.enabled !== false).map((output) => ({
    id: String(output.id),
    processingBypass: output.processing?.bypass === true,
    artifacts: {
      warpMeshSha256: sha256(canonicalJson(output.warp || {})),
      blendMapSha256: output.processing?.bypass || !output.blend?.map
        ? null
        : sha256("blend:" + output.blend.map.path),
      blackMapSha256: output.processing?.bypass || !output.blackUniformity?.enabled
        ? null
        : sha256("black:" + (output.blackUniformity.map?.path || output.blackUniformity.lift)),
      maskSha256: output.processing?.bypass || !output.mask?.enabled
        ? null
        : sha256("mask:" + canonicalJson(output.mask)),
      colorLutSha256: output.processing?.bypass || !output.color?.lut
        ? null
        : sha256("lut:" + output.color.lut.path),
    },
  }));
  const payload = {
    schemaVersion: 1,
    algorithm: "sha256",
    configSha256: sha256(canonicalJson(config)),
    outputs,
  };
  return {
    ...payload,
    fingerprint: sha256(canonicalJson(payload)),
  };
}

function refingerprint(binding) {
  const payload = structuredClone(binding);
  delete payload.fingerprint;
  return { ...payload, fingerprint: sha256(canonicalJson(payload)) };
}

class FakeNativeClient {
  constructor({ adapterLuid = null, bootBlackLocked = false, bootToken = null } = {}) {
    this.requests = [];
    this.revision = 1;
    this.pattern = "content";
    this.blank = false;
    this.outputs = [{
      id: "boot-output",
      enabled: true,
      processing: { bypass: false },
      warp: { enabled: false },
    }];
    this.activeCorrectionBinding = fakeCorrectionBinding({
      revision: this.revision,
      outputs: this.outputs,
    });
    this.responseBindingOverride = null;
    this.statusBindingOverride = null;
    this.applyError = null;
    this.statusError = null;
    this.statusDelayMs = 0;
    this.nativeState = "running";
    this.sourceState = "connected";
    this.adapterLuid = adapterLuid;
    this.timingAvailable = true;
    this.timingAgeMilliseconds = 5;
    this.occluded = false;
    this.bootBlackLocked = bootBlackLocked;
    this.bootBlackReleaseCount = bootBlackLocked ? 0 : 1;
    this.bootToken = bootToken;
    this.shutdown = false;
  }

  async request(type, payload = {}) {
    this.requests.push({ type, payload });
    if (type === "hello") {
      return {
        type: "result",
        ok: true,
        payload: {
          version: "test",
          backend: "d3d11",
          protocolVersion: 1,
          patterns: {
            modes: ["content", "grid", "identify", "solid", "gray-code"],
            applyCorrectionsModes: ["solid"],
          },
          ...(this.bootToken ? {
            bootBlackLock: {
              startsLocked: true,
              authenticatedRelease: true,
              lifetimeMutationAuthentication: true,
            },
          } : {}),
        },
      };
    }
    if (type === "get-status") {
      if (this.statusDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.statusDelayMs));
      if (this.statusError) throw this.statusError;
      const activeCorrectionBinding = this.statusBindingOverride || this.activeCorrectionBinding;
      const bindingById = new Map(activeCorrectionBinding.outputs.map((output) => [output.id, output]));
      return {
        type: "result",
        ok: true,
        payload: {
          schemaVersion: 2,
          revision: this.revision,
          state: this.bootBlackLocked
            ? "boot-black-locked"
            : (this.occluded ? "display-occluded" : this.nativeState),
          bootBlackLocked: this.bootBlackLocked,
          bootBlackReleaseCount: this.bootBlackReleaseCount,
          activeCorrectionBinding,
          compositionSource: { state: this.sourceState, senderName: "PB-COMPOSITION" },
          outputs: this.outputs.map((output) => ({
            id: output.id,
            active: true,
            blank: this.blank,
            processingBypass: output.processing?.bypass === true,
            correctionBinding: bindingById.get(String(output.id))?.artifacts,
            pattern: this.pattern,
            occluded: this.occluded,
            presentSubmissions: {
              attempted: 120,
              accepted: 120,
              occluded: 0,
              otherStatuses: 0,
              failures: 0,
              lastHresult: "0x00000000",
              lastPresentIdHresult: "0x00000000",
              lastSubmittedPresentId: 120,
              lastSubmissionQpc: 2_000_000,
            },
            displayTiming: {
              source: "IDXGISwapChain::GetFrameStatistics",
              syncInterval: 1,
              cadenceMetricsApplicable: true,
              phaseProof: false,
              multiMonitorReliability: "platform-dependent",
              available: this.timingAvailable,
              status: this.timingAvailable ? "available" : "not-currently-available",
              lastQueryHresult: this.timingAvailable ? "0x00000000" : "0x887A0022",
              lastQueryQpc: 2_000_000,
              presentCount: this.timingAvailable ? 118 : null,
              presentRefreshCount: this.timingAvailable ? 118 : null,
              syncRefreshCount: this.timingAvailable ? 119 : null,
              syncQpcTime: this.timingAvailable ? 1_999_000 : null,
              sampleAgeMilliseconds: this.timingAvailable ? this.timingAgeMilliseconds : null,
              sampleSequence: this.timingAvailable ? 118 : 0,
              discontinuities: 0,
              droppedPresents: this.timingAvailable ? 0 : null,
              repeatedRefreshes: this.timingAvailable ? 0 : null,
              latePresentEvents: this.timingAvailable ? 0 : null,
              maximumLatenessRefreshes: this.timingAvailable ? 0 : null,
            },
            renderMilliseconds: 1.2,
          })),
        },
      };
    }
    if (type === "apply-config") {
      if (this.applyError) throw this.applyError;
      let config = payload;
      if (this.bootToken) {
        if (payload.authorizationToken !== this.bootToken
          || !payload.config || typeof payload.config !== "object") {
          const error = new Error("boot configuration authorization failed");
          error.code = "COMMAND_FAILED";
          throw error;
        }
        config = payload.config;
      }
      if ((config.adapterLuid ?? null) !== this.adapterLuid) {
        const error = new Error("GPU adapter change requires renderer restart");
        error.code = "COMMAND_FAILED";
        throw error;
      }
      if (config.revision <= this.revision) {
        const error = new Error("revision must increase");
        error.code = "COMMAND_FAILED";
        throw error;
      }
      this.revision = config.revision;
      this.outputs = config.outputs;
      this.activeCorrectionBinding = fakeCorrectionBinding(config);
      return {
        type: "result",
        ok: true,
        payload: {
          revision: this.revision,
          outputs: this.outputs.length,
          activeCorrectionBinding: this.responseBindingOverride || this.activeCorrectionBinding,
        },
      };
    }
    if (type === "release-boot-black") {
      if (payload.authorizationToken !== this.bootToken) {
        const error = new Error("boot authorization failed");
        error.code = "COMMAND_FAILED";
        throw error;
      }
      const released = this.bootBlackLocked;
      this.bootBlackLocked = false;
      this.bootBlackReleaseCount = 1;
      return {
        type: "result",
        ok: true,
        payload: {
          released,
          alreadyReleased: !released,
          bootBlackLocked: false,
          bootBlackReleaseCount: 1,
        },
      };
    }
    if (type === "set-pattern") {
      let pattern = payload;
      if (this.bootToken) {
        if (payload.authorizationToken !== this.bootToken
          || !payload.pattern || typeof payload.pattern !== "object") {
          throw new Error("set-pattern authorization failed");
        }
        pattern = payload.pattern;
      }
      if (this.bootBlackLocked) throw new Error("set-pattern is unavailable while boot black is locked");
      this.pattern = pattern.mode;
      return { type: "result", ok: true, payload: { mode: pattern.mode, cellSize: pattern.cellSize } };
    }
    if (type === "blank") {
      let blank = payload;
      if (this.bootToken) {
        if (payload.authorizationToken !== this.bootToken
          || !payload.blank || typeof payload.blank !== "object") {
          throw new Error("blank authorization failed");
        }
        blank = payload.blank;
      }
      if (this.bootBlackLocked && blank.enabled !== true) {
        throw new Error("blank(false) is unavailable while boot black is locked");
      }
      this.blank = blank.enabled;
      return { type: "result", ok: true, payload: { blank: this.blank } };
    }
    if (type === "shutdown") {
      if (payload.authorizationToken !== this.bootToken) throw new Error("shutdown authorization failed");
      this.shutdown = true;
      return { type: "result", ok: true, payload: { shuttingDown: true } };
    }
    throw new Error(`Unexpected fake request: ${type}`);
  }
}

test("native Windows boot-black remains locked through initialization and releases exactly once", async () => {
  const bootToken = "A".repeat(43);
  const client = new FakeNativeClient({ bootBlackLocked: true, bootToken });
  const engine = new WindowsNativeRenderEngine({
    nodeId: "node-boot-lock",
    physicalOutputs: [
      { ...identityOutput("A", "DP-1", 0), display: { gdiName: "\\\\.\\DISPLAY1" } },
      { ...identityOutput("B", "DP-2", 1680), display: { gdiName: "\\\\.\\DISPLAY2" } },
    ],
    compositionSource: project().compositionSource,
    rendererPipe: "\\\\.\\pipe\\pixel-brightness-renderer-node-boot-lock",
    rendererBootToken: bootToken,
    client,
    statusPollMs: 10_000,
    statusFreshnessMs: 30_000,
  });

  await engine.initialize();
  assert.equal(engine.diagnostics().ready, false);
  assert.equal(engine.diagnostics().bootBlackLocked, true);
  assert.equal(client.requests.some((request) => request.type === "release-boot-black"), false,
    "renderer initialization must never release the independent boot latch");

  await engine.configure(project());
  const bootApply = client.requests.find((request) => request.type === "apply-config");
  assert.equal(bootApply.payload.authorizationToken, bootToken);
  assert.equal(bootApply.payload.config.revision, 2);
  assert.equal(engine.diagnostics().bootBlackLocked, true,
    "authenticated boot configuration must not release the content latch");
  await assert.rejects(engine.setPattern({ type: "white" }), /boot black is locked/);
  await assert.rejects(engine.blank(false), /boot black is locked/);
  await engine.blank(true);

  await engine.releaseBootBlack();
  assert.equal(engine.diagnostics().ready, true);
  assert.equal(engine.diagnostics().bootBlackLocked, false);
  assert.equal(engine.diagnostics().bootBlackReleaseCount, 1);
  assert.equal(client.requests.filter((request) => request.type === "release-boot-black").length, 1);
  assert.equal(engine.rendererBootToken, bootToken,
    "release credential must remain as the renderer's lifetime control credential");

  await assert.rejects(
    client.request("blank", { blank: { enabled: false } }),
    /blank authorization failed/,
  );
  await assert.rejects(
    client.request("blank", { authorizationToken: "wrong", blank: { enabled: false } }),
    /blank authorization failed/,
  );
  assert.equal(client.blank, true, "missing/wrong credentials must not clear sticky black");
  await assert.rejects(
    client.request("set-pattern", { pattern: { mode: "white" } }),
    /set-pattern authorization failed/,
  );
  assert.equal(client.pattern, "content");
  const revisionBeforeAttack = client.revision;
  await assert.rejects(
    client.request("apply-config", { authorizationToken: "wrong", config: bootApply.payload.config }),
    /boot configuration authorization failed/,
  );
  assert.equal(client.revision, revisionBeforeAttack);
  await assert.rejects(client.request("shutdown", {}), /shutdown authorization failed/);
  assert.equal(client.shutdown, false);

  await engine.blank(false);
  assert.equal(client.blank, false, "the authenticated Node retains deliberate runtime control");
  assert.deepEqual(client.requests.at(-1), {
    type: "blank",
    payload: {
      authorizationToken: bootToken,
      blank: { enabled: false },
    },
  });

  await engine.releaseBootBlack();
  assert.equal(client.requests.filter((request) => request.type === "release-boot-black").length, 1,
    "a repeated local call must not issue a second native release request");
  await engine.stop();
});

test("discarded native boot authorization cannot be used later in the same process", async () => {
  const bootToken = "B".repeat(43);
  const client = new FakeNativeClient({ bootBlackLocked: true, bootToken });
  const engine = new WindowsNativeRenderEngine({
    nodeId: "node-discarded-boot-lock",
    compositionSource: project().compositionSource,
    rendererPipe: "\\\\.\\pipe\\pixel-brightness-renderer-node-discarded-boot-lock",
    rendererBootToken: bootToken,
    client,
    statusPollMs: 10_000,
    statusFreshnessMs: 30_000,
  });
  await engine.initialize();
  engine.discardBootBlackAuthorization();
  await engine.blank(true);
  await assert.rejects(engine.releaseBootBlack(), /discarded by fail-closed startup/);
  assert.equal(client.requests.some((request) => request.type === "release-boot-black"), false);
  assert.equal(engine.diagnostics().bootBlackLocked, true);
  assert.equal(engine.diagnostics().bootBlackAuthorizationDiscarded, true);
  await engine.stop();
});

test("boot credential refuses config when native status does not prove a fresh locked process", async () => {
  const bootToken = "C".repeat(43);
  const client = new FakeNativeClient({ bootBlackLocked: false, bootToken });
  const engine = new WindowsNativeRenderEngine({
    nodeId: "node-stale-boot-process",
    physicalOutputs: [
      { ...identityOutput("A", "DP-1", 0), display: { gdiName: "\\\\.\\DISPLAY1" } },
      { ...identityOutput("B", "DP-2", 1680), display: { gdiName: "\\\\.\\DISPLAY2" } },
    ],
    compositionSource: project().compositionSource,
    rendererPipe: "\\\\.\\pipe\\pixel-brightness-renderer-node-stale-boot-process",
    rendererBootToken: bootToken,
    client,
    statusPollMs: 10_000,
    statusFreshnessMs: 30_000,
  });
  await engine.initialize();
  await assert.rejects(engine.configure(project()), /did not prove a fresh locked boot-black state/);
  assert.equal(client.requests.some((request) => request.type === "apply-config"), false);
  assert.equal(client.requests.some((request) => request.type === "release-boot-black"), false);
  await engine.stop();
});

function identityOutput(id, connector, x) {
  return {
    id,
    name: `Projector ${id}`,
    connector,
    enabled: true,
    wallId: "wall-main",
    resolution: { width: 1920, height: 1080, refreshNum: 60, refreshDen: 1 },
    sourceViewport: { x, y: 0, width: 1920, height: 1080 },
    overlap: { left: id === "A" ? 0 : 240, right: id === "A" ? 240 : 0, top: 0, bottom: 0 },
    warp: { enabled: true, columns: 2, rows: 2, interpolation: "bicubic", points: null },
    blend: { enabled: true, feather: 0.78, gamma: 2.2 },
    blackUniformity: { enabled: false, lift: 0, map: null },
    mask: { enabled: false, map: null, path: null, softness: 0 },
    color: { gain: [1, 1, 1], offset: [0, 0, 0], gamma: [1, 1, 1], lut: null },
  };
}

function project() {
  return normalizeProject({
    id: "arena-final",
    revision: 1,
    canvas: { width: 3600, height: 1080, frameRateNum: 60, frameRateDen: 1 },
    compositionSource: {
      type: "spout",
      senderName: "PB-COMPOSITION",
      width: 3600,
      height: 1080,
      frameRateNum: 60,
      frameRateDen: 1,
      onMissing: "black",
      onMismatch: "black",
      allowAutoSelect: false,
    },
    walls: [{ id: "wall-main", name: "Main" }],
    outputs: [
      { ...identityOutput("A", "logical-A", 0), display: { gdiName: "\\\\.\\DISPLAY91" } },
      { ...identityOutput("B", "logical-B", 1680), display: { gdiName: "\\\\.\\DISPLAY92" } },
    ],
    timeline: { cues: [] },
  });
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test("native Windows engine applies Web project over IPC and persists the exact recovery DTO", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-native-engine-"));
  const configPath = join(directory, "renderer.json");
  const client = new FakeNativeClient({ adapterLuid: ADAPTER_LUID });
  const engine = new WindowsNativeRenderEngine({
    nodeId: "node-01",
    platform: "linux",
    physicalOutputs: [
      { ...identityOutput("A", "DP-1", 0), display: { gdiName: "\\\\.\\DISPLAY1", adapterLuid: ADAPTER_LUID, targetId: 11 } },
      { ...identityOutput("B", "DP-2", 1680), display: { gdiName: "\\\\.\\DISPLAY2", adapterLuid: ADAPTER_LUID, targetId: 12 } },
    ],
    compositionSource: project().compositionSource,
    rendererPipe: "\\\\.\\pipe\\pixel-brightness-renderer-node-01",
    rendererConfigPath: configPath,
    client,
  });

  await engine.initialize();
  await engine.configure(project());
  const apply = client.requests.find((request) => request.type === "apply-config");
  assert.ok(apply);
  assert.equal(apply.payload.revision, 2);
  assert.equal(apply.payload.adapterLuid, ADAPTER_LUID);
  assert.equal(apply.payload.compositionSource.senderName, "PB-COMPOSITION");
  // A saved project may carry a stale Windows display selector from another
  // machine. The node's local physical binding is authoritative at apply time.
  assert.equal(apply.payload.outputs[0].display.gdiName, "\\\\.\\DISPLAY1");
  assert.equal(apply.payload.outputs[1].display.gdiName, "\\\\.\\DISPLAY2");
  assert.equal(apply.payload.outputs[1].sourceViewport.x, 1680);
  assert.equal("source" in apply.payload.outputs[0], false);
  assert.equal("connector" in apply.payload.outputs[0], false);

  const persisted = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(persisted, apply.payload);
  assert.equal(persisted.adapterLuid, ADAPTER_LUID);
  assert.equal(engine.externalCadence, true);

  const requestsBeforeFrame = client.requests.length;
  assert.deepEqual(engine.renderFrame(100n), []);
  assert.equal(client.requests.length, requestsBeforeFrame, "JS frame requests must not drive native presentation");

  await engine.setPattern({ outputId: "A", type: "grid", cellSize: 32 });
  assert.deepEqual(client.requests.at(-1), {
    type: "set-pattern",
    payload: { mode: "grid", cellSize: 32, outputId: "A" },
  });
  assert.equal(engine.adapters.get("A").mode, "grid");
  assert.equal(engine.adapters.get("B").mode, "black");
  await engine.clearPattern("A");
  assert.equal(client.requests.at(-1).payload.mode, "content");
  assert.equal(engine.adapters.get("A").mode, "content");
  assert.equal(engine.adapters.get("B").mode, "content", "targeted clear must restore every isolated peer");
  await engine.setPattern({ outputId: "A", type: "solid", rgb: [0.125, 0.5, 1] });
  assert.deepEqual(client.requests.at(-1), {
    type: "set-pattern",
    payload: {
      mode: "solid",
      outputId: "A",
      rgb: [0.125, 0.5, 1],
      applyCorrections: false,
    },
  });
  await engine.setPattern({
    outputId: "A",
    type: "solid",
    rgb: [0.0039, 0.18, 0.9],
    applyCorrections: true,
  });
  assert.deepEqual(client.requests.at(-1), {
    type: "set-pattern",
    payload: {
      mode: "solid",
      outputId: "A",
      rgb: [0.0039, 0.18, 0.9],
      applyCorrections: true,
    },
  });
  await assert.rejects(
    engine.setPattern({ type: "grid", applyCorrections: true }),
    /only valid for a solid/,
  );
  engine.hello.patterns.applyCorrectionsModes = [];
  await assert.rejects(
    engine.setPattern({ type: "solid", rgb: [0.18, 0.18, 0.18], applyCorrections: true }),
    /does not advertise corrected solid-pattern support/,
  );
  engine.hello.patterns.applyCorrectionsModes = ["solid"];
  await engine.setPattern({ outputId: "B", type: "gray-code", axis: "x", bit: 7, inverse: true });
  assert.deepEqual(client.requests.at(-1), {
    type: "set-pattern",
    payload: { mode: "gray-code", outputId: "B", axis: "x", bit: 7, inverse: true },
  });

  await engine.refreshStatus();
  const diagnostics = engine.diagnostics();
  assert.equal(diagnostics.backend, "windows-dxgi-native");
  assert.equal(diagnostics.ready, true);
  assert.equal(diagnostics.framesRendered, 240);
  assert.equal(diagnostics.presentSubmissions, 240);
  assert.equal(diagnostics.displayTimingAvailable, true);
  assert.equal(diagnostics.droppedFrames, 0);
  assert.equal(diagnostics.outputs[0].occluded, false);
  assert.equal(diagnostics.outputs[0].displayTiming.phaseProof, false);
  assert.equal(diagnostics.outputs[0].displayTiming.syncInterval, 1);
  assert.equal(diagnostics.outputs[0].displayTiming.cadenceMetricsApplicable, true);
  assert.equal(diagnostics.outputs[0].displayTiming.multiMonitorReliability, "platform-dependent");
  assert.equal(diagnostics.ignoredJsFrameRequests, 1);
  assert.equal(diagnostics.correctionBindingMatches, true);
  assert.equal(
    diagnostics.activeCorrectionFingerprint,
    client.activeCorrectionBinding.fingerprint,
  );

  await engine.configure({ ...project(), revision: 2 });
  const recoveredBackup = JSON.parse(await readFile(`${configPath}.last-known-good.json`, "utf8"));
  assert.deepEqual(recoveredBackup, persisted, "the prior flushed renderer DTO must remain available as LKG");

  client.statusError = new Error("named pipe closed");
  await assert.rejects(engine.refreshStatus(), /named pipe closed/);
  const failedDiagnostics = engine.diagnostics();
  assert.equal(failedDiagnostics.ready, false);
  assert.equal(failedDiagnostics.connected, false);
  assert.equal(failedDiagnostics.nativeStatus, null);
  assert.match(failedDiagnostics.error, /named pipe closed/);
  client.statusError = null;
  await engine.initialize();
  assert.equal(engine.diagnostics().connected, true, "a fresh hello/status handshake must recover the renderer");

  await engine.stop();
  assert.deepEqual(client.requests.at(-1), { type: "blank", payload: { enabled: true } });
});

test("a post-apply renderer-config persistence failure proves global black before discarding claims", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-native-config-fail-closed-"));
  const configPath = join(directory, "renderer.json");
  const client = new FakeNativeClient({ adapterLuid: ADAPTER_LUID });
  const engine = new WindowsNativeRenderEngine({
    nodeId: "node-config-fail-closed",
    platform: "linux",
    physicalOutputs: [
      { ...identityOutput("A", "DP-1", 0), display: { gdiName: "\\\\.\\DISPLAY1", adapterLuid: ADAPTER_LUID, targetId: 11 } },
    ],
    compositionSource: project().compositionSource,
    rendererPipe: "\\\\.\\pipe\\pixel-brightness-renderer-config-fail-closed",
    rendererConfigPath: configPath,
    client,
  });

  await engine.initialize();
  await engine.configure(normalizeProject({
    ...project(),
    outputs: [identityOutput("A", "logical-A", 0)],
  }));
  await engine.blank(false);
  assert.equal(client.blank, false, "fixture must begin with visible content");

  const nonDirectory = join(directory, "not-a-directory");
  await writeFile(nonDirectory, "blocks renderer config persistence", "utf8");
  engine.rendererConfigPath = join(nonDirectory, "renderer.json");
  const requestStart = client.requests.length;
  await assert.rejects(
    engine.applyOutput({ ...identityOutput("A", "logical-A", 0), overlap: { left: 1, right: 0, top: 0, bottom: 0 } }),
    /not-a-directory|EEXIST|ENOTDIR/i,
  );

  const recoveryRequests = client.requests.slice(requestStart);
  const applyIndex = recoveryRequests.findIndex((request) => request.type === "apply-config");
  const blankIndex = recoveryRequests.findIndex((request) => request.type === "blank"
    && (request.payload?.enabled === true || request.payload?.blank?.enabled === true));
  const statusIndex = recoveryRequests.findIndex((request, index) => index > blankIndex && request.type === "get-status");
  assert.ok(applyIndex >= 0 && blankIndex > applyIndex && statusIndex > blankIndex,
    "a successful native apply must be followed by authenticated black and fresh status proof when persistence fails");
  assert.equal(client.blank, true);
  assert.equal(engine.project, null);
  assert.equal(engine.projectRevision, null);
  assert.equal(engine.diagnostics().ready, false);
  assert.equal(engine.diagnostics().configAuthorityValid, false);
  const retainedFailure = engine.diagnostics().error;
  await engine.refreshStatus();
  assert.equal(engine.diagnostics().ready, false,
    "periodic status must not resurrect READY after durable config authority was lost");
  assert.equal(engine.diagnostics().configAuthorityValid, false);
  assert.equal(engine.diagnostics().error, retainedFailure);
});

test("native Windows diagnostics never turn missing or stale display statistics into zero faults", async () => {
  const client = new FakeNativeClient();
  const engine = new WindowsNativeRenderEngine({
    nodeId: "node-timing",
    physicalOutputs: [
      { ...identityOutput("A", "DP-1", 0), display: { gdiName: "\\\\.\\DISPLAY1" } },
    ],
    compositionSource: project().compositionSource,
    rendererPipe: "\\\\.\\pipe\\pixel-brightness-renderer-node-timing",
    client,
    statusPollMs: 10_000,
    statusFreshnessMs: 30_000,
  });
  await engine.initialize();
  await engine.configure({ ...project(), outputs: [project().outputs[0]] });

  client.timingAvailable = false;
  await engine.refreshStatus();
  let diagnostics = engine.diagnostics();
  assert.equal(diagnostics.ready, true, "display statistics are a physical acceptance gate, not source liveness");
  assert.equal(diagnostics.displayTimingAvailable, false);
  assert.equal(diagnostics.droppedFrames, null);
  assert.equal(diagnostics.repeatedFrames, null);
  assert.equal(diagnostics.lateFrames, null);
  assert.equal(diagnostics.outputs[0].metrics.lastFrame, null);
  assert.equal(diagnostics.outputs[0].displayTiming.status, "not-currently-available");

  client.timingAvailable = true;
  client.timingAgeMilliseconds = 1_001;
  await engine.refreshStatus();
  diagnostics = engine.diagnostics();
  assert.equal(diagnostics.displayTimingAvailable, false);
  assert.equal(diagnostics.outputs[0].displayTiming.available, true);
  assert.equal(diagnostics.outputs[0].displayTiming.fresh, false);
  assert.equal(diagnostics.droppedFrames, null);

  client.timingAgeMilliseconds = 5;
  client.occluded = true;
  await engine.refreshStatus();
  diagnostics = engine.diagnostics();
  assert.equal(diagnostics.displayTimingAvailable, false);
  assert.equal(diagnostics.outputs[0].occluded, true);
  assert.equal(diagnostics.outputs[0].displayTiming.occluded, true);
  assert.equal(diagnostics.droppedFrames, null);
  assert.equal(diagnostics.ready, false);

  client.occluded = false;
  await engine.refreshStatus();
  diagnostics = engine.diagnostics();
  assert.equal(diagnostics.displayTimingAvailable, true);
  assert.equal(diagnostics.droppedFrames, 0);
  await engine.stop();
});

test("PixelBrightnessNode selects the one native DXGI bridge for Windows config", async () => {
  const config = await loadNodeConfig({
    platform: "win32",
    cwd: "C:\\show",
    env: {
      PROGRAMDATA: "C:\\ProgramData",
      PROGRAMFILES: "C:\\Program Files",
      PIXEL_BRIGHTNESS_NODE_ID: "node-01",
      PIXEL_BRIGHTNESS_RENDERER_ADAPTER_LUID: ADAPTER_LUID,
      PIXEL_BRIGHTNESS_OUTPUTS: JSON.stringify([
        { ...identityOutput("A", "\\\\.\\DISPLAY1", 0), display: { gdiName: "\\\\.\\DISPLAY1" } },
      ]),
    },
  });
  const node = new PixelBrightnessNode(config, {
    nativeRendererClient: new FakeNativeClient({ adapterLuid: ADAPTER_LUID }),
  });
  assert.equal(node.engine instanceof WindowsNativeRenderEngine, true);
  assert.equal(node.engine.externalCadence, true);
  assert.equal(node.engine.client instanceof FakeNativeClient, true);
  assert.equal(config.adapterLuid, ADAPTER_LUID);
  assert.equal(node.engine.adapterLuid, ADAPTER_LUID);
});

test("native status polling invalidates source loss, stale snapshots, and recovers without a Node restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-native-status-authority-"));
  const client = new FakeNativeClient();
  const engine = new WindowsNativeRenderEngine({
    nodeId: "node-status",
    platform: "linux",
    physicalOutputs: [
      identityOutput("A", "DP-1", 0),
      identityOutput("B", "DP-2", 1680),
    ],
    compositionSource: project().compositionSource,
    rendererPipe: "\\\\.\\pipe\\pixel-brightness-renderer-node-status",
    rendererConfigPath: join(directory, "renderer.json"),
    client,
    statusPollMs: 25,
    statusFreshnessMs: 100,
  });
  await engine.initialize();
  await engine.configure(project());
  assert.equal(engine.diagnostics().ready, true);

  client.nativeState = "input-degraded";
  client.sourceState = "stale";
  await waitFor(
    () => engine.diagnostics().compositionSource?.state === "stale",
    "periodic native status did not observe Spout loss",
  );
  assert.equal(engine.diagnostics().ready, false, "input-degraded must never remain show-ready");

  client.nativeState = "running";
  client.sourceState = "connected";
  await waitFor(() => engine.diagnostics().ready === true, "periodic native status did not recover");

  client.statusDelayMs = 250;
  await waitFor(
    () => engine.diagnostics().nativeStatusFresh === false,
    "a wedged status request must age the cached READY snapshot out",
  );
  assert.equal(engine.diagnostics().connected, false);
  assert.match(engine.diagnostics().error, /status is older than 100 ms/);
  client.statusDelayMs = 0;
  await waitFor(() => engine.diagnostics().ready === true, "fresh status did not recover after a delayed request");
  await engine.stop();
});

test("native correction binding rejects identity, forged artifact, and stale or failed apply claims", async () => {
  const client = new FakeNativeClient();
  const engine = new WindowsNativeRenderEngine({
    nodeId: "node-binding",
    physicalOutputs: [
      { ...identityOutput("A", "DP-1", 0), display: { gdiName: "\\\\.\\DISPLAY1" } },
      { ...identityOutput("B", "DP-2", 1680), display: { gdiName: "\\\\.\\DISPLAY2" } },
    ],
    compositionSource: project().compositionSource,
    rendererPipe: "\\\\.\\pipe\\pixel-brightness-renderer-node-binding",
    client,
    statusPollMs: 10_000,
    statusFreshnessMs: 30_000,
  });
  await engine.initialize();
  await engine.configure(project());
  const appliedFingerprint = engine.diagnostics().activeCorrectionFingerprint;
  assert.equal(appliedFingerprint, client.activeCorrectionBinding.fingerprint);

  const identityBinding = structuredClone(client.activeCorrectionBinding);
  identityBinding.outputs[0].artifacts.warpMeshSha256 = sha256("identity-mesh");
  client.statusBindingOverride = refingerprint(identityBinding);
  await assert.rejects(
    engine.refreshStatus(),
    /correction binding differs from the applied receipt/,
  );
  assert.equal(engine.diagnostics().ready, false);
  assert.equal(engine.diagnostics().activeCorrectionFingerprint, null);
  assert.equal(engine.diagnostics().observedCorrectionBinding.fingerprint, client.statusBindingOverride.fingerprint);

  const forgedBinding = structuredClone(client.activeCorrectionBinding);
  forgedBinding.outputs[0].artifacts.blackMapSha256 = sha256("forged-black-map");
  client.statusBindingOverride = forgedBinding;
  await assert.rejects(
    engine.refreshStatus(),
    /fingerprint does not bind/,
  );
  assert.equal(engine.diagnostics().activeCorrectionFingerprint, null);
  assert.equal(engine.diagnostics().observedCorrectionBinding, null);

  client.statusBindingOverride = null;
  await engine.refreshStatus();
  assert.equal(engine.diagnostics().activeCorrectionFingerprint, appliedFingerprint);

  const wrongConfigBinding = structuredClone(client.activeCorrectionBinding);
  wrongConfigBinding.configSha256 = sha256("different-but-self-consistent-native-config");
  const selfConsistentWrongConfigBinding = refingerprint(wrongConfigBinding);
  client.responseBindingOverride = selfConsistentWrongConfigBinding;
  client.statusBindingOverride = selfConsistentWrongConfigBinding;
  await assert.rejects(
    engine.configure(project()),
    /config digest does not match the exact normalized config sent/,
  );
  assert.equal(engine.diagnostics().ready, false);
  assert.equal(engine.diagnostics().projectRevision, null);
  assert.equal(engine.diagnostics().activeCorrectionFingerprint, null);
  client.responseBindingOverride = null;
  client.statusBindingOverride = null;
  await engine.configure(project());
  const recoveredFingerprint = engine.diagnostics().activeCorrectionFingerprint;

  client.applyError = new Error("correction asset load failed");
  await assert.rejects(engine.configure(project()), /correction asset load failed/);
  client.applyError = null;
  await engine.refreshStatus();
  assert.equal(engine.diagnostics().activeCorrectionFingerprint, null,
    "an ambiguous apply failure must clear the Node's project/binding authority even when native retained the old binding");
  assert.equal(engine.diagnostics().observedCorrectionBinding.fingerprint, recoveredFingerprint,
    "fresh telemetry may diagnose the retained native binding without restoring authority");
  assert.equal(client.blank, true, "an ambiguous native apply must be forced globally black");

  client.statusDelayMs = 100;
  engine.statusFreshnessMs = 25;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(engine.diagnostics().activeCorrectionFingerprint, null);
  client.statusDelayMs = 0;
  engine.statusFreshnessMs = 30_000;

  const wrongIdentity = structuredClone(client.activeCorrectionBinding);
  const nextConfig = engine.createNativeConfig(project(), { revision: client.revision + 1 });
  wrongIdentity.configSha256 = sha256(canonicalJson(nextConfig));
  wrongIdentity.outputs[0].id = "FORGED-OUTPUT";
  client.responseBindingOverride = refingerprint(wrongIdentity);
  await assert.rejects(
    engine.configure(project()),
    /output identity does not match/,
  );
  assert.equal(engine.diagnostics().projectRevision, null);
  assert.equal(engine.diagnostics().activeCorrectionFingerprint, null);
  await engine.stop();
});

test("native Windows engine rejects split physical adapters and a mismatched configured LUID", () => {
  const physicalOutput = (id, luid, targetId) => ({
    ...identityOutput(id, `\\\\.\\DISPLAY${targetId}`, 0),
    display: { gdiName: `\\\\.\\DISPLAY${targetId}`, adapterLuid: luid, targetId },
  });
  assert.throws(() => new WindowsNativeRenderEngine({
    nodeId: "node-01",
    physicalOutputs: [
      physicalOutput("A", ADAPTER_LUID, 1),
      physicalOutput("B", "00000000:00000002", 2),
    ],
  }), /must use one GPU adapter LUID/);
  assert.throws(() => new WindowsNativeRenderEngine({
    nodeId: "node-01",
    adapterLuid: "00000000:00000002",
    physicalOutputs: [physicalOutput("A", ADAPTER_LUID, 1)],
  }), /does not match the physical output GPU adapter LUID/);
});
