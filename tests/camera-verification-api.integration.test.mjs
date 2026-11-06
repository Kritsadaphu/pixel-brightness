import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPixelBrightnessServer } from "../runtime/server/server.mjs";
import { createCameraLensProfile } from "../runtime/shared/camera-lens-profile.mjs";
import {
  CAMERA_OPTICAL_VERIFICATION_STATE,
  createCameraOpticalVerificationOperatorPrompt,
  createCameraOpticalVerificationState,
  evaluateCameraOpticalVerification,
  normalizeCameraOpticalVerificationState,
} from "../runtime/shared/camera-verification.mjs";
import { COMMAND, defaultProject, normalizeProject } from "../runtime/shared/protocol.mjs";

const NODE_ID = "optical-node-01";
const SESSION_ID = "camera-calibration-optical-fixture";

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function correctionBinding(outputId, artifacts) {
  const payload = {
    schemaVersion: 1,
    algorithm: "sha256",
    configSha256: sha256("renderer-config-revision-8"),
    outputs: [{
      id: outputId,
      processingBypass: false,
      artifacts: {
        warpMeshSha256: sha256(`gpu-warp:${outputId}`),
        blendMapSha256: artifacts.blendWeight.sha256,
        blackMapSha256: artifacts.blackPedestal.sha256,
        maskSha256: artifacts.mask.sha256,
        colorLutSha256: artifacts.lut.sha256,
      },
    }],
  };
  return { ...payload, fingerprint: sha256(canonicalJson(payload)) };
}

function refingerprintCorrectionBinding(binding) {
  const payload = structuredClone(binding);
  delete payload.fingerprint;
  return { ...payload, fingerprint: sha256(canonicalJson(payload)) };
}

function camera() {
  return {
    id: "sony-a7iv-001",
    vendor: "Sony",
    model: "ILCE-7M4",
    serial: "A7IV-UNIT-001",
    transport: "usb",
    backend: "sony-remote-sdk",
    capabilities: {
      manualExposure: true,
      manualWhiteBalance: true,
      manualFocus: true,
      linearCapture: true,
    },
  };
}

function lensProfile() {
  return createCameraLensProfile({
    schema: "pixel-brightness.camera-lens-profile.v1",
    camera: { manufacturer: "Sony", model: "ILCE-7M4", serialNumber: "A7IV-UNIT-001" },
    lens: {
      manufacturer: "Sony",
      model: "FE 16-35mm F2.8 GM II",
      serialNumber: "GM2-UNIT-001",
    },
    frame: { width: 64, height: 48 },
    capture: { focalLengthMm: 16, focusDistanceM: 4.2, apertureFNumber: 5.6 },
    intrinsics: { fx: 40, fy: 40, cx: 32, cy: 24 },
    distortion: { model: "brown-conrady-v1", k1: -0.03, k2: 0.002, k3: 0, p1: 0, p2: 0 },
    calibration: {
      method: "opencv-charuco-brown-conrady-v1",
      calibratedAt: iso(Date.now() - 24 * 60 * 60 * 1_000),
      rmsResidualPx: 0.18,
      maxResidualPx: 0.55,
      imageCount: 32,
    },
  });
}

function settings(shutterUs) {
  return {
    exposureMode: "manual",
    iso: 100,
    apertureF: 5.6,
    shutterUs,
    whiteBalance: { mode: "kelvin", kelvin: 5_600 },
    focusMode: "manual",
    captureFormat: "linear-rgb",
  };
}

async function installApplicableCalibration(server) {
  await server.control.register({
    protocolVersion: 1,
    nodeId: NODE_ID,
    capabilities: { outputs: [{ id: "A", connector: "DP-1" }] },
  });
  const profile = lensProfile();
  const base = defaultProject();
  const preApplySource = {
    ...base.outputs[0],
    nodeId: NODE_ID,
    color: { ...base.outputs[0].color, offset: [0, 0, 0] },
  };
  const preApplyOutput = normalizeProject({
    ...base,
    revision: 7,
    outputs: [preApplySource],
  }).outputs[0];
  const appliedOutput = {
    ...preApplyOutput,
    color: { ...preApplyOutput.color, offset: [0.03, 0.02, 0.01] },
  };
  const appliedProject = normalizeProject({
    ...base,
    revision: 8,
    outputs: [appliedOutput],
    updatedAt: iso(Date.now() - 5 * 60 * 1_000),
  });
  const rendererAcknowledgedAt = iso(Date.now() - 4 * 60 * 1_000);
  const artifacts = {
    blendWeight: { sha256: sha256("blend-weight:A") },
    blackPedestal: { sha256: sha256("black-pedestal:A") },
    mask: { sha256: sha256("surface-mask:A") },
    lut: { sha256: sha256("color-lut:A") },
  };
  const rendererCorrectionBinding = correctionBinding("A", artifacts);
  const surfaceTarget = {
    outputId: "A",
    wallId: "wall-north",
    surveyId: "survey-wall-north",
    cameraViewId: "camera-view-fixed",
    lensProfileSha256: profile.sha256,
    frame: structuredClone(profile.frame),
    corners: [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.9, y: 0.8 },
      { x: 0.1, y: 0.8 },
    ],
    method: "operator-four-corner-planar-v1",
  };
  await server.store.transaction((state) => {
    state.project = appliedProject;
    state.timeline.frameRateNum = appliedProject.canvas.frameRateNum;
    state.timeline.frameRateDen = appliedProject.canvas.frameRateDen;
    state.cameraCalibrations[SESSION_ID] = {
      schemaVersion: 1,
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      mode: "measured",
      state: "complete",
      project: { id: appliedProject.id, revision: 7 },
      outputIds: ["A"],
      plan: {
        project: { id: appliedProject.id, revision: 7 },
        lensProfile: profile,
        exposureProfiles: [
          { id: "geometry-short", role: "geometry", normalizationScale: 1, settings: settings(16_667) },
          { id: "radiometry-long", role: "radiometry", normalizationScale: 60, settings: settings(1_000_000) },
        ],
        outputs: [{
          id: "A",
          width: appliedOutput.resolution.width,
          height: appliedOutput.resolution.height,
          sourceViewport: { x: 0, y: 0, width: 1, height: 1 },
          surfaceTarget,
        }],
        mesh: { columns: 2, rows: 2, minimumConfidence: 0.75 },
        nearBlackLevels: [1 / 255, 4 / 255, 16 / 255],
        settleFrames: 2,
      },
      manifest: {
        schemaVersion: 2,
        applicable: true,
        provenance: "measured",
        camera: camera(),
        outputs: [{
          outputId: "A",
          artifacts,
          radiometry: {
            black: { target: 0.02 },
            measuredExposureNormalization: {
              bridgeId: `${SESSION_ID}/A/exposure-bridge`,
              measuredScaleLuma: 60,
              uncertaintyLuma: 0.01,
              status: "passed",
              gates: { passed: true },
            },
          },
        }],
      },
      projectApplied: true,
      projectCommitted: true,
      currentlyApplied: true,
      appliedRevision: 8,
      preApplyProjectRevision: 7,
      preApplyOutputs: [preApplyOutput],
      rendererAcknowledged: true,
      rendererAcknowledgedAt,
      rendererCorrectionBinding,
      opticalVerification: {
        state: "pending-optical-capture",
        required: true,
        verifiedAt: null,
        reason: null,
      },
      createdAt: rendererAcknowledgedAt,
      updatedAt: rendererAcknowledgedAt,
    };
    state.latestCameraCalibrationId = SESSION_ID;
    return true;
  });
  return { appliedProject, preApplyOutput };
}

function passingMetrics(plan) {
  return {
    geometry: plan.outputs.map((output) => ({
      outputId: output.id,
      holes: 0,
      confidence: 0.9,
      targetResidualP95Px: 1,
      targetResidualMaxPx: 2,
      projectorDriftP95Px: 1,
      projectorDriftMaxPx: 2,
      pixelCoverage: 0.95,
      tileCoverage: 0.99,
      clippedFraction: 0,
    })),
    radiometry: plan.outputs.map((output) => ({
      outputId: output.id,
      coverage: 0.95,
      clippedFraction: 0,
      normalSnrDb: 30,
      nearBlackSnrDb: 20,
      relativeUncertainty: 0.01,
      neutralRatioRelativeErrorRgb: [0.01, 0.01, 0.01],
      nearBlackRelativeErrorRgb: [0.02, 0.02, 0.02],
      primaryRmse: 0.02,
      primaryMaxError: 0.04,
    })),
    combined: {
      blackUncertaintyP95: 0.002,
      blackNonuniformityRange: 0.005,
      negativeBeyondUncertaintyFraction: 0.01,
      seamResidualP95: 0.02,
      seamResidualMax: 0.04,
    },
    blackFloor: {
      measurementBasis: "sensor-dark-subtracted-exposure-normalized-camera-linear-luma",
      exposureProfileId: "radiometry-long",
      normalizationScale: 60,
      globalMeasuredNormalizationScale: plan.globalMeasuredNormalizationScale,
      globalNormalizationRelativeUncertainty: plan.globalNormalizationRelativeUncertainty,
      global: {
        targetLevel: Math.max(...plan.blackFloorBaselines.map((baseline) => baseline.targetLevel)),
        observedP95: 0.021,
        absoluteDrift: 0.001,
        uncertaintyP95: 0.001,
        sampleCount: 256,
      },
      outputs: plan.blackFloorBaselines.map((baseline) => ({
        outputId: baseline.outputId,
        blackPedestalSha256: baseline.blackPedestalSha256,
        exposureBridgeId: baseline.exposureBridgeId,
        measuredNormalizationScale: baseline.measuredNormalizationScale,
        normalizationRelativeUncertainty: baseline.normalizationRelativeUncertainty,
        targetLevel: baseline.targetLevel,
        observedP95: 0.021,
        absoluteDrift: 0.001,
        uncertaintyP95: 0.001,
        sampleCount: 128,
      })),
    },
    overlapBands: plan.overlapBands.map((band) => ({
      bandId: band.id,
      outputIds: [...band.outputIds],
      relation: band.relation,
      measurementBasis: band.measurementBasis,
      exposureProfileId: band.exposureProfileId,
      normalizationScale: band.normalizationScale,
      expectedLevel: band.expectedLevel,
      sampleCount: 128,
      coverage: 0.95,
      analysisBandWidthPx: 3,
      boundaryResidualP95: 0.02,
      boundaryResidualMax: 0.04,
    })),
  };
}

function patternParameters(pattern) {
  if (pattern.type === "solid") return { rgb: [...pattern.rgb], applyCorrections: pattern.applyCorrections };
  return { axis: pattern.axis, bit: pattern.bit, inverse: pattern.inverse };
}

function verificationEvidenceTimeline(plan, startedAtMs) {
  const scopes = [];
  for (const step of plan.steps) {
    const confirmationLeaseId = step.captureConditions.confirmationLeaseId;
    const current = scopes.at(-1);
    if (current?.confirmationLeaseId === confirmationLeaseId) {
      current.lastStepId = step.id;
      current.stepCount += 1;
    } else {
      scopes.push({
        confirmationLeaseId,
        firstStepId: step.id,
        lastStepId: step.id,
        stepCount: 1,
      });
    }
  }
  const presentations = new Map();
  const captures = new Map();
  const confirmations = [];
  let cursor = startedAtMs + 1_000;
  for (const [scopeIndex, scope] of scopes.entries()) {
    confirmations.push({
      confirmationId: String.fromCharCode(99 + scopeIndex).repeat(32),
      ...scope,
      confirmedAt: iso(cursor),
      serverCommandId: `confirm-command-${scopeIndex + 1}`,
      serverCommandSequence: scopeIndex + 2,
    });
    cursor += 1_000;
    const firstIndex = plan.steps.findIndex((step) => step.id === scope.firstStepId);
    const lastIndex = plan.steps.findIndex((step) => step.id === scope.lastStepId);
    for (const step of plan.steps.slice(firstIndex, lastIndex + 1)) {
      if (step.pattern != null) {
        presentations.set(step.id, iso(cursor));
        cursor += 100;
      }
      for (let repeat = 0; repeat < step.repeats; repeat += 1) {
        captures.set(`${step.id}#${repeat}`, iso(cursor));
        cursor += 100;
      }
    }
    cursor += 1_000;
  }
  return { confirmations, presentations, captures, completedAtMs: cursor };
}

function conclusiveState(plan, { passed }) {
  const startedAtMs = Date.now() - 120_000;
  const timeline = verificationEvidenceTimeline(plan, startedAtMs);
  const startedAt = iso(startedAtMs);
  const completedAt = iso(timeline.completedAtMs);
  const metrics = passingMetrics(plan);
  if (!passed) {
    metrics.blackFloor.global.observedP95 = metrics.blackFloor.global.targetLevel + 0.2;
    metrics.blackFloor.global.absoluteDrift = 0.2;
  }
  const evaluated = evaluateCameraOpticalVerification(metrics, plan);
  const report = {
    schemaVersion: plan.schemaVersion,
    verificationId: plan.verificationId,
    calibrationSessionId: plan.calibrationSessionId,
    leaseToken: plan.leaseToken,
    state: evaluated.passed ? "verified" : "failed",
    projectRevision: plan.project.appliedRevision,
    startedAt,
    completedAt,
    renderer: {
      nodeProjectRevision: plan.project.appliedRevision,
      rendererProjectRevision: plan.project.appliedRevision,
      connected: true,
      ready: true,
      acknowledgedAt: plan.rendererAcknowledgedAt,
      activeCorrectionBinding: structuredClone(plan.rendererCorrectionBinding),
      activeCorrectionFingerprint: plan.rendererCorrectionBinding.fingerprint,
      capabilities: {
        correctedSolid: true,
        rawGrayCode: true,
        preservesWarp: true,
        targetIsolation: true,
      },
      outputBindings: plan.outputs.map((output) => ({
        outputId: output.id,
        calibrationSessionId: plan.calibrationSessionId,
      })),
    },
    provenance: {
      camera: structuredClone(plan.camera),
      lens: {
        vendor: plan.lensProfile.lens.manufacturer,
        model: plan.lensProfile.lens.model,
        serial: plan.lensProfile.lens.serialNumber,
        focalLengthMm: plan.lensProfile.capture.focalLengthMm,
        apertureF: plan.lensProfile.capture.apertureFNumber,
        focusDistanceM: plan.lensProfile.capture.focusDistanceM,
        focusLocked: true,
        zoomLocked: true,
        stabilization: "off",
      },
      pipeline: {
        captureMode: "single-shot",
        shutterMode: "efcs",
        rawEncoding: "lossless-compressed",
        sourcePixelFormat: "sony-arw-bayer-14",
        retainedPixelFormat: "linear-rgb-f32",
        bitDepth: 14,
        linearized: true,
        blackLevelSubtracted: false,
        whiteBalanceApplied: false,
        toneCurveApplied: false,
        noiseReductionApplied: false,
        lensCorrectionsApplied: false,
      },
      exposureProfiles: structuredClone(plan.exposureProfiles),
      lensProfileSha256: plan.lensProfile.sha256,
    },
    confirmations: timeline.confirmations,
    presentations: plan.steps.filter((step) => step.pattern != null).map((step) => ({
      stepId: step.id,
      projectRevision: plan.project.appliedRevision,
      outputId: step.outputId,
      pattern: structuredClone(step.pattern),
      outputs: plan.outputs.map((output, outputIndex) => {
        const targeted = step.outputId == null || step.outputId === output.id;
        return {
          id: output.id,
          pattern: targeted ? step.pattern.type : "black",
          patternParameters: targeted ? patternParameters(step.pattern) : {},
          correctionsBypassed: !targeted || step.pattern.applyCorrections !== true,
          processingBypass: false,
          blank: false,
          renderedFramesBefore: step.sequence * 10 + outputIndex,
          renderedFramesAfter: step.sequence * 10 + outputIndex + step.settleFrames,
        };
      }),
      presentedAt: timeline.presentations.get(step.id),
    })),
    captures: plan.steps.flatMap((step) => Array.from({ length: step.repeats }, (_value, repeat) => {
      const id = `${step.id}#${repeat}`;
      return {
        id,
        stepId: step.id,
        repeat,
        capturedAt: timeline.captures.get(id),
        sourceSha256: createHash("sha256").update(id).digest("hex"),
        width: plan.lensProfile.frame.width,
        height: plan.lensProfile.frame.height,
        bitDepth: 14,
        linearized: true,
        exposureProfileId: step.exposureProfileId,
      };
    })),
    metrics,
    evaluation: {
      passed: evaluated.passed,
      failedGateIds: evaluated.failedGateIds,
      gates: evaluated.gates,
    },
    failure: evaluated.passed
      ? null
      : { code: "OPTICAL_GATES_FAILED", message: "One or more optical gates failed", details: evaluated.failedGateIds },
  };
  return normalizeCameraOpticalVerificationState({
    ...createCameraOpticalVerificationState(plan, { at: startedAt }),
    state: report.state,
    progress: {
      completedSteps: plan.steps.length,
      totalSteps: plan.steps.length,
      currentStepId: null,
      currentStepIndex: null,
    },
    startedAt,
    updatedAt: completedAt,
    completedAt,
    failure: report.failure,
    report,
  }, { plan });
}

async function authoritativeConclusiveState(server, plan, options) {
  const runtime = conclusiveState(plan, options);
  const firstSequence = server.store.state.nextCommandSequence;
  runtime.report.confirmations.forEach((confirmation, index) => {
    confirmation.serverCommandSequence = firstSequence + index;
  });
  const canonicalRuntime = normalizeCameraOpticalVerificationState(runtime, { plan });
  await server.store.transaction((state) => {
    const wrapper = state.cameraCalibrations[SESSION_ID].opticalVerification;
    wrapper.confirmationCommands = canonicalRuntime.report.confirmations.map((entry) => ({
      id: entry.serverCommandId,
      sequence: entry.serverCommandSequence,
      type: COMMAND.CONFIRM_CAMERA_OPTICAL_VERIFICATION,
      confirmationId: entry.confirmationId,
      confirmationLeaseId: entry.confirmationLeaseId,
      stepId: entry.firstStepId,
      confirmedAt: entry.confirmedAt,
    }));
    const highestSequence = wrapper.confirmationCommands.at(-1)?.sequence ?? 0;
    state.nodes[NODE_ID].commandSequence = Math.max(
      Number(state.nodes[NODE_ID].commandSequence ?? 0),
      highestSequence,
    );
    state.nextCommandSequence = Math.max(state.nextCommandSequence, highestSequence + 1);
    return true;
  });
  return canonicalRuntime;
}

function highestConfirmationSequence(runtime) {
  return Math.max(0, ...runtime.report.confirmations.map((confirmation) => confirmation.serverCommandSequence));
}

function cancelledState(plan, { startedAt, completedAt }) {
  return normalizeCameraOpticalVerificationState({
    ...createCameraOpticalVerificationState(plan, { at: startedAt }),
    state: CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED,
    startedAt,
    updatedAt: completedAt,
    completedAt,
    failure: {
      code: "OPTICAL_VERIFICATION_CANCELLED",
      message: "Optical verification was cancelled",
      details: null,
    },
  }, { plan });
}

function cancelledFailClosedBlockedState(plan, { startedAt, completedAt }) {
  return normalizeCameraOpticalVerificationState({
    ...createCameraOpticalVerificationState(plan, { at: startedAt }),
    state: CAMERA_OPTICAL_VERIFICATION_STATE.BLOCKED,
    startedAt,
    updatedAt: completedAt,
    completedAt,
    failure: {
      code: "OPTICAL_VERIFICATION_FAIL_CLOSED_FAILED",
      message: "Cancellation was received but sticky black could not be confirmed",
      details: { cause: "OPTICAL_VERIFICATION_CANCELLED" },
    },
  }, { plan });
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  return { response, body: await response.json() };
}

test("renderer acknowledgement requires the exact active manifest-bound correction receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-camera-renderer-receipt-"));
  const server = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
  try {
    await installApplicableCalibration(server);
    const expected = structuredClone(
      server.store.state.cameraCalibrations[SESSION_ID].rendererCorrectionBinding,
    );
    await server.store.transaction((state) => {
      const calibration = state.cameraCalibrations[SESSION_ID];
      calibration.rendererAcknowledged = false;
      calibration.rendererAcknowledgedAt = null;
      calibration.rendererCorrectionBinding = null;
      calibration.opticalVerification = {
        state: "pending-renderer-ack",
        required: true,
        verifiedAt: null,
        reason: null,
      };
      return true;
    });

    await server.control.heartbeat(NODE_ID, {
      status: "ready",
      telemetry: {
        projectRevision: 8,
        renderer: { projectRevision: 8, ready: true, connected: true },
      },
    });
    let calibration = server.store.state.cameraCalibrations[SESSION_ID];
    assert.equal(calibration.rendererAcknowledged, false);
    assert.equal(calibration.rendererCorrectionBinding, null);

    const wrongArtifact = structuredClone(expected);
    wrongArtifact.outputs[0].artifacts.blendMapSha256 = sha256("different-live-blend");
    const mismatched = refingerprintCorrectionBinding(wrongArtifact);
    await server.control.heartbeat(NODE_ID, {
      status: "ready",
      telemetry: {
        projectRevision: 8,
        renderer: {
          projectRevision: 8,
          ready: true,
          connected: true,
          correctionBindingMatches: true,
          activeCorrectionFingerprint: mismatched.fingerprint,
          activeCorrectionBinding: mismatched,
        },
      },
    });
    calibration = server.store.state.cameraCalibrations[SESSION_ID];
    assert.equal(calibration.rendererAcknowledged, false);
    assert.equal(calibration.rendererCorrectionBinding, null);

    await server.control.heartbeat(NODE_ID, {
      status: "ready",
      telemetry: {
        projectRevision: 8,
        renderer: {
          projectRevision: 8,
          ready: true,
          connected: true,
          correctionBindingMatches: true,
          activeCorrectionFingerprint: expected.fingerprint,
          activeCorrectionBinding: expected,
        },
      },
    });
    calibration = server.store.state.cameraCalibrations[SESSION_ID];
    assert.equal(calibration.rendererAcknowledged, true);
    assert.deepEqual(calibration.rendererCorrectionBinding, expected);
    assert.equal(calibration.opticalVerification.state, "pending-optical-capture");
  } finally {
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

function postJson(body) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

test("optical verification API owns the node, binds confirmation, and completes failed-result rollback only after restore ack", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-camera-verification-api-"));
  const server = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const { preApplyOutput } = await installApplicableCalibration(server);

    const started = await requestJson(
      baseUrl,
      `/v1/calibrations/camera/${encodeURIComponent(SESSION_ID)}/verification`,
      postJson({}),
    );
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    assert.equal(started.body.command.type, COMMAND.START_CAMERA_OPTICAL_VERIFICATION);
    const plan = started.body.calibration.opticalVerification.plan;
    assert.equal(started.body.calibration.opticalVerification.state, "queued");
    assert.deepEqual(plan.outputs[0].resolution, {
      width: server.control.getProject().outputs[0].resolution.width,
      height: server.control.getProject().outputs[0].resolution.height,
    }, "optical verification must translate the canonical calibration width/height fields");

    for (const [pathname, body] of [
      ["/v1/projects/default", server.control.getProject()],
      ["/v1/calibrations/camera/survey-previews", { nodeId: NODE_ID }],
      ["/v1/calibrations/camera", { mode: "simulation", nodeId: NODE_ID }],
      ["/v1/outputs/A/pattern", { type: "grid" }],
      [`/v1/nodes/${NODE_ID}/actions`, { type: "COLLECT_DIAGNOSTICS", payload: {} }],
    ]) {
      const options = postJson(body);
      if (pathname === "/v1/projects/default") {
        options.headers["if-match"] = String(body.revision);
      }
      const blocked = await requestJson(baseUrl, pathname, options);
      assert.equal(blocked.response.status, 409, `${pathname}: ${JSON.stringify(blocked.body)}`);
      assert.equal(blocked.body.error.code, "camera_optical_verification_busy");
    }

    const promptAt = new Date().toISOString();
    const firstStep = plan.steps[0];
    const prompt = createCameraOpticalVerificationOperatorPrompt(plan, {
      stepId: firstStep.id,
      confirmationId: "operator_confirmation_token_000001",
      requestedAt: promptAt,
    });
    const waiting = normalizeCameraOpticalVerificationState({
      ...createCameraOpticalVerificationState(plan, { at: promptAt }),
      state: CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR,
      progress: {
        completedSteps: 0,
        totalSteps: plan.steps.length,
        currentStepId: firstStep.id,
        currentStepIndex: 0,
      },
      startedAt: promptAt,
      updatedAt: promptAt,
      operatorPrompt: prompt,
    }, { plan });
    const waitingResponse = await server.control.heartbeat(NODE_ID, {
      status: "ready",
      cameraOpticalVerification: waiting,
    });
    assert.equal(waitingResponse.acknowledgedCameraOpticalVerificationId, null);
    const confirmed = await requestJson(
      baseUrl,
      `/v1/calibrations/camera/${encodeURIComponent(SESSION_ID)}/verification/confirm`,
      postJson({
        confirmed: true,
        stepId: firstStep.id,
        confirmationId: prompt.confirmationId,
      }),
    );
    assert.equal(confirmed.response.status, 202, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.command.type, COMMAND.CONFIRM_CAMERA_OPTICAL_VERIFICATION);
    assert.equal(Object.hasOwn(confirmed.body.command.payload || {}, "confirmed"), false);
    const queuedConfirmation = server.store.state.commandQueues[NODE_ID]
      .find((command) => command.id === confirmed.body.command.id);
    assert.equal(Object.hasOwn(queuedConfirmation.payload, "confirmed"), false);

    const failedState = await authoritativeConclusiveState(server, plan, { passed: false });
    const failed = await server.control.heartbeat(NODE_ID, {
      status: "ready",
      ackSequence: highestConfirmationSequence(failedState),
      cameraOpticalVerification: failedState,
      telemetry: {
        projectRevision: 8,
        renderer: { projectRevision: 8, ready: true, connected: true },
      },
    });
    assert.equal(failed.acknowledgedCameraOpticalVerificationId, plan.verificationId);
    assert.equal(server.control.getProject().revision, 9);
    assert.deepEqual(server.control.getProject().outputs[0], preApplyOutput);
    let calibration = server.store.state.cameraCalibrations[SESSION_ID];
    assert.equal(calibration.currentlyApplied, false);
    assert.equal(calibration.opticalVerification.state, "rollback-renderer-ack");
    assert.equal(calibration.opticalVerification.rollback.targetRevision, 9);
    assert.equal(calibration.opticalVerification.restoreCommand, null);
    const rollbackCancel = await requestJson(
      baseUrl,
      `/v1/calibrations/camera/${encodeURIComponent(SESSION_ID)}/verification/cancel`,
      postJson({}),
    );
    assert.equal(rollbackCancel.response.status, 409);
    assert.equal(rollbackCancel.body.error.code, "camera_optical_verification_rollback_in_progress");
    const rollbackSync = server.store.state.commandQueues[NODE_ID]
      .find((command) => command.type === COMMAND.SYNC_PROJECT && command.payload.revision === 9);
    assert.ok(rollbackSync);

    await server.control.heartbeat(NODE_ID, {
      status: "ready",
      ackSequence: rollbackSync.sequence,
      telemetry: {
        projectRevision: 9,
        renderer: { projectRevision: 9, ready: true, connected: true },
      },
    });
    calibration = server.store.state.cameraCalibrations[SESSION_ID];
    const restoreCommand = calibration.opticalVerification.restoreCommand;
    assert.equal(restoreCommand.type, COMMAND.RESTORE_AFTER_CAMERA_ROLLBACK);
    assert.ok(calibration.opticalVerification.rollback.rendererAcknowledgedAt);
    assert.equal(calibration.opticalVerification.state, "rollback-renderer-ack");
    const queuedRestore = server.store.state.commandQueues[NODE_ID]
      .find((command) => command.id === restoreCommand.id);
    assert.deepEqual(queuedRestore.payload, {
      verificationId: plan.verificationId,
      leaseToken: plan.leaseToken,
      calibrationSessionId: SESSION_ID,
      projectRevision: 9,
    });

    const restoredAt = iso(Date.now() + 10);
    const nodeRestored = normalizeCameraOpticalVerificationState({
      ...calibration.opticalVerification.runtime,
      state: CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK,
      updatedAt: restoredAt,
      completedAt: restoredAt,
      rollback: {
        ...calibration.opticalVerification.runtime.rollback,
        state: "restored",
        restoredAt,
      },
    }, { plan });
    const restored = await server.control.heartbeat(NODE_ID, {
      status: "ready",
      ackSequence: restoreCommand.sequence,
      cameraOpticalVerification: nodeRestored,
      telemetry: {
        projectRevision: 9,
        renderer: { projectRevision: 9, ready: true, connected: true },
      },
    });
    assert.equal(restored.acknowledgedCameraOpticalVerificationId, plan.verificationId);
    calibration = server.store.state.cameraCalibrations[SESSION_ID];
    assert.equal(calibration.opticalVerification.state, "rolled-back");
    assert.equal(calibration.opticalVerification.rollback.state, "restored");
    assert.equal(calibration.opticalVerification.completedAt, restoredAt);
  } finally {
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("acknowledged cancellation keeps unverified correction fail-closed through exact pre-apply rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-camera-verification-cancel-rollback-"));
  const server = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
  try {
    const { preApplyOutput } = await installApplicableCalibration(server);
    const started = await server.control.startCameraOpticalVerification(SESSION_ID);
    const plan = started.calibration.opticalVerification.plan;
    const forgedAt = iso(Date.now() + 1_000);
    const forgedCancellation = cancelledState(plan, {
      startedAt: iso(Date.now()),
      completedAt: forgedAt,
    });
    await assert.rejects(
      server.control.heartbeat(NODE_ID, {
        status: "ready",
        cameraOpticalVerification: forgedCancellation,
        telemetry: {
          projectRevision: 8,
          renderer: { projectRevision: 8, ready: true, connected: true },
        },
      }),
      (error) => error?.code === "camera_optical_verification_cancel_not_acknowledged",
    );
    assert.equal(server.control.getProject().revision, 8);

    const cancelled = await server.control.cancelCameraOpticalVerification(SESSION_ID);
    assert.equal(cancelled.command.type, COMMAND.CANCEL_CAMERA_OPTICAL_VERIFICATION);
    const cancelRequestedAt = cancelled.calibration.opticalVerification.cancelRequestedAt;
    const cancelledAt = iso(Date.parse(cancelRequestedAt) + 1_000);
    const authoritativeCancellation = cancelledState(plan, {
      startedAt: cancelRequestedAt,
      completedAt: cancelledAt,
    });

    await assert.rejects(
      server.control.heartbeat(NODE_ID, {
        status: "ready",
        ackSequence: cancelled.command.sequence - 1,
        cameraOpticalVerification: authoritativeCancellation,
      }),
      (error) => error?.code === "camera_optical_verification_cancel_not_acknowledged",
    );
    assert.equal(server.control.getProject().revision, 8);

    const rollbackStarted = await server.control.heartbeat(NODE_ID, {
      status: "ready",
      ackSequence: cancelled.command.sequence,
      cameraOpticalVerification: authoritativeCancellation,
      telemetry: {
        projectRevision: 8,
        renderer: { projectRevision: 8, ready: true, connected: true },
      },
    });
    assert.equal(rollbackStarted.acknowledgedCameraOpticalVerificationId, plan.verificationId);
    assert.equal(server.control.getProject().revision, 9);
    assert.deepEqual(server.control.getProject().outputs[0], preApplyOutput);
    let calibration = server.store.state.cameraCalibrations[SESSION_ID];
    assert.equal(calibration.currentlyApplied, false);
    assert.equal(calibration.opticalVerification.state, CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_RENDERER_ACK);
    assert.equal(calibration.opticalVerification.report, null);
    assert.equal(calibration.opticalVerification.failure.code, "OPTICAL_VERIFICATION_CANCELLED");
    assert.equal(calibration.opticalVerification.rollback.trigger, "cancelled");
    assert.equal(calibration.opticalVerification.rollback.targetRevision, 9);

    const rollbackSync = server.store.state.commandQueues[NODE_ID]
      .find((command) => command.type === COMMAND.SYNC_PROJECT && command.payload.revision === 9);
    assert.ok(rollbackSync);
    await server.control.heartbeat(NODE_ID, {
      status: "ready",
      ackSequence: rollbackSync.sequence,
      telemetry: {
        projectRevision: 9,
        renderer: { projectRevision: 9, ready: true, connected: true },
      },
    });
    calibration = server.store.state.cameraCalibrations[SESSION_ID];
    const restoreCommand = calibration.opticalVerification.restoreCommand;
    assert.equal(restoreCommand.type, COMMAND.RESTORE_AFTER_CAMERA_ROLLBACK);

    const restoredAt = iso(Date.parse(calibration.opticalVerification.runtime.updatedAt) + 1_000);
    const nodeRestored = normalizeCameraOpticalVerificationState({
      ...calibration.opticalVerification.runtime,
      state: CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK,
      updatedAt: restoredAt,
      completedAt: restoredAt,
      rollback: {
        ...calibration.opticalVerification.runtime.rollback,
        state: "restored",
        restoredAt,
      },
    }, { plan });
    const restored = await server.control.heartbeat(NODE_ID, {
      status: "ready",
      ackSequence: restoreCommand.sequence,
      cameraOpticalVerification: nodeRestored,
      telemetry: {
        projectRevision: 9,
        renderer: { projectRevision: 9, ready: true, connected: true },
      },
    });
    assert.equal(restored.acknowledgedCameraOpticalVerificationId, plan.verificationId);
    calibration = server.store.state.cameraCalibrations[SESSION_ID];
    assert.equal(calibration.opticalVerification.state, CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK);
    assert.equal(calibration.opticalVerification.rollback.trigger, "cancelled");
    assert.equal(calibration.opticalVerification.rollback.state, "restored");
    assert.equal(calibration.opticalVerification.report, null);
  } finally {
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("acknowledged cancellation still starts rollback when sticky-black confirmation itself blocks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-camera-verification-cancel-black-blocked-"));
  const server = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
  try {
    await installApplicableCalibration(server);
    const started = await server.control.startCameraOpticalVerification(SESSION_ID);
    const plan = started.calibration.opticalVerification.plan;
    const cancelled = await server.control.cancelCameraOpticalVerification(SESSION_ID);
    const cancelRequestedAt = cancelled.calibration.opticalVerification.cancelRequestedAt;
    const blocked = cancelledFailClosedBlockedState(plan, {
      startedAt: cancelRequestedAt,
      completedAt: iso(Date.parse(cancelRequestedAt) + 1_000),
    });
    const response = await server.control.heartbeat(NODE_ID, {
      status: "ready",
      ackSequence: cancelled.command.sequence,
      cameraOpticalVerification: blocked,
      telemetry: {
        projectRevision: 8,
        renderer: { projectRevision: 8, ready: true, connected: true },
      },
    });
    assert.equal(response.acknowledgedCameraOpticalVerificationId, plan.verificationId);
    const calibration = server.store.state.cameraCalibrations[SESSION_ID];
    assert.equal(server.control.getProject().revision, 9);
    assert.equal(calibration.opticalVerification.state, CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_RENDERER_ACK);
    assert.equal(calibration.opticalVerification.rollback.trigger, "cancelled");
    assert.equal(calibration.opticalVerification.failure.code, "OPTICAL_VERIFICATION_FAIL_CLOSED_FAILED");
    assert.equal(calibration.opticalVerification.report, null);
  } finally {
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("renderer restore failure is mirrored as rollback-blocked instead of remaining in progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-camera-verification-restore-blocked-"));
  const server = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
  try {
    await installApplicableCalibration(server);
    const started = await server.control.startCameraOpticalVerification(SESSION_ID);
    const plan = started.calibration.opticalVerification.plan;
    const failedRuntime = await authoritativeConclusiveState(server, plan, { passed: false });
    await server.control.heartbeat(NODE_ID, {
      status: "ready",
      ackSequence: highestConfirmationSequence(failedRuntime),
      cameraOpticalVerification: failedRuntime,
      telemetry: {
        projectRevision: 8,
        renderer: { projectRevision: 8, ready: true, connected: true },
      },
    });
    const rollbackSync = server.store.state.commandQueues[NODE_ID]
      .find((command) => command.type === COMMAND.SYNC_PROJECT && command.payload.revision === 9);
    assert.ok(rollbackSync);

    await server.control.heartbeat(NODE_ID, {
      status: "ready",
      ackSequence: rollbackSync.sequence,
      telemetry: {
        projectRevision: 9,
        renderer: { projectRevision: 9, ready: true, connected: true },
      },
    });
    let calibration = server.store.state.cameraCalibrations[SESSION_ID];
    const restoreCommand = calibration.opticalVerification.restoreCommand;
    assert.equal(restoreCommand.type, COMMAND.RESTORE_AFTER_CAMERA_ROLLBACK);

    const blockedAt = iso(Date.parse(calibration.opticalVerification.runtime.updatedAt) + 10);
    const nodeBlocked = normalizeCameraOpticalVerificationState({
      ...calibration.opticalVerification.runtime,
      state: CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_BLOCKED,
      updatedAt: blockedAt,
      completedAt: blockedAt,
      rollback: {
        ...calibration.opticalVerification.runtime.rollback,
        state: "blocked",
        reason: "Renderer could not restore exact content after rollback",
        restoredAt: null,
      },
    }, { plan });
    const blocked = await server.control.heartbeat(NODE_ID, {
      status: "ready",
      ackSequence: restoreCommand.sequence,
      cameraOpticalVerification: nodeBlocked,
      telemetry: {
        projectRevision: 9,
        renderer: { projectRevision: 9, ready: true, connected: true },
      },
    });
    assert.equal(blocked.acknowledgedCameraOpticalVerificationId, plan.verificationId);
    calibration = server.store.state.cameraCalibrations[SESSION_ID];
    assert.equal(calibration.opticalVerification.state, "rollback-blocked");
    assert.equal(calibration.opticalVerification.rollback.state, "blocked");
    assert.equal(calibration.opticalVerification.rollback.targetRevision, 9);
    assert.match(calibration.opticalVerification.rollback.reason, /could not restore exact content/);
    assert.equal(calibration.opticalVerification.report.state, "failed");
    assert.equal(calibration.opticalVerification.reason, "automatic-rollback-restore-blocked");
  } finally {
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("failed optical verification becomes rollback-blocked when the authoritative project revision moved", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-camera-verification-blocked-"));
  const server = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
  try {
    await installApplicableCalibration(server);
    const started = await server.control.startCameraOpticalVerification(SESSION_ID);
    const plan = started.calibration.opticalVerification.plan;
    await server.store.transaction((state) => {
      state.project = normalizeProject({ ...state.project, revision: 9 });
      return true;
    });
    const failedRuntime = await authoritativeConclusiveState(server, plan, { passed: false });
    const result = await server.control.heartbeat(NODE_ID, {
      status: "ready",
      ackSequence: highestConfirmationSequence(failedRuntime),
      cameraOpticalVerification: failedRuntime,
    });
    assert.equal(result.acknowledgedCameraOpticalVerificationId, plan.verificationId);
    const calibration = server.store.state.cameraCalibrations[SESSION_ID];
    assert.equal(calibration.opticalVerification.state, "rollback-blocked");
    assert.equal(calibration.opticalVerification.rollback.state, "blocked");
    assert.match(calibration.opticalVerification.rollback.reason, /revision moved/);
    assert.equal(server.control.getProject().revision, 9);
    assert.equal(server.store.state.commandQueues[NODE_ID]
      .some((command) => command.payload?.reason === "camera-optical-verification-rollback"), false);
  } finally {
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("verified optical evidence is acknowledged without mutating the applied project", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-camera-verification-passed-"));
  const server = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
  try {
    await installApplicableCalibration(server);
    const started = await server.control.startCameraOpticalVerification(SESSION_ID);
    const plan = started.calibration.opticalVerification.plan;
    const verifiedRuntime = await authoritativeConclusiveState(server, plan, { passed: true });
    const confirmationSequence = highestConfirmationSequence(verifiedRuntime);
    const stateBeforePrematureReport = JSON.stringify(server.store.state);
    await assert.rejects(
      server.control.heartbeat(NODE_ID, {
        status: "ready",
        ackSequence: confirmationSequence - 1,
        cameraOpticalVerification: verifiedRuntime,
        telemetry: {
          projectRevision: 8,
          renderer: { projectRevision: 8, ready: true, connected: true },
        },
      }),
      (error) => error?.code === "camera_optical_verification_confirmation_not_acknowledged",
    );
    assert.equal(JSON.stringify(server.store.state), stateBeforePrematureReport);
    const result = await server.control.heartbeat(NODE_ID, {
      status: "ready",
      ackSequence: confirmationSequence,
      cameraOpticalVerification: verifiedRuntime,
      telemetry: {
        projectRevision: 8,
        renderer: { projectRevision: 8, ready: true, connected: true },
      },
    });
    assert.equal(result.acknowledgedCameraOpticalVerificationId, plan.verificationId);
    const calibration = server.store.state.cameraCalibrations[SESSION_ID];
    assert.equal(calibration.opticalVerification.state, "verified");
    assert.equal(calibration.opticalVerification.report.evaluation.passed, true);
    assert.equal(calibration.opticalVerification.verifiedAt, calibration.opticalVerification.completedAt);
    assert.equal(calibration.currentlyApplied, true);
    assert.equal(server.control.getProject().revision, 8);
  } finally {
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal optical evidence cannot forge or omit Server-issued confirmation commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-camera-verification-confirmation-evidence-"));
  const server = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
  try {
    await installApplicableCalibration(server);
    const started = await server.control.startCameraOpticalVerification(SESSION_ID);
    const plan = started.calibration.opticalVerification.plan;
    const runtime = await authoritativeConclusiveState(server, plan, { passed: true });
    await server.store.transaction((state) => {
      state.cameraCalibrations[SESSION_ID].opticalVerification.confirmationCommands[1].id = "forged-command-id";
      return true;
    });
    await assert.rejects(
      server.control.heartbeat(NODE_ID, {
        status: "ready",
        ackSequence: highestConfirmationSequence(runtime),
        cameraOpticalVerification: runtime,
        telemetry: {
          projectRevision: 8,
          renderer: { projectRevision: 8, ready: true, connected: true },
        },
      }),
      (error) => error?.code === "camera_optical_verification_confirmation_evidence_mismatch",
    );
    const calibration = server.store.state.cameraCalibrations[SESSION_ID];
    assert.equal(calibration.opticalVerification.state, "queued");
    assert.equal(calibration.opticalVerification.report, null);
  } finally {
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic rollback blocks a non-canonical pre-apply output snapshot instead of repairing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-camera-verification-snapshot-blocked-"));
  const server = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
  try {
    await installApplicableCalibration(server);
    await server.store.transaction((state) => {
      state.cameraCalibrations[SESSION_ID].preApplyOutputs[0].warp.points = null;
      delete state.cameraCalibrations[SESSION_ID].preApplyOutputs[0].warp.enabled;
      return true;
    });
    const started = await server.control.startCameraOpticalVerification(SESSION_ID);
    const plan = started.calibration.opticalVerification.plan;
    const failedRuntime = await authoritativeConclusiveState(server, plan, { passed: false });
    const result = await server.control.heartbeat(NODE_ID, {
      status: "ready",
      ackSequence: highestConfirmationSequence(failedRuntime),
      cameraOpticalVerification: failedRuntime,
    });
    assert.equal(result.acknowledgedCameraOpticalVerificationId, plan.verificationId);
    const calibration = server.store.state.cameraCalibrations[SESSION_ID];
    assert.equal(calibration.opticalVerification.state, "rollback-blocked");
    assert.match(calibration.opticalVerification.rollback.reason, /not an exact canonical project output/);
    assert.equal(server.control.getProject().revision, 8);
    assert.equal(calibration.currentlyApplied, true);
  } finally {
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
