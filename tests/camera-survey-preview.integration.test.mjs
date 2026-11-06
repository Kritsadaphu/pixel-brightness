import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PixelBrightnessNode } from "../runtime/node/daemon.mjs";
import { encodeCameraSurveyPreviewPng } from "../runtime/node/camera-survey-preview.mjs";
import { createPixelBrightnessServer } from "../runtime/server/server.mjs";
import { createNodeCredential } from "../runtime/shared/node-auth.mjs";
import { createCameraLensProfile } from "../runtime/shared/camera-lens-profile.mjs";
import { COMMAND, createCommand, defaultProject } from "../runtime/shared/protocol.mjs";
import { normalizeCameraSurveyPreviewCommand } from "../runtime/shared/camera-survey-preview.mjs";
import { epochNowNs } from "../runtime/shared/timecore.mjs";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "camera-helper-fixture.mjs");

let executionLeaseCounter = 0;
function executionLease(nodeId, ttlMs = 5_000) {
  const issuedAtNs = epochNowNs();
  executionLeaseCounter += 1;
  return {
    schemaVersion: 1,
    leaseId: `execution_lease_${executionLeaseCounter.toString(16).padStart(32, "0")}`,
    nodeId,
    fenceGeneration: 0,
    issuedAtNs: issuedAtNs.toString(),
    expiresAtNs: (issuedAtNs + BigInt(ttlMs) * 1_000_000n).toString(),
  };
}

function lensProfile() {
  return createCameraLensProfile({
    schema: "pixel-brightness.camera-lens-profile.v1",
    camera: { manufacturer: "Sony", model: "ILCE-7M4", serialNumber: "FIXTURE-001" },
    lens: {
      manufacturer: "Sony",
      model: "FE 16-35mm F2.8 GM II",
      serialNumber: "FIXTURE-LENS-001",
    },
    frame: { width: 32, height: 32 },
    capture: { focalLengthMm: 16, focusDistanceM: 5, apertureFNumber: 5.6 },
    intrinsics: { fx: 24, fy: 24, cx: 16, cy: 16 },
    distortion: { model: "brown-conrady-v1", k1: -0.03, k2: 0.002, k3: 0, p1: 0, p2: 0 },
    calibration: {
      method: "opencv-charuco-brown-conrady-v1",
      calibratedAt: "2026-08-01T00:00:00.000Z",
      rmsResidualPx: 0.18,
      maxResidualPx: 0.55,
      imageCount: 32,
    },
  });
}

function cameraSettings() {
  return {
    exposureMode: "manual",
    iso: 100,
    apertureF: 5.6,
    shutterUs: 16_667,
    whiteBalance: { mode: "kelvin", kelvin: 5_600 },
    focusMode: "manual",
    captureFormat: "linear-rgb",
  };
}

function artifactForFrame(width = 32, height = 32) {
  const data = new Float32Array(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 3] = (index % width) / (width - 1);
    data[index * 3 + 1] = Math.floor(index / width) / (height - 1);
    data[index * 3 + 2] = 0.25;
  }
  return encodeCameraSurveyPreviewPng({ width, height, pixelFormat: "linear-rgb-f32", data });
}

function completedReport(request, artifact = artifactForFrame()) {
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    nodeId: request.nodeId,
    cameraViewId: request.cameraViewId,
    lensProfileSha256: request.lensProfile.sha256,
    status: "complete",
    capturedAt: "2026-08-24T00:00:00.000Z",
    completedAt: "2026-08-24T00:00:01.000Z",
    frame: { width: 32, height: 32, pixelFormat: "linear-rgb-f32" },
    camera: { id: "sony-a7iv-fixture", vendor: "Sony", model: "ILCE-7M4", serial: "FIXTURE-001" },
    lens: {
      id: "fixture-lens",
      vendor: "Sony",
      model: "FE 16-35mm F2.8 GM II",
      serial: "FIXTURE-LENS-001",
      focalLengthMm: 16,
      apertureF: 5.6,
      focusDistanceM: 5,
      focusLocked: true,
      zoomLocked: true,
      stabilization: "off",
    },
    pipeline: {
      captureMode: "single-shot",
      shutterMode: "efcs",
      rawEncoding: "lossless-compressed",
      sourcePixelFormat: "ARW-14",
      retainedPixelFormat: "linear-rgb-f32",
      bitDepth: 14,
      linearized: true,
      blackLevelSubtracted: false,
      whiteBalanceApplied: false,
      toneCurveApplied: false,
      noiseReductionApplied: false,
      lensCorrectionsApplied: false,
    },
    source: {
      kind: "single-shot-linear-raw-decode-v1",
      rawFormat: "ARW",
      sourceBitDepth: 14,
      sourceSha256: "a".repeat(64),
      rasterSha256: "b".repeat(64),
      decoder: { name: "fixture", version: "1" },
    },
    artifact,
  };
}

async function responseJson(response) {
  return { response, body: await response.json() };
}

test("authenticated Server queues one bound preview command and serves only verified PNG bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-camera-survey-preview-server-"));
  const token = "survey-preview-test-token";
  const nodeSigningKey = "survey-preview-node-signing-key-00000001";
  const nodeToken = createNodeCredential("survey-node", nodeSigningKey);
  const server = await createPixelBrightnessServer({
    dataDir: root,
    controlToken: token,
    nodeSigningKey,
    offlineAfterMs: 60_000,
  });
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await server.control.register({
      protocolVersion: 1,
      nodeId: "survey-node",
      capabilities: {
        outputs: [{ id: "A", connector: "DP-1" }],
        camera: { backend: "sony-sdk", helperConfigured: true, linearRawCapture: true },
      },
    });
    const requestBody = {
      nodeId: "survey-node",
      cameraId: "sony-a7iv-fixture",
      cameraViewId: "north-wall-fixed-view",
      lensProfile: lensProfile(),
      cameraSettings: cameraSettings(),
    };

    const unauthorized = await fetch(`${baseUrl}/v1/calibrations/camera/survey-previews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    assert.equal(unauthorized.status, 401);

    const started = await responseJson(await fetch(`${baseUrl}/v1/calibrations/camera/survey-previews`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    }));
    assert.equal(started.response.status, 202);
    assert.equal(started.body.command.type, COMMAND.CAPTURE_CAMERA_SURVEY_PREVIEW);
    assert.equal(started.body.preview.frame.width, 32);
    const requestId = started.body.preview.requestId;
    const queued = server.store.state.commandQueues["survey-node"].find((command) => command.id === started.body.command.id);
    assert.equal(queued.payload.lensProfile.sha256, requestBody.lensProfile.sha256);
    assert.deepEqual(queued.payload.limits, {
      maxPixels: 1_024,
      maxWidth: 32,
      maxHeight: 32,
      maxRawBytes: 12_288,
      preferredPixelFormat: "linear-rgb-f32",
    });

    const report = completedReport(queued.payload);
    const badHash = await responseJson(await fetch(
      `${baseUrl}/v1/nodes/survey-node/camera-survey-previews/${encodeURIComponent(requestId)}/result`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${nodeToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          ...report,
          artifact: { ...report.artifact, sha256: "0".repeat(64) },
        }),
      },
    ));
    assert.equal(badHash.response.status, 400);
    assert.equal(badHash.body.error.code, "camera_survey_preview_hash_mismatch");

    const completed = await responseJson(await fetch(
      `${baseUrl}/v1/nodes/survey-node/camera-survey-previews/${encodeURIComponent(requestId)}/result`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${nodeToken}`, "content-type": "application/json" },
        body: JSON.stringify(report),
      },
    ));
    assert.equal(completed.response.status, 200);
    assert.equal(completed.body.acknowledgedCameraSurveyPreviewId, requestId);
    assert.equal(completed.body.preview.report.artifact.dataBase64, undefined);

    const artifactPath = `/v1/calibrations/camera/survey-previews/${encodeURIComponent(requestId)}/artifact`;
    assert.equal((await fetch(`${baseUrl}${artifactPath}`)).status, 401);
    const artifactResponse = await fetch(`${baseUrl}${artifactPath}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(artifactResponse.status, 200);
    const artifactBytes = Buffer.from(await artifactResponse.arrayBuffer());
    assert.equal(createHash("sha256").update(artifactBytes).digest("hex"), report.artifact.sha256);
    assert.equal(artifactResponse.headers.get("x-content-sha256"), report.artifact.sha256);
  } finally {
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("survey result committed before a lost response survives the later exact command dead letter", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-camera-survey-preview-ambiguous-success-"));
  let server = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
  try {
    const registration = await server.control.register({
      protocolVersion: 1,
      nodeId: "survey-ambiguous-node",
      capabilities: { outputs: [{ id: "A", connector: "DP-1" }] },
    });
    const started = await server.control.requestCameraSurveyPreview({
      nodeId: "survey-ambiguous-node",
      cameraId: "sony-a7iv-fixture",
      cameraViewId: "north-wall-fixed-view",
      lensProfile: lensProfile(),
      cameraSettings: cameraSettings(),
    });
    const command = server.store.state.commandQueues["survey-ambiguous-node"].find((candidate) => (
      candidate.id === started.command.id
    ));
    const report = completedReport(command.payload);
    await server.control.completeCameraSurveyPreview(
      "survey-ambiguous-node",
      started.preview.requestId,
      report,
    );
    // The result endpoint committed, but model its response as lost. Advance
    // only through the preceding registration SYNC so the capture remains the
    // exact ordered queue head when the Node later exhausts retries.
    await server.control.heartbeat("survey-ambiguous-node", {
      ackSequence: registration.commandSequence,
    });
    const firstFailedAt = new Date(Date.now() - 1_000).toISOString();
    const deadLetteredAt = new Date().toISOString();
    const deadLetterId = "command_dead_letter_55555555555555555555555555555555";
    await server.control.heartbeat("survey-ambiguous-node", {
      commandDeadLetters: [{
        schemaVersion: 1,
        deadLetterId,
        nodeId: "survey-ambiguous-node",
        command: { id: command.id, sequence: command.sequence, type: command.type },
        attempts: 2,
        retryBudget: 2,
        safetyCritical: true,
        firstFailedAt,
        lastFailedAt: deadLetteredAt,
        deadLetteredAt,
        errors: [
          { attempt: 1, failedAt: firstFailedAt, name: "Error", code: "LOST_RESULT_ACK", message: "result ack lost" },
          { attempt: 2, failedAt: deadLetteredAt, name: "Error", code: "LOST_RESULT_ACK", message: "result ack lost" },
        ],
        failClosed: { active: true, blackApplied: true, enforcementError: null },
      }],
    });
    const retained = server.store.state.cameraSurveyPreviews[started.preview.requestId];
    assert.equal(retained.status, "complete");
    assert.equal(retained.report.artifact.sha256, report.artifact.sha256);
    assert.deepEqual(
      server.store.state.commandDeadLetters["survey-ambiguous-node"][0].compensation.owner,
      { kind: "camera-survey-preview", id: started.preview.requestId, state: "complete" },
    );

    await server.close();
    server = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
    const restored = server.store.state.cameraSurveyPreviews[started.preview.requestId];
    assert.equal(restored.status, "complete");
    assert.equal(restored.report.artifact.sha256, report.artifact.sha256);
  } finally {
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent preview requests serialize against the live camera-busy state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-camera-survey-preview-race-"));
  const server = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
  try {
    await server.control.register({
      protocolVersion: 1,
      nodeId: "survey-race-node",
      capabilities: { outputs: [{ id: "A", connector: "DP-1" }] },
    });
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const enteredGate = new Promise((resolve) => { entered = resolve; });
    const blocker = server.store.transaction(async () => {
      entered();
      await gate;
    });
    await enteredGate;

    const request = {
      nodeId: "survey-race-node",
      cameraId: "sony-a7iv-fixture",
      cameraViewId: "north-wall-fixed-view",
      lensProfile: lensProfile(),
      cameraSettings: cameraSettings(),
    };
    const first = server.control.requestCameraSurveyPreview(request);
    const second = server.control.requestCameraSurveyPreview(request);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await blocker;

    const outcomes = await Promise.allSettled([first, second]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    assert.equal(rejected.reason.status, 409);
    assert.equal(rejected.reason.code, "camera_survey_preview_camera_busy");
    assert.equal(Object.values(server.store.state.cameraSurveyPreviews).length, 1);
    assert.equal(server.store.state.commandQueues["survey-race-node"].filter(
      (command) => command.type === COMMAND.CAPTURE_CAMERA_SURVEY_PREVIEW,
    ).length, 1);
  } finally {
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("Server converts a late complete survey report to failed after a fleet fence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-camera-survey-preview-fenced-complete-"));
  const server = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
  try {
    const registrations = {};
    for (const nodeId of ["survey-fence-a", "survey-fence-b"]) {
      registrations[nodeId] = await server.control.register({
        protocolVersion: 1,
        nodeId,
        capabilities: { outputs: [] },
      });
      await server.control.heartbeat(nodeId, { ackSequence: registrations[nodeId].commandSequence });
    }
    await server.control.prepare({ nodeIds: ["survey-fence-a", "survey-fence-b"], baseFrame: "0" });
    for (const nodeId of ["survey-fence-a", "survey-fence-b"]) {
      await server.control.heartbeat(nodeId, {
        ackSequence: server.store.state.timeline.prepareSequences[nodeId],
      });
    }
    await server.control.play({
      nodeIds: ["survey-fence-a", "survey-fence-b"],
      baseFrame: "0",
      delayMs: 10_000,
    });
    const started = await server.control.requestCameraSurveyPreview({
      nodeId: "survey-fence-b",
      cameraId: "sony-a7iv-fixture",
      cameraViewId: "north-wall-fixed-view",
      lensProfile: lensProfile(),
      cameraSettings: cameraSettings(),
    });
    const play = server.store.state.commandQueues["survey-fence-a"]
      .find((command) => command.type === COMMAND.PLAY_AT);
    const failedAt = new Date().toISOString();
    await server.control.heartbeat("survey-fence-a", {
      commandDeadLetters: [{
        schemaVersion: 1,
        deadLetterId: "command_dead_letter_cccccccccccccccccccccccccccccccc",
        nodeId: "survey-fence-a",
        command: { id: play.id, sequence: play.sequence, type: play.type },
        attempts: 2,
        retryBudget: 2,
        safetyCritical: true,
        firstFailedAt: failedAt,
        lastFailedAt: failedAt,
        deadLetteredAt: failedAt,
        errors: [{ attempt: 2, failedAt, name: "Error", code: "POISON", message: "fixture poison" }],
        failClosed: { active: true, blackApplied: true, enforcementError: null },
      }],
    });
    const request = server.store.state.cameraSurveyPreviews[started.preview.requestId].request;
    const accepted = await server.control.completeCameraSurveyPreview(
      "survey-fence-b",
      request.requestId,
      completedReport(request),
    );
    assert.equal(accepted.preview.status, "failed");
    assert.equal(accepted.preview.failure.code, "SERVER_FAIL_CLOSED_FENCE_ACTIVE");
    const replay = await server.control.completeCameraSurveyPreview(
      "survey-fence-b",
      request.requestId,
      completedReport(request),
    );
    assert.equal(replay.preview.status, "failed");
    await server.close();
    const reopened = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
    assert.equal(reopened.store.state.cameraSurveyPreviews[request.requestId].status, "failed");
    assert.equal(reopened.store.state.cameraSurveyPreviews[request.requestId].report.error.code,
      "SERVER_FAIL_CLOSED_FENCE_ACTIVE");
    await reopened.close();
  } finally {
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("render Node executes the bounded helper request and reports a RAW-derived preview", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-camera-survey-preview-node-"));
  await chmod(fixture, 0o755);
  const project = defaultProject();
  const request = normalizeCameraSurveyPreviewCommand({
    schemaVersion: 1,
    requestId: "camera-survey-preview-node-001",
    nodeId: "survey-preview-node",
    cameraId: "sony-a7iv-fixture",
    cameraViewId: "north-wall-fixed-view",
    lensProfile: lensProfile(),
    cameraSettings: cameraSettings(),
  });
  const command = createCommand(COMMAND.CAPTURE_CAMERA_SURVEY_PREVIEW, request, { sequence: 1 });
  let commandSent = false;
  let aborted = false;
  let submitted = null;
  const fakeClient = {
    time: async () => ({ serverTimeNs: epochNowNs().toString() }),
    register: async () => ({
      protocolVersion: 1,
      node: { ackSequence: 0, commandSequence: 1 },
      commandSequence: 1,
      executionLease: executionLease("survey-preview-node"),
      project,
    }),
    state: async () => ({ timeline: { status: "idle", targetNodeIds: [] }, media: [] }),
    heartbeat: async () => ({
      serverTimeNs: epochNowNs().toString(),
      failClosedFence: null,
      executionLease: executionLease("survey-preview-node"),
      acknowledgedActionResultIds: [],
    }),
    pollCommands: async () => {
      if (!commandSent) {
        commandSent = true;
        return {
          protocolVersion: 1,
          failClosedFence: null,
          executionLease: executionLease("survey-preview-node"),
          commands: [command],
        };
      }
      while (!aborted) await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("aborted");
    },
    submitCameraSurveyPreview: async (requestId, report) => {
      submitted = { requestId, report };
      return { acknowledgedCameraSurveyPreviewId: requestId };
    },
    assetUrl: (sha256) => `/v1/assets/${sha256}`,
    download: async () => { throw new Error("unexpected download"); },
    abort: () => { aborted = true; },
  };
  const config = {
    nodeId: "survey-preview-node",
    name: "Survey Preview Node",
    version: "0.3.0",
    serverUrl: "http://127.0.0.1:4100",
    dataDir: directory,
    outputs: [{ id: "A", connector: "DP-1" }],
    heartbeatMs: 25,
    hostTelemetryMs: 1_000,
    clockSyncMs: 5_000,
    clockSyncRounds: 3,
    pollWaitMs: 25,
    requestTimeoutMs: 500,
    maxAssetBytes: 1_000_000,
    cameraBackend: "sony-sdk",
    cameraHelperCommand: fixture,
    cameraCaptureDir: join(directory, "camera-captures"),
    cameraExpectedModel: "ILCE-7M4",
    cameraHelperTimeoutMs: 5_000,
    logLevel: "error",
    nodeToken: null,
  };
  const hostTelemetryCollector = {
    collect: async ({ renderer }) => ({ schemaVersion: 2, host: { hostname: "survey-node" }, renderer }),
  };
  const node = new PixelBrightnessNode(config, { hostTelemetryCollector });
  node.client = fakeClient;
  node.cache.client = fakeClient;
  try {
    await node.start();
    const deadline = Date.now() + 3_000;
    while (!submitted && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(submitted, "Node did not submit its survey-preview report");
    assert.equal(submitted.requestId, request.requestId);
    assert.equal(submitted.report.status, "complete", JSON.stringify(submitted.report.error || null));
    assert.equal(submitted.report.lensProfileSha256, request.lensProfile.sha256);
    assert.equal(submitted.report.source.kind, "single-shot-linear-raw-decode-v1");
    assert.equal(submitted.report.spatialTransform, "none-raw-sensor-raster-v1");
    assert.equal(submitted.report.pipeline.lensCorrectionsApplied, false);
    assert.equal(submitted.report.artifact.mimeType, "image/png");
    const artifactBytes = Buffer.from(submitted.report.artifact.dataBase64, "base64");
    assert.equal(artifactBytes.byteLength, submitted.report.artifact.byteLength);
    assert.equal(createHash("sha256").update(artifactBytes).digest("hex"), submitted.report.artifact.sha256);
  } finally {
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("survey helper completion after execution-epoch loss cannot persist or submit a terminal report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-camera-survey-preview-authority-loss-"));
  await chmod(fixture, 0o755);
  const previousDelay = process.env.PB_FIXTURE_SURVEY_DELAY_MS;
  process.env.PB_FIXTURE_SURVEY_DELAY_MS = "250";
  const nodeId = "survey-preview-authority-loss";
  const project = defaultProject();
  const request = normalizeCameraSurveyPreviewCommand({
    schemaVersion: 1,
    requestId: "camera-survey-preview-authority-loss-001",
    nodeId,
    cameraId: "sony-a7iv-fixture",
    cameraViewId: "north-wall-fixed-view",
    lensProfile: lensProfile(),
    cameraSettings: cameraSettings(),
  });
  const command = createCommand(COMMAND.CAPTURE_CAMERA_SURVEY_PREVIEW, request, { sequence: 1 });
  let commandSent = false;
  let aborted = false;
  let submitted = null;
  const fakeClient = {
    time: async () => ({ serverTimeNs: epochNowNs().toString() }),
    register: async () => ({
      protocolVersion: 1,
      node: { ackSequence: 0, commandSequence: 1, failClosedFence: null },
      commandSequence: 1,
      executionLease: executionLease(nodeId, 80),
      project,
    }),
    state: async () => ({ timeline: { status: "idle", targetNodeIds: [] }, media: [] }),
    heartbeat: async () => {
      if (commandSent) throw new Error("simulated survey lease-renewal partition");
      return {
        serverTimeNs: epochNowNs().toString(),
        failClosedFence: null,
        executionLease: executionLease(nodeId, 80),
        acknowledgedActionResultIds: [],
      };
    },
    pollCommands: async () => {
      if (!commandSent) {
        commandSent = true;
        return {
          protocolVersion: 1,
          commandSequence: 1,
          failClosedFence: null,
          executionLease: executionLease(nodeId, 80),
          commands: [command],
        };
      }
      while (!aborted) await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("aborted");
    },
    submitCameraSurveyPreview: async (requestId, report) => {
      submitted = { requestId, report };
      return { acknowledgedCameraSurveyPreviewId: requestId };
    },
    assetUrl: (sha256) => `/v1/assets/${sha256}`,
    download: async () => { throw new Error("unexpected download"); },
    abort: () => { aborted = true; },
  };
  const config = {
    nodeId,
    name: "Survey Preview Authority Loss Node",
    version: "0.3.0",
    serverUrl: "http://127.0.0.1:4100",
    dataDir: directory,
    outputs: [{ id: "A", connector: "DP-1" }],
    heartbeatMs: 20,
    hostTelemetryMs: 1_000,
    clockSyncMs: 5_000,
    clockSyncRounds: 3,
    pollWaitMs: 20,
    requestTimeoutMs: 500,
    maxAssetBytes: 1_000_000,
    cameraBackend: "sony-sdk",
    cameraHelperCommand: fixture,
    cameraCaptureDir: join(directory, "camera-captures"),
    cameraExpectedModel: "ILCE-7M4",
    cameraHelperTimeoutMs: 5_000,
    logLevel: "error",
    nodeToken: null,
  };
  const hostTelemetryCollector = {
    collect: async ({ renderer }) => ({ schemaVersion: 2, host: { hostname: "survey-node" }, renderer }),
  };
  const node = new PixelBrightnessNode(config, { hostTelemetryCollector });
  node.client = fakeClient;
  node.cache.client = fakeClient;
  try {
    await node.start();
    const deadline = Date.now() + 3_000;
    while (!node.executionLeaseExpired && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(node.executionLeaseExpired, true);
    assert.equal(submitted, null,
      "a helper result which crossed its authority epoch must never reach the completion endpoint");
    assert.equal(node.diagnostics().ackSequence, 0);
    assert.equal(node.store.snapshot().cameraSurveyPreviewReport, null);
    assert.equal(node.diagnostics().metrics.commandFailures, 0);
  } finally {
    await node.stop().catch(() => {});
    if (previousDelay == null) delete process.env.PB_FIXTURE_SURVEY_DELAY_MS;
    else process.env.PB_FIXTURE_SURVEY_DELAY_MS = previousDelay;
    await rm(directory, { recursive: true, force: true });
  }
});
