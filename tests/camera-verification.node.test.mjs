import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CAMERA_LOCK_FIELDS,
  normalizeManualCameraSettings,
} from "../runtime/shared/camera-calibration.mjs";
import { createCameraLensProfile } from "../runtime/shared/camera-lens-profile.mjs";
import {
  CAMERA_OPTICAL_VERIFICATION_STATE,
  createCameraOpticalVerificationOperatorPrompt,
  createCameraOpticalVerificationPlan,
  createCameraOpticalVerificationState,
  evaluateCameraOpticalVerification,
  normalizeCameraOpticalVerificationConfirmation,
  normalizeCameraOpticalVerificationReport,
  normalizeCameraOpticalVerificationState,
} from "../runtime/shared/camera-verification.mjs";
import { requiredGrayBits } from "../runtime/shared/calibration.mjs";
import {
  NativeRendererPatternOverrideAdapter,
  cameraTargetMeshForOutput,
} from "../runtime/node/camera-calibration.mjs";
import {
  CameraOpticalVerificationRunner,
  MeasuredCameraOpticalVerificationSolver,
} from "../runtime/node/camera-verification.mjs";
import { PixelBrightnessNode } from "../runtime/node/daemon.mjs";
import { NodeStateStore } from "../runtime/node/state-store.mjs";
import {
  COMMAND,
  createCommand,
  defaultProject,
  normalizeProject,
} from "../runtime/shared/protocol.mjs";
import { epochNowNs } from "../runtime/shared/timecore.mjs";

const ACKNOWLEDGED_AT = "2026-08-24T10:00:00.000Z";

let executionLeaseCounter = 0;

function executionLease(nodeId, ttlMs = 1_000) {
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

function clock(start = "2026-08-24T10:00:01.000Z") {
  let milliseconds = Date.parse(start);
  return () => {
    const value = new Date(milliseconds).toISOString();
    milliseconds += 100;
    return value;
  };
}

function camera() {
  return {
    id: "sony-a7iv-001",
    vendor: "Sony",
    model: "ILCE-7M4",
    serial: "A7IV-UNIT-001",
    transport: "usb",
    backend: "sony-camera-remote-sdk",
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
      calibratedAt: "2026-08-01T00:00:00.000Z",
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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(label) {
  return createHash("sha256").update(label).digest("hex");
}

function rendererCorrectionBinding(baselines) {
  const payload = {
    schemaVersion: 1,
    algorithm: "sha256",
    configSha256: sha256("native-renderer-config:revision-8"),
    outputs: baselines.map((baseline) => ({
      id: baseline.outputId,
      processingBypass: false,
      artifacts: {
        warpMeshSha256: sha256(`native-warp:${baseline.outputId}`),
        blendMapSha256: sha256(`native-blend:${baseline.outputId}`),
        blackMapSha256: baseline.blackPedestalSha256,
        maskSha256: sha256(`native-mask:${baseline.outputId}`),
        colorLutSha256: sha256(`native-lut:${baseline.outputId}`),
      },
    })),
  };
  return {
    ...payload,
    fingerprint: createHash("sha256").update(canonicalJson(payload)).digest("hex"),
  };
}

function surfaceTarget(profile, id, offset = 0, { wallId = `wall-${id}`, corners = null } = {}) {
  return {
    outputId: id,
    wallId,
    surveyId: `survey-${id}`,
    cameraViewId: "camera-view-main",
    lensProfileSha256: profile.sha256,
    frame: structuredClone(profile.frame),
    corners: corners || [
      { x: 0.1 + offset, y: 0.1 },
      { x: 0.9 + offset, y: 0.1 },
      { x: 0.9 + offset, y: 0.8 },
      { x: 0.1 + offset, y: 0.8 },
    ],
    method: "operator-four-corner-planar-v1",
  };
}

function verificationPlan({
  outputIds = ["A"],
  sharedEdge = false,
  rendererAcknowledgedAt = ACKNOWLEDGED_AT,
} = {}) {
  const profile = lensProfile();
  const exposureProfiles = [
    { id: "geometry-short", role: "geometry", normalizationScale: 1, settings: settings(16_667) },
    { id: "radiometry-long", role: "radiometry", normalizationScale: 60, settings: settings(1_000_000) },
  ];
  const blackFloorBaselines = outputIds.map((id) => ({
    outputId: id,
    calibrationSessionId: "calibration-room-a-v2",
    sourceManifestSchemaVersion: 2,
    blackPedestalSha256: sha256(`black-pedestal:${id}`),
    exposureProfileId: "radiometry-long",
    normalizationScale: 60,
    exposureBridgeId: `calibration-room-a-v2/${id}/exposure-bridge`,
    exposureBridgeStatus: "passed",
    exposureBridgeGatesPassed: true,
    measuredNormalizationScale: 60,
    normalizationRelativeUncertainty: 0.005,
    measurementBasis: "sensor-dark-subtracted-exposure-normalized-camera-linear-luma",
    targetLevel: 0,
  }));
  return createCameraOpticalVerificationPlan({
    verificationId: `verify-${outputIds.join("-")}-revision-8`,
    leaseToken: "verification_lease_token_00000001",
    calibrationSessionId: "calibration-room-a-v2",
    nodeId: "node-a",
    project: { id: "room-a", baseRevision: 7, appliedRevision: 8 },
    rendererAcknowledgedAt,
    camera: camera(),
    lensProfile: profile,
    exposureProfiles,
    outputs: outputIds.map((id, index) => ({
      id,
      resolution: { width: 8, height: 4 },
      sourceViewport: { x: sharedEdge ? index : index * 2, y: 0, width: 1, height: 1 },
      surfaceTarget: sharedEdge
        ? surfaceTarget(profile, id, 0, {
          wallId: "wall-shared",
          corners: index === 0
            ? [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.8 }, { x: 0.1, y: 0.8 }]
            : [{ x: 0.5, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.8 }, { x: 0.5, y: 0.8 }],
        })
        : surfaceTarget(profile, id, index * -0.02),
    })),
    blackFloorBaselines,
    rendererCorrectionBinding: rendererCorrectionBinding(blackFloorBaselines),
    mesh: { columns: 4, rows: 3, minimumConfidence: 0.75 },
    nearBlackLevels: [1 / 255, 4 / 255, 16 / 255],
    settleFrames: 2,
  });
}

function passingMetrics(plan) {
  return {
    geometry: plan.outputs.map((output) => ({
      outputId: output.id,
      holes: 0,
      confidence: 0.95,
      targetResidualP95Px: 0.5,
      targetResidualMaxPx: 1,
      projectorDriftP95Px: 0.5,
      projectorDriftMaxPx: 1,
      pixelCoverage: 0.95,
      tileCoverage: 0.99,
      clippedFraction: 0,
    })),
    radiometry: plan.outputs.map((output) => ({
      outputId: output.id,
      coverage: 0.95,
      clippedFraction: 0,
      normalSnrDb: 40,
      nearBlackSnrDb: 30,
      relativeUncertainty: 0.005,
      neutralRatioRelativeErrorRgb: [0.01, 0.01, 0.01],
      nearBlackRelativeErrorRgb: [0.02, 0.02, 0.02],
      primaryRmse: 0.01,
      primaryMaxError: 0.02,
    })),
    combined: {
      blackUncertaintyP95: 0.001,
      blackNonuniformityRange: 0.002,
      negativeBeyondUncertaintyFraction: 0,
      seamResidualP95: 0.01,
      seamResidualMax: 0.02,
    },
    blackFloor: {
      measurementBasis: plan.blackFloorBaselines[0].measurementBasis,
      exposureProfileId: plan.blackFloorBaselines[0].exposureProfileId,
      normalizationScale: plan.blackFloorBaselines[0].normalizationScale,
      globalMeasuredNormalizationScale: plan.globalMeasuredNormalizationScale,
      globalNormalizationRelativeUncertainty: plan.globalNormalizationRelativeUncertainty,
      global: {
        targetLevel: Math.max(...plan.blackFloorBaselines.map((baseline) => baseline.targetLevel)),
        observedP95: Math.max(...plan.blackFloorBaselines.map((baseline) => baseline.targetLevel)),
        absoluteDrift: 0,
        uncertaintyP95: 0.001,
        sampleCount: 128,
      },
      outputs: plan.blackFloorBaselines.map((baseline) => ({
        outputId: baseline.outputId,
        blackPedestalSha256: baseline.blackPedestalSha256,
        exposureBridgeId: baseline.exposureBridgeId,
        measuredNormalizationScale: baseline.measuredNormalizationScale,
        normalizationRelativeUncertainty: baseline.normalizationRelativeUncertainty,
        targetLevel: baseline.targetLevel,
        observedP95: baseline.targetLevel,
        absoluteDrift: 0,
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
      coverage: 1,
      analysisBandWidthPx: 4,
      boundaryResidualP95: 0.01,
      boundaryResidualMax: 0.02,
    })),
  };
}

class FakeCamera {
  constructor(plan, now, { invalidPipeline = false } = {}) {
    this.plan = plan;
    this.now = now;
    this.invalidPipeline = invalidPipeline;
    this.captureIndex = 0;
  }

  async detect() {
    return { adapter: { available: true }, cameras: [structuredClone(this.plan.camera)], error: null };
  }

  async open() {
    return structuredClone(this.plan.camera);
  }

  async lockManualSettings(input) {
    return {
      confirmed: true,
      applied: normalizeManualCameraSettings(input),
      lockedFields: [...CAMERA_LOCK_FIELDS],
    };
  }

  async capture({ step, repeat, exposureSettings }) {
    const pixels = this.plan.lensProfile.frame.width * this.plan.lensProfile.frame.height;
    const data = new Float32Array(pixels * 3).fill(0.2);
    const index = this.captureIndex++;
    return {
      id: `adapter-${index}`,
      capturedAt: this.now(),
      width: this.plan.lensProfile.frame.width,
      height: this.plan.lensProfile.frame.height,
      pixelFormat: "linear-rgb-f32",
      bitDepth: 14,
      linearized: true,
      data,
      cameraDevice: structuredClone(this.plan.camera),
      lens: {
        vendor: this.plan.lensProfile.lens.manufacturer,
        model: this.plan.lensProfile.lens.model,
        serial: this.plan.lensProfile.lens.serialNumber,
        focalLengthMm: this.plan.lensProfile.capture.focalLengthMm,
        apertureF: this.plan.lensProfile.capture.apertureFNumber,
        focusDistanceM: this.plan.lensProfile.capture.focusDistanceM,
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
        blackLevelSubtracted: this.invalidPipeline,
        whiteBalanceApplied: false,
        toneCurveApplied: false,
        noiseReductionApplied: false,
        lensCorrectionsApplied: false,
      },
      provenance: {
        settings: structuredClone(exposureSettings),
        sourceSha256: createHash("sha256").update(`${step.id}#${repeat}#${index}`).digest("hex"),
      },
    };
  }

  async close() {}
}

class FakePattern {
  constructor(plan) {
    this.plan = plan;
    this.sequence = 0;
    this.mode = "content";
  }

  async beginVerification() {
    this.mode = "black";
    return { exclusive: true, arenaBlanked: true, mode: "black" };
  }

  async showVerificationStep(step) {
    assert.equal(step.sequence, this.sequence++);
    if (!step.pattern) {
      return { presented: true, exclusive: true, arenaBlanked: true, stepId: step.id, presentation: null };
    }
    return {
      presented: true,
      exclusive: true,
      arenaBlanked: true,
      stepId: step.id,
      presentation: {
        outputs: this.plan.outputs.map((output, index) => {
          const targeted = step.outputId == null || step.outputId === output.id;
          return {
            id: output.id,
            pattern: targeted ? step.pattern.type : "black",
            patternParameters: targeted
              ? step.pattern.type === "solid"
                ? { rgb: [...step.pattern.rgb], applyCorrections: step.pattern.applyCorrections === true }
                : { axis: step.pattern.axis, bit: step.pattern.bit, inverse: step.pattern.inverse === true }
              : {},
            correctionsBypassed: !targeted || step.pattern.applyCorrections !== true,
            processingBypass: false,
            blank: false,
            renderedFramesBefore: step.sequence * 10 + index,
            renderedFramesAfter: step.sequence * 10 + index + step.settleFrames,
          };
        }),
      },
    };
  }

  verificationRendererEvidence() {
    return {
      nodeProjectRevision: this.plan.project.appliedRevision,
      rendererProjectRevision: this.plan.project.appliedRevision,
      connected: true,
      ready: true,
      acknowledgedAt: this.plan.rendererAcknowledgedAt,
      capabilities: { correctedSolid: true, rawGrayCode: true, preservesWarp: true, targetIsolation: true },
      outputBindings: this.plan.outputs.map((output) => ({
        outputId: output.id,
        calibrationSessionId: this.plan.calibrationSessionId,
      })),
      activeCorrectionBinding: structuredClone(this.plan.rendererCorrectionBinding),
      activeCorrectionFingerprint: this.plan.rendererCorrectionBinding.fingerprint,
    };
  }

  async completeVerification() {
    this.mode = "content";
    return { restored: true, mode: "content" };
  }

  async failClosed() {
    this.mode = "black";
    return { failClosed: true, mode: "black" };
  }

  async restoreAfterRollback({ projectRevision }) {
    this.mode = "content";
    return { restored: true, mode: "content", projectRevision };
  }
}

function confirmation(plan, state, confirmedAt) {
  const prompt = state.operatorPrompt;
  return {
    schemaVersion: plan.schemaVersion,
    verificationId: plan.verificationId,
    calibrationSessionId: plan.calibrationSessionId,
    nodeId: plan.nodeId,
    projectRevision: plan.project.appliedRevision,
    leaseToken: plan.leaseToken,
    stepId: prompt.stepId,
    confirmationId: prompt.confirmationId,
    confirmationLeaseId: prompt.confirmationLeaseId,
    confirmedAt,
  };
}

test("runner binds three operator leases, exact RAW provenance and corrected presentation evidence", async () => {
  const plan = verificationPlan();
  const now = clock();
  const pattern = new FakePattern(plan);
  let confirmationCount = 0;
  const states = [];
  const runner = new CameraOpticalVerificationRunner({
    cameraAdapter: new FakeCamera(plan, now),
    patternAdapter: pattern,
    solver: { solve: async () => passingMetrics(plan) },
    now,
    onTransition: (state) => { states.push(state); },
    requestOperatorConfirmation: ({ state }) => {
      confirmationCount += 1;
      return {
        confirmation: confirmation(plan, state, now()),
        serverCommandId: `confirm-command-${confirmationCount}`,
        serverCommandSequence: confirmationCount,
      };
    },
  });
  const result = await runner.run(plan, {
    baselineManifest: { sessionId: plan.calibrationSessionId },
    nodeProjectRevision: plan.project.appliedRevision,
  });
  assert.equal(
    result.state.state,
    CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED,
    JSON.stringify({ failure: result.state.failure, evaluation: result.report?.evaluation }),
  );
  assert.equal(result.failClosed, false);
  assert.equal(pattern.mode, "content");
  assert.equal(confirmationCount, 3);
  assert.equal(states.filter((state) => state.state === CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR).length, 3);
  assert.equal(result.report.captures.length, plan.steps.reduce((total, step) => total + step.repeats, 0));
  const corrected = result.report.presentations.find((entry) => entry.pattern.applyCorrections === true);
  assert.equal(corrected.outputs[0].correctionsBypassed, false);
  assert.equal(corrected.outputs[0].processingBypass, false);
  assert.deepEqual(normalizeCameraOpticalVerificationReport(result.report, { plan }), result.report);
});

test("runner leaves sticky black for failed gates and blocks a changed RAW pipeline without a forged report", async () => {
  const failedPlan = verificationPlan();
  const failedNow = clock();
  const failedPattern = new FakePattern(failedPlan);
  let failedConfirmationSequence = 0;
  const failedMetrics = passingMetrics(failedPlan);
  failedMetrics.geometry[0].holes = 1;
  const failed = await new CameraOpticalVerificationRunner({
    cameraAdapter: new FakeCamera(failedPlan, failedNow),
    patternAdapter: failedPattern,
    solver: { solve: async () => failedMetrics },
    now: failedNow,
    requestOperatorConfirmation: ({ state }) => {
      failedConfirmationSequence += 1;
      return {
        confirmation: confirmation(failedPlan, state, failedNow()),
        serverCommandId: `failed-confirm-${failedConfirmationSequence}`,
        serverCommandSequence: failedConfirmationSequence,
      };
    },
  }).run(failedPlan, {
    baselineManifest: { sessionId: failedPlan.calibrationSessionId },
    nodeProjectRevision: failedPlan.project.appliedRevision,
  });
  assert.equal(failed.state.state, CAMERA_OPTICAL_VERIFICATION_STATE.FAILED);
  assert.equal(failed.report.evaluation.passed, false);
  assert.equal(failed.failClosed, true);
  assert.equal(failedPattern.mode, "black");

  const blockedPlan = verificationPlan();
  const blockedNow = clock();
  const blockedPattern = new FakePattern(blockedPlan);
  let blockedConfirmationSequence = 0;
  const blocked = await new CameraOpticalVerificationRunner({
    cameraAdapter: new FakeCamera(blockedPlan, blockedNow, { invalidPipeline: true }),
    patternAdapter: blockedPattern,
    solver: { solve: async () => passingMetrics(blockedPlan) },
    now: blockedNow,
    requestOperatorConfirmation: ({ state }) => {
      blockedConfirmationSequence += 1;
      return {
        confirmation: confirmation(blockedPlan, state, blockedNow()),
        serverCommandId: `blocked-confirm-${blockedConfirmationSequence}`,
        serverCommandSequence: blockedConfirmationSequence,
      };
    },
  }).run(blockedPlan, {
    baselineManifest: { sessionId: blockedPlan.calibrationSessionId },
    nodeProjectRevision: blockedPlan.project.appliedRevision,
  });
  assert.equal(blocked.state.state, CAMERA_OPTICAL_VERIFICATION_STATE.BLOCKED);
  assert.equal(blocked.state.failure.code, "OPTICAL_VERIFICATION_PIPELINE_MISMATCH");
  assert.equal(blocked.report, null);
  assert.equal(blocked.failClosed, true);
  assert.equal(blockedPattern.mode, "black");
});

test("runner establishes sticky black when measured preflight fails before pattern ownership", async () => {
  const plan = verificationPlan();
  const now = clock();
  const pattern = new FakePattern(plan);
  const result = await new CameraOpticalVerificationRunner({
    cameraAdapter: new FakeCamera(plan, now),
    patternAdapter: pattern,
    solver: {
      begin: async () => {
        const error = new Error("baseline artifact is unavailable");
        error.code = "OPTICAL_VERIFICATION_BASELINE_INVALID";
        throw error;
      },
      solve: async () => passingMetrics(plan),
    },
    now,
    requestOperatorConfirmation: () => {
      throw new Error("preflight must fail before confirmation");
    },
  }).run(plan, {
    baselineManifest: { sessionId: plan.calibrationSessionId },
    nodeProjectRevision: plan.project.appliedRevision,
  });
  assert.equal(result.state.state, CAMERA_OPTICAL_VERIFICATION_STATE.BLOCKED);
  assert.equal(result.state.report, null);
  assert.equal(result.failClosed, true);
  assert.equal(pattern.mode, "black");
});

test("cancellation after pattern ownership retains sticky black until authoritative rollback", async () => {
  const plan = verificationPlan();
  const now = clock();
  const pattern = new FakePattern(plan);
  const abort = new AbortController();
  const result = await new CameraOpticalVerificationRunner({
    cameraAdapter: new FakeCamera(plan, now),
    patternAdapter: pattern,
    solver: { solve: async () => passingMetrics(plan) },
    now,
    requestOperatorConfirmation: ({ state }) => {
      const confirmationResult = confirmation(plan, state, now());
      abort.abort();
      return {
        confirmation: confirmationResult,
        serverCommandId: "cancel-confirm-1",
        serverCommandSequence: 1,
      };
    },
  }).run(plan, {
    signal: abort.signal,
    baselineManifest: { sessionId: plan.calibrationSessionId },
    nodeProjectRevision: plan.project.appliedRevision,
  });
  assert.equal(result.state.state, CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED);
  assert.equal(result.state.failure.code, "OPTICAL_VERIFICATION_CANCELLED");
  assert.equal(result.failClosed, true);
  assert.equal(result.report, null);
  assert.equal(pattern.mode, "black");
});

test("cancellation wins at the final report release boundary before content can be restored", async () => {
  const plan = verificationPlan();
  const now = clock();
  const abort = new AbortController();
  class ReleaseBoundaryPattern extends FakePattern {
    constructor(activePlan) {
      super(activePlan);
      this.evidenceCalls = 0;
      this.contentRestoreCalls = 0;
    }

    verificationRendererEvidence() {
      this.evidenceCalls += 1;
      const evidence = super.verificationRendererEvidence();
      if (this.evidenceCalls === 1) abort.abort();
      return evidence;
    }

    async completeVerification() {
      this.contentRestoreCalls += 1;
      return super.completeVerification();
    }
  }
  const pattern = new ReleaseBoundaryPattern(plan);
  let sequence = 1;
  const result = await new CameraOpticalVerificationRunner({
    cameraAdapter: new FakeCamera(plan, now),
    patternAdapter: pattern,
    solver: { solve: async () => passingMetrics(plan) },
    now,
    requestOperatorConfirmation: ({ state }) => ({
      confirmation: confirmation(plan, state, now()),
      serverCommandId: `release-boundary-confirm-${sequence}`,
      serverCommandSequence: sequence++,
    }),
  }).run(plan, {
    signal: abort.signal,
    baselineManifest: { sessionId: plan.calibrationSessionId },
    nodeProjectRevision: plan.project.appliedRevision,
  });
  assert.equal(result.state.state, CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED);
  assert.equal(result.failClosed, true);
  assert.equal(pattern.contentRestoreCalls, 0);
  assert.equal(pattern.mode, "black");
});

test("native pattern adapter proves corrected target, raw non-target black and settled frame counters", async () => {
  const plan = verificationPlan({ outputIds: ["A", "B"] });
  class Engine {
    constructor() {
      this.outputs = plan.outputs.map((output) => ({
        id: output.id,
        active: true,
        blank: false,
        pattern: "content",
        patternParameters: {},
        processingBypass: false,
        correctionsBypassed: false,
        renderedFrames: 0,
      }));
      this.capabilities = {
        modes: ["solid", "gray-code", "content"],
        rawCorrectionBypass: true,
        targetIsolation: true,
        applyCorrectionsModes: ["solid"],
        preservesWarp: true,
        solidEncoding: "linear",
        grayCodeCoordinate: "physical-output-pixel",
      };
      this.activeCorrectionBinding = structuredClone(plan.rendererCorrectionBinding);
    }

    calibrationPatternCapabilities() { return this.capabilities; }

    diagnostics() {
      return {
        connected: true,
        ready: true,
        projectRevision: plan.project.appliedRevision,
        activeCorrectionBinding: structuredClone(this.activeCorrectionBinding),
        activeCorrectionFingerprint: this.activeCorrectionBinding.fingerprint,
        correctionBindingMatches: true,
      };
    }

    async refreshStatus() {
      this.outputs.forEach((output) => { output.renderedFrames += 1; });
      return { state: "running", outputs: structuredClone(this.outputs) };
    }

    async blank(enabled) {
      this.outputs.forEach((output) => { output.blank = enabled; });
    }

    async setPattern(pattern) {
      this.outputs.forEach((output) => {
        output.blank = false;
        const targeted = !pattern.outputId || output.id === pattern.outputId || pattern.type === "content";
        output.pattern = targeted ? pattern.type : "black";
        output.patternParameters = !targeted ? {} : pattern.type === "solid"
          ? { rgb: [...pattern.rgb], applyCorrections: pattern.applyCorrections === true }
          : pattern.type === "gray-code"
            ? { axis: pattern.axis, bit: pattern.bit, inverse: pattern.inverse === true }
            : {};
        output.correctionsBypassed = pattern.type === "content"
          ? false
          : !targeted || pattern.applyCorrections !== true;
      });
    }
  }
  const engine = new Engine();
  const adapter = new NativeRendererPatternOverrideAdapter({ engine, pollMs: 1, settleTimeoutMs: 1_000 });
  await adapter.beginVerification({ plan, nodeProjectRevision: plan.project.appliedRevision });
  const correctedIndex = plan.steps.findIndex((step) => step.outputId === "A" && step.purpose === "corrected-neutral-018");
  let corrected;
  for (const step of plan.steps.slice(0, correctedIndex + 1)) {
    const result = await adapter.showVerificationStep(step);
    if (step.sequence === correctedIndex) corrected = result.presentation;
  }
  assert.equal(corrected.outputs[0].pattern, "solid");
  assert.deepEqual(corrected.outputs[0].patternParameters, { rgb: [0.18, 0.18, 0.18], applyCorrections: true });
  assert.equal(corrected.outputs[0].correctionsBypassed, false);
  assert.equal(corrected.outputs[1].pattern, "black");
  assert.equal(corrected.outputs[1].correctionsBypassed, true);
  assert.equal(corrected.outputs[0].processingBypass, false);
  assert.ok(corrected.outputs.every((output) => output.renderedFramesAfter - output.renderedFramesBefore >= 2));

  const changedBinding = structuredClone(engine.activeCorrectionBinding);
  changedBinding.configSha256 = sha256("unexpected-native-config");
  const changedPayload = { ...changedBinding };
  delete changedPayload.fingerprint;
  changedBinding.fingerprint = createHash("sha256").update(canonicalJson(changedPayload)).digest("hex");
  engine.activeCorrectionBinding = changedBinding;
  await assert.rejects(
    () => adapter.verificationRendererEvidence({ plan, nodeProjectRevision: plan.project.appliedRevision }),
    (error) => error.code === "OPTICAL_VERIFICATION_RENDERER_CORRECTION_MISMATCH",
  );

  const mismatched = new Engine();
  mismatched.activeCorrectionBinding = structuredClone(changedBinding);
  await assert.rejects(
    () => new NativeRendererPatternOverrideAdapter({ engine: mismatched }).beginVerification({
      plan,
      nodeProjectRevision: plan.project.appliedRevision,
    }),
    (error) => error.code === "OPTICAL_VERIFICATION_RENDERER_CORRECTION_MISMATCH",
  );

  const incapable = new Engine();
  incapable.capabilities.applyCorrectionsModes = [];
  await assert.rejects(
    () => new NativeRendererPatternOverrideAdapter({ engine: incapable }).beginVerification({
      plan,
      nodeProjectRevision: plan.project.appliedRevision,
    }),
    (error) => error.code === "CALIBRATION_PATTERN_ADAPTER_UNAVAILABLE",
  );
});

function syntheticCapture(plan, step, { blackLiftNormalized = 0, boundaryDefect = 0 } = {}) {
  const { width, height } = plan.lensProfile.frame;
  const profile = plan.exposureProfiles.find((candidate) => candidate.id === step.exposureProfileId);
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let rgb;
      if (step.purpose === "sensor-dark") {
        rgb = [profile.role === "geometry" ? 0.001 : 0.002, profile.role === "geometry" ? 0.001 : 0.002,
          profile.role === "geometry" ? 0.001 : 0.002];
      } else if (step.purpose === "projectors-off-ambient") {
        rgb = [0.005, 0.005, 0.005];
      } else if (step.purpose === "geometry-white") {
        rgb = [0.8, 0.8, 0.8];
      } else if (step.purpose === "geometry-gray-code") {
        const output = plan.outputs.find((candidate) => candidate.id === step.outputId);
        const dimension = step.pattern.axis === "x" ? output.resolution.width : output.resolution.height;
        const coordinates = output.surfaceTarget.corners.map((point) => (
          step.pattern.axis === "x" ? point.x : point.y
        ));
        const minimum = Math.min(...coordinates);
        const maximum = Math.max(...coordinates);
        const cameraPosition = step.pattern.axis === "x" ? x / (width - 1) : y / (height - 1);
        const position = Math.max(0, Math.min(1, (cameraPosition - minimum) / (maximum - minimum)));
        const coordinate = Math.min(dimension - 1, Math.round(position * (dimension - 1)));
        const shift = requiredGrayBits(dimension) - step.pattern.bit - 1;
        const gray = coordinate ^ (coordinate >> 1);
        const on = (((gray >> shift) & 1) === 1) !== step.pattern.inverse;
        rgb = [on ? 0.8 : 0.01, on ? 0.8 : 0.01, on ? 0.8 : 0.01];
      } else {
        const base = profile.role === "radiometry" ? 0.02 : 0.01;
        rgb = step.pattern.rgb.map((channel) => base + channel * profile.normalizationScale);
        if (step.purpose === "global-corrected-black-long" && blackLiftNormalized !== 0) {
          rgb = rgb.map((channel) => channel + blackLiftNormalized * profile.normalizationScale);
        }
        if (step.purpose === "global-corrected-neutral-018" && boundaryDefect !== 0
          && Math.abs(x / (width - 1) - 0.5) <= 0.1) {
          const sign = x / (width - 1) < 0.5 ? -1 : 1;
          rgb = rgb.map((channel) => channel + sign * boundaryDefect * profile.normalizationScale);
        }
      }
      const offset = (y * width + x) * 3;
      data.set(rgb, offset);
    }
  }
  return { width, height, data };
}

async function measuredSolverFixture(root, plan) {
  const outputs = [];
  for (const output of plan.outputs) {
    const target = cameraTargetMeshForOutput({
      plan,
      output,
      cameraWidth: plan.lensProfile.frame.width,
      cameraHeight: plan.lensProfile.frame.height,
      fallbackCorners: output.surfaceTarget.corners,
    });
    const points = target.points.map((point) => ({
      u: point.u,
      v: point.v,
      x: Math.round(point.cameraX * (output.resolution.width - 1)) / (output.resolution.width - 1),
      y: Math.round(point.cameraY * (output.resolution.height - 1)) / (output.resolution.height - 1),
    }));
    const bytes = Buffer.from(JSON.stringify({
      columns: plan.mesh.columns,
      rows: plan.mesh.rows,
      interpolation: "bicubic",
      points,
    }));
    const pathname = join(root, `${output.id}.warp.json`);
    await writeFile(pathname, bytes);
    const baseline = plan.blackFloorBaselines.find((candidate) => candidate.outputId === output.id);
    outputs.push({
      outputId: output.id,
      geometry: { status: "passed", lensProfileSha256: plan.lensProfile.sha256 },
      radiometry: {
        black: { target: baseline.targetLevel },
        measuredExposureNormalization: {
          bridgeId: baseline.exposureBridgeId,
          longProfileId: baseline.exposureProfileId,
          nominalScale: baseline.normalizationScale,
          measuredScaleLuma: baseline.measuredNormalizationScale,
          uncertaintyLuma: baseline.normalizationRelativeUncertainty,
          status: baseline.exposureBridgeStatus,
          gates: { passed: baseline.exposureBridgeGatesPassed },
        },
      },
      artifacts: {
        warp: {
          uri: new URL(`file://${pathname}`).href,
          path: pathname,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteLength: bytes.byteLength,
          format: "pb-warp-mesh-v1",
          columns: plan.mesh.columns,
          rows: plan.mesh.rows,
          interpolation: "bicubic",
          pointCount: points.length,
        },
        blackPedestal: { sha256: baseline.blackPedestalSha256 },
      },
    });
  }
  const baselineManifest = {
    schemaVersion: 2,
    sessionId: plan.calibrationSessionId,
    applicable: true,
    provenance: "measured",
    lensProfile: structuredClone(plan.lensProfile),
    captureProvenance: { device: structuredClone(plan.camera) },
    outputs,
  };
  const solver = new MeasuredCameraOpticalVerificationSolver({ artifactRoot: root, maxAnalysisPixels: 65_536 });
  await solver.begin({ plan, baselineManifest });
  return { solver, baselineManifest };
}

test("measured solver verifies the hashed baseline warp and derives finite distortion-aware Gray metrics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-optical-verification-solver-"));
  try {
    const plan = verificationPlan();
    const { solver, baselineManifest } = await measuredSolverFixture(root, plan);
    const solveStartedAt = Date.now();
    for (const step of plan.steps) {
      for (let repeat = 0; repeat < step.repeats; repeat += 1) {
        await solver.consumeCapture({ step, capture: syntheticCapture(plan, step) });
      }
    }
    const metrics = await solver.solve();
    const evaluated = evaluateCameraOpticalVerification(metrics, plan);
    assert.ok(Date.now() - solveStartedAt < 1_000, "bounded 64x48 metric fixture unexpectedly repeated raster scans");
    assert.equal(evaluated.metrics.geometry[0].holes, 0);
    assert.ok(evaluated.metrics.geometry[0].confidence >= plan.mesh.minimumConfidence);
    assert.ok(Number.isFinite(evaluated.metrics.geometry[0].projectorDriftP95Px));
    assert.ok(Number.isFinite(evaluated.metrics.radiometry[0].primaryRmse));
    assert.ok(Math.max(...evaluated.metrics.radiometry[0].neutralRatioRelativeErrorRgb) < 1e-5);
    assert.ok(Math.max(...evaluated.metrics.radiometry[0].nearBlackRelativeErrorRgb) < 1e-5);
    assert.ok(evaluated.metrics.radiometry[0].primaryRmse < 1e-5);
    assert.equal(evaluated.metrics.combined.seamResidualMax, 0);
    assert.ok(evaluated.metrics.blackFloor.global.sampleCount >= 64);
    assert.ok(evaluated.metrics.blackFloor.global.absoluteDrift < 0.01);
    assert.deepEqual(evaluated.metrics.overlapBands, []);

    const forged = structuredClone(baselineManifest);
    forged.outputs[0].artifacts.warp.sha256 = "0".repeat(64);
    await assert.rejects(
      () => new MeasuredCameraOpticalVerificationSolver({ artifactRoot: root }).begin({ plan, baselineManifest: forged }),
      (error) => error.code === "CALIBRATION_ARTIFACT_HASH_MISMATCH",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("measured solver fails a spatially uniform long-exposure black-floor lift", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-optical-verification-black-lift-"));
  try {
    const plan = verificationPlan();
    const { solver } = await measuredSolverFixture(root, plan);
    for (const step of plan.steps) {
      for (let repeat = 0; repeat < step.repeats; repeat += 1) {
        await solver.consumeCapture({
          step,
          capture: syntheticCapture(plan, step, { blackLiftNormalized: 0.02 }),
        });
      }
    }
    const evaluated = evaluateCameraOpticalVerification(await solver.solve(), plan);
    assert.equal(evaluated.passed, false);
    assert.ok(evaluated.metrics.blackFloor.global.absoluteDrift > plan.gates.blackFloor.maximumAbsoluteDrift);
    assert.ok(evaluated.failedGateIds.includes("black-floor:global:absolute-drift"));
    assert.ok(evaluated.failedGateIds.includes("black-floor:A:absolute-drift"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("measured solver gates localized shared-edge discontinuity even when surface means balance", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-optical-verification-seam-"));
  try {
    const plan = verificationPlan({ outputIds: ["A", "B"], sharedEdge: true });
    assert.equal(plan.overlapBands.length, 1);
    assert.equal(plan.overlapBands[0].relation, "shared-edge");
    const { solver } = await measuredSolverFixture(root, plan);
    for (const step of plan.steps) {
      for (let repeat = 0; repeat < step.repeats; repeat += 1) {
        await solver.consumeCapture({
          step,
          capture: syntheticCapture(plan, step, { boundaryDefect: 0.03 }),
        });
      }
    }
    const evaluated = evaluateCameraOpticalVerification(await solver.solve(), plan);
    const band = evaluated.metrics.overlapBands[0];
    assert.ok(band.sampleCount >= plan.gates.overlapBands.minimumSampleCount);
    assert.ok(band.analysisBandWidthPx >= plan.gates.overlapBands.minimumAnalysisBandWidthPx);
    assert.ok(band.boundaryResidualP95 > plan.gates.overlapBands.maximumBoundaryResidualP95);
    assert.equal(evaluated.passed, false);
    assert.ok(evaluated.failedGateIds.includes(`overlap-band:${band.bandId}:boundary-residual-p95`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 10, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${message}; last=${JSON.stringify(last)}`);
}

function daemonConfig(plan, directory) {
  return {
    nodeId: plan.nodeId,
    name: "Optical Verification Node",
    version: "0.3.0-test",
    serverUrl: "http://127.0.0.1:4100",
    dataDir: directory,
    outputs: plan.outputs.map((output) => ({ id: output.id, connector: `DP-${output.id}` })),
    heartbeatMs: 5,
    hostTelemetryMs: 1_000,
    clockSyncMs: 5_000,
    clockSyncRounds: 1,
    pollWaitMs: 5,
    requestTimeoutMs: 500,
    maxAssetBytes: 1_000_000,
    cameraBackend: "sony-sdk",
    logLevel: "error",
    nodeToken: null,
  };
}

const daemonHostTelemetry = {
  collect: async ({ renderer }) => ({ schemaVersion: 2, host: { hostname: "optical-node" }, renderer }),
};

class RecoveryEngine {
  constructor(plan) {
    this.adapters = new Map();
    this.externalCadence = false;
    this.connected = true;
    this.ready = true;
    this.initializeCalls = 0;
    this.bootBlackReleaseCalls = 0;
    this.bootBlackAuthorizationDiscardCalls = 0;
    this.projectRevision = null;
    this.blankEnabled = false;
    this.activeCorrectionBinding = structuredClone(plan.rendererCorrectionBinding);
    this.outputs = plan.outputs.map((output) => ({
      id: output.id,
      active: true,
      blank: false,
      pattern: "content",
      patternParameters: {},
      processingBypass: false,
      correctionsBypassed: false,
      renderedFrames: 0,
    }));
  }

  async initialize() { this.initializeCalls += 1; }

  async releaseBootBlack() { this.bootBlackReleaseCalls += 1; }

  discardBootBlackAuthorization() { this.bootBlackAuthorizationDiscardCalls += 1; }

  async configure(input) {
    this.project = input;
    this.projectRevision = input.revision;
    return this.diagnostics();
  }

  calibrationPatternCapabilities() {
    return {
      modes: ["solid", "gray-code", "content"],
      rawCorrectionBypass: true,
      targetIsolation: true,
      applyCorrectionsModes: ["solid"],
      preservesWarp: true,
      solidEncoding: "linear",
      grayCodeCoordinate: "physical-output-pixel",
    };
  }

  async refreshStatus() {
    for (const output of this.outputs) output.renderedFrames += 3;
    return { state: "running", outputs: structuredClone(this.outputs) };
  }

  async blank(enabled) {
    this.blankEnabled = enabled === true;
    for (const output of this.outputs) output.blank = this.blankEnabled;
  }

  async setPattern(pattern) {
    for (const output of this.outputs) {
      const targeted = pattern.outputId == null || String(pattern.outputId) === output.id;
      output.pattern = targeted ? pattern.type : "black";
      output.patternParameters = targeted && pattern.type === "solid"
        ? { rgb: [...pattern.rgb], applyCorrections: pattern.applyCorrections === true }
        : targeted && pattern.type === "gray-code"
          ? { axis: pattern.axis, bit: pattern.bit, inverse: pattern.inverse === true }
          : {};
      output.processingBypass = false;
      output.correctionsBypassed = !targeted || pattern.applyCorrections !== true;
    }
  }

  async clearPattern() {}

  async prepare() { return this.diagnostics(); }

  renderFrame() { return []; }

  async stop() { this.ready = false; }

  diagnostics() {
    return {
      backend: "verification-recovery-test-engine",
      ready: this.ready,
      connected: this.connected,
      projectRevision: this.projectRevision,
      nativeRevision: this.projectRevision,
      activeCorrectionFingerprint: this.activeCorrectionBinding.fingerprint,
      activeCorrectionBinding: structuredClone(this.activeCorrectionBinding),
      correctionBindingMatches: true,
      compositionSource: null,
      droppedFrames: 0,
      framesRendered: 0,
      outputs: this.outputs.map((output) => ({
        id: output.id,
        connector: `DP-${output.id}`,
        metrics: { droppedFrames: 0, framesRendered: output.renderedFrames },
      })),
    };
  }
}

function daemonClient({
  project,
  commands,
  onHeartbeat = null,
  serverAckSequence = 0,
  serverCommandSequence = null,
}) {
  let aborted = false;
  return {
    time: async () => ({ serverTimeNs: epochNowNs().toString() }),
    register: async () => {
      const commandSequence = serverCommandSequence ?? commands.at(-1)?.sequence ?? 0;
      return {
        protocolVersion: 1,
        node: { ackSequence: serverAckSequence, commandSequence },
        commandSequence,
        project,
      };
    },
    state: async () => ({ timeline: { status: "idle", targetNodeIds: [] }, media: [] }),
    heartbeat: async (payload) => onHeartbeat?.(payload) || ({
      serverTimeNs: epochNowNs().toString(),
      acknowledgedActionResultIds: [],
    }),
    pollCommands: async (afterSequence) => {
      while (!aborted) {
        const pending = commands.filter((command) => command.sequence > afterSequence);
        if (pending.length > 0) return { protocolVersion: 1, commands: pending };
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw new Error("aborted");
    },
    assetUrl: (sha256) => `/v1/assets/${sha256}`,
    download: async () => { throw new Error("unexpected download"); },
    abort: () => { aborted = true; },
  };
}

test("daemon releases native boot black once only after safe state hydration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-native-boot-safe-"));
  const plan = verificationPlan();
  const engine = new RecoveryEngine(plan);
  const client = daemonClient({ project: null, commands: [] });
  const node = new PixelBrightnessNode(daemonConfig(plan, directory), {
    hostTelemetryCollector: daemonHostTelemetry,
    renderEngineFactory: () => engine,
  });
  node.client = client;
  node.cache.client = client;
  try {
    await node.start();
    assert.equal(engine.initializeCalls, 1);
    await waitFor(() => engine.bootBlackReleaseCalls === 1, {
      message: "authoritative registration did not release the hydrated boot-black latch",
    });
    assert.equal(engine.bootBlackReleaseCalls, 1);
    assert.equal(engine.bootBlackAuthorizationDiscardCalls, 0);
    await node.start();
    assert.equal(engine.bootBlackReleaseCalls, 1,
      "an already-running daemon must not repeat boot authorization");
  } finally {
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("daemon state initialization failure never releases native boot black", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-native-boot-state-failure-"));
  const plan = verificationPlan();
  const engine = new RecoveryEngine(plan);
  const node = new PixelBrightnessNode(daemonConfig(plan, directory), {
    hostTelemetryCollector: daemonHostTelemetry,
    renderEngineFactory: () => engine,
  });
  node.store.initialize = async () => { throw new Error("state and LKG are unreadable"); };
  try {
    await assert.rejects(node.start(), /state and LKG are unreadable/);
    assert.equal(engine.initializeCalls, 1,
      "failure path may connect only to reinforce ordinary black");
    assert.equal(engine.bootBlackReleaseCalls, 0);
    assert.equal(engine.bootBlackAuthorizationDiscardCalls, 1);
    assert.equal(engine.blankEnabled, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retained command-failure safety lock never releases native boot black", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-native-boot-command-lock-"));
  const plan = verificationPlan();
  const command = { id: "retained-safety-command", sequence: 1, type: "play-at" };
  const deadLetterId = `command_dead_letter_${"b".repeat(32)}`;
  const durable = new NodeStateStore(join(directory, "state.json"));
  await durable.initialize();
  durable.state.lastSequence = 1;
  durable.state.commandFailures = {
    "sequence:1": {
      command,
      deadLetterId,
      status: "dead-lettered",
      attempts: 3,
      retryBudget: 3,
      safetyCritical: true,
    },
  };
  durable.state.commandFailureSafetyLock = {
    schemaVersion: 1,
    status: "active",
    activatedAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    command,
    deadLetterId,
    attempts: 3,
    reason: { code: "TEST_RETAINED_FAILURE", message: "retained safety command failed" },
    blackApplied: true,
    lastEnforcedAt: "2026-08-25T00:00:00.000Z",
    enforcementError: null,
  };
  await durable.save(durable.state);

  const engine = new RecoveryEngine(plan);
  const client = daemonClient({
    project: null,
    commands: [],
    serverAckSequence: 1,
    serverCommandSequence: 1,
  });
  const node = new PixelBrightnessNode(daemonConfig(plan, directory), {
    hostTelemetryCollector: daemonHostTelemetry,
    renderEngineFactory: () => engine,
  });
  node.client = client;
  node.cache.client = client;
  try {
    await node.start();
    assert.equal(engine.bootBlackReleaseCalls, 0);
    assert.equal(engine.bootBlackAuthorizationDiscardCalls, 1);
    assert.equal(engine.blankEnabled, true);
    assert.equal(node.diagnostics().commandFailureSafetyLock.status, "active");
  } finally {
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

function confirmationCrashFixture(plan) {
  const startedAt = "2026-08-24T10:00:01.000Z";
  const requestedAt = "2026-08-24T10:00:01.100Z";
  const confirmedAt = "2026-08-24T10:00:01.200Z";
  const step = plan.steps[0];
  const prompt = createCameraOpticalVerificationOperatorPrompt(plan, {
    stepId: step.id,
    confirmationId: "11111111-1111-4111-8111-111111111111",
    requestedAt,
  });
  const waiting = normalizeCameraOpticalVerificationState({
    ...createCameraOpticalVerificationState(plan, { at: startedAt }),
    state: CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR,
    progress: {
      completedSteps: 0,
      totalSteps: plan.steps.length,
      currentStepId: step.id,
      currentStepIndex: 0,
    },
    startedAt,
    updatedAt: requestedAt,
    operatorPrompt: prompt,
  }, { plan });
  const payload = normalizeCameraOpticalVerificationConfirmation({
    ...confirmation(plan, waiting, confirmedAt),
  }, { plan, state: waiting });
  const consumed = normalizeCameraOpticalVerificationState({
    ...waiting,
    updatedAt: confirmedAt,
    operatorPrompt: {
      ...waiting.operatorPrompt,
      state: "confirmation-queued",
      confirmedAt,
    },
  }, { plan });
  return { state: consumed, payload };
}

async function writeNodeState(directory, input) {
  await writeFile(join(directory, "state.json"), `${JSON.stringify({
    schemaVersion: 1,
    lastSequence: input.lastSequence,
    project: input.project,
    transport: null,
    preparedAssetSha256: null,
    preparedAssets: [],
    pendingActions: [],
    actionResults: [],
    hostActionJournal: [],
    cameraOpticalVerification: input.state,
    cameraOpticalVerificationPlan: input.plan,
    cameraOpticalVerificationConfirmationReceipt: input.confirmationReceipt || null,
    cameraOpticalVerificationRestoreReceipt: input.restoreReceipt || null,
    cameraOpticalVerificationReportAcknowledged: false,
    cameraOpticalVerificationFailClosed: input.failClosed === true,
    updatedAt: input.state.updatedAt,
  }, null, 2)}\n`, "utf8");
}

test("a forged optical fail-closed bit recovers LKG into a lock that rejects content commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-optical-state-recovery-lock-"));
  const plan = verificationPlan();
  const failed = await failedVerificationFixture(plan);
  const statePath = join(directory, "state.json");
  const durable = new NodeStateStore(statePath);
  await durable.initialize();
  durable.state.cameraOpticalVerificationPlan = plan;
  durable.state.cameraOpticalVerification = failed;
  durable.state.cameraOpticalVerificationFailClosed = true;
  await durable.save(durable.state);

  const forged = JSON.parse(await readFile(statePath, "utf8"));
  forged.cameraOpticalVerificationFailClosed = false;
  await writeFile(statePath, `${JSON.stringify(forged)}\n`, "utf8");
  const recoveredStore = new NodeStateStore(statePath);
  const recovered = await recoveredStore.initialize();
  assert.equal(recovered.stateRecoverySafetyLock.status, "active");
  assert.equal(recovered.cameraOpticalVerification, null,
    "older LKG evidence may be absent but must never release the independent recovery lock");

  const engine = new RecoveryEngine(plan);
  const blankCalls = [];
  const blank = engine.blank.bind(engine);
  engine.blank = async (enabled) => {
    blankCalls.push(enabled);
    await blank(enabled);
  };
  const heartbeatPayloads = [];
  const command = createCommand(COMMAND.START_CAMERA_CALIBRATION, {}, { sequence: 1 });
  const client = daemonClient({
    project: null,
    commands: [command],
    onHeartbeat: (payload) => {
      heartbeatPayloads.push(structuredClone(payload));
      return { serverTimeNs: epochNowNs().toString(), acknowledgedActionResultIds: [] };
    },
  });
  const node = new PixelBrightnessNode(daemonConfig(plan, directory), {
    hostTelemetryCollector: daemonHostTelemetry,
    renderEngineFactory: () => engine,
  });
  node.client = client;
  node.cache.client = client;
  try {
    await node.start();
    await waitFor(() => node.diagnostics().commandFailures["sequence:1"], {
      message: "state-recovery lock rejection",
    });
    await waitFor(() => heartbeatPayloads.some((payload) => (
      payload.telemetry?.stateRecoverySafetyLock?.status === "active"
    )), { message: "state-recovery lock heartbeat" });
    assert.ok(blankCalls.length > 0);
    assert.ok(blankCalls.every((enabled) => enabled === true),
      "no recovery-locked path may release native black");
    assert.equal(node.diagnostics().stateRecoverySafetyLock.status, "active");
    assert.equal(node.diagnostics().stateRecoverySafetyLock.blackApplied, true);
    assert.equal(engine.bootBlackReleaseCalls, 0,
      "recovered state may never authorize the independent native boot latch");
    assert.equal(engine.bootBlackAuthorizationDiscardCalls, 1);
  } finally {
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("retained optical sticky black blocks a new calibration until exact rollback restore", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-optical-retained-fail-closed-"));
  const plan = verificationPlan();
  const project = normalizeProject({
    ...defaultProject(),
    id: plan.project.id,
    revision: plan.project.appliedRevision,
    outputs: [],
  });
  const failed = await failedVerificationFixture(plan);
  await writeNodeState(directory, {
    lastSequence: 0,
    project,
    plan,
    state: failed,
    failClosed: true,
  });
  const engine = new RecoveryEngine(plan);
  const blankCalls = [];
  const blank = engine.blank.bind(engine);
  engine.blank = async (enabled) => {
    blankCalls.push(enabled);
    await blank(enabled);
  };
  const heartbeatPayloads = [];
  const command = createCommand(COMMAND.START_CAMERA_CALIBRATION, {}, { sequence: 1 });
  const client = daemonClient({
    project,
    commands: [command],
    onHeartbeat: (payload) => {
      heartbeatPayloads.push(structuredClone(payload));
      return { serverTimeNs: epochNowNs().toString(), acknowledgedActionResultIds: [] };
    },
  });
  const node = new PixelBrightnessNode(daemonConfig(plan, directory), {
    hostTelemetryCollector: daemonHostTelemetry,
    renderEngineFactory: () => engine,
  });
  node.client = client;
  node.cache.client = client;
  try {
    await node.start();
    await waitFor(() => node.diagnostics().commandFailures["sequence:1"], {
      message: "optical sticky-black command rejection",
    });
    await waitFor(() => heartbeatPayloads.some((payload) => (
      payload.telemetry?.cameraOpticalVerificationFailClosed === true
    )), { message: "optical fail-closed heartbeat" });
    assert.equal(node.diagnostics().cameraCalibration, null);
    assert.equal(node.diagnostics().cameraOpticalVerificationFailClosed, true);
    assert.ok(blankCalls.length > 0);
    assert.ok(blankCalls.every((enabled) => enabled === true),
      "no new calibration may release optical sticky black");
    assert.equal(engine.bootBlackReleaseCalls, 0,
      "retained optical fail-closed state may never authorize native boot release");
    assert.equal(engine.bootBlackAuthorizationDiscardCalls, 1);
  } finally {
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("daemon no-ops only an exact consumed CONFIRM replay and advances its sequence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-optical-confirm-replay-"));
  const plan = verificationPlan();
  const baseProject = defaultProject();
  const project = normalizeProject({
    ...baseProject,
    id: plan.project.id,
    revision: plan.project.appliedRevision,
    outputs: [],
  });
  const fixture = confirmationCrashFixture(plan);
  const command = createCommand(COMMAND.CONFIRM_CAMERA_OPTICAL_VERIFICATION, fixture.payload, { sequence: 2 });
  await writeNodeState(directory, {
    lastSequence: 1,
    project,
    plan,
    state: fixture.state,
    confirmationReceipt: { sequence: 2, commandId: command.id, payload: fixture.payload },
    failClosed: true,
  });
  const engine = new RecoveryEngine(plan);
  const client = daemonClient({ project, commands: [command], serverAckSequence: 1 });
  const node = new PixelBrightnessNode(daemonConfig(plan, directory), {
    hostTelemetryCollector: daemonHostTelemetry,
    renderEngineFactory: () => engine,
  });
  node.client = client;
  node.cache.client = client;
  try {
    await node.start();
    await waitFor(() => node.diagnostics().ackSequence === 2, { message: "consumed CONFIRM replay ack" });
    assert.equal(node.diagnostics().cameraOpticalVerification.state, CAMERA_OPTICAL_VERIFICATION_STATE.BLOCKED);
    assert.equal(node.diagnostics().metrics.commandFailures, 0);
    assert.equal(engine.blankEnabled, true);
  } finally {
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

async function failedVerificationFixture(plan) {
  const now = clock();
  const metrics = passingMetrics(plan);
  metrics.geometry[0].holes = 1;
  let commandSequence = 10;
  const result = await new CameraOpticalVerificationRunner({
    cameraAdapter: new FakeCamera(plan, now),
    patternAdapter: new FakePattern(plan),
    solver: { solve: async () => metrics },
    now,
    requestOperatorConfirmation: ({ state }) => {
      const sequence = commandSequence++;
      return {
        confirmation: confirmation(plan, state, now()),
        serverCommandId: `server-confirm-${sequence}`,
        serverCommandSequence: sequence,
      };
    },
  }).run(plan, {
    baselineManifest: { sessionId: plan.calibrationSessionId },
    nodeProjectRevision: plan.project.appliedRevision,
  });
  assert.equal(
    result.state.state,
    CAMERA_OPTICAL_VERIFICATION_STATE.FAILED,
    JSON.stringify(result.state.failure),
  );
  return result.state;
}

function rollbackCrashState(plan, failed, stage) {
  const sourceRevision = plan.project.appliedRevision;
  const targetRevision = sourceRevision + 1;
  const rendererAcknowledgedAt = new Date(Date.parse(failed.updatedAt) + 1_000).toISOString();
  const restoredAt = new Date(Date.parse(rendererAcknowledgedAt) + 1_000).toISOString();
  if (stage === CAMERA_OPTICAL_VERIFICATION_STATE.ROLLING_BACK) {
    return normalizeCameraOpticalVerificationState({
      ...failed,
      state: stage,
      updatedAt: rendererAcknowledgedAt,
      rollback: {
        state: "pending",
        trigger: "failed",
        sourceRevision,
        targetRevision: null,
        reason: "Authoritative Server rollback requested after failed optical gates",
        rendererAcknowledgedAt: null,
        restoredAt: null,
      },
    }, { plan });
  }
  if (stage === CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_RENDERER_ACK) {
    return normalizeCameraOpticalVerificationState({
      ...failed,
      state: stage,
      updatedAt: rendererAcknowledgedAt,
      rollback: {
        state: "renderer-ack",
        trigger: "failed",
        sourceRevision,
        targetRevision,
        reason: "Authoritative Server rollback requested after failed optical gates",
        rendererAcknowledgedAt,
        restoredAt: null,
      },
    }, { plan });
  }
  return normalizeCameraOpticalVerificationState({
    ...failed,
    state: CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK,
    updatedAt: restoredAt,
    rollback: {
      state: "restored",
      trigger: "failed",
      sourceRevision,
      targetRevision,
      reason: "Authoritative Server rollback requested after failed optical gates",
      rendererAcknowledgedAt,
      restoredAt,
    },
  }, { plan });
}

test("daemon resumes exact RESTORE replay from every persisted rollback crash point", async (context) => {
  const plan = verificationPlan();
  const failed = await failedVerificationFixture(plan);
  for (const stage of [
    CAMERA_OPTICAL_VERIFICATION_STATE.ROLLING_BACK,
    CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_RENDERER_ACK,
    CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK,
  ]) {
    await context.test(stage, async () => {
      const directory = await mkdtemp(join(tmpdir(), `pixel-optical-restore-${stage}-`));
      const baseProject = defaultProject();
      const project = normalizeProject({
        ...baseProject,
        id: plan.project.id,
        revision: plan.project.appliedRevision + 1,
        outputs: [],
      });
      const payload = {
        verificationId: plan.verificationId,
        leaseToken: plan.leaseToken,
        calibrationSessionId: plan.calibrationSessionId,
        projectRevision: project.revision,
      };
      const command = createCommand(COMMAND.RESTORE_AFTER_CAMERA_ROLLBACK, payload, { sequence: 6 });
      const state = rollbackCrashState(plan, failed, stage);
      await writeNodeState(directory, {
        lastSequence: 5,
        project,
        plan,
        state,
        restoreReceipt: { sequence: 6, commandId: command.id, payload },
        failClosed: stage !== CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK,
      });
      const engine = new RecoveryEngine(plan);
      const client = daemonClient({
        project,
        commands: [command],
        serverAckSequence: 5,
        onHeartbeat: (heartbeat) => ({
          serverTimeNs: epochNowNs().toString(),
          acknowledgedActionResultIds: [],
          ...(heartbeat.cameraOpticalVerification?.state === CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK
            && heartbeat.ackSequence >= 6
            ? { acknowledgedCameraOpticalVerificationId: plan.verificationId }
            : {}),
        }),
      });
      const node = new PixelBrightnessNode(daemonConfig(plan, directory), {
        hostTelemetryCollector: daemonHostTelemetry,
        renderEngineFactory: () => engine,
      });
      node.client = client;
      node.cache.client = client;
      try {
        await node.start();
        await waitFor(() => {
          const diagnostics = node.diagnostics();
          return diagnostics.ackSequence === 6
            && diagnostics.cameraOpticalVerification?.state === CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK
            && diagnostics.cameraOpticalVerificationReportAcknowledged === true;
        }, { message: `${stage} RESTORE replay convergence` });
        assert.equal(node.diagnostics().metrics.commandFailures, 0);
        assert.equal(node.diagnostics().cameraOpticalVerificationFailClosed, false);
        assert.equal(engine.blankEnabled, false);
      } finally {
        await node.stop().catch(() => {});
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("daemon fail-closes the renderer when verification factory preflight throws", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-optical-verification-preflight-"));
  const plan = verificationPlan();
  const baseProject = defaultProject();
  const project = normalizeProject({
    ...baseProject,
    id: plan.project.id,
    revision: plan.project.appliedRevision,
    outputs: [],
  });
  const commands = [createCommand(COMMAND.START_CAMERA_OPTICAL_VERIFICATION, { plan }, { sequence: 1 })];
  const engine = new RecoveryEngine(plan);
  const client = daemonClient({ project, commands });
  const node = new PixelBrightnessNode(daemonConfig(plan, directory), {
    hostTelemetryCollector: daemonHostTelemetry,
    renderEngineFactory: () => engine,
    cameraOpticalVerificationFactory: async () => {
      const error = new Error("camera helper executable is unavailable");
      error.code = "CAMERA_HELPER_UNAVAILABLE";
      throw error;
    },
  });
  node.client = client;
  node.cache.client = client;
  node.cameraCalibration = {
    sessionId: plan.calibrationSessionId,
    state: "complete",
    manifest: { sessionId: plan.calibrationSessionId },
  };
  try {
    await node.start();
    await waitFor(() => node.diagnostics().cameraOpticalVerification?.state
      === CAMERA_OPTICAL_VERIFICATION_STATE.BLOCKED, { message: "preflight BLOCKED state" });
    assert.equal(node.diagnostics().cameraOpticalVerificationFailClosed, true);
    assert.equal(engine.blankEnabled, true);
    assert.equal(node.diagnostics().cameraOpticalVerification.failure.code, "CAMERA_HELPER_UNAVAILABLE");
  } finally {
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unabortable optical content restore after lease loss cannot publish VERIFIED", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-optical-verification-lease-loss-"));
  const plan = verificationPlan({
    rendererAcknowledgedAt: new Date(Date.now() - 1_000).toISOString(),
  });
  const project = normalizeProject({
    ...defaultProject(),
    id: plan.project.id,
    revision: plan.project.appliedRevision,
    outputs: [],
  });
  const commands = [createCommand(COMMAND.START_CAMERA_OPTICAL_VERIFICATION, { plan }, { sequence: 1 })];
  const confirmedPrompts = new Set();
  let nextSequence = 2;
  let completionStarted = false;
  let aborted = false;
  let pattern;
  class UnabortableCompletionPattern extends FakePattern {
    async completeVerification() {
      completionStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return super.completeVerification();
    }
  }
  const client = {
    time: async () => ({ serverTimeNs: epochNowNs().toString() }),
    register: async () => ({
      protocolVersion: 1,
      node: { ackSequence: 0, commandSequence: 100, failClosedFence: null },
      commandSequence: 100,
      executionLease: executionLease(plan.nodeId),
      project,
    }),
    state: async () => ({ timeline: { status: "idle", targetNodeIds: [] }, media: [] }),
    heartbeat: async (payload) => {
      if (completionStarted) throw new Error("simulated optical execution-lease partition");
      const state = payload.cameraOpticalVerification;
      const prompt = state?.operatorPrompt;
      if (state?.state === CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR
        && prompt?.state === "waiting"
        && !confirmedPrompts.has(prompt.confirmationId)) {
        confirmedPrompts.add(prompt.confirmationId);
        commands.push(createCommand(COMMAND.CONFIRM_CAMERA_OPTICAL_VERIFICATION, {
          ...confirmation(plan, state, new Date(Math.max(
            Date.now(),
            Date.parse(prompt.requestedAt),
          )).toISOString()),
        }, { sequence: nextSequence++ }));
      }
      return {
        serverTimeNs: epochNowNs().toString(),
        failClosedFence: null,
        executionLease: executionLease(plan.nodeId),
        acknowledgedActionResultIds: [],
      };
    },
    pollCommands: async (afterSequence) => {
      while (!aborted) {
        const pending = commands.filter((command) => command.sequence > afterSequence);
        if (pending.length > 0) return {
          protocolVersion: 1,
          commandSequence: commands.at(-1).sequence,
          failClosedFence: null,
          executionLease: executionLease(plan.nodeId),
          commands: pending,
        };
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw new Error("aborted");
    },
    assetUrl: (sha256) => `/v1/assets/${sha256}`,
    download: async () => { throw new Error("unexpected download"); },
    abort: () => { aborted = true; },
  };
  const engine = new RecoveryEngine(plan);
  const node = new PixelBrightnessNode(daemonConfig(plan, directory), {
    hostTelemetryCollector: daemonHostTelemetry,
    renderEngineFactory: () => engine,
    cameraOpticalVerificationFactory: ({ plan: activePlan }) => {
      pattern = new UnabortableCompletionPattern(activePlan);
      return {
        cameraAdapter: new FakeCamera(activePlan, () => new Date().toISOString()),
        patternAdapter: pattern,
        solver: { solve: async () => passingMetrics(activePlan) },
      };
    },
  });
  node.client = client;
  node.cache.client = client;
  node.cameraCalibration = {
    sessionId: plan.calibrationSessionId,
    state: "complete",
    manifest: { sessionId: plan.calibrationSessionId },
  };
  try {
    await node.start();
    await waitFor(() => completionStarted, {
      timeoutMs: 10_000,
      message: "unabortable optical content restore boundary",
    });
    await waitFor(() => {
      const diagnostics = node.diagnostics();
      return diagnostics.cameraOpticalVerification != null
        && diagnostics.cameraOpticalVerification.state !== CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED
        && diagnostics.cameraOpticalVerification.report == null
        && diagnostics.cameraOpticalVerificationFailClosed === true;
    }, { timeoutMs: 5_000, message: "lease-lost optical fail-closed terminal state" });
    const diagnostics = node.diagnostics();
    assert.notEqual(diagnostics.cameraOpticalVerification.state,
      CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED);
    assert.equal(diagnostics.cameraOpticalVerification.report, null);
    assert.equal(diagnostics.cameraOpticalVerificationFailClosed, true);
    assert.equal(pattern.mode, "black");
    assert.equal(engine.blankEnabled, true);
  } finally {
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("daemon cancellation remains black until exact rollback revision and RESTORE command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-optical-cancel-rollback-node-"));
  const plan = verificationPlan({
    rendererAcknowledgedAt: new Date(Date.now() - 1_000).toISOString(),
  });
  const baseProject = defaultProject();
  const project = normalizeProject({
    ...baseProject,
    id: plan.project.id,
    revision: plan.project.appliedRevision,
    outputs: [],
  });
  const rollbackProject = normalizeProject({ ...project, revision: plan.project.appliedRevision + 1 });
  const commands = [createCommand(COMMAND.START_CAMERA_OPTICAL_VERIFICATION, { plan }, { sequence: 1 })];
  const heartbeatPayloads = [];
  let pattern = null;
  let abortQueued = false;
  let cancellationAcknowledged = false;
  let rollbackQueued = false;
  let restoreSequence = null;
  let cancelledWhileBlack = false;
  let clientAborted = false;
  const fakeClient = {
    time: async () => ({ serverTimeNs: epochNowNs().toString() }),
    register: async () => ({
      protocolVersion: 1,
      node: { ackSequence: 0, commandSequence: 1 },
      commandSequence: 1,
      project,
    }),
    state: async () => ({ timeline: { status: "idle", targetNodeIds: [] }, media: [] }),
    heartbeat: async (payload) => {
      heartbeatPayloads.push(structuredClone(payload));
      const state = payload.cameraOpticalVerification;
      if (state?.state === CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR && !abortQueued) {
        abortQueued = true;
        commands.push(createCommand(COMMAND.CANCEL_CAMERA_OPTICAL_VERIFICATION, {
          verificationId: plan.verificationId,
          leaseToken: plan.leaseToken,
        }, { sequence: 2 }));
      }
      if (state?.state === CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED
        && payload.ackSequence >= 2 && !cancellationAcknowledged) {
        cancelledWhileBlack = pattern?.mode === "black";
        cancellationAcknowledged = true;
        return {
          serverTimeNs: epochNowNs().toString(),
          acknowledgedCameraOpticalVerificationId: plan.verificationId,
        };
      }
      if (cancellationAcknowledged && state == null && !rollbackQueued) {
        rollbackQueued = true;
        commands.push(createCommand(COMMAND.SYNC_PROJECT, { project: rollbackProject }, { sequence: 3 }));
        restoreSequence = 4;
        commands.push(createCommand(COMMAND.RESTORE_AFTER_CAMERA_ROLLBACK, {
          verificationId: plan.verificationId,
          leaseToken: plan.leaseToken,
          calibrationSessionId: plan.calibrationSessionId,
          projectRevision: rollbackProject.revision,
        }, { sequence: restoreSequence }));
      }
      if (state?.state === CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK
        && payload.ackSequence >= restoreSequence) {
        return {
          serverTimeNs: epochNowNs().toString(),
          acknowledgedCameraOpticalVerificationId: plan.verificationId,
        };
      }
      return { serverTimeNs: epochNowNs().toString(), acknowledgedActionResultIds: [] };
    },
    pollCommands: async (afterSequence) => {
      while (!clientAborted) {
        const pending = commands.filter((command) => command.sequence > afterSequence);
        if (pending.length > 0) return { protocolVersion: 1, commands: pending };
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw new Error("aborted");
    },
    assetUrl: (sha256) => `/v1/assets/${sha256}`,
    download: async () => { throw new Error("unexpected download"); },
    abort: () => { clientAborted = true; },
  };
  const engine = new RecoveryEngine(plan);
  const node = new PixelBrightnessNode(daemonConfig(plan, directory), {
    hostTelemetryCollector: daemonHostTelemetry,
    renderEngineFactory: () => engine,
    cameraOpticalVerificationFactory: ({ plan: activePlan }) => {
      pattern = new FakePattern(activePlan);
      return {
        cameraAdapter: new FakeCamera(activePlan, () => new Date().toISOString()),
        patternAdapter: pattern,
        solver: { solve: async () => passingMetrics(activePlan) },
      };
    },
  });
  node.client = fakeClient;
  node.cache.client = fakeClient;
  node.cameraCalibration = {
    sessionId: plan.calibrationSessionId,
    state: "complete",
    manifest: { sessionId: plan.calibrationSessionId },
  };
  try {
    await node.start();
    await waitFor(() => {
      const diagnostics = node.diagnostics();
      return diagnostics.cameraOpticalVerification?.state === CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK
        && diagnostics.cameraOpticalVerificationReportAcknowledged === true;
    }, { timeoutMs: 15_000, message: "cancelled rollback acknowledgement" });
    const cancelledHeartbeat = heartbeatPayloads.find((payload) => (
      payload.cameraOpticalVerification?.state === CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED
      && payload.ackSequence >= 2
    ));
    assert.ok(cancelledHeartbeat, "cancelled terminal state was not retained through the cancel command ACK");
    assert.equal(cancelledHeartbeat.cameraOpticalVerification.report, null);
    assert.equal(cancelledHeartbeat.cameraOpticalVerification.failure.code, "OPTICAL_VERIFICATION_CANCELLED");
    assert.equal(cancelledWhileBlack, true);
    const diagnostics = node.diagnostics();
    assert.equal(diagnostics.cameraOpticalVerification.rollback.trigger, "cancelled");
    assert.equal(diagnostics.cameraOpticalVerification.rollback.targetRevision, rollbackProject.revision);
    assert.equal(diagnostics.cameraOpticalVerification.report, null);
    assert.equal(diagnostics.cameraOpticalVerificationFailClosed, false);
    assert.equal(diagnostics.metrics.commandFailures, 0);
    assert.equal(pattern.mode, "content");
    assert.equal(engine.projectRevision, rollbackProject.revision);
  } finally {
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("daemon uses slewed Server time across a five-second helper offset and retains FAILED through rollback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pixel-optical-verification-node-"));
  const plan = verificationPlan({
    rendererAcknowledgedAt: new Date(Date.now() - 1_000).toISOString(),
  });
  const baseProject = defaultProject();
  const project = normalizeProject({
    ...baseProject,
    id: plan.project.id,
    revision: plan.project.appliedRevision,
    outputs: [],
  });
  const rollbackProject = normalizeProject({ ...project, revision: plan.project.appliedRevision + 1 });
  class Engine {
    constructor() {
      this.adapters = new Map();
      this.externalCadence = false;
      this.connected = true;
      this.ready = true;
      this.projectRevision = null;
      this.blankEnabled = false;
      this.outputs = plan.outputs.map((output) => output.id);
      this.activeCorrectionBinding = structuredClone(plan.rendererCorrectionBinding);
    }

    async initialize() {}

    async configure(input) {
      this.project = input;
      this.projectRevision = input.revision;
      return this.diagnostics();
    }

    async refreshStatus() {
      return { state: "running", outputs: this.outputs.map((id) => ({ id, active: true })) };
    }

    async blank(enabled) { this.blankEnabled = enabled; }

    async prepare() { return this.diagnostics(); }

    renderFrame() { return []; }

    async clearPattern() {}

    async stop() { this.ready = false; }

    diagnostics() {
      return {
        backend: "verification-test-engine",
        ready: this.ready,
        connected: this.connected,
        projectRevision: this.projectRevision,
        nativeRevision: this.projectRevision,
        activeCorrectionFingerprint: this.activeCorrectionBinding.fingerprint,
        activeCorrectionBinding: structuredClone(this.activeCorrectionBinding),
        correctionBindingMatches: true,
        compositionSource: null,
        droppedFrames: 0,
        framesRendered: 0,
        outputs: this.outputs.map((id) => ({
          id,
          connector: `DP-${id}`,
          metrics: { droppedFrames: 0, framesRendered: 0 },
        })),
      };
    }
  }

  const commands = [createCommand(COMMAND.START_CAMERA_OPTICAL_VERIFICATION, { plan }, { sequence: 1 })];
  const heartbeatPayloads = [];
  const confirmed = new Set();
  let nextSequence = 2;
  let aborted = false;
  let failedAckReturned = false;
  let rollbackQueued = false;
  let restoreSequence = null;
  const serverNowNs = () => (epochNowNs() + 5_000_000_000n).toString();
  const fakeClient = {
    time: async () => ({ serverTimeNs: serverNowNs() }),
    register: async () => ({
      protocolVersion: 1,
      node: { ackSequence: 0, commandSequence: commands.at(-1)?.sequence || 0 },
      commandSequence: commands.at(-1)?.sequence || 0,
      project,
    }),
    state: async () => ({ timeline: { status: "idle", targetNodeIds: [] }, media: [] }),
    heartbeat: async (payload) => {
      heartbeatPayloads.push(structuredClone(payload));
      const state = payload.cameraOpticalVerification;
      if (state?.state === CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR
        && state.operatorPrompt?.state === "waiting"
        && !confirmed.has(state.operatorPrompt.confirmationId)) {
        confirmed.add(state.operatorPrompt.confirmationId);
        commands.push(createCommand(COMMAND.CONFIRM_CAMERA_OPTICAL_VERIFICATION, {
          schemaVersion: plan.schemaVersion,
          verificationId: plan.verificationId,
          calibrationSessionId: plan.calibrationSessionId,
          nodeId: plan.nodeId,
          projectRevision: plan.project.appliedRevision,
          leaseToken: plan.leaseToken,
          stepId: state.operatorPrompt.stepId,
          confirmationId: state.operatorPrompt.confirmationId,
          confirmationLeaseId: state.operatorPrompt.confirmationLeaseId,
          confirmedAt: new Date(Date.parse(state.operatorPrompt.requestedAt) + 1).toISOString(),
        }, { sequence: nextSequence++ }));
      }
      if (state?.state === CAMERA_OPTICAL_VERIFICATION_STATE.FAILED && !failedAckReturned) {
        failedAckReturned = true;
        return {
          serverTimeNs: serverNowNs(),
          acknowledgedCameraOpticalVerificationId: plan.verificationId,
        };
      }
      if (failedAckReturned && state == null && !rollbackQueued) {
        rollbackQueued = true;
        commands.push(createCommand(COMMAND.SYNC_PROJECT, { project: rollbackProject }, { sequence: nextSequence++ }));
        restoreSequence = nextSequence++;
        commands.push(createCommand(COMMAND.RESTORE_AFTER_CAMERA_ROLLBACK, {
          verificationId: plan.verificationId,
          leaseToken: plan.leaseToken,
          calibrationSessionId: plan.calibrationSessionId,
          projectRevision: rollbackProject.revision,
        }, { sequence: restoreSequence }));
      }
      if (state?.state === CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK
        && payload.ackSequence >= restoreSequence) {
        return {
          serverTimeNs: serverNowNs(),
          acknowledgedCameraOpticalVerificationId: plan.verificationId,
        };
      }
      return { serverTimeNs: serverNowNs(), acknowledgedActionResultIds: [] };
    },
    pollCommands: async (afterSequence) => {
      while (!aborted) {
        const pending = commands.filter((command) => command.sequence > afterSequence);
        if (pending.length > 0) return { protocolVersion: 1, commands: pending };
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw new Error("aborted");
    },
    assetUrl: (sha256) => `/v1/assets/${sha256}`,
    download: async () => { throw new Error("unexpected download"); },
    abort: () => { aborted = true; },
  };
  const engine = new Engine();
  let pattern;
  const config = {
    nodeId: plan.nodeId,
    name: "Optical Verification Node",
    version: "0.3.0-test",
    serverUrl: "http://127.0.0.1:4100",
    dataDir: directory,
    outputs: plan.outputs.map((output) => ({ id: output.id, connector: `DP-${output.id}` })),
    heartbeatMs: 5,
    hostTelemetryMs: 1_000,
    clockSyncMs: 5_000,
    clockSyncRounds: 1,
    pollWaitMs: 5,
    requestTimeoutMs: 500,
    maxAssetBytes: 1_000_000,
    cameraBackend: "sony-sdk",
    logLevel: "error",
    nodeToken: null,
  };
  const hostTelemetryCollector = {
    collect: async ({ renderer }) => ({ schemaVersion: 2, host: { hostname: "optical-node" }, renderer }),
  };
  const node = new PixelBrightnessNode(config, {
    hostTelemetryCollector,
    renderEngineFactory: () => engine,
    cameraOpticalVerificationFactory: ({ plan: activePlan }) => {
      pattern = new FakePattern(activePlan);
      const metrics = passingMetrics(activePlan);
      metrics.geometry[0].holes = 1;
      return {
        cameraAdapter: new FakeCamera(activePlan, () => new Date().toISOString()),
        patternAdapter: pattern,
        solver: { solve: async () => metrics },
      };
    },
  });
  node.client = fakeClient;
  node.cache.client = fakeClient;
  node.cameraCalibration = {
    sessionId: plan.calibrationSessionId,
    state: "complete",
    manifest: { sessionId: plan.calibrationSessionId },
  };
  try {
    await node.start();
    try {
      await waitFor(() => {
        const diagnostics = node.diagnostics();
        return diagnostics.cameraOpticalVerification?.state === CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK
          && diagnostics.cameraOpticalVerificationReportAcknowledged === true;
      }, { timeoutMs: 8_000, message: "rolled-back acknowledgement" });
    } catch (error) {
      const heartbeatStates = heartbeatPayloads.slice(-20).map((payload) => ({
        state: payload.cameraOpticalVerification?.state || null,
        ack: payload.ackSequence,
      }));
      error.message += `; diagnostics=${JSON.stringify(node.diagnostics().cameraOpticalVerification)}`
        + `; nodeError=${JSON.stringify(node.diagnostics().error)}`
        + `; commandFailures=${JSON.stringify(node.diagnostics().commandFailures)}`
        + `; heartbeatStates=${JSON.stringify(heartbeatStates)}`;
      throw error;
    }
    const failedHeartbeat = heartbeatPayloads.find((payload) => (
      payload.cameraOpticalVerification?.state === CAMERA_OPTICAL_VERIFICATION_STATE.FAILED
    ));
    assert.ok(failedHeartbeat?.cameraOpticalVerification.report);
    assert.ok(heartbeatPayloads.some((payload) => payload.cameraOpticalVerification == null && failedAckReturned));
    const rolledHeartbeat = heartbeatPayloads.find((payload) => (
      payload.cameraOpticalVerification?.state === CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK
      && payload.ackSequence >= restoreSequence
    ));
    assert.ok(rolledHeartbeat, "rolled-back state was not retained through the restore command sequence");
    assert.equal(rolledHeartbeat.cameraOpticalVerification.rollback.targetRevision, rollbackProject.revision);
    const bindingHeartbeat = heartbeatPayloads.find((payload) => (
      payload.telemetry?.renderer?.activeCorrectionFingerprint === plan.rendererCorrectionBinding.fingerprint
    ));
    assert.deepEqual(bindingHeartbeat?.telemetry.renderer.activeCorrectionBinding, plan.rendererCorrectionBinding);
    assert.equal(bindingHeartbeat?.telemetry.renderer.correctionBindingMatches, true);
    assert.equal(pattern.mode, "content");
    assert.equal(engine.projectRevision, rollbackProject.revision);
    assert.equal(node.diagnostics().cameraOpticalVerification.report.state, CAMERA_OPTICAL_VERIFICATION_STATE.FAILED);
    assert.ok(BigInt(node.diagnostics().clock.appliedOffsetNs) > 4_000_000_000n);
    assert.equal(node.diagnostics().metrics.commandFailures, 0,
      "an eager confirmation issued on the first publishable heartbeat must not race its local lease");
    assert.deepEqual(node.diagnostics().pendingCommandDeadLetters, []);
    assert.equal(node.diagnostics().commandFailureSafetyLock, null);
  } finally {
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
