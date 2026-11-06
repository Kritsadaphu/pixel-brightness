import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PixelBrightnessNode } from "../runtime/node/daemon.mjs";
import {
  NodeStateStore,
  canonicalCameraCalibrationReport,
  createCameraCalibrationAcknowledgement,
} from "../runtime/node/state-store.mjs";
import { defaultProject, normalizeProject } from "../runtime/shared/protocol.mjs";
import { epochNowNs } from "../runtime/shared/timecore.mjs";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function project() {
  const base = defaultProject();
  return normalizeProject({
    ...base,
    id: "camera-ack-project",
    revision: 7,
    outputs: [],
    timeline: { ...base.timeline, cues: [] },
  });
}

function applicableCompleteCalibration() {
  return {
    schemaVersion: 1,
    sessionId: "camera-applicable-complete-001",
    mode: "measured",
    plan: { localExecutionPlan: true },
    state: "complete",
    stepIndex: 4,
    completedSteps: 5,
    totalSteps: 5,
    camera: { vendor: "Sony", model: "ILCE-7M4", serial: "ACK-A7IV-001" },
    manifest: {
      schemaVersion: 5,
      sessionId: "camera-applicable-complete-001",
      provenance: "node-ack-durability-fixture",
      applicable: true,
    },
    projectPatch: {
      schemaVersion: 1,
      projectId: "camera-ack-project",
      baseRevision: 7,
      outputs: [{ id: "A", black: { enabled: true, level: 0.00125 } }],
    },
    failure: null,
    startedAt: "2026-08-25T00:00:00.000Z",
    completedAt: "2026-08-25T00:01:00.000Z",
    updatedAt: "2026-08-25T00:01:00.000Z",
    bundle: null,
  };
}

async function seedTerminalState(directory, calibration = applicableCompleteCalibration()) {
  const state = new NodeStateStore(join(directory, "state.json"));
  await state.initialize();
  state.state.project = project();
  state.state.cameraCalibration = structuredClone(calibration);
  await state.save(state.state);
  return calibration;
}

async function waitFor(predicate, { timeoutMs = 5_000, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

class AckTestEngine {
  constructor() {
    this.adapters = new Map();
    this.externalCadence = false;
    this.ready = true;
    this.connected = true;
    this.projectRevision = null;
  }

  async initialize() {}

  async configure(input) { this.projectRevision = input.revision; }

  async prepare() {}

  async blank() {}

  async clearPattern() {}

  renderFrame() { return []; }

  async stop() { this.ready = false; }

  diagnostics() {
    return {
      backend: "camera-ack-test-engine",
      ready: this.ready,
      connected: this.connected,
      projectRevision: this.projectRevision,
      nativeRevision: this.projectRevision,
      compositionSource: null,
      droppedFrames: 0,
      framesRendered: 0,
      outputs: [],
    };
  }
}

function nodeConfig(directory) {
  return {
    nodeId: "camera-ack-node",
    name: "Camera ACK Node",
    version: "0.3.0-test",
    platform: "darwin",
    serverUrl: "http://127.0.0.1:4100",
    dataDir: directory,
    outputs: [],
    heartbeatMs: 5,
    hostTelemetryMs: 60_000,
    clockSyncMs: 60_000,
    clockSyncRounds: 1,
    pollWaitMs: 5,
    requestTimeoutMs: 500,
    commandRetryBudget: 3,
    maxAssetBytes: 1_000_000,
    maxCacheBytes: 2_000_000,
    cameraBackend: "sony-sdk",
    logLevel: "error",
    nodeToken: null,
  };
}

const hostTelemetry = {
  collect: async ({ renderer }) => ({
    schemaVersion: 2,
    host: { hostname: "camera-ack-node" },
    renderer,
  }),
};

function client({ onHeartbeat = () => ({}) } = {}) {
  let aborted = false;
  return {
    time: async () => ({ serverTimeNs: epochNowNs().toString() }),
    register: async () => ({
      protocolVersion: 1,
      node: { ackSequence: 0, commandSequence: 0 },
      commandSequence: 0,
      project: project(),
    }),
    state: async () => ({ timeline: { status: "idle", targetNodeIds: [] }, media: [] }),
    heartbeat: async (payload) => ({
      serverTimeNs: epochNowNs().toString(),
      acknowledgedActionResultIds: [],
      ...await onHeartbeat(structuredClone(payload)),
    }),
    pollCommands: async () => {
      while (!aborted) await new Promise((resolve) => setTimeout(resolve, 2));
      throw new Error("aborted");
    },
    assetUrl: (sha256) => `/v1/assets/${sha256}`,
    download: async () => { throw new Error("unexpected asset download"); },
    abort: () => { aborted = true; },
  };
}

function createNode(directory, nodeClient) {
  const node = new PixelBrightnessNode(nodeConfig(directory), {
    hostTelemetryCollector: hostTelemetry,
    renderEngineFactory: () => new AckTestEngine(),
  });
  node.client = nodeClient;
  node.cache.client = nodeClient;
  return node;
}

async function crashNode(node) {
  node.running = false;
  node.abortController.abort();
  node.client.abort();
  await Promise.allSettled(node.tasks);
  await node.store.flush();
  await node.engine.stop();
}

test("applicable COMPLETE ACK is durable and restart omits the terminal report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-camera-ack-restart-"));
  const firstPayloads = [];
  let acknowledged = false;
  const firstClient = client({
    onHeartbeat: (payload) => {
      firstPayloads.push(payload);
      const report = payload.telemetry?.cameraCalibration;
      if (report?.state === "complete" && !acknowledged) {
        acknowledged = true;
        return { acknowledgedCameraCalibrationId: report.sessionId };
      }
      return {};
    },
  });
  const firstNode = createNode(directory, firstClient);
  try {
    const calibration = await seedTerminalState(directory);
    const expectedReport = canonicalCameraCalibrationReport(calibration);
    await firstNode.start();
    const acknowledgedState = await waitFor(async () => {
      const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
      return state.cameraCalibrationAcknowledgementReceipt ? state : null;
    }, { message: "durable camera-calibration acknowledgement receipt" });
    assert.equal(
      acknowledgedState.cameraCalibrationAcknowledgementReceipt.terminalReportSha256,
      digest(expectedReport),
    );
    assert.equal(
      acknowledgedState.cameraCalibrationAcknowledgementReceipt.projectPatchSha256,
      digest(expectedReport.projectPatch),
    );
    await waitFor(() => firstPayloads.some((payload) => payload.telemetry?.cameraCalibration == null), {
      message: "post-ACK heartbeat without terminal report",
    });
    assert.equal(digest(firstPayloads.find((payload) => (
      payload.telemetry?.cameraCalibration?.state === "complete"
    )).telemetry.cameraCalibration), digest(expectedReport));
    await firstNode.stop();

    const restartPayloads = [];
    const restartClient = client({ onHeartbeat: (payload) => { restartPayloads.push(payload); return {}; } });
    const restarted = createNode(directory, restartClient);
    try {
      await restarted.start();
      await waitFor(() => restartPayloads.length > 0, { message: "restart heartbeat" });
      assert.ok(restartPayloads.every((payload) => payload.telemetry?.cameraCalibration == null));
      assert.equal(restarted.store.snapshot().cameraCalibration.projectPatch, null);
      assert.match(
        restarted.store.snapshot().cameraCalibrationAcknowledgementReceipt.terminalReportSha256,
        /^[a-f0-9]{64}$/,
      );
    } finally {
      await restarted.stop().catch(() => {});
    }
  } finally {
    await firstNode.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed local ACK commit retains and replays the exact full terminal report after crash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-camera-ack-save-failure-"));
  const originalCalibration = await seedTerminalState(directory);
  let firstPublishedReport = null;
  let ackReturned = false;
  const failingClient = client({
    onHeartbeat: (payload) => {
      const report = payload.telemetry?.cameraCalibration;
      if (report && !ackReturned) {
        firstPublishedReport = report;
        ackReturned = true;
        return { acknowledgedCameraCalibrationId: report.sessionId };
      }
      return {};
    },
  });
  const failingNode = createNode(directory, failingClient);
  const durableSave = failingNode.store.save.bind(failingNode.store);
  let rejectedReceiptSave = false;
  failingNode.store.save = async (candidate) => {
    if (!rejectedReceiptSave && candidate.cameraCalibrationAcknowledgementReceipt != null) {
      rejectedReceiptSave = true;
      const error = new Error("injected acknowledgement fsync failure");
      error.code = "EIO";
      throw error;
    }
    return durableSave(candidate);
  };
  try {
    await failingNode.start();
    await waitFor(() => rejectedReceiptSave && failingNode.diagnostics().metrics.heartbeatFailures > 0, {
      message: "failed local acknowledgement commit",
    });
    assert.deepEqual(failingNode.cameraCalibration.projectPatch, originalCalibration.projectPatch);
    assert.equal(failingNode.store.snapshot().cameraCalibrationAcknowledgementReceipt, null);
    assert.deepEqual(failingNode.store.snapshot().cameraCalibration.projectPatch, originalCalibration.projectPatch);
    await crashNode(failingNode);

    let replayedReport = null;
    const restartClient = client({
      onHeartbeat: (payload) => {
        replayedReport ||= payload.telemetry?.cameraCalibration || null;
        return {};
      },
    });
    const restarted = createNode(directory, restartClient);
    try {
      await restarted.start();
      await waitFor(() => replayedReport != null, { message: "full terminal report replay after restart" });
      assert.equal(canonicalJson(replayedReport), canonicalJson(firstPublishedReport));
      assert.deepEqual(replayedReport.projectPatch, originalCalibration.projectPatch);
    } finally {
      await restarted.stop().catch(() => {});
    }
  } finally {
    if (failingNode.running) await failingNode.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("forged terminal receipt restores LKG full evidence under a recovery lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-camera-ack-forged-receipt-"));
  const pathname = join(directory, "state.json");
  try {
    const calibration = await seedTerminalState(directory);
    const state = new NodeStateStore(pathname);
    await state.initialize();
    const acknowledgement = createCameraCalibrationAcknowledgement({
      calibration,
      publishedReport: canonicalCameraCalibrationReport(calibration),
      acknowledgedAt: "2026-08-25T00:02:00.000Z",
    });
    state.state.cameraCalibration = acknowledgement.calibration;
    state.state.cameraCalibrationAcknowledgementReceipt = acknowledgement.receipt;
    await state.save(state.state);

    const forged = JSON.parse(await readFile(pathname, "utf8"));
    forged.cameraCalibrationAcknowledgementReceipt.terminalReportSha256 = "f".repeat(64);
    if (forged.cameraCalibrationAcknowledgementReceipt.terminalReportSha256
      === acknowledgement.receipt.terminalReportSha256) {
      forged.cameraCalibrationAcknowledgementReceipt.terminalReportSha256 = "e".repeat(64);
    }
    await writeFile(pathname, `${JSON.stringify(forged, null, 2)}\n`);

    const recovered = new NodeStateStore(pathname);
    const restored = await recovered.initialize();
    assert.equal(restored.cameraCalibrationAcknowledgementReceipt, null);
    assert.deepEqual(restored.cameraCalibration.projectPatch, calibration.projectPatch);
    assert.equal(restored.stateRecoverySafetyLock?.status, "active");
    assert.equal(restored.stateRecoverySafetyLock?.reason.code, "NODE_STATE_LKG_RECOVERY");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
