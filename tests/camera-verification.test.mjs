import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createCameraLensProfile } from "../runtime/shared/camera-lens-profile.mjs";
import {
  CAMERA_OPTICAL_VERIFICATION_SCHEMA_VERSION,
  CAMERA_OPTICAL_VERIFICATION_STATE,
  CameraOpticalVerificationError,
  createCameraOpticalVerificationOperatorPrompt,
  createCameraOpticalVerificationPlan,
  createCameraOpticalVerificationState,
  evaluateCameraOpticalVerification,
  normalizeCameraOpticalVerificationConfirmation,
  normalizeCameraOpticalVerificationPlan,
  normalizeCameraOpticalVerificationReport,
  normalizeCameraOpticalVerificationState,
} from "../runtime/shared/camera-verification.mjs";
import { COMMAND, createCommand } from "../runtime/shared/protocol.mjs";
import {
  RendererCorrectionBindingError,
  normalizeRendererCorrectionBinding,
} from "../runtime/shared/renderer-correction-binding.mjs";

const NOW = Date.parse("2026-08-24T12:00:00.000Z");
const ACKNOWLEDGED_AT = "2026-08-24T10:00:00.000Z";
const STARTED_AT = "2026-08-24T10:00:01.000Z";
const EVIDENCE_AT = "2026-08-24T10:01:00.000Z";
const COMPLETED_AT = "2026-08-24T10:10:00.000Z";

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
    distortion: {
      model: "brown-conrady-v1",
      k1: -0.03,
      k2: 0.002,
      k3: 0,
      p1: 0,
      p2: 0,
    },
    calibration: {
      method: "opencv-charuco-brown-conrady-v1",
      calibratedAt: "2026-08-01T00:00:00.000Z",
      rmsResidualPx: 0.18,
      maxResidualPx: 0.55,
      imageCount: 32,
    },
  }, { now: NOW });
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

function refingerprintRendererBinding(binding) {
  const payload = structuredClone(binding);
  delete payload.fingerprint;
  return { ...payload, fingerprint: sha256(canonicalJson(payload)) };
}

function rendererCorrectionBinding(outputs, baselines) {
  const baselineById = new Map(baselines.map((baseline) => [baseline.outputId, baseline]));
  const calibrated = outputs.map((output) => ({
    id: output.id,
    processingBypass: false,
    artifacts: {
      warpMeshSha256: sha256(`warp:${output.id}`),
      blendMapSha256: sha256(`blend:${output.id}`),
      blackMapSha256: baselineById.get(output.id).blackPedestalSha256,
      maskSha256: sha256(`mask:${output.id}`),
      colorLutSha256: sha256(`lut:${output.id}`),
    },
  }));
  const payload = {
    schemaVersion: 1,
    algorithm: "sha256",
    configSha256: sha256("renderer-config-revision-8"),
    outputs: [
      calibrated[0],
      {
        id: "peer-output",
        processingBypass: true,
        artifacts: {
          warpMeshSha256: sha256("peer-identity-warp"),
          blendMapSha256: null,
          blackMapSha256: null,
          maskSha256: null,
          colorLutSha256: null,
        },
      },
      ...calibrated.slice(1),
    ],
  };
  return { ...payload, fingerprint: sha256(canonicalJson(payload)) };
}

function planRequest(overrides = {}) {
  const profile = lensProfile();
  const outputs = [
    {
      id: "wall-a",
      resolution: { width: 8, height: 4 },
      sourceViewport: { x: 0, y: 0, width: 8, height: 4 },
      surfaceTarget: {
        outputId: "wall-a",
        wallId: "north-wall",
        surveyId: "survey-north-wall",
        cameraViewId: "camera-view-main",
        lensProfileSha256: profile.sha256,
        frame: structuredClone(profile.frame),
        corners: [
          { x: 0.1, y: 0.1 },
          { x: 0.55, y: 0.1 },
          { x: 0.55, y: 0.8 },
          { x: 0.1, y: 0.8 },
        ],
        method: "operator-four-corner-planar-v1",
      },
    },
    {
      id: "wall-b",
      resolution: { width: 8, height: 4 },
      sourceViewport: { x: 6, y: 0, width: 8, height: 4 },
      surfaceTarget: {
        outputId: "wall-b",
        wallId: "north-wall",
        surveyId: "survey-north-wall",
        cameraViewId: "camera-view-main",
        lensProfileSha256: profile.sha256,
        frame: structuredClone(profile.frame),
        corners: [
          { x: 0.45, y: 0.1 },
          { x: 0.9, y: 0.1 },
          { x: 0.9, y: 0.8 },
          { x: 0.45, y: 0.8 },
        ],
        method: "operator-four-corner-planar-v1",
      },
    },
  ];
  const blackFloorBaselines = outputs.map((output, index) => ({
    outputId: output.id,
    calibrationSessionId: "calibration-room-a-v2",
    sourceManifestSchemaVersion: 2,
    blackPedestalSha256: String(index + 1).repeat(64),
    exposureProfileId: "radiometry-long",
    normalizationScale: 60,
    exposureBridgeId: `calibration-room-a-v2/${output.id}/exposure-bridge`,
    exposureBridgeStatus: "passed",
    exposureBridgeGatesPassed: true,
    measuredNormalizationScale: 59.5 + index,
    normalizationRelativeUncertainty: 0.005,
    measurementBasis: "sensor-dark-subtracted-exposure-normalized-camera-linear-luma",
    targetLevel: 0.02,
  }));
  return {
    verificationId: "verify-room-a-revision-8",
    leaseToken: "verification_lease_token_00000001",
    calibrationSessionId: "calibration-room-a-v2",
    nodeId: "node-a",
    project: { id: "room-a", baseRevision: 7, appliedRevision: 8 },
    rendererAcknowledgedAt: ACKNOWLEDGED_AT,
    camera: camera(),
    lensProfile: profile,
    exposureProfiles: [
      { id: "geometry-short", role: "geometry", normalizationScale: 1, settings: settings(16_667) },
      { id: "radiometry-long", role: "radiometry", normalizationScale: 60, settings: settings(1_000_000) },
    ],
    outputs,
    blackFloorBaselines,
    rendererCorrectionBinding: rendererCorrectionBinding(outputs, blackFloorBaselines),
    mesh: { columns: 4, rows: 3, minimumConfidence: 0.75 },
    nearBlackLevels: [1 / 255, 4 / 255, 16 / 255],
    settleFrames: 2,
    ...overrides,
  };
}

function plan(overrides = {}) {
  return createCameraOpticalVerificationPlan(planRequest(overrides), { now: NOW });
}

function completedProgress(verificationPlan) {
  return {
    completedSteps: verificationPlan.steps.length,
    totalSteps: verificationPlan.steps.length,
    currentStepId: null,
    currentStepIndex: null,
  };
}

function passingMetrics(verificationPlan) {
  return {
    geometry: verificationPlan.outputs.map((output) => ({
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
    radiometry: verificationPlan.outputs.map((output) => ({
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
      globalMeasuredNormalizationScale: verificationPlan.globalMeasuredNormalizationScale,
      globalNormalizationRelativeUncertainty: verificationPlan.globalNormalizationRelativeUncertainty,
      global: {
        targetLevel: 0.02,
        observedP95: 0.021,
        absoluteDrift: 0.001,
        uncertaintyP95: 0.001,
        sampleCount: 256,
      },
      outputs: verificationPlan.blackFloorBaselines.map((baseline) => ({
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
    overlapBands: verificationPlan.overlapBands.map((band) => ({
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

function presentationEvidence(verificationPlan) {
  return verificationPlan.steps.filter((step) => step.pattern != null).map((step) => ({
    stepId: step.id,
    projectRevision: verificationPlan.project.appliedRevision,
    outputId: step.outputId,
    pattern: structuredClone(step.pattern),
    outputs: verificationPlan.outputs.map((output, outputIndex) => {
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
    presentedAt: EVIDENCE_AT,
  }));
}

function captureEvidence(verificationPlan) {
  return verificationPlan.steps.flatMap((step) => Array.from({ length: step.repeats }, (_value, repeat) => {
    const id = `${step.id}#${repeat}`;
    const capturedAt = step.captureConditions.confirmationLeaseId === "verification-sensor-dark"
      ? "2026-08-24T10:00:15.000Z"
      : step.captureConditions.confirmationLeaseId === "verification-ambient"
        ? "2026-08-24T10:00:25.000Z"
        : EVIDENCE_AT;
    return {
      id,
      stepId: step.id,
      repeat,
      capturedAt,
      sourceSha256: createHash("sha256").update(id).digest("hex"),
      width: verificationPlan.lensProfile.frame.width,
      height: verificationPlan.lensProfile.frame.height,
      bitDepth: 14,
      linearized: true,
      exposureProfileId: step.exposureProfileId,
    };
  }));
}

function confirmationEvidence(verificationPlan) {
  const scopes = [];
  for (const step of verificationPlan.steps) {
    const leaseId = step.captureConditions.confirmationLeaseId;
    const current = scopes.at(-1);
    if (current?.confirmationLeaseId === leaseId) {
      current.lastStepId = step.id;
      current.stepCount += 1;
    } else {
      scopes.push({
        confirmationLeaseId: leaseId,
        firstStepId: step.id,
        lastStepId: step.id,
        stepCount: 1,
      });
    }
  }
  return scopes.map((scope, index) => ({
    confirmationId: String.fromCharCode(99 + index).repeat(32),
    ...scope,
    confirmedAt: `2026-08-24T10:00:${String(10 + index * 10).padStart(2, "0")}.000Z`,
    serverCommandId: `confirm-command-${index + 1}`,
    serverCommandSequence: index + 2,
  }));
}

function conclusiveReport(verificationPlan, { metrics = passingMetrics(verificationPlan) } = {}) {
  const evaluated = evaluateCameraOpticalVerification(metrics, verificationPlan, { now: NOW });
  return {
    schemaVersion: CAMERA_OPTICAL_VERIFICATION_SCHEMA_VERSION,
    verificationId: verificationPlan.verificationId,
    calibrationSessionId: verificationPlan.calibrationSessionId,
    leaseToken: verificationPlan.leaseToken,
    state: evaluated.passed
      ? CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED
      : CAMERA_OPTICAL_VERIFICATION_STATE.FAILED,
    projectRevision: verificationPlan.project.appliedRevision,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    renderer: {
      nodeProjectRevision: verificationPlan.project.appliedRevision,
      rendererProjectRevision: verificationPlan.project.appliedRevision,
      connected: true,
      ready: true,
      acknowledgedAt: verificationPlan.rendererAcknowledgedAt,
      capabilities: {
        correctedSolid: true,
        rawGrayCode: true,
        preservesWarp: true,
        targetIsolation: true,
      },
      outputBindings: verificationPlan.outputs.map((output) => ({
        outputId: output.id,
        calibrationSessionId: verificationPlan.calibrationSessionId,
      })),
      activeCorrectionBinding: structuredClone(verificationPlan.rendererCorrectionBinding),
      activeCorrectionFingerprint: verificationPlan.rendererCorrectionBinding.fingerprint,
    },
    provenance: {
      camera: structuredClone(verificationPlan.camera),
      lens: {
        vendor: verificationPlan.lensProfile.lens.manufacturer,
        model: verificationPlan.lensProfile.lens.model,
        serial: verificationPlan.lensProfile.lens.serialNumber,
        focalLengthMm: verificationPlan.lensProfile.capture.focalLengthMm,
        apertureF: verificationPlan.lensProfile.capture.apertureFNumber,
        focusDistanceM: verificationPlan.lensProfile.capture.focusDistanceM,
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
      exposureProfiles: structuredClone(verificationPlan.exposureProfiles),
      lensProfileSha256: verificationPlan.lensProfile.sha256,
    },
    confirmations: confirmationEvidence(verificationPlan),
    presentations: presentationEvidence(verificationPlan),
    captures: captureEvidence(verificationPlan),
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
}

function assertCode(expectedCode) {
  return (error) => error instanceof CameraOpticalVerificationError && error.code === expectedCode;
}

test("pure shared renderer binding normalizer verifies canonical SHA-256 and ordered optional artifacts", () => {
  const request = planRequest();
  const binding = request.rendererCorrectionBinding;
  assert.deepEqual(normalizeRendererCorrectionBinding(binding), binding);
  const payload = structuredClone(binding);
  delete payload.fingerprint;
  assert.equal(binding.fingerprint, createHash("sha256").update(canonicalJson(payload)).digest("hex"));
  assert.equal(binding.outputs[1].artifacts.colorLutSha256, null, "non-calibrated peer artifacts may be absent");

  const forged = structuredClone(binding);
  forged.outputs[0].artifacts.colorLutSha256 = sha256("forged-lut");
  assert.throws(
    () => normalizeRendererCorrectionBinding(forged),
    (error) => error instanceof RendererCorrectionBindingError
      && error.code === "RENDERER_CORRECTION_FINGERPRINT_MISMATCH",
  );
});

test("plan derives immutable gates, exact capture order and protocol commands", () => {
  const verificationPlan = plan();
  assert.deepEqual(normalizeCameraOpticalVerificationPlan(verificationPlan, { now: NOW }), verificationPlan);
  assert.equal(Object.isFrozen(verificationPlan.gates), true);
  assert.equal(Object.isFrozen(verificationPlan.gates.geometry), true);
  assert.equal(verificationPlan.lowLevel, 1 / 255);
  assert.equal(verificationPlan.steps[0].purpose, "sensor-dark");
  assert.equal(verificationPlan.outputs[0].surfaceTarget.lensProfileSha256, verificationPlan.lensProfile.sha256);
  assert.equal(verificationPlan.schemaVersion, CAMERA_OPTICAL_VERIFICATION_SCHEMA_VERSION);
  assert.equal(verificationPlan.blackFloorBaselines[0].exposureProfileId, "radiometry-long");
  assert.equal(verificationPlan.rendererCorrectionBinding.outputs.length, 3);
  assert.equal(verificationPlan.rendererCorrectionBinding.outputs[1].id, "peer-output");
  assert.equal(verificationPlan.rendererCorrectionBinding.outputs[1].processingBypass, true);
  assert.equal(verificationPlan.overlapBands.length, 1);
  assert.equal(verificationPlan.overlapBands[0].relation, "area-overlap");
  assert.deepEqual(verificationPlan.overlapBands[0].outputIds, ["wall-a", "wall-b"]);
  assert.ok(verificationPlan.overlapBands[0].cameraPolygon.length >= 3);
  assert.equal(verificationPlan.steps.at(-1).purpose, "global-corrected-near-black");
  assert.ok(verificationPlan.steps.some((step) => (
    step.purpose === "geometry-gray-code" && step.pattern.applyCorrections == null
  )));
  assert.ok(verificationPlan.steps.some((step) => (
    step.purpose === "corrected-neutral-018" && step.pattern.applyCorrections === true
  )));

  const forged = structuredClone(verificationPlan);
  forged.gates.geometry.minimumPixelCoverage = 0;
  assert.throws(
    () => normalizeCameraOpticalVerificationPlan(forged, { now: NOW }),
    assertCode("INVALID_OPTICAL_VERIFICATION_CONTRACT"),
  );
  const incapableCamera = camera();
  incapableCamera.capabilities.linearCapture = false;
  assert.throws(
    () => plan({ camera: incapableCamera }),
    assertCode("INVALID_OPTICAL_VERIFICATION_CONTRACT"),
  );
  const mismatchedTargetOutputs = structuredClone(verificationPlan.outputs);
  mismatchedTargetOutputs[0].surfaceTarget.lensProfileSha256 = "a".repeat(64);
  assert.throws(
    () => plan({ outputs: mismatchedTargetOutputs }),
    assertCode("OPTICAL_VERIFICATION_SURFACE_TARGET_MISMATCH"),
  );
  const missingTargetOutputs = structuredClone(verificationPlan.outputs);
  delete missingTargetOutputs[0].surfaceTarget;
  assert.throws(
    () => plan({ outputs: missingTargetOutputs }),
    assertCode("INVALID_OPTICAL_VERIFICATION_CONTRACT"),
  );
  const failedBridge = planRequest();
  failedBridge.blackFloorBaselines[0].exposureBridgeStatus = "failed";
  failedBridge.blackFloorBaselines[0].exposureBridgeGatesPassed = false;
  assert.throws(
    () => createCameraOpticalVerificationPlan(failedBridge, { now: NOW }),
    assertCode("OPTICAL_VERIFICATION_BASELINE_MISMATCH"),
  );
  const uncalibratedScale = planRequest();
  uncalibratedScale.blackFloorBaselines[0].measuredNormalizationScale = 40;
  assert.throws(
    () => createCameraOpticalVerificationPlan(uncalibratedScale, { now: NOW }),
    assertCode("OPTICAL_VERIFICATION_BASELINE_MISMATCH"),
  );
  const bypassedCorrection = planRequest();
  bypassedCorrection.rendererCorrectionBinding.outputs[0].processingBypass = true;
  bypassedCorrection.rendererCorrectionBinding = refingerprintRendererBinding(
    bypassedCorrection.rendererCorrectionBinding,
  );
  assert.throws(
    () => createCameraOpticalVerificationPlan(bypassedCorrection, { now: NOW }),
    assertCode("OPTICAL_VERIFICATION_RENDERER_CORRECTION_IDENTITY"),
  );
  const missingCorrection = planRequest();
  missingCorrection.rendererCorrectionBinding.outputs[0].artifacts.maskSha256 = null;
  missingCorrection.rendererCorrectionBinding = refingerprintRendererBinding(
    missingCorrection.rendererCorrectionBinding,
  );
  assert.throws(
    () => createCameraOpticalVerificationPlan(missingCorrection, { now: NOW }),
    assertCode("OPTICAL_VERIFICATION_RENDERER_CORRECTION_IDENTITY"),
  );
  const wrongBlackMap = planRequest();
  wrongBlackMap.rendererCorrectionBinding.outputs[0].artifacts.blackMapSha256 = sha256("other-black-map");
  wrongBlackMap.rendererCorrectionBinding = refingerprintRendererBinding(wrongBlackMap.rendererCorrectionBinding);
  assert.throws(
    () => createCameraOpticalVerificationPlan(wrongBlackMap, { now: NOW }),
    assertCode("OPTICAL_VERIFICATION_RENDERER_CORRECTION_MISMATCH"),
  );
  const reorderedCorrections = planRequest();
  const first = reorderedCorrections.rendererCorrectionBinding.outputs.shift();
  reorderedCorrections.rendererCorrectionBinding.outputs.push(first);
  reorderedCorrections.rendererCorrectionBinding = refingerprintRendererBinding(
    reorderedCorrections.rendererCorrectionBinding,
  );
  assert.throws(
    () => createCameraOpticalVerificationPlan(reorderedCorrections, { now: NOW }),
    assertCode("OPTICAL_VERIFICATION_RENDERER_CORRECTION_MISMATCH"),
  );

  assert.equal(createCommand(
    COMMAND.START_CAMERA_OPTICAL_VERIFICATION,
    { plan: verificationPlan },
    { id: "fixed" },
  ).type, COMMAND.START_CAMERA_OPTICAL_VERIFICATION);
  assert.equal(createCommand(
    COMMAND.CONFIRM_CAMERA_OPTICAL_VERIFICATION,
    { schemaVersion: CAMERA_OPTICAL_VERIFICATION_SCHEMA_VERSION },
    { id: "fixed" },
  ).type, COMMAND.CONFIRM_CAMERA_OPTICAL_VERIFICATION);
  for (const command of [
    COMMAND.CANCEL_CAMERA_OPTICAL_VERIFICATION,
    COMMAND.RESTORE_AFTER_CAMERA_ROLLBACK,
  ]) assert.equal(createCommand(command, {}, { id: "fixed" }).type, command);

  const legacy = structuredClone(verificationPlan);
  legacy.schemaVersion = 1;
  assert.throws(
    () => normalizeCameraOpticalVerificationPlan(legacy, { now: NOW }),
    assertCode("INVALID_OPTICAL_VERIFICATION_CONTRACT"),
  );
  assert.throws(
    () => createCommand(COMMAND.START_CAMERA_OPTICAL_VERIFICATION, { plan: legacy }, { id: "legacy" }),
    /schema mismatch/,
  );
});

test("valid evidence normalizes to a verified report and terminal state", () => {
  const verificationPlan = plan();
  const report = conclusiveReport(verificationPlan);
  const normalizedReport = normalizeCameraOpticalVerificationReport(report, { plan: verificationPlan, now: NOW });
  assert.equal(normalizedReport.state, CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED);
  assert.equal(normalizedReport.captures.length, verificationPlan.steps.reduce((sum, step) => sum + step.repeats, 0));
  assert.equal(normalizedReport.evaluation.passed, true);

  const state = {
    ...createCameraOpticalVerificationState(verificationPlan, { at: STARTED_AT, now: NOW }),
    state: CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED,
    progress: completedProgress(verificationPlan),
    startedAt: STARTED_AT,
    updatedAt: COMPLETED_AT,
    completedAt: COMPLETED_AT,
    report,
  };
  const verified = normalizeCameraOpticalVerificationState(state, { plan: verificationPlan, now: NOW });
  assert.equal(verified.state, CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED);
  const superseded = normalizeCameraOpticalVerificationState({
    ...verified,
    state: CAMERA_OPTICAL_VERIFICATION_STATE.SUPERSEDED,
    updatedAt: "2026-08-24T10:11:00.000Z",
  }, { plan: verificationPlan, now: NOW });
  assert.equal(superseded.state, CAMERA_OPTICAL_VERIFICATION_STATE.SUPERSEDED);
  assert.deepEqual(superseded.report, verified.report,
    "superseding project authority must retain the validated conclusive report");
});

test("same-wall touching viewports derive a two-sided shared-edge camera band", () => {
  const request = planRequest();
  request.outputs[1].sourceViewport.x = 8;
  request.outputs[1].surfaceTarget.corners = [
    { x: 0.55, y: 0.1 },
    { x: 0.9, y: 0.1 },
    { x: 0.9, y: 0.8 },
    { x: 0.55, y: 0.8 },
  ];
  const verificationPlan = createCameraOpticalVerificationPlan(request, { now: NOW });
  assert.equal(verificationPlan.overlapBands.length, 1);
  assert.equal(verificationPlan.overlapBands[0].relation, "shared-edge");
  assert.equal(verificationPlan.overlapBands[0].cameraBandWidthPx, 12);
  assert.ok(verificationPlan.overlapBands[0].cameraPolygon.length >= 4);
  assert.ok(verificationPlan.overlapBands[0].cameraPolygon.some((point) => point.x < 0.55));
  assert.ok(verificationPlan.overlapBands[0].cameraPolygon.some((point) => point.x > 0.55));
});

test("fixed-view immersive corners derive cross-wall bands only when projected endpoints coincide", () => {
  const request = planRequest();
  request.outputs[1].sourceViewport.x = 8;
  request.outputs[1].surfaceTarget.wallId = "east-wall";
  request.outputs[1].surfaceTarget.surveyId = "survey-east-wall";
  request.outputs[1].surfaceTarget.corners = [
    { x: 0.55, y: 0.1 },
    { x: 0.9, y: 0.1 },
    { x: 0.9, y: 0.8 },
    { x: 0.55, y: 0.8 },
  ];
  const verificationPlan = createCameraOpticalVerificationPlan(request, { now: NOW });
  assert.equal(verificationPlan.overlapBands.length, 1);
  assert.equal(verificationPlan.overlapBands[0].relation, "cross-wall-shared-edge");
  assert.deepEqual(verificationPlan.overlapBands[0].wallIds, ["east-wall", "north-wall"]);
  assert.equal(verificationPlan.overlapBands[0].endpointMismatchMaxPx, 0);

  request.outputs[1].surfaceTarget.corners = [
    { x: 0.7, y: 0.1 },
    { x: 0.9, y: 0.1 },
    { x: 0.9, y: 0.8 },
    { x: 0.7, y: 0.8 },
  ];
  assert.throws(
    () => createCameraOpticalVerificationPlan(request, { now: NOW }),
    assertCode("OPTICAL_VERIFICATION_SHARED_EDGE_UNRESOLVED"),
  );
});

test("operator confirmations bind one random id to the current step and physical-condition lease", () => {
  const verificationPlan = plan();
  assert.deepEqual(
    [...new Set(verificationPlan.steps.map((step) => step.captureConditions.confirmationLeaseId))],
    ["verification-sensor-dark", "verification-ambient", "verification-projectors-on"],
  );
  const step = verificationPlan.steps[0];
  const prompt = createCameraOpticalVerificationOperatorPrompt(verificationPlan, {
    stepId: step.id,
    confirmationId: "c".repeat(32),
    requestedAt: "2026-08-24T10:00:05.000Z",
    now: NOW,
  });
  assert.match(prompt.instructions, /powered, warmed and EDID-connected/);
  assert.match(prompt.instructions, /manufacturer-rated shutter\/dowser/);
  assert.match(prompt.instructions, /Never disconnect a display/);
  assert.match(prompt.instructions, /hot projector lens/);
  const waitingState = {
    ...createCameraOpticalVerificationState(verificationPlan, { at: STARTED_AT, now: NOW }),
    state: CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR,
    progress: {
      completedSteps: 0,
      totalSteps: verificationPlan.steps.length,
      currentStepId: step.id,
      currentStepIndex: 0,
    },
    startedAt: STARTED_AT,
    updatedAt: "2026-08-24T10:00:05.000Z",
    operatorPrompt: prompt,
  };
  assert.equal(
    normalizeCameraOpticalVerificationState(waitingState, { plan: verificationPlan, now: NOW })
      .operatorPrompt.confirmationLeaseId,
    "verification-sensor-dark",
  );

  const confirmation = {
    schemaVersion: CAMERA_OPTICAL_VERIFICATION_SCHEMA_VERSION,
    verificationId: verificationPlan.verificationId,
    calibrationSessionId: verificationPlan.calibrationSessionId,
    nodeId: verificationPlan.nodeId,
    projectRevision: verificationPlan.project.appliedRevision,
    leaseToken: verificationPlan.leaseToken,
    stepId: step.id,
    confirmationId: prompt.confirmationId,
    confirmationLeaseId: prompt.confirmationLeaseId,
    confirmedAt: "2026-08-24T10:00:10.000Z",
  };
  assert.deepEqual(
    normalizeCameraOpticalVerificationConfirmation(confirmation, {
      plan: verificationPlan,
      state: waitingState,
      now: NOW,
    }),
    confirmation,
  );

  const stale = { ...confirmation, confirmationId: "d".repeat(32) };
  assert.throws(
    () => normalizeCameraOpticalVerificationConfirmation(stale, {
      plan: verificationPlan,
      state: waitingState,
      now: NOW,
    }),
    assertCode("OPTICAL_VERIFICATION_CONFIRMATION_STALE"),
  );

  const queuedState = structuredClone(waitingState);
  queuedState.updatedAt = confirmation.confirmedAt;
  queuedState.operatorPrompt.state = "confirmation-queued";
  queuedState.operatorPrompt.confirmedAt = confirmation.confirmedAt;
  assert.equal(
    normalizeCameraOpticalVerificationState(queuedState, { plan: verificationPlan, now: NOW })
      .operatorPrompt.state,
    "confirmation-queued",
  );
  assert.throws(
    () => normalizeCameraOpticalVerificationConfirmation(confirmation, {
      plan: verificationPlan,
      state: queuedState,
      now: NOW,
    }),
    assertCode("OPTICAL_VERIFICATION_CONFIRMATION_REPLAY"),
  );
});

test("real overlap-band gates produce a failed report without trusting whole-surface seam summaries", () => {
  const verificationPlan = plan();
  const metrics = passingMetrics(verificationPlan);
  metrics.combined.seamResidualP95 = 0;
  metrics.combined.seamResidualMax = 0;
  metrics.overlapBands[0].boundaryResidualP95 = 0.2;
  metrics.overlapBands[0].boundaryResidualMax = 0.2;
  const evaluated = evaluateCameraOpticalVerification(metrics, verificationPlan, { now: NOW });
  assert.equal(evaluated.passed, false);
  assert.deepEqual(evaluated.failedGateIds, [
    `overlap-band:${verificationPlan.overlapBands[0].id}:boundary-residual-p95`,
    `overlap-band:${verificationPlan.overlapBands[0].id}:boundary-residual-max`,
  ]);
  const report = conclusiveReport(verificationPlan, { metrics });
  assert.equal(
    normalizeCameraOpticalVerificationReport(report, { plan: verificationPlan, now: NOW }).state,
    CAMERA_OPTICAL_VERIFICATION_STATE.FAILED,
  );

  const spoofed = structuredClone(report);
  spoofed.state = CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED;
  spoofed.evaluation = {
    passed: true,
    failedGateIds: [],
    gates: structuredClone(verificationPlan.gates),
  };
  spoofed.failure = null;
  assert.throws(
    () => normalizeCameraOpticalVerificationReport(spoofed, { plan: verificationPlan, now: NOW }),
    assertCode("OPTICAL_VERIFICATION_RESULT_SPOOFED"),
  );
});

test("absolute black-floor gates reject a spatially uniform +0.20 lift", () => {
  const verificationPlan = plan();
  const metrics = passingMetrics(verificationPlan);
  metrics.combined.blackNonuniformityRange = 0;
  metrics.blackFloor.global.observedP95 = 0.22;
  metrics.blackFloor.global.absoluteDrift = 0.2;
  for (const observation of metrics.blackFloor.outputs) {
    observation.observedP95 = 0.22;
    observation.absoluteDrift = 0.2;
  }
  const evaluated = evaluateCameraOpticalVerification(metrics, verificationPlan, { now: NOW });
  assert.equal(evaluated.passed, false);
  assert.deepEqual(evaluated.failedGateIds, [
    "black-floor:global:absolute-drift",
    "black-floor:wall-a:absolute-drift",
    "black-floor:wall-b:absolute-drift",
  ]);
});

test("black-floor report cannot spoof its target, bridge scale, digest or derived drift", async (context) => {
  const verificationPlan = plan();
  const cases = [
    {
      name: "target",
      code: "OPTICAL_VERIFICATION_BASELINE_MISMATCH",
      mutate: (metrics) => { metrics.blackFloor.outputs[0].targetLevel += 0.01; },
    },
    {
      name: "measured normalization",
      code: "OPTICAL_VERIFICATION_BASELINE_MISMATCH",
      mutate: (metrics) => { metrics.blackFloor.outputs[0].measuredNormalizationScale += 1; },
    },
    {
      name: "black pedestal digest",
      code: "OPTICAL_VERIFICATION_BASELINE_MISMATCH",
      mutate: (metrics) => { metrics.blackFloor.outputs[0].blackPedestalSha256 = "f".repeat(64); },
    },
    {
      name: "derived drift",
      code: "INVALID_OPTICAL_VERIFICATION_REPORT",
      mutate: (metrics) => { metrics.blackFloor.outputs[0].absoluteDrift = 0; },
    },
  ];
  for (const entry of cases) {
    await context.test(entry.name, () => {
      const metrics = passingMetrics(verificationPlan);
      entry.mutate(metrics);
      assert.throws(
        () => evaluateCameraOpticalVerification(metrics, verificationPlan, { now: NOW }),
        assertCode(entry.code),
      );
    });
  }
});

test("planned overlap bands fail closed on missing or inadequate localized samples", () => {
  const verificationPlan = plan();
  const missing = passingMetrics(verificationPlan);
  missing.overlapBands = [];
  assert.throws(
    () => evaluateCameraOpticalVerification(missing, verificationPlan, { now: NOW }),
    assertCode("INVALID_OPTICAL_VERIFICATION_REPORT"),
  );

  const inadequate = passingMetrics(verificationPlan);
  inadequate.overlapBands[0].sampleCount = 8;
  inadequate.overlapBands[0].coverage = 0.2;
  inadequate.overlapBands[0].analysisBandWidthPx = 1;
  assert.deepEqual(
    evaluateCameraOpticalVerification(inadequate, verificationPlan, { now: NOW }).failedGateIds,
    [
      `overlap-band:${verificationPlan.overlapBands[0].id}:sample-count`,
      `overlap-band:${verificationPlan.overlapBands[0].id}:coverage`,
      `overlap-band:${verificationPlan.overlapBands[0].id}:analysis-band-width`,
    ],
  );
});

test("terminal evidence rejects missing, swapped, reused or post-capture confirmation leases", async (context) => {
  const verificationPlan = plan();
  const cases = [
    {
      name: "missing lease",
      mutate: (report) => { report.confirmations.pop(); },
    },
    {
      name: "swapped lease",
      mutate: (report) => { [report.confirmations[0], report.confirmations[1]] = [report.confirmations[1], report.confirmations[0]]; },
    },
    {
      name: "reused confirmation id",
      mutate: (report) => { report.confirmations[1].confirmationId = report.confirmations[0].confirmationId; },
    },
    {
      name: "reused server command id",
      mutate: (report) => { report.confirmations[1].serverCommandId = report.confirmations[0].serverCommandId; },
    },
    {
      name: "capture predates lease confirmation",
      mutate: (report) => { report.confirmations[2].confirmedAt = "2026-08-24T10:01:01.000Z"; },
    },
  ];
  for (const entry of cases) {
    await context.test(entry.name, () => {
      const report = conclusiveReport(verificationPlan);
      entry.mutate(report);
      assert.throws(
        () => normalizeCameraOpticalVerificationReport(report, { plan: verificationPlan, now: NOW }),
        assertCode("INVALID_OPTICAL_VERIFICATION_EVIDENCE"),
      );
    });
  }
});

test("report rejects renderer correction, revision, camera, lens, RAW-pipeline and pattern spoofing", async (context) => {
  const verificationPlan = plan();
  const cases = [
    {
      name: "renderer revision",
      code: "OPTICAL_VERIFICATION_REVISION_MISMATCH",
      mutate: (report) => { report.renderer.rendererProjectRevision += 1; },
    },
    {
      name: "forged renderer artifact with stale fingerprint",
      code: "RENDERER_CORRECTION_FINGERPRINT_MISMATCH",
      mutate: (report) => {
        report.renderer.activeCorrectionBinding.outputs[0].artifacts.warpMeshSha256 = sha256("forged-warp");
      },
    },
    {
      name: "different valid renderer correction receipt",
      code: "OPTICAL_VERIFICATION_RENDERER_CORRECTION_MISMATCH",
      mutate: (report) => {
        report.renderer.activeCorrectionBinding.outputs[0].artifacts.warpMeshSha256 = sha256("other-warp");
        report.renderer.activeCorrectionBinding = refingerprintRendererBinding(
          report.renderer.activeCorrectionBinding,
        );
        report.renderer.activeCorrectionFingerprint = report.renderer.activeCorrectionBinding.fingerprint;
      },
    },
    {
      name: "renderer identity bypass",
      code: "OPTICAL_VERIFICATION_RENDERER_CORRECTION_MISMATCH",
      mutate: (report) => {
        report.renderer.activeCorrectionBinding.outputs[0].processingBypass = true;
        report.renderer.activeCorrectionBinding = refingerprintRendererBinding(
          report.renderer.activeCorrectionBinding,
        );
        report.renderer.activeCorrectionFingerprint = report.renderer.activeCorrectionBinding.fingerprint;
      },
    },
    {
      name: "renderer fingerprint alias",
      code: "OPTICAL_VERIFICATION_RENDERER_CORRECTION_MISMATCH",
      mutate: (report) => { report.renderer.activeCorrectionFingerprint = "f".repeat(64); },
    },
    {
      name: "camera serial",
      code: "OPTICAL_VERIFICATION_CAMERA_MISMATCH",
      mutate: (report) => { report.provenance.camera.serial = "OTHER-CAMERA"; },
    },
    {
      name: "lens serial",
      code: "OPTICAL_VERIFICATION_LENS_MISMATCH",
      mutate: (report) => { report.provenance.lens.serial = "OTHER-LENS"; },
    },
    {
      name: "RAW pipeline",
      code: "OPTICAL_VERIFICATION_PIPELINE_MISMATCH",
      mutate: (report) => { report.provenance.pipeline.whiteBalanceApplied = true; },
    },
    {
      name: "corrected pattern bypass",
      code: "INVALID_OPTICAL_VERIFICATION_EVIDENCE",
      mutate: (report) => {
        const presentation = report.presentations.find((entry) => entry.pattern.applyCorrections === true);
        presentation.outputs.find((output) => output.id === presentation.outputId).correctionsBypassed = true;
      },
    },
    {
      name: "capture predates its pattern",
      code: "INVALID_OPTICAL_VERIFICATION_EVIDENCE",
      mutate: (report) => {
        const presentation = report.presentations[0];
        const capture = report.captures.find((entry) => entry.stepId === presentation.stepId);
        capture.capturedAt = "2026-08-24T10:00:30.000Z";
      },
    },
  ];
  for (const entry of cases) {
    await context.test(entry.name, () => {
      const report = conclusiveReport(verificationPlan);
      entry.mutate(report);
      assert.throws(
        () => normalizeCameraOpticalVerificationReport(report, { plan: verificationPlan, now: NOW }),
        assertCode(entry.code),
      );
    });
  }
});

test("capture completeness/digest uniqueness and persisted terminal states fail closed", () => {
  const verificationPlan = plan();
  const missing = conclusiveReport(verificationPlan);
  missing.captures.pop();
  assert.throws(
    () => normalizeCameraOpticalVerificationReport(missing, { plan: verificationPlan, now: NOW }),
    assertCode("INVALID_OPTICAL_VERIFICATION_EVIDENCE"),
  );

  const duplicate = conclusiveReport(verificationPlan);
  duplicate.captures[1].sourceSha256 = duplicate.captures[0].sourceSha256;
  assert.throws(
    () => normalizeCameraOpticalVerificationReport(duplicate, { plan: verificationPlan, now: NOW }),
    assertCode("INVALID_OPTICAL_VERIFICATION_EVIDENCE"),
  );

  const forgedState = {
    ...createCameraOpticalVerificationState(verificationPlan, { at: STARTED_AT, now: NOW }),
    state: CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED,
    progress: completedProgress(verificationPlan),
    startedAt: STARTED_AT,
    updatedAt: COMPLETED_AT,
    completedAt: COMPLETED_AT,
  };
  assert.throws(
    () => normalizeCameraOpticalVerificationState(forgedState, { plan: verificationPlan, now: NOW }),
    assertCode("INVALID_OPTICAL_VERIFICATION_STATE"),
  );
});

test("rollback state advances one revision and requires ordered renderer/restoration evidence", () => {
  const verificationPlan = plan();
  const metrics = passingMetrics(verificationPlan);
  metrics.overlapBands[0].boundaryResidualMax = 0.2;
  const report = conclusiveReport(verificationPlan, { metrics });
  const base = {
    ...createCameraOpticalVerificationState(verificationPlan, { at: STARTED_AT, now: NOW }),
    progress: completedProgress(verificationPlan),
    startedAt: report.startedAt,
    updatedAt: "2026-08-24T10:10:01.000Z",
    report,
  };
  const rolling = {
    ...base,
    state: CAMERA_OPTICAL_VERIFICATION_STATE.ROLLING_BACK,
    rollback: {
      state: "pending",
      trigger: "failed",
      sourceRevision: verificationPlan.project.appliedRevision,
      targetRevision: null,
      reason: "Optical verification failed",
      rendererAcknowledgedAt: null,
      restoredAt: null,
    },
  };
  assert.equal(
    normalizeCameraOpticalVerificationState(rolling, { plan: verificationPlan, now: NOW }).rollback.state,
    "pending",
  );

  const awaitingRenderer = structuredClone(rolling);
  awaitingRenderer.state = CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_RENDERER_ACK;
  awaitingRenderer.rollback.state = "renderer-ack";
  awaitingRenderer.rollback.targetRevision = verificationPlan.project.appliedRevision + 1;
  assert.equal(
    normalizeCameraOpticalVerificationState(awaitingRenderer, { plan: verificationPlan, now: NOW })
      .rollback.rendererAcknowledgedAt,
    null,
  );
  const rendererAcknowledged = structuredClone(awaitingRenderer);
  rendererAcknowledged.updatedAt = "2026-08-24T10:10:02.000Z";
  rendererAcknowledged.rollback.rendererAcknowledgedAt = rendererAcknowledged.updatedAt;
  assert.equal(
    normalizeCameraOpticalVerificationState(rendererAcknowledged, { plan: verificationPlan, now: NOW })
      .rollback.rendererAcknowledgedAt,
    rendererAcknowledged.updatedAt,
  );

  const restored = structuredClone(rolling);
  restored.state = CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK;
  restored.updatedAt = "2026-08-24T10:10:03.000Z";
  restored.completedAt = "2026-08-24T10:10:03.000Z";
  restored.rollback = {
    state: "restored",
    trigger: "failed",
    sourceRevision: verificationPlan.project.appliedRevision,
    targetRevision: verificationPlan.project.appliedRevision + 1,
    reason: "Optical verification failed",
    rendererAcknowledgedAt: "2026-08-24T10:10:02.000Z",
    restoredAt: "2026-08-24T10:10:03.000Z",
  };
  assert.equal(
    normalizeCameraOpticalVerificationState(restored, { plan: verificationPlan, now: NOW }).state,
    CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK,
  );

  const forged = structuredClone(restored);
  forged.rollback.targetRevision += 1;
  assert.throws(
    () => normalizeCameraOpticalVerificationState(forged, { plan: verificationPlan, now: NOW }),
    assertCode("OPTICAL_VERIFICATION_REVISION_MISMATCH"),
  );
});

test("cancelled rollback requires cancellation trigger/failure and forbids a conclusive gate report", () => {
  const verificationPlan = plan();
  const cancelled = {
    ...createCameraOpticalVerificationState(verificationPlan, { at: STARTED_AT, now: NOW }),
    state: CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED,
    startedAt: STARTED_AT,
    updatedAt: COMPLETED_AT,
    completedAt: COMPLETED_AT,
    failure: {
      code: "OPTICAL_VERIFICATION_CANCELLED",
      message: "Optical verification was cancelled",
      details: null,
    },
  };
  assert.equal(
    normalizeCameraOpticalVerificationState(cancelled, { plan: verificationPlan, now: NOW }).state,
    CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED,
  );
  const awaitingRenderer = {
    ...cancelled,
    state: CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_RENDERER_ACK,
    completedAt: null,
    rollback: {
      state: "renderer-ack",
      trigger: "cancelled",
      sourceRevision: verificationPlan.project.appliedRevision,
      targetRevision: verificationPlan.project.appliedRevision + 1,
      reason: "Authoritative cancellation rollback",
      rendererAcknowledgedAt: null,
      restoredAt: null,
    },
  };
  assert.equal(
    normalizeCameraOpticalVerificationState(awaitingRenderer, { plan: verificationPlan, now: NOW })
      .rollback.trigger,
    "cancelled",
  );

  const wrongFailure = structuredClone(awaitingRenderer);
  wrongFailure.failure.code = "OPTICAL_GATES_FAILED";
  assert.throws(
    () => normalizeCameraOpticalVerificationState(wrongFailure, { plan: verificationPlan, now: NOW }),
    assertCode("OPTICAL_VERIFICATION_RESULT_SPOOFED"),
  );
  const forgedReport = structuredClone(awaitingRenderer);
  forgedReport.progress = completedProgress(verificationPlan);
  forgedReport.report = conclusiveReport(verificationPlan);
  assert.throws(
    () => normalizeCameraOpticalVerificationState(forgedReport, { plan: verificationPlan, now: NOW }),
    assertCode("INVALID_OPTICAL_VERIFICATION_STATE"),
  );
  const wrongTrigger = structuredClone(awaitingRenderer);
  wrongTrigger.rollback.trigger = "failed";
  assert.throws(
    () => normalizeCameraOpticalVerificationState(wrongTrigger, { plan: verificationPlan, now: NOW }),
    assertCode("INVALID_OPTICAL_VERIFICATION_STATE"),
  );
});
