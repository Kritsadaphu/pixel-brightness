import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { encodeCameraSurveyPreviewPng } from "../runtime/node/camera-survey-preview.mjs";
import {
  CameraCalibrationOrchestrator,
  DeterministicPatternOverrideAdapter,
  DeterministicSimulatedCameraAdapter,
  MeasuredCalibrationSolver,
  materializeMeasuredCalibrationProjectPatch,
} from "../runtime/node/camera-calibration.mjs";
import { createPixelBrightnessServer } from "../runtime/server/server.mjs";
import { createCameraLensProfile } from "../runtime/shared/camera-lens-profile.mjs";
import { createNodeCredential } from "../runtime/shared/node-auth.mjs";
import { COMMAND } from "../runtime/shared/protocol.mjs";

const TOKEN = "camera-bundle-api-test-token";
const NODE_SIGNING_KEY = "camera-bundle-node-signing-key-000000001";
const NODE_TOKEN = createNodeCredential("bundle-node", NODE_SIGNING_KEY);

class MeasuredSonyFixtureCameraAdapter extends DeterministicSimulatedCameraAdapter {
  constructor(now) {
    super({ width: 64, height: 64, cameraId: "sony-a7iv-fixture", now });
    this.camera = {
      ...this.camera,
      vendor: "Sony",
      model: "ILCE-7M4",
      serial: "FIXTURE-001",
      transport: "usb",
      backend: "test-physical-raw-fixture",
    };
  }

  async capture(context) {
    const capture = await super.capture(context);
    const rasterBytes = Buffer.from(capture.data.buffer, capture.data.byteOffset, capture.data.byteLength);
    const rasterSha256 = createHash("sha256").update(rasterBytes).digest("hex");
    capture.lens = {
      ...capture.lens,
      id: "fixture-lens",
      vendor: "Sony",
      model: "FE 16-35mm F2.8 GM II",
      serial: "FIXTURE-LENS-001",
      mount: "E",
      focalLengthMm: 16,
      focusDistanceM: 5,
    };
    capture.rasterSha256 = rasterSha256;
    capture.provenance = {
      decoder: {
        name: "fixture-decoder",
        version: "1.0.0",
        binarySha256: createHash("sha256").update("fixture-decoder-binary-v1").digest("hex"),
      },
      rawDecode: {
        rawFormat: "PBRAW",
        sensorWidth: capture.width,
        sensorHeight: capture.height,
        cfaPattern: "RGGB",
        blackLevels: [0, 0, 0, 0],
        whiteLevels: [4_294_967_295, 4_294_967_295, 4_294_967_295, 4_294_967_295],
      },
      sourceSha256: createHash("sha256")
        .update(`fixture-physical-raw:${capture.id}:`)
        .update(rasterBytes)
        .digest("hex"),
      rasterSha256,
    };
    return capture;
  }
}

function monotonicEvidenceClock() {
  let index = 0;
  const base = Date.now() + 1_000;
  return () => new Date(base + index++ * 1_000).toISOString();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function correctionBinding(calibrations) {
  const manifestsByOutput = new Map(calibrations.flatMap((calibration) => (
    calibration.manifest.outputs.map((output) => [output.outputId, output])
  )));
  const payload = {
    schemaVersion: 1,
    algorithm: "sha256",
    configSha256: createHash("sha256").update("bundle-renderer-config").digest("hex"),
    outputs: ["A", "C"].map((id) => {
      const artifacts = manifestsByOutput.get(id).artifacts;
      return {
        id,
        processingBypass: false,
        artifacts: {
          warpMeshSha256: artifacts.warp.sha256,
          blendMapSha256: artifacts.blendWeight.sha256,
          blackMapSha256: artifacts.blackPedestal.sha256,
          maskSha256: artifacts.mask.sha256,
          colorLutSha256: artifacts.lut.sha256,
        },
      };
    }),
  };
  return {
    ...payload,
    fingerprint: createHash("sha256").update(canonicalJson(payload)).digest("hex"),
  };
}

async function solveBundleMember(server, calibration, project, artifactRoot, now) {
  const requestOperatorConfirmation = async ({ step }) => {
    const confirmationId = `confirmation:${step.confirmationLeaseId || step.id}`;
    const requestedAt = new Date().toISOString();
    await server.control.heartbeat(calibration.nodeId, {
      protocolVersion: 1,
      status: "ready",
      cameraCalibration: {
        sessionId: calibration.sessionId,
        state: "capturing",
        completedSteps: Math.max(0, step.sequence),
        stepIndex: step.sequence,
        operatorPrompt: {
          state: "waiting",
          stepId: step.id,
          confirmationId,
          title: "Fixture physical confirmation",
          instructions: step.captureConditions.operatorPrompt,
          conditions: [
            `projectorState:${step.captureConditions.projectorState}`,
            `opticalPath:${step.captureConditions.opticalPath}`,
            `otherProjectors:${step.captureConditions.otherProjectors}`,
          ],
          requestedAt,
          confirmedAt: null,
        },
      },
    });
    const confirmed = await server.control.confirmCameraCalibration(calibration.sessionId, {
      confirmed: true,
      stepId: step.id,
      confirmationId,
    });
    const confirmedAt = confirmed.command.payload.confirmedAt;
    return {
      confirmed: true,
      stepId: step.id,
      confirmationId,
      confirmedAt,
      conditionVerification: {
        projectorState: step.captureConditions.projectorState,
        opticalPath: step.captureConditions.opticalPath,
        otherProjectors: step.captureConditions.otherProjectors,
        method: "test-operator-confirmation",
        verifiedAt: confirmedAt,
        confirmationLeaseId: step.confirmationLeaseId || null,
        confirmationId,
      },
    };
  };
  const result = await new CameraCalibrationOrchestrator({
    cameraAdapter: new MeasuredSonyFixtureCameraAdapter(now),
    patternAdapter: new DeterministicPatternOverrideAdapter(),
    solver: new MeasuredCalibrationSolver({ artifactRoot }),
    requestOperatorConfirmation,
    now,
  }).run(calibration.plan);
  const projectPatch = await materializeMeasuredCalibrationProjectPatch({
    manifest: result.manifest,
    project,
    artifactRoot,
  });
  return {
    sessionId: calibration.sessionId,
    state: "complete",
    completedSteps: calibration.plan.steps.length,
    stepIndex: calibration.plan.steps.length - 1,
    camera: result.manifest.camera,
    startedAt: result.manifest.startedAt,
    completedAt: result.manifest.completedAt,
    manifest: result.manifest,
    projectPatch,
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
    frame: { width: 64, height: 64 },
    capture: { focalLengthMm: 16, focusDistanceM: 5, apertureFNumber: 5.6 },
    intrinsics: { fx: 48, fy: 48, cx: 32, cy: 32 },
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

function artifactForFrame(variant) {
  const width = 64;
  const height = 64;
  const data = new Float32Array(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 3] = (index % width) / (width - 1);
    data[index * 3 + 1] = Math.floor(index / width) / (height - 1);
    data[index * 3 + 2] = variant;
  }
  return encodeCameraSurveyPreviewPng({ width, height, pixelFormat: "linear-rgb-f32", data });
}

function completedReport(request, artifact) {
  const capturedAt = new Date(Date.now() - 1_000).toISOString();
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    nodeId: request.nodeId,
    cameraViewId: request.cameraViewId,
    lensProfileSha256: request.lensProfile.sha256,
    status: "complete",
    capturedAt,
    completedAt: new Date(Date.now() - 500).toISOString(),
    frame: { width: 64, height: 64, pixelFormat: "linear-rgb-f32" },
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
      sourceSha256: artifact.sha256,
      rasterSha256: artifact.sha256,
      decoder: { name: "fixture", version: "1" },
    },
    artifact,
  };
}

async function jsonRequest(baseUrl, path, {
  method = "GET",
  body,
  ifMatch,
  authorized = true,
} = {}) {
  const headers = {};
  if (authorized) headers.authorization = `Bearer ${path.startsWith("/v1/nodes/") ? NODE_TOKEN : TOKEN}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (ifMatch !== undefined) headers["if-match"] = String(ifMatch);
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, body: await response.json() };
}

async function createCompletedPreview(server, baseUrl, cameraViewId, variant) {
  const started = await jsonRequest(baseUrl, "/v1/calibrations/camera/survey-previews", {
    method: "POST",
    body: {
      nodeId: "bundle-node",
      cameraId: "sony-a7iv-fixture",
      cameraViewId,
      lensProfile: lensProfile(),
      cameraSettings: cameraSettings(),
    },
  });
  assert.equal(started.response.status, 202);
  const requestId = started.body.preview.requestId;
  const command = server.store.state.commandQueues["bundle-node"]
    .find((candidate) => candidate.id === started.body.command.id);
  const completed = await jsonRequest(
    baseUrl,
    `/v1/nodes/bundle-node/camera-survey-previews/${encodeURIComponent(requestId)}/result`,
    { method: "POST", body: completedReport(command.payload, artifactForFrame(variant)) },
  );
  assert.equal(completed.response.status, 200);
  return requestId;
}

function bundleRequest(previewIds) {
  const boundary = [
    { x: 0.05, y: 0.05 }, { x: 0.95, y: 0.05 },
    { x: 0.95, y: 0.95 }, { x: 0.05, y: 0.95 },
  ];
  return {
    expectedOutputIds: ["A", "C"],
    members: [
      {
        memberId: "north-view",
        previewId: previewIds[0],
        outputIds: ["A"],
        survey: { id: "north-survey", wallId: "wall-north", boundary },
        artifactSha256: "0".repeat(64),
        authenticatedAt: "2099-01-01T00:00:00.000Z",
      },
      {
        memberId: "east-view",
        previewId: previewIds[1],
        outputIds: ["C"],
        survey: { id: "east-survey", wallId: "wall-east", boundary },
        artifactSha256: "0".repeat(64),
        authenticatedAt: "2099-01-01T00:00:00.000Z",
      },
    ],
    sameWallOverlaps: [],
    physicalAdjacencies: [{
      id: "north-east-seam",
      wallIds: ["wall-north", "wall-east"],
      outputIds: ["A", "C"],
    }],
  };
}

test("Server owns authenticated multi-view bundle creation, binding and persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-camera-bundle-api-"));
  let server = await createPixelBrightnessServer({
    dataDir: root,
    controlToken: TOKEN,
    nodeSigningKey: NODE_SIGNING_KEY,
    offlineAfterMs: 60_000,
  });
  try {
    let address = await server.listen({ host: "127.0.0.1", port: 0 });
    let baseUrl = `http://127.0.0.1:${address.port}`;
    await server.control.register({
      protocolVersion: 1,
      nodeId: "bundle-node",
      capabilities: {
        outputs: [
          { id: "A", connector: "DP-1" },
          { id: "C", connector: "DP-3" },
        ],
        camera: { backend: "sony-sdk", helperConfigured: true, linearRawCapture: true },
      },
    });

    const initialProject = server.control.getProject();
    const project = {
      ...initialProject,
      canvas: { ...initialProject.canvas, width: 128, height: 64 },
      compositionSource: {
        ...initialProject.compositionSource,
        width: 128,
        height: 64,
      },
      walls: [
        { id: "wall-north", name: "North wall" },
        { id: "wall-east", name: "East wall" },
      ],
      outputs: initialProject.outputs
        .filter((output) => ["A", "C"].includes(output.id))
        .map((output) => ({
          ...output,
          nodeId: "bundle-node",
          wallId: output.id === "A" ? "wall-north" : "wall-east",
          resolution: { ...output.resolution, width: 64, height: 64 },
          sourceViewport: {
            x: output.id === "A" ? 0 : 64,
            y: 0,
            width: 64,
            height: 64,
          },
          overlap: { left: 0, right: 0, top: 0, bottom: 0 },
        })),
    };
    const saved = await jsonRequest(baseUrl, "/v1/projects/default", {
      method: "POST",
      ifMatch: initialProject.revision,
      body: project,
    });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
    const baseRevision = saved.body.project.revision;

    const previewIds = [
      await createCompletedPreview(server, baseUrl, "north-wall-fixed-view", 0.2),
      await createCompletedPreview(server, baseUrl, "east-wall-fixed-view", 0.8),
    ];
    const request = bundleRequest(previewIds);
    const unauthorized = await jsonRequest(baseUrl, "/v1/calibrations/camera/bundles", {
      authorized: false,
    });
    assert.equal(unauthorized.response.status, 401);
    const missingCas = await jsonRequest(baseUrl, "/v1/calibrations/camera/bundles", {
      method: "POST",
      body: request,
    });
    assert.equal(missingCas.response.status, 428);
    const staleCas = await jsonRequest(baseUrl, "/v1/calibrations/camera/bundles", {
      method: "POST",
      ifMatch: baseRevision - 1,
      body: request,
    });
    assert.equal(staleCas.response.status, 409);

    const created = await jsonRequest(baseUrl, "/v1/calibrations/camera/bundles", {
      method: "POST",
      ifMatch: baseRevision,
      body: request,
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.bundle.aggregateState, "collecting-views");
    assert.equal(created.body.bundle.currentlyApplied, false);
    assert.equal(created.body.bundle.baseProject.revision, baseRevision);
    assert.equal(created.body.bundle.currentProjectRevision, baseRevision);
    assert.equal(created.body.bundle.bundle.members[0].preview.artifactSha256,
      server.store.state.cameraSurveyPreviews[previewIds[0]].report.artifact.sha256);
    assert.notEqual(created.body.bundle.bundle.members[0].preview.artifactSha256, "0".repeat(64));
    assert.notEqual(created.body.bundle.bundle.members[0].preview.authenticatedAt, "2099-01-01T00:00:00.000Z");
    assert.match(created.body.bundle.bundle.members[0].viewCaptureId, /^viewcap_/);
    assert.notEqual(
      created.body.bundle.bundle.members[0].viewCaptureId,
      created.body.bundle.bundle.members[1].viewCaptureId,
    );
    const bundleId = created.body.bundle.bundleId;
    assert.equal(server.control.getProject().revision, baseRevision, "bundle creation must not mutate the project");

    const reused = await jsonRequest(baseUrl, "/v1/calibrations/camera/bundles", {
      method: "POST",
      ifMatch: baseRevision,
      body: request,
    });
    assert.equal(reused.response.status, 409);
    assert.equal(reused.body.error.code, "camera_calibration_bundle_preview_reused");

    await server.close();
    server = await createPixelBrightnessServer({
      dataDir: root,
      controlToken: TOKEN,
      nodeSigningKey: NODE_SIGNING_KEY,
      offlineAfterMs: 60_000,
    });
    address = await server.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${address.port}`;
    const restored = await jsonRequest(
      baseUrl,
      `/v1/calibrations/camera/bundles/${encodeURIComponent(bundleId)}`,
    );
    assert.equal(restored.response.status, 200);
    assert.equal(restored.body.bundle.bundleId, bundleId);
    assert.equal(restored.body.bundle.memberCount, 2);

    const started = await jsonRequest(
      baseUrl,
      `/v1/calibrations/camera/bundles/${encodeURIComponent(bundleId)}/members/north-view/calibration`,
      {
        method: "POST",
        body: {
          mode: "measured",
          nodeId: "forged-node",
          outputIds: ["C"],
          lensProfile: { sha256: "0".repeat(64) },
        },
      },
    );
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    assert.equal(started.body.command.type, COMMAND.START_CAMERA_CALIBRATION);
    assert.deepEqual(started.body.command.payload.plan.outputs.map((output) => output.id), ["A"]);
    assert.equal(started.body.command.payload.bundle.bundleId, bundleId);
    assert.equal(started.body.command.payload.bundle.memberId, "north-view");
    assert.equal(started.body.command.payload.bundle.cameraViewId,
      created.body.bundle.bundle.members[0].cameraViewId);
    assert.equal(started.body.command.payload.bundle.viewCaptureId,
      created.body.bundle.bundle.members[0].viewCaptureId);
    const sessionId = started.body.calibration.sessionId;
    assert.equal(server.store.state.cameraCalibrationBundles[bundleId].memberSessions["north-view"], sessionId);

    const duplicateStart = await jsonRequest(
      baseUrl,
      `/v1/calibrations/camera/bundles/${encodeURIComponent(bundleId)}/members/north-view/calibration`,
      { method: "POST", body: {} },
    );
    assert.equal(duplicateStart.response.status, 409);

    const artifactRoot = join(root, "bundle-calibration-artifacts");
    const now = monotonicEvidenceClock();
    const northReport = await solveBundleMember(
      server,
      started.body.calibration,
      server.control.getProject(),
      artifactRoot,
      now,
    );
    const confirmationCommands = server.store.state.cameraCalibrations[sessionId].confirmationCommands;
    assert.equal(confirmationCommands.length, 3, "measured V2 requires three physical confirmation leases");
    const highestConfirmationSequence = Math.max(...confirmationCommands.map((command) => command.sequence));
    const beforeRejectedEvidence = JSON.stringify(server.store.state);
    const prematureTerminal = await jsonRequest(baseUrl, "/v1/nodes/bundle-node/heartbeat", {
      method: "POST",
      body: {
        protocolVersion: 1,
        status: "ready",
        ackSequence: highestConfirmationSequence - 1,
        telemetry: { projectRevision: baseRevision },
        cameraCalibration: northReport,
      },
    });
    assert.equal(prematureTerminal.response.status, 409, JSON.stringify(prematureTerminal.body));
    assert.equal(prematureTerminal.body.error.code, "camera_calibration_confirmation_not_acknowledged");
    assert.equal(JSON.stringify(server.store.state), beforeRejectedEvidence);

    const forgedConfirmationReport = structuredClone(northReport);
    const forgedLeaseId = confirmationCommands[0].confirmationLeaseId;
    for (const capture of forgedConfirmationReport.manifest.captureProvenance.captures) {
      if (capture.conditionVerification.confirmationLeaseId === forgedLeaseId) {
        capture.conditionVerification.confirmationId = "forged-physical-confirmation";
      }
    }
    const forgedConfirmation = await jsonRequest(baseUrl, "/v1/nodes/bundle-node/heartbeat", {
      method: "POST",
      body: {
        protocolVersion: 1,
        status: "ready",
        ackSequence: server.store.state.nodes["bundle-node"].commandSequence,
        telemetry: { projectRevision: baseRevision },
        cameraCalibration: forgedConfirmationReport,
      },
    });
    assert.equal(forgedConfirmation.response.status, 409, JSON.stringify(forgedConfirmation.body));
    assert.equal(forgedConfirmation.body.error.code, "camera_calibration_confirmation_evidence_mismatch");
    assert.equal(JSON.stringify(server.store.state), beforeRejectedEvidence);

    const stagedNorth = await jsonRequest(baseUrl, "/v1/nodes/bundle-node/heartbeat", {
      method: "POST",
      body: {
        protocolVersion: 1,
        status: "ready",
        ackSequence: server.store.state.nodes["bundle-node"].commandSequence,
        telemetry: { projectRevision: baseRevision },
        cameraCalibration: northReport,
      },
    });
    assert.equal(stagedNorth.response.status, 200, JSON.stringify(stagedNorth.body));
    assert.equal(stagedNorth.body.acknowledgedCameraCalibrationId, sessionId);
    assert.equal(server.control.getProject().revision, baseRevision,
      "staging the first member must not mutate the project");
    assert.equal(
      server.store.state.cameraCalibrationBundles[bundleId].bundle.members[0].state,
      "per-view-calibrated",
    );
    assert.ok(server.store.state.cameraCalibrations[sessionId].projectPatch);

    const durableTerminalState = JSON.stringify(server.store.state);
    const terminalForgeries = [
      (report) => { report.state = "failed"; },
      (report) => { report.completedSteps -= 1; },
      (report) => { report.camera.serial = "FORGED-SERIAL"; },
      (report) => {
        report.completedAt = new Date(Date.parse(report.completedAt) + 1_000).toISOString();
      },
    ];
    for (const mutate of terminalForgeries) {
      const forgedReport = structuredClone(northReport);
      mutate(forgedReport);
      const forgedReplay = await jsonRequest(baseUrl, "/v1/nodes/bundle-node/heartbeat", {
        method: "POST",
        body: {
          protocolVersion: 1,
          status: "ready",
          telemetry: { projectRevision: baseRevision },
          cameraCalibration: forgedReport,
        },
      });
      assert.equal(forgedReplay.response.status, 409, JSON.stringify(forgedReplay.body));
      assert.equal(forgedReplay.body.error.code, "camera_calibration_terminal_replay_mismatch");
      assert.equal(JSON.stringify(server.store.state), durableTerminalState);
    }
    const calibrationBeforeExactReplay = JSON.stringify(server.store.state.cameraCalibrations[sessionId]);
    const exactReplay = await jsonRequest(baseUrl, "/v1/nodes/bundle-node/heartbeat", {
      method: "POST",
      body: {
        protocolVersion: 1,
        status: "ready",
        telemetry: { projectRevision: baseRevision },
        cameraCalibration: northReport,
      },
    });
    assert.equal(exactReplay.response.status, 200, JSON.stringify(exactReplay.body));
    assert.equal(exactReplay.body.acknowledgedCameraCalibrationId, sessionId);
    assert.equal(
      JSON.stringify(server.store.state.cameraCalibrations[sessionId]),
      calibrationBeforeExactReplay,
    );

    const eastStarted = await jsonRequest(
      baseUrl,
      `/v1/calibrations/camera/bundles/${encodeURIComponent(bundleId)}/members/east-view/calibration`,
      { method: "POST", body: { mode: "measured", mesh: { columns: 2, rows: 2 } } },
    );
    assert.equal(eastStarted.response.status, 202, JSON.stringify(eastStarted.body));
    assert.deepEqual(eastStarted.body.calibration.outputIds, ["C"]);
    const eastSessionId = eastStarted.body.calibration.sessionId;
    const eastReport = await solveBundleMember(
      server,
      eastStarted.body.calibration,
      server.control.getProject(),
      artifactRoot,
      now,
    );
    const stagedEast = await jsonRequest(baseUrl, "/v1/nodes/bundle-node/heartbeat", {
      method: "POST",
      body: {
        protocolVersion: 1,
        status: "ready",
        ackSequence: server.store.state.nodes["bundle-node"].commandSequence,
        telemetry: { projectRevision: baseRevision },
        cameraCalibration: eastReport,
      },
    });
    assert.equal(stagedEast.response.status, 200, JSON.stringify(stagedEast.body));
    assert.equal(stagedEast.body.acknowledgedCameraCalibrationId, eastSessionId);
    assert.equal(server.control.getProject().revision, baseRevision,
      "all member patches must remain staged under the frozen base");
    const stagedBundle = server.store.state.cameraCalibrationBundles[bundleId];
    assert.equal(stagedBundle.bundle.aggregateState, "per-view-calibrated");
    assert.equal(stagedBundle.bundle.finalEvidence, null);
    assert.ok(server.store.state.cameraCalibrations[eastSessionId].projectPatch);

    await server.close();
    server = await createPixelBrightnessServer({
      dataDir: root,
      controlToken: TOKEN,
      nodeSigningKey: NODE_SIGNING_KEY,
      offlineAfterMs: 60_000,
    });
    address = await server.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${address.port}`;
    assert.equal(server.control.getProject().revision, baseRevision);
    assert.ok(server.store.state.cameraCalibrations[sessionId].manifest);
    assert.ok(server.store.state.cameraCalibrations[sessionId].projectPatch);
    assert.ok(server.store.state.cameraCalibrations[eastSessionId].manifest);
    assert.ok(server.store.state.cameraCalibrations[eastSessionId].projectPatch);

    const missingCommitCas = await jsonRequest(
      baseUrl,
      `/v1/calibrations/camera/bundles/${encodeURIComponent(bundleId)}/commit`,
      { method: "POST", body: {} },
    );
    assert.equal(missingCommitCas.response.status, 428);
    const staleCommit = await jsonRequest(
      baseUrl,
      `/v1/calibrations/camera/bundles/${encodeURIComponent(bundleId)}/commit`,
      { method: "POST", ifMatch: baseRevision - 1, body: {} },
    );
    assert.equal(staleCommit.response.status, 409);

    const committed = await jsonRequest(
      baseUrl,
      `/v1/calibrations/camera/bundles/${encodeURIComponent(bundleId)}/commit`,
      { method: "POST", ifMatch: baseRevision, body: {} },
    );
    assert.equal(committed.response.status, 202, JSON.stringify(committed.body));
    assert.equal(committed.body.bundle.commit.state, "awaiting-renderer-ack");
    assert.equal(committed.body.bundle.currentlyApplied, true);
    assert.equal(committed.body.bundle.currentProjectRevision, baseRevision + 1);
    assert.equal(committed.body.bundle.rollbackSnapshot.projectRevision, baseRevision);
    assert.deepEqual(committed.body.bundle.rollbackSnapshot.outputIds, ["A", "C"]);
    const committedProject = server.control.getProject();
    assert.equal(committedProject.revision, baseRevision + 1,
      "the union of member patches must commit as exactly one revision");
    assert.deepEqual(committedProject.outputs.map((output) => output.resolution), [
      { width: 64, height: 64, refreshNum: 60, refreshDen: 1 },
      { width: 64, height: 64, refreshNum: 60, refreshDen: 1 },
    ]);
    for (const output of committedProject.outputs) {
      assert.equal(output.blend.map.width, 64);
      assert.equal(output.blend.map.height, 64);
      assert.equal(output.blackUniformity.map.width, 64);
      assert.equal(output.blackUniformity.map.height, 64);
    }
    assert.equal(server.store.state.cameraCalibrations[sessionId].preApplyOutputs, null);
    assert.equal(
      server.store.state.cameraCalibrations[sessionId].bundleRollbackSnapshotId,
      committed.body.bundle.rollbackSnapshot.id,
    );
    const bundleSyncCommands = server.store.state.commandQueues["bundle-node"]
      .filter((command) => command.type === COMMAND.SYNC_PROJECT
        && command.payload.reason === "camera-calibration-bundle");
    assert.equal(bundleSyncCommands.length, 1);
    assert.equal(bundleSyncCommands[0].payload.revision, baseRevision + 1);

    await server.store.flush();
    const commitProbeRoot = join(root, "strict-commit-probe");
    await mkdir(commitProbeRoot, { recursive: true });
    await writeFile(
      join(commitProbeRoot, "state.json"),
      await readFile(join(root, "state.json"), "utf8"),
      "utf8",
    );
    const strictCommitProbe = await createPixelBrightnessServer({
      dataDir: commitProbeRoot,
      controlToken: TOKEN,
      nodeSigningKey: NODE_SIGNING_KEY,
      offlineAfterMs: 60_000,
    });
    await strictCommitProbe.close();

    await server.close();
    server = await createPixelBrightnessServer({
      dataDir: root,
      controlToken: TOKEN,
      nodeSigningKey: NODE_SIGNING_KEY,
      offlineAfterMs: 60_000,
    });
    address = await server.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${address.port}`;
    assert.equal(
      server.store.state.cameraCalibrationBundles[bundleId].commit.state,
      "awaiting-renderer-ack",
      "an atomic bundle commit and rollback snapshot must survive strict hydration",
    );

    const duplicateCommit = await jsonRequest(
      baseUrl,
      `/v1/calibrations/camera/bundles/${encodeURIComponent(bundleId)}/commit`,
      { method: "POST", ifMatch: baseRevision, body: {} },
    );
    assert.equal(duplicateCommit.response.status, 409);
    const projectEditDuringAck = await jsonRequest(baseUrl, "/v1/projects/default", {
      method: "POST",
      ifMatch: baseRevision + 1,
      body: committedProject,
    });
    assert.equal(projectEditDuringAck.response.status, 409);
    assert.equal(projectEditDuringAck.body.error.code, "camera_calibration_bundle_commit_busy");

    const calibrations = [sessionId, eastSessionId]
      .map((id) => server.store.state.cameraCalibrations[id]);
    const rendererBinding = correctionBinding(calibrations);
    const rendererAck = await jsonRequest(baseUrl, "/v1/nodes/bundle-node/heartbeat", {
      method: "POST",
      body: {
        protocolVersion: 1,
        status: "ready",
        telemetry: {
          projectRevision: baseRevision + 1,
          renderer: {
            projectRevision: baseRevision + 1,
            ready: true,
            connected: true,
            correctionBindingMatches: true,
            activeCorrectionFingerprint: rendererBinding.fingerprint,
            activeCorrectionBinding: rendererBinding,
          },
        },
      },
    });
    assert.equal(rendererAck.response.status, 200, JSON.stringify(rendererAck.body));
    const acknowledgedBundle = server.control.getCameraCalibrationBundle(bundleId).bundle;
    assert.equal(acknowledgedBundle.commit.state, "renderer-acknowledged");
    assert.equal(acknowledgedBundle.bundle.finalEvidence.projectRevision, baseRevision + 1);
    assert.equal(
      acknowledgedBundle.bundle.finalEvidence.rendererCorrectionFingerprint,
      rendererBinding.fingerprint,
    );
    assert.equal(acknowledgedBundle.bundle.aggregateState, "per-view-calibrated");
    assert.equal(acknowledgedBundle.currentlyApplied, true);

    const forgedPassedAdjacency = await jsonRequest(
      baseUrl,
      `/v1/calibrations/camera/bundles/${encodeURIComponent(bundleId)}`
        + "/adjacencies/north-east-seam/observations",
      { method: "POST", body: { status: "passed", previewId: previewIds[0] } },
    );
    assert.equal(forgedPassedAdjacency.response.status, 409);
    assert.equal(
      forgedPassedAdjacency.body.error.code,
      "camera_calibration_bundle_adjacency_pass_requires_verifier",
    );

    const unsafeLegacyVerification = await jsonRequest(
      baseUrl,
      `/v1/calibrations/camera/${encodeURIComponent(sessionId)}/verification`,
      { method: "POST", body: {} },
    );
    assert.equal(unsafeLegacyVerification.response.status, 409);
    assert.equal(
      unsafeLegacyVerification.body.error.code,
      "camera_calibration_bundle_verification_wiring_required",
    );

    await server.store.flush();
    const validState = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    await server.close();
    for (const scenario of [
      {
        name: "forged-optical-state",
        mutate(state) {
          state.cameraCalibrations[sessionId].opticalVerification.state = "verified";
        },
      },
      {
        name: "forged-current-application",
        mutate(state) {
          state.cameraCalibrations[sessionId].currentlyApplied = false;
        },
      },
      {
        name: "forged-renderer-ack",
        mutate(state) {
          state.cameraCalibrations[sessionId].rendererAcknowledged = false;
        },
      },
      {
        name: "forged-bundle-final-evidence",
        mutate(state) {
          state.cameraCalibrationBundles[bundleId].bundle.finalEvidence.rendererCorrectionFingerprint = "0".repeat(64);
        },
      },
    ]) {
      const corruptRoot = join(root, scenario.name);
      await mkdir(corruptRoot, { recursive: true });
      const corrupt = structuredClone(validState);
      scenario.mutate(corrupt);
      await writeFile(join(corruptRoot, "state.json"), `${JSON.stringify(corrupt)}\n`, "utf8");
      await writeFile(
        join(corruptRoot, "state.last-known-good.json"),
        `${JSON.stringify(validState)}\n`,
        "utf8",
      );
      const recovered = await createPixelBrightnessServer({
        dataDir: corruptRoot,
        controlToken: TOKEN,
        nodeSigningKey: NODE_SIGNING_KEY,
        offlineAfterMs: 60_000,
      });
      assert.equal(
        recovered.store.state.cameraCalibrationBundles[bundleId].commit.state,
        "renderer-acknowledged",
      );
      assert.ok(
        (await readdir(corruptRoot)).some((entry) => entry.startsWith("state.json.invalid-")),
        `${scenario.name} must quarantine primary and recover the exact LKG`,
      );
      await recovered.close();
    }
  } finally {
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("Server-derived camera failure acknowledges only the exact terminal report after a lost response", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-camera-terminal-derived-failure-"));
  let server = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
  try {
    await server.control.register({
      protocolVersion: 1,
      nodeId: "bundle-node",
      capabilities: { outputs: [{ id: "A", connector: "DP-1" }] },
    });
    const initialProject = server.control.getProject();
    await server.control.saveProject({
      ...initialProject,
      canvas: { ...initialProject.canvas, width: 64, height: 64 },
      compositionSource: { ...initialProject.compositionSource, width: 64, height: 64 },
      outputs: initialProject.outputs.filter((output) => output.id === "A").map((output) => ({
        ...output,
        nodeId: "bundle-node",
        resolution: { ...output.resolution, width: 64, height: 64 },
        sourceViewport: { x: 0, y: 0, width: 64, height: 64 },
        overlap: { left: 0, right: 0, top: 0, bottom: 0 },
      })),
    }, { ifMatchRevision: initialProject.revision });
    const artifactRoot = join(root, "derived-failure-artifacts");
    const now = monotonicEvidenceClock();
    for (const failureMode of ["missing-patch", "invalid-patch"]) {
      const started = await server.control.startCameraCalibration({
        mode: "measured",
        nodeId: "bundle-node",
        outputIds: ["A"],
        mesh: { columns: 2, rows: 2 },
        settleFrames: 1,
      });
      const report = await solveBundleMember(
        server,
        started.calibration,
        server.control.getProject(),
        artifactRoot,
        now,
      );
      if (failureMode === "missing-patch") delete report.projectPatch;
      else report.projectPatch.outputs[0].enabled = !report.projectPatch.outputs[0].enabled;
      const acknowledgement = await server.control.heartbeat("bundle-node", {
        protocolVersion: 1,
        status: "ready",
        ackSequence: server.store.state.nodes["bundle-node"].commandSequence,
        cameraCalibration: report,
      });
      assert.equal(acknowledgement.acknowledgedCameraCalibrationId, started.calibration.sessionId);
      const failed = server.store.state.cameraCalibrations[started.calibration.sessionId];
      assert.equal(failed.state, "failed");
      assert.match(failed.terminalReportSha256, /^[a-f0-9]{64}$/);
      const immutableFailure = JSON.stringify(failed);

      const exactRetry = await server.control.heartbeat("bundle-node", {
        protocolVersion: 1,
        status: "ready",
        ackSequence: server.store.state.nodes["bundle-node"].commandSequence,
        cameraCalibration: report,
      });
      assert.equal(exactRetry.acknowledgedCameraCalibrationId, started.calibration.sessionId);
      assert.equal(JSON.stringify(server.store.state.cameraCalibrations[started.calibration.sessionId]), immutableFailure);

      const forgedRetry = structuredClone(report);
      forgedRetry.camera.serial = `${forgedRetry.camera.serial}-forged`;
      await assert.rejects(
        server.control.heartbeat("bundle-node", {
          protocolVersion: 1,
          status: "ready",
          ackSequence: server.store.state.nodes["bundle-node"].commandSequence,
          cameraCalibration: forgedRetry,
        }),
        (error) => error?.status === 409 && error?.code === "camera_calibration_terminal_replay_mismatch",
      );
      assert.equal(JSON.stringify(server.store.state.cameraCalibrations[started.calibration.sessionId]), immutableFailure);
    }

    await server.close();
    server = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
    assert.equal(
      Object.values(server.store.state.cameraCalibrations).filter((calibration) => calibration.state === "failed").length,
      2,
    );
  } finally {
    await server.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
