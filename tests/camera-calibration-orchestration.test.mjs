import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CAMERA_CALIBRATION_EVENT,
  CAMERA_CALIBRATION_STATE,
  CAMERA_LOCK_FIELDS,
  assertCalibrationManifestApplicable,
  createCameraCalibrationPlan,
  createCameraCalibrationSession,
  normalizeCameraCalibrationManifest,
  transitionCameraCalibration,
  validateCameraCalibrationProjectPatch,
} from "../runtime/shared/camera-calibration.mjs";
import { createCameraLensProfile } from "../runtime/shared/camera-lens-profile.mjs";
import { derivePlanarOutputTargets } from "../runtime/shared/camera-survey.mjs";
import {
  CameraCalibrationOrchestrator,
  CanonR50WindowsCameraAdapter,
  DeterministicPatternOverrideAdapter,
  DeterministicSimulatedCalibrationSolver,
  DeterministicSimulatedCameraAdapter,
  MeasuredCalibrationSolver,
  NativeRendererPatternOverrideAdapter,
  allocateCombinedBlackCorrection,
  boundCalibrationCapture,
  materializeMeasuredCalibrationProjectPatch,
  scatterCameraMapToProjector,
  solveMeasuredRadiometry,
} from "../runtime/node/camera-calibration.mjs";

function output(id, width = 8, height = 4) {
  return { id, resolution: { width, height } };
}

function plan(overrides = {}) {
  return createCameraCalibrationPlan({
    sessionId: "calibration-test-001",
    projectId: "room-test",
    projectRevision: 7,
    outputs: [output("A"), output("B")],
    mesh: { columns: 2, rows: 2, minimumConfidence: 0.05 },
    settleFrames: 2,
    repeats: 1,
    ...overrides,
  });
}

function simulatedMarkerlessPlan({ lensSerial = "SIM-LENS-0001", sessionId = "markerless-measured-001" } = {}) {
  const frame = { width: 64, height: 64 };
  const lensProfile = createCameraLensProfile({
    schema: "pixel-brightness.camera-lens-profile.v1",
    camera: {
      manufacturer: "Pixel Brightness",
      model: "Deterministic simulated camera",
      serialNumber: "SIM-0001",
    },
    lens: {
      manufacturer: "Pixel Brightness",
      model: "Deterministic simulated prime",
      serialNumber: lensSerial,
    },
    frame,
    capture: { focalLengthMm: 35, focusDistanceM: 3, apertureFNumber: 5.6 },
    intrinsics: { fx: 48, fy: 48, cx: 32, cy: 32 },
    distortion: { model: "brown-conrady-v1", k1: -0.04, k2: 0.005, k3: 0, p1: 0, p2: 0 },
    calibration: {
      method: "opencv-charuco-brown-conrady-v1",
      calibratedAt: "2026-08-01T00:00:00.000Z",
      rmsResidualPx: 0.2,
      maxResidualPx: 0.6,
      imageCount: 30,
    },
  });
  const outputs = [{
    id: "A",
    resolution: { width: 64, height: 64 },
    wallId: "wall-north",
    sourceViewport: { x: 0, y: 0, width: 64, height: 64 },
  }];
  const surfaceTargets = derivePlanarOutputTargets({
    surveys: [{
      id: "north-wall-survey",
      wallId: "wall-north",
      cameraViewId: "sim-fixed-view",
      frame,
      lensProfileSha256: lensProfile.sha256,
      boundary: [{ x: 0.08, y: 0.1 }, { x: 0.92, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }],
    }],
    outputs,
    lensProfile,
  });
  return createCameraCalibrationPlan({
    sessionId,
    projectId: "room-test",
    projectRevision: 7,
    outputs,
    surfaceTargets,
    lensProfile,
    mesh: { columns: 2, rows: 2, minimumConfidence: 0.05 },
    settleFrames: 2,
    repeats: 1,
  });
}

function clock() {
  let index = 0;
  return () => new Date(Date.parse("2026-08-19T00:00:00.000Z") + index++ * 1_000).toISOString();
}

class MeasuredRawFixtureCameraAdapter extends DeterministicSimulatedCameraAdapter {
  constructor({
    duplicateSourceAt = -1,
    decoderDriftAt = -1,
    rawDecodeDriftAt = -1,
    omitProvenanceAt = -1,
    now = (index) => new Date(Date.parse("2026-08-19T00:00:01.000Z") + index * 100).toISOString(),
    ...options
  } = {}) {
    super({ ...options, now });
    this.camera = {
      ...this.camera,
      transport: "usb",
      backend: "test-physical-raw-fixture",
    };
    this.rawFixtureCaptureIndex = 0;
    this.duplicateSourceAt = duplicateSourceAt;
    this.decoderDriftAt = decoderDriftAt;
    this.rawDecodeDriftAt = rawDecodeDriftAt;
    this.omitProvenanceAt = omitProvenanceAt;
    this.firstSourceSha256 = null;
  }

  async capture(context) {
    const capture = await super.capture(context);
    const index = this.rawFixtureCaptureIndex++;
    if (index === this.omitProvenanceAt) return capture;
    const rasterBytes = Buffer.from(capture.data.buffer, capture.data.byteOffset, capture.data.byteLength);
    const rasterSha256 = createHash("sha256").update(rasterBytes).digest("hex");
    const uniqueSourceSha256 = createHash("sha256")
      .update(`fixture-physical-raw:${capture.id}:`)
      .update(rasterBytes)
      .digest("hex");
    if (this.firstSourceSha256 == null) this.firstSourceSha256 = uniqueSourceSha256;
    const sourceSha256 = index === this.duplicateSourceAt ? this.firstSourceSha256 : uniqueSourceSha256;
    capture.rasterSha256 = rasterSha256;
    capture.provenance = {
      decoder: {
        name: index === this.decoderDriftAt ? "fixture-decoder-drifted" : "fixture-decoder",
        version: "1.0.0",
        binarySha256: createHash("sha256").update("fixture-decoder-binary-v1").digest("hex"),
      },
      rawDecode: {
        rawFormat: "PBRAW",
        sensorWidth: capture.width,
        sensorHeight: capture.height,
        cfaPattern: index === this.rawDecodeDriftAt ? "BGGR" : "RGGB",
        blackLevels: [0, 0, 0, 0],
        whiteLevels: [4_294_967_295, 4_294_967_295, 4_294_967_295, 4_294_967_295],
      },
      sourceSha256,
      rasterSha256,
    };
    return capture;
  }
}

async function confirmOperator({ step }) {
  const confirmationId = `confirmation:${step.confirmationLeaseId || step.id}`;
  return {
    confirmed: true,
    stepId: step.id,
    confirmationId,
    conditionVerification: {
      projectorState: step.captureConditions.projectorState,
      opticalPath: step.captureConditions.opticalPath,
      otherProjectors: step.captureConditions.otherProjectors,
      method: "test-operator-confirmation",
      verifiedAt: "2026-08-19T00:00:00.000Z",
      confirmationLeaseId: step.confirmationLeaseId || null,
      confirmationId,
    },
  };
}

function syntheticRadiometricCaptures(calibrationPlan, {
  nearBlackNoise = 0.000002,
  injectOutlier = true,
  longExposureMultiplier = 1,
} = {}) {
  const width = 16;
  const height = 12;
  const sensorOffset = [0.002, 0.0022, 0.0018];
  const ambient = [0.00008, 0.00009, 0.00007];
  const blackFloor = [0.00025, 0.00028, 0.00022];
  const gamma = [2, 2.3, 1.8];
  const matrix = [
    [0.98, 0.015, 0.005],
    [0.01, 0.98, 0.01],
    [0.005, 0.015, 0.98],
  ];
  const included = new Set([
    "reference",
    "black",
    "near-black",
    "tone",
    "primary-red",
    "primary-green",
    "primary-blue",
    "low-primary-red",
    "low-primary-green",
    "low-primary-blue",
    "exposure-bridge-short",
    "exposure-bridge-long",
  ]);
  const captures = [];
  for (const step of calibrationPlan.steps.filter((candidate) => candidate.capture && included.has(candidate.purpose))) {
    const profile = calibrationPlan.exposureProfiles.find((candidate) => candidate.id === step.exposureProfileId);
    const exposure = step.exposure.normalizationScale
      * (profile?.role === "radiometry" ? longExposureMultiplier : 1);
    const input = step.inputRgb || [0, 0, 0];
    const emitted = input.map((value, channel) => Math.pow(value, gamma[channel]));
    const projected = matrix.map((row) => row.reduce((sum, coefficient, channel) => (
      sum + coefficient * emitted[channel]
    ), 0));
    for (let repeat = 0; repeat < step.repeats; repeat += 1) {
      const data = new Float32Array(width * height * 3);
      for (let pixel = 0; pixel < width * height; pixel += 1) {
        const spatial = 0.96 + 0.04 * (pixel % width) / (width - 1);
        for (let channel = 0; channel < 3; channel += 1) {
          let optical;
          if (step.referenceKind === "sensor-dark") optical = 0;
          else if (step.referenceKind === "projectors-off-ambient") optical = ambient[channel];
          else optical = ambient[channel] + blackFloor[channel] * spatial + 0.55 * projected[channel] * spatial;
          const noisyStep = step.purpose === "near-black" || step.purpose.startsWith("low-primary");
          const amplitude = noisyStep ? nearBlackNoise : 0.000001;
          const signedNoise = (((repeat * 17 + pixel * 7 + channel * 3) % 13) - 6) / 6 * amplitude;
          let value = sensorOffset[channel] + exposure * optical + signedNoise;
          if (injectOutlier && repeat === 0 && pixel === 0 && channel === 0) value += 0.2;
          data[pixel * 3 + channel] = Math.max(0, Math.min(1, value));
        }
      }
      captures.push({
        id: `${step.id}#${repeat}`,
        stepId: step.id,
        outputId: step.outputId,
        repeat,
        capturedAt: new Date(Date.parse("2026-08-19T00:00:00.000Z") + captures.length * 10).toISOString(),
        width,
        height,
        pixelFormat: "linear-rgb-f32",
        exposure: structuredClone(step.exposure),
        data,
      });
    }
  }
  return { captures, width, height, gamma };
}

test("V2 plan owns calibration output and sequences every projector deterministically", () => {
  const value = plan();
  assert.deepEqual(value.sourcePolicy, {
    arena: "blanked",
    owner: "pixel-brightness-pattern-override",
    failure: "remain-black",
    success: "restore-composition",
  });
  assert.equal(value.steps[0].purpose, "safety-black");
  assert.equal(value.steps.at(-1).purpose, "safety-black");
  assert.ok(value.steps.every((step, index) => step.sequence === index));
  assert.equal(new Set(value.steps.map((step) => step.id)).size, value.steps.length);
  assert.equal(value.steps.filter((step) => step.referenceKind === "projector-black").length, 1);

  for (const outputId of ["A", "B"]) {
    const steps = value.steps.filter((step) => step.outputId === outputId);
    assert.equal(steps.filter((step) => step.semantic === "exposure-bridge").length, 2);
    assert.equal(steps.filter((step) => step.purpose === "near-black").length, 3);
    assert.equal(steps.filter((step) => step.purpose === "white").length, 1);
    assert.equal(steps.filter((step) => step.purpose === "tone").length, 3);
    assert.equal(steps.filter((step) => step.purpose.startsWith("primary-")).length, 3);
    assert.equal(steps.filter((step) => step.purpose === "gray-code" && step.pattern.axis === "x").length, 6);
    assert.equal(steps.filter((step) => step.purpose === "gray-code" && step.pattern.axis === "y").length, 4);
    assert.ok(steps.every((step) => step.isolateOutput && step.otherOutputs === "black"));
  }
});

test("calibration state machine rejects an out-of-order capture", () => {
  const calibrationPlan = plan({ outputs: [output("A")] });
  const camera = {
    id: "sim",
    vendor: "PB",
    model: "Sim",
    transport: "simulation",
    backend: "simulation",
    capabilities: { manualExposure: true, manualWhiteBalance: true, manualFocus: true, linearCapture: true },
  };
  const event = (type, data = {}) => ({ type, sessionId: calibrationPlan.sessionId, at: "2026-08-19T00:00:00.000Z", ...data });
  let session = createCameraCalibrationSession(calibrationPlan);
  session = transitionCameraCalibration(session, event(CAMERA_CALIBRATION_EVENT.START), calibrationPlan);
  session = transitionCameraCalibration(session, event(CAMERA_CALIBRATION_EVENT.CAMERA_FOUND, { camera }), calibrationPlan);
  session = transitionCameraCalibration(session, event(CAMERA_CALIBRATION_EVENT.BEGIN_LOCK), calibrationPlan);
  session = transitionCameraCalibration(session, event(CAMERA_CALIBRATION_EVENT.CAMERA_LOCKED, { cameraLock: {} }), calibrationPlan);
  session = transitionCameraCalibration(session, event(CAMERA_CALIBRATION_EVENT.BEGIN_OVERRIDE), calibrationPlan);
  session = transitionCameraCalibration(session, event(CAMERA_CALIBRATION_EVENT.OVERRIDE_READY), calibrationPlan);
  assert.equal(session.state, CAMERA_CALIBRATION_STATE.CAPTURING);
  assert.throws(
    () => transitionCameraCalibration(session, event(CAMERA_CALIBRATION_EVENT.STEP_COMPLETE, {
      stepId: calibrationPlan.steps[1].id,
    }), calibrationPlan),
    (error) => error.code === "CAPTURE_STEP_OUT_OF_ORDER",
  );
});

test("Windows Canon R50 boundary reports unavailable instead of claiming EDSDK capture", async () => {
  const camera = new CanonR50WindowsCameraAdapter();
  const detection = await camera.detect();
  assert.equal(detection.adapter.backend, "canon-edsdk");
  assert.equal(detection.adapter.implemented, false);
  assert.equal(detection.adapter.available, false);
  assert.deepEqual(detection.cameras, []);
  assert.equal(detection.error.code, "CANON_EDSDK_ADAPTER_UNAVAILABLE");

  const patterns = new DeterministicPatternOverrideAdapter();
  const orchestrator = new CameraCalibrationOrchestrator({
    cameraAdapter: camera,
    patternAdapter: patterns,
    solver: new DeterministicSimulatedCalibrationSolver(),
    requestOperatorConfirmation: confirmOperator,
    now: clock(),
  });
  await assert.rejects(
    () => orchestrator.run(plan({ outputs: [output("A")] })),
    (error) => error.code === "CANON_EDSDK_ADAPTER_UNAVAILABLE"
      && error.session.state === CAMERA_CALIBRATION_STATE.FAILED,
  );
  assert.deepEqual(patterns.log, [], "projector content must not be touched when camera detection fails");
});

test("physical capture fails closed on missing, reused or session-drifting RAW provenance", async () => {
  const cases = [
    [{ omitProvenanceAt: 0 }, "CAPTURE_RAW_PROVENANCE_REQUIRED"],
    [{ duplicateSourceAt: 1 }, "CAPTURE_RAW_SOURCE_REUSED"],
    [{ decoderDriftAt: 1 }, "CAPTURE_RAW_DECODER_CHANGED"],
    [{ rawDecodeDriftAt: 1 }, "CAPTURE_RAW_DECODE_CHANGED"],
  ];
  for (const [adapterOptions, code] of cases) {
    const patterns = new DeterministicPatternOverrideAdapter();
    const runClock = clock();
    const orchestrator = new CameraCalibrationOrchestrator({
      cameraAdapter: new MeasuredRawFixtureCameraAdapter({ width: 8, height: 4, now: runClock, ...adapterOptions }),
      patternAdapter: patterns,
      solver: new DeterministicSimulatedCalibrationSolver(),
      requestOperatorConfirmation: confirmOperator,
      now: runClock,
    });
    await assert.rejects(
      () => orchestrator.run(plan({ outputs: [output("A")] })),
      (error) => error.code === code && error.session.state === CAMERA_CALIBRATION_STATE.FAILED,
    );
    assert.equal(patterns.mode, "black");
  }
});

async function simulatedRun() {
  const calibrationPlan = plan({ repeats: 2 });
  const camera = new DeterministicSimulatedCameraAdapter({ width: 8, height: 4 });
  const patterns = new DeterministicPatternOverrideAdapter();
  const orchestrator = new CameraCalibrationOrchestrator({
    cameraAdapter: camera,
    patternAdapter: patterns,
    solver: new DeterministicSimulatedCalibrationSolver(),
    requestOperatorConfirmation: confirmOperator,
    now: clock(),
  });
  const result = await orchestrator.run(calibrationPlan);
  return { calibrationPlan, camera, patterns, result };
}

test("deterministic camera run produces the complete non-applicable simulated artifact manifest", async () => {
  const first = await simulatedRun();
  const second = await simulatedRun();
  const expectedCaptures = first.calibrationPlan.steps.filter((step) => step.capture)
    .reduce((total, step) => total + step.repeats, 0);

  assert.equal(first.result.session.state, CAMERA_CALIBRATION_STATE.COMPLETE);
  assert.equal(first.result.captureCount, expectedCaptures);
  assert.equal(first.result.manifest.provenance, "simulated");
  assert.equal(first.result.manifest.applicable, false);
  assert.deepEqual(first.result.manifest, second.result.manifest, "same simulated inputs must produce byte-stable manifests");
  assert.equal(first.patterns.log[0], "begin:black");
  assert.equal(first.patterns.log.at(-1), "complete:content");
  assert.equal(first.patterns.mode, "content");
  assert.equal(first.camera.captureLog.length, expectedCaptures);

  for (const outputManifest of first.result.manifest.outputs) {
    const { artifacts } = outputManifest;
    assert.equal(artifacts.warp.pointCount, 9);
    assert.equal(artifacts.warp.format, "pb-warp-mesh-v1");
    assert.equal(artifacts.blendWeight.format, "r32_float");
    assert.equal(artifacts.blackPedestal.format, "r32_float");
    assert.equal(artifacts.mask.format, "r32_float");
    assert.equal(artifacts.confidence.format, "r32_float");
    assert.ok(Math.abs(artifacts.gamma.rgb[0] - 2.2) < 0.05);
    assert.equal(artifacts.lut.format, "rgba32_float");
    assert.equal(artifacts.lut.status, "identity-fallback");
    for (const key of ["warp", "blendWeight", "blackPedestal", "mask", "confidence", "lut"]) {
      assert.match(artifacts[key].sha256, /^[a-f0-9]{64}$/);
    }
  }
  assert.throws(
    () => assertCalibrationManifestApplicable(first.result.manifest),
    (error) => error.code === "CALIBRATION_ARTIFACT_NOT_APPLICABLE",
  );
});

test("camera correction values are scattered by decoded projector address, never image-resized", () => {
  const scattered = scatterCameraMapToProjector({
    values: new Float32Array([1, 2, 3, 4]),
    cameraWidth: 2,
    cameraHeight: 2,
    projectorWidth: 2,
    projectorHeight: 2,
    projectorX: new Int32Array([1, 0, 1, 0]),
    projectorY: new Int32Array([0, 0, 1, 1]),
    confidence: new Float32Array([1, 1, 1, 1]),
    minimumConfidence: 0.5,
  });
  assert.deepEqual([...scattered], [2, 1, 4, 3]);
});

test("projector scatter leaves unseen pixels disabled and measures coverage against the full output", () => {
  const scattered = scatterCameraMapToProjector({
    values: new Float32Array(16).fill(1),
    cameraWidth: 4,
    cameraHeight: 4,
    projectorWidth: 8,
    projectorHeight: 4,
    projectorX: Int32Array.from({ length: 16 }, (_, index) => index % 4),
    projectorY: Int32Array.from({ length: 16 }, (_, index) => Math.floor(index / 4)),
    confidence: new Float32Array(16).fill(1),
    minimumConfidence: 0.5,
    returnMetadata: true,
  });
  assert.equal(scattered.coverage.boundingPixelRatio, 1,
    "a dense partial footprint is dense only inside its own observed bounds");
  assert.equal(scattered.coverage.pixelRatio, 0.5,
    "production coverage must include the unobserved half of the projector");
  assert.equal(scattered.coverage.filledPixels, 0);
  for (let y = 0; y < 4; y += 1) {
    assert.deepEqual([...scattered.values.slice(y * 8, y * 8 + 8)], [1, 1, 1, 1, 0, 0, 0, 0]);
  }
});

test("camera frames are retained as bounded luma instead of unbounded RGB", () => {
  const capture = boundCalibrationCapture({
    id: "frame-1",
    width: 8,
    height: 4,
    pixelFormat: "linear-rgb-f32",
    data: new Float32Array(8 * 4 * 3).fill(0.5),
    adapterBinarySidecar: Buffer.alloc(1024),
  }, { maxPixels: 8, maxWidth: 8, maxHeight: 4 });
  assert.equal(capture.width, 4);
  assert.equal(capture.height, 2);
  assert.equal(capture.pixelFormat, "linear-luma-f32");
  assert.equal(capture.data.byteLength, 8 * Float32Array.BYTES_PER_ELEMENT);
  assert.equal(capture.boundedCapture.downsampled, true);
  assert.equal("adapterBinarySidecar" in capture, false, "adapter-owned binary sidecars must never enter retained stacks");
  assert.ok([...capture.data].every((value) => Math.abs(value - 0.5) < 1e-6));
});

test("measured radiometry robustly fits nonlinear RGB and builds a non-identity 17-cube LUT", () => {
  const calibrationPlan = plan({ outputs: [output("A", 16, 12)] });
  const synthetic = syntheticRadiometricCaptures(calibrationPlan, { longExposureMultiplier: 0.98 });
  const solved = solveMeasuredRadiometry({
    plan: calibrationPlan,
    output: calibrationPlan.outputs[0],
    captures: synthetic.captures,
    surfaceMask: new Float32Array(synthetic.width * synthetic.height).fill(1),
    cameraWidth: synthetic.width,
    cameraHeight: synthetic.height,
  });
  assert.equal(solved.lut.size, 17);
  assert.equal(solved.lut.values.length, 17 ** 3 * 4);
  assert.equal(solved.radiometry.status, "passed");
  assert.ok(Math.abs(solved.radiometry.measuredExposureNormalization.measuredScaleLuma - 58.8) < 0.1);
  assert.ok(Math.abs(solved.radiometry.measuredExposureNormalization.measuredScaleLuma - 60) > 1);
  assert.equal(solved.radiometry.fit.identityVerified, false);
  assert.ok(solved.lut.maximumIdentityDeviation > 0.005);
  assert.ok(Math.abs(solved.gamma.rgb[0] - synthetic.gamma[0]) < 0.25);
  assert.ok(Math.abs(solved.gamma.rgb[1] - synthetic.gamma[1]) < 0.25);
  assert.ok(Math.abs(solved.gamma.rgb[2] - synthetic.gamma[2]) < 0.25);
  assert.ok(solved.radiometry.fit.nearBlackSnrDb >= solved.radiometry.gates.minimumSnrDb);
  assert.ok(solved.radiometry.referenceCaptureIds.sensorDark.length > 0);
  assert.ok(solved.radiometry.samples.usable > 0);
});

test("measured radiometry rejects a nominal exposure scale contradicted by its optical bridge", () => {
  const calibrationPlan = plan({ outputs: [output("A", 16, 12)] });
  const synthetic = syntheticRadiometricCaptures(calibrationPlan, {
    injectOutlier: false,
    longExposureMultiplier: 0.9,
  });
  assert.throws(
    () => solveMeasuredRadiometry({
      plan: calibrationPlan,
      output: calibrationPlan.outputs[0],
      captures: synthetic.captures,
      surfaceMask: new Float32Array(synthetic.width * synthetic.height).fill(1),
      cameraWidth: synthetic.width,
      cameraHeight: synthetic.height,
    }),
    (error) => error.code === "CALIBRATION_EXPOSURE_NORMALIZATION_MISMATCH"
      && error.details.measuredExposureNormalization.relativeErrorLuma > 0.05,
  );
});

test("measured radiometry fails closed when every near-black bracket is below the noise floor", () => {
  const calibrationPlan = plan({ outputs: [output("A", 16, 12)] });
  const synthetic = syntheticRadiometricCaptures(calibrationPlan, {
    nearBlackNoise: 0.03,
    injectOutlier: false,
  });
  assert.throws(
    () => solveMeasuredRadiometry({
      plan: calibrationPlan,
      output: calibrationPlan.outputs[0],
      captures: synthetic.captures,
      surfaceMask: new Float32Array(synthetic.width * synthetic.height).fill(1),
      cameraWidth: synthetic.width,
      cameraHeight: synthetic.height,
    }),
    (error) => error.code === "CALIBRATION_NEAR_BLACK_SNR_TOO_LOW",
  );
});

test("overlapping projector black maps add to one combined optical correction", () => {
  const combined = allocateCombinedBlackCorrection({
    blackFrames: [
      new Float32Array([0.01, 0.02, 0.03, 0.04]),
      new Float32Array([0.03, 0.04, 0.05, 0.06]),
    ],
    masks: [new Float32Array([1, 1, 1, 1]), new Float32Array([1, 1, 1, 1])],
    blendWeights: [new Float32Array([0.25, 0.25, 0.25, 0.25]), new Float32Array([0.75, 0.75, 0.75, 0.75])],
    responseScales: [0.5, 1],
    targetPercentile: 1,
  });
  const projectorX = new Int32Array([0, 1, 0, 1]);
  const projectorY = new Int32Array([0, 0, 1, 1]);
  const scatter = (values) => scatterCameraMapToProjector({
    values,
    cameraWidth: 2,
    cameraHeight: 2,
    projectorWidth: 2,
    projectorHeight: 2,
    projectorX,
    projectorY,
    confidence: new Float32Array([1, 1, 1, 1]),
  });
  const first = scatter(combined.contributions[0]);
  const second = scatter(combined.contributions[1]);
  for (let pixel = 0; pixel < combined.totalCorrection.length; pixel += 1) {
    const opticalLift = first[pixel] * 0.5 + second[pixel];
    assert.ok(Math.abs(opticalLift - combined.totalCorrection[pixel]) < 1e-6);
    assert.ok(opticalLift <= combined.totalCorrection[pixel] + 1e-6,
      "overlap must allocate one calibrated optical correction across projectors");
  }
});

test("measured black correction preserves spatial ambient in the observable black floor", async () => {
  class SpatialAmbientCamera extends MeasuredRawFixtureCameraAdapter {
    async capture(context) {
      const capture = await super.capture(context);
      if (context.step.referenceKind === "sensor-dark") return capture;
      const exposure = Math.max(1e-9, Number(context.step.exposure?.normalizationScale) || 1);
      for (let y = 0; y < capture.height; y += 1) {
        for (let x = 0; x < capture.width; x += 1) {
          const spatialAmbient = 0.004 * x / Math.max(1, capture.width - 1);
          const offset = (y * capture.width + x) * 3;
          for (let channel = 0; channel < 3; channel += 1) {
            capture.data[offset + channel] = Math.min(1,
              capture.data[offset + channel] + exposure * spatialAmbient);
          }
        }
      }
      return capture;
    }
  }

  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-spatial-ambient-"));
  try {
    const calibrationPlan = plan({ outputs: [output("A", 64, 64)] });
    const runClock = clock();
    const result = await new CameraCalibrationOrchestrator({
      cameraAdapter: new SpatialAmbientCamera({ width: 64, height: 64, now: runClock }),
      patternAdapter: new DeterministicPatternOverrideAdapter(),
      solver: new MeasuredCalibrationSolver({ artifactRoot: root }),
      requestOperatorConfirmation: confirmOperator,
      now: runClock,
    }).run(calibrationPlan);
    const pedestal = await readFile(result.manifest.outputs[0].artifacts.blackPedestal.path);
    const values = new Float32Array(
      pedestal.buffer,
      pedestal.byteOffset,
      pedestal.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );
    const maximumLift = values.reduce((maximum, value) => Math.max(maximum, value), 0);
    assert.ok(maximumLift > 0.002,
      "the black-pedestal map must retain and equalize the injected spatial ambient gradient");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production measured solver commits verified projector-space artifacts atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-measured-solver-"));
  try {
    const calibrationPlan = plan({ outputs: [output("A", 64, 64)] });
    const runClock = clock();
    const orchestrator = new CameraCalibrationOrchestrator({
      cameraAdapter: new MeasuredRawFixtureCameraAdapter({ width: 64, height: 64, now: runClock }),
      patternAdapter: new DeterministicPatternOverrideAdapter(),
      solver: new MeasuredCalibrationSolver({ artifactRoot: root }),
      requestOperatorConfirmation: confirmOperator,
      now: runClock,
    });
    const result = await orchestrator.run(calibrationPlan);
    assert.equal(result.manifest.provenance, "measured");
    assert.equal(result.manifest.applicable, true);
    assert.equal(result.manifest.captureProvenance.version, 2);
    assert.equal(result.manifest.captureProvenance.decoder.name, "fixture-decoder");
    assert.equal(result.manifest.captureProvenance.rawDecode.rawFormat, "PBRAW");
    assert.equal(new Set(result.manifest.captureProvenance.captures
      .map((capture) => capture.sourceSha256)).size, result.manifest.captureProvenance.captures.length);
    assert.equal(assertCalibrationManifestApplicable(result.manifest).sessionId, calibrationPlan.sessionId);

    const entries = await readdir(root);
    assert.equal(entries.length, 1, "one committed session directory must replace all staging files");
    assert.equal(entries[0].startsWith("."), false);
    const outputManifest = result.manifest.outputs[0];
    for (const name of ["warp", "blendWeight", "blackPedestal", "mask", "confidence", "lut"]) {
      const information = await stat(outputManifest.artifacts[name].path);
      assert.equal(information.isFile(), true);
      assert.equal(information.size, outputManifest.artifacts[name].byteLength);
    }
    for (const name of ["blendWeight", "blackPedestal", "mask", "confidence"]) {
      assert.equal(outputManifest.artifacts[name].byteLength, 64 * 64 * 4);
    }

    const project = {
      id: "room-test",
      revision: 7,
      outputs: [{
        id: "A",
        nodeId: "render-01",
        resolution: { width: 64, height: 64, refreshNum: 60, refreshDen: 1 },
        sourceViewport: { x: 0, y: 0, width: 64, height: 64 },
      }],
    };
    const patch = await materializeMeasuredCalibrationProjectPatch({
      manifest: result.manifest,
      project,
      artifactRoot: root,
    });
    assert.equal(patch.outputs[0].warp.points.length, 9);
    assert.equal(patch.outputs[0].blend.map.path, outputManifest.artifacts.blendWeight.path);
    assert.equal(patch.outputs[0].blackUniformity.map.path, outputManifest.artifacts.blackPedestal.path);
    assert.equal(patch.outputs[0].mask.map.path, outputManifest.artifacts.mask.path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("measured markerless solve binds lens identity and emits passed distortion-aware geometry evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-markerless-measured-"));
  try {
    const runClock = clock();
    const camera = new MeasuredRawFixtureCameraAdapter({ width: 64, height: 64, now: runClock });
    const result = await new CameraCalibrationOrchestrator({
      cameraAdapter: camera,
      patternAdapter: new DeterministicPatternOverrideAdapter(),
      solver: new MeasuredCalibrationSolver({ artifactRoot: root }),
      requestOperatorConfirmation: confirmOperator,
      now: runClock,
    }).run(simulatedMarkerlessPlan());
    const geometry = result.manifest.outputs[0].geometry;
    assert.equal(geometry.status, "passed");
    assert.equal(geometry.method, "operator-four-corner-planar-v1");
    assert.equal(geometry.gates.passed, true);
    assert.equal(geometry.correspondence.holes, 0);
    assert.equal(assertCalibrationManifestApplicable(result.manifest).lensProfile.sha256,
      result.manifest.lensProfile.sha256);
    const tamperedProfile = structuredClone(result.manifest);
    tamperedProfile.lensProfile.lens.serialNumber = "FORGED-LENS";
    assert.throws(
      () => assertCalibrationManifestApplicable(tamperedProfile),
      (error) => error.code === "LENS_PROFILE_IDENTITY_MISMATCH",
    );

    const mismatchClock = clock();
    await assert.rejects(
      () => new CameraCalibrationOrchestrator({
        cameraAdapter: new MeasuredRawFixtureCameraAdapter({ width: 64, height: 64, now: mismatchClock }),
        patternAdapter: new DeterministicPatternOverrideAdapter(),
        solver: new MeasuredCalibrationSolver({ artifactRoot: root }),
        requestOperatorConfirmation: confirmOperator,
        now: mismatchClock,
      }).run(simulatedMarkerlessPlan({ lensSerial: "OTHER-LENS", sessionId: "markerless-mismatch-001" })),
      (error) => error.code === "CAMERA_LENS_PROFILE_CAPTURE_MISMATCH"
        && error.session.state === CAMERA_CALIBRATION_STATE.FAILED,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("measured solver rejects a spatially perforated correction map before commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-sparse-solver-"));
  const patterns = new DeterministicPatternOverrideAdapter();
  try {
    const runClock = clock();
    const orchestrator = new CameraCalibrationOrchestrator({
      cameraAdapter: new MeasuredRawFixtureCameraAdapter({ width: 32, height: 32, now: runClock }),
      patternAdapter: patterns,
      solver: new MeasuredCalibrationSolver({ artifactRoot: root }),
      requestOperatorConfirmation: confirmOperator,
      now: runClock,
    });
    await assert.rejects(
      () => orchestrator.run(plan({ outputs: [output("A", 64, 64)] })),
      (error) => error.code === "CALIBRATION_MAP_COVERAGE_TOO_LOW"
        && error.session.state === CAMERA_CALIBRATION_STATE.FAILED,
    );
    assert.equal(patterns.mode, "black");
    assert.deepEqual(await readdir(root), [], "no sparse calibration artifact may be committed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture-memory preflight fails before projector pattern ownership", async () => {
  const calibrationPlan = plan({
    outputs: [output("A")],
    mesh: { columns: 128, rows: 128, minimumConfidence: 0.05 },
  });
  const capturedSteps = calibrationPlan.steps.filter((step) => step.capture);
  const radiometricSteps = capturedSteps.filter((step) => step.pattern?.kind === "solid");
  const uncertaintySteps = capturedSteps.filter((step) => step.referenceKind != null
    || step.purpose === "near-black");
  const minimumPixels = Math.max(4_096,
    (calibrationPlan.mesh.columns + 1) * (calibrationPlan.mesh.rows + 1) * 4);
  const retainedOnlyMinimum = minimumPixels
      * (capturedSteps.length + uncertaintySteps.length) * Float32Array.BYTES_PER_ELEMENT
    + 4_096 * radiometricSteps.length * 3 * Float32Array.BYTES_PER_ELEMENT * 2;
  const patterns = new DeterministicPatternOverrideAdapter();
  const orchestrator = new CameraCalibrationOrchestrator({
    cameraAdapter: new DeterministicSimulatedCameraAdapter({ width: 8, height: 4 }),
    patternAdapter: patterns,
    solver: new DeterministicSimulatedCalibrationSolver(),
    maxSessionCaptureBytes: 1_024,
    now: clock(),
  });
  await assert.rejects(
    () => orchestrator.run(calibrationPlan),
    (error) => {
      assert.equal(error.code, "CALIBRATION_CAPTURE_MEMORY_BUDGET_EXCEEDED");
      assert.equal(error.session.state, CAMERA_CALIBRATION_STATE.FAILED);
      assert.equal(error.details.minimumPixels, minimumPixels);
      assert.ok(error.details.estimatedMinimumPeakBytes > retainedOnlyMinimum,
        "preflight must include the active robust-stack peak, not only retained output rasters");
      assert.ok(error.details.estimatedMinimumPeakBytes > error.details.maxSessionCaptureBytes);
      return true;
    },
  );
  assert.deepEqual(patterns.log, []);
});

test("successful capture policy reports a peak estimate inside its session budget", async () => {
  const maxSessionCaptureBytes = 64 * 1024 * 1024;
  const result = await new CameraCalibrationOrchestrator({
    cameraAdapter: new DeterministicSimulatedCameraAdapter({ width: 8, height: 4 }),
    patternAdapter: new DeterministicPatternOverrideAdapter(),
    solver: new DeterministicSimulatedCalibrationSolver(),
    requestOperatorConfirmation: confirmOperator,
    maxCapturePixels: 65_536,
    maxRadiometricPixels: 16_384,
    maxSessionCaptureBytes,
    now: clock(),
  }).run(plan({ outputs: [output("A")] }));
  const memory = result.captureMemory;
  assert.equal(memory.maxSessionCaptureBytes, maxSessionCaptureBytes);
  assert.ok(memory.estimatedActiveStackBytes > 0);
  assert.equal(memory.estimatedMaximumBytes,
    memory.estimatedRetainedBytes + memory.estimatedActiveStackBytes);
  assert.ok(memory.estimatedMaximumBytes > memory.estimatedRetainedBytes);
  assert.ok(memory.estimatedMaximumBytes <= memory.maxSessionCaptureBytes);
});

test("invalid camera lock stops before projector pattern ownership", async () => {
  class UnlockedCamera extends DeterministicSimulatedCameraAdapter {
    async lockManualSettings(settings) {
      const result = await super.lockManualSettings(settings);
      return { ...result, confirmed: false, lockedFields: CAMERA_LOCK_FIELDS.filter((field) => field !== "focusMode") };
    }
  }
  const patterns = new DeterministicPatternOverrideAdapter();
  const orchestrator = new CameraCalibrationOrchestrator({
    cameraAdapter: new UnlockedCamera({ width: 8, height: 4 }),
    patternAdapter: patterns,
    solver: new DeterministicSimulatedCalibrationSolver(),
    now: clock(),
  });
  await assert.rejects(
    () => orchestrator.run(plan({ outputs: [output("A")] })),
    (error) => error.code === "CAMERA_SETTINGS_NOT_LOCKED" && error.session.state === CAMERA_CALIBRATION_STATE.FAILED,
  );
  assert.deepEqual(patterns.log, []);
});

test("solver failure after pattern takeover leaves all outputs black", async () => {
  const patterns = new DeterministicPatternOverrideAdapter();
  const orchestrator = new CameraCalibrationOrchestrator({
    cameraAdapter: new DeterministicSimulatedCameraAdapter({ width: 8, height: 4 }),
    patternAdapter: patterns,
    solver: { solve: async () => { throw new Error("synthetic solve failure"); } },
    requestOperatorConfirmation: confirmOperator,
    now: clock(),
  });
  await assert.rejects(
    () => orchestrator.run(plan({ outputs: [output("A")] })),
    (error) => error.code === "CALIBRATION_FAILED" && error.session.state === CAMERA_CALIBRATION_STATE.FAILED,
  );
  assert.equal(patterns.mode, "black");
  assert.match(patterns.log.at(-1), /^failed:black:/);
  assert.doesNotMatch(patterns.log.join("\n"), /complete:content/);
});

test("native Windows pattern adapter presents settled raw solid and Gray-code frames with target isolation", async () => {
  class FakeNativeEngine {
    constructor() {
      this.outputs = ["A", "B"].map((id) => ({
        id,
        active: true,
        blank: false,
        pattern: "content",
        patternParameters: {},
        correctionsBypassed: false,
        renderedFrames: 0,
      }));
      this.requests = [];
    }

    calibrationPatternCapabilities() {
      return {
        modes: ["solid", "gray-code", "content"],
        rawCorrectionBypass: true,
        targetIsolation: true,
        preservesWarp: true,
        solidEncoding: "linear",
        grayCodeCoordinate: "physical-output-pixel",
      };
    }

    async refreshStatus() {
      this.outputs.forEach((output) => { output.renderedFrames += 1; });
      return { state: "running", outputs: structuredClone(this.outputs) };
    }

    async blank(enabled, outputId = null) {
      this.requests.push({ type: "blank", enabled, outputId });
      this.outputs.forEach((output) => { if (!outputId || output.id === outputId) output.blank = enabled; });
      return { blank: enabled };
    }

    async setPattern(pattern) {
      this.requests.push({ request: "pattern", ...pattern });
      this.outputs.forEach((output) => {
        if (!pattern.outputId || output.id === pattern.outputId) {
          output.pattern = pattern.type;
          output.patternParameters = pattern.type === "solid"
            ? { rgb: [...pattern.rgb] }
            : pattern.type === "gray-code"
              ? { axis: pattern.axis, bit: pattern.bit, inverse: pattern.inverse }
              : {};
          output.correctionsBypassed = pattern.type !== "content";
        } else if (pattern.type !== "content") {
          output.pattern = "black";
          output.patternParameters = {};
          output.correctionsBypassed = true;
        }
      });
      return { mode: pattern.type };
    }
  }

  const calibrationPlan = plan({ outputs: [output("A")], settleFrames: 2 });
  const engine = new FakeNativeEngine();
  const patterns = new NativeRendererPatternOverrideAdapter({ engine, pollMs: 1, settleTimeoutMs: 1_000 });
  const ownership = await patterns.beginCalibration({ plan: calibrationPlan });
  assert.equal(ownership.exclusive, true);
  assert.equal(ownership.postWarpCoordinates, true);
  assert.equal(ownership.identityRaster, false);
  const firstGrayIndex = calibrationPlan.steps.findIndex((step) => step.purpose === "gray-code");
  for (const step of calibrationPlan.steps.slice(0, firstGrayIndex + 2)) await patterns.showStep(step);
  const grayRequest = engine.requests.find((request) => request.request === "pattern" && request.type === "gray-code"
    && request.axis === "x");
  assert.equal(grayRequest.bit, 0);
  assert.equal(grayRequest.inverse, false);
  assert.equal(grayRequest.outputId, "A");
  assert.equal(engine.outputs.find((item) => item.id === "B").pattern, "black");
  const restored = await patterns.completeCalibration();
  assert.deepEqual(restored, { restored: true, mode: "content" });
  assert.ok(engine.outputs.every((item) => item.pattern === "content" && item.blank === false));

  const second = new NativeRendererPatternOverrideAdapter({ engine, pollMs: 1, settleTimeoutMs: 1_000 });
  await second.beginCalibration({ plan: calibrationPlan });
  await second.failClosed({ reason: { code: "SYNTHETIC" } });
  assert.ok(engine.outputs.every((item) => item.blank === true));
});

test("manifest validator rejects missing required calibration artifacts", async () => {
  const { result, calibrationPlan } = await simulatedRun();
  const broken = structuredClone(result.manifest);
  delete broken.outputs[0].artifacts.confidence;
  assert.throws(
    () => normalizeCameraCalibrationManifest(broken, { plan: calibrationPlan }),
    (error) => error.code === "INVALID_CALIBRATION_CONTRACT" || error.code === "INVALID_CALIBRATION_MANIFEST",
  );
});

test("verified measured artifacts map to final warp, blend, black, mask, gamma and LUT output fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-measured-artifacts-"));
  try {
    const calibrationPlan = plan({ outputs: [output("A", 64, 64), output("B", 64, 64)] });
    const runClock = clock();
    const orchestrator = new CameraCalibrationOrchestrator({
      cameraAdapter: new MeasuredRawFixtureCameraAdapter({ width: 64, height: 64, now: runClock }),
      patternAdapter: new DeterministicPatternOverrideAdapter(),
      solver: new MeasuredCalibrationSolver({ artifactRoot: root }),
      requestOperatorConfirmation: confirmOperator,
      now: runClock,
    });
    const { manifest } = await orchestrator.run(calibrationPlan);
    const project = {
      id: "room-test",
      revision: 7,
      outputs: ["A", "B"].map((id) => ({
        id,
        nodeId: "render-01",
        resolution: { width: 64, height: 64, refreshNum: 60, refreshDen: 1 },
        sourceViewport: { x: 0, y: 0, width: 64, height: 64 },
      })),
    };
    const patch = await materializeMeasuredCalibrationProjectPatch({ manifest, project, artifactRoot: root });
    const validated = validateCameraCalibrationProjectPatch(patch, manifest, project, { nodeId: "render-01" });
    assert.equal(validated.outputs.length, 2);
    for (const output of validated.outputs) {
      assert.equal(output.warp.enabled, true);
      assert.equal(output.warp.points.length, 9);
      assert.equal(output.blend.enabled, true);
      assert.equal(output.blend.map.format, "r32_float");
      assert.equal(output.blackUniformity.enabled, true);
      assert.equal(output.blackUniformity.lift, 0);
      assert.equal(output.blackUniformity.map.format, "r32_float");
      assert.equal(output.mask.enabled, true);
      assert.equal(output.mask.map.format, "r32_float");
      assert.deepEqual(output.color.gamma, manifest.outputs.find((item) => item.outputId === output.id).artifacts.gamma.rgb);
      assert.equal(output.color.lut.format, "rgba32_float");
    }

    const forgedWarpPatch = structuredClone(patch);
    forgedWarpPatch.outputs[0].warp.points[4].x += 0.000001;
    assert.throws(
      () => validateCameraCalibrationProjectPatch(
        forgedWarpPatch,
        manifest,
        project,
        { nodeId: "render-01" },
      ),
      (error) => error.code === "INVALID_CALIBRATION_PROJECT_PATCH"
        && /warp content/.test(error.message),
    );

    const tampered = manifest.outputs[0].artifacts.blendWeight.path;
    await writeFile(tampered, Buffer.alloc(manifest.outputs[0].artifacts.blendWeight.byteLength, 0xff));
    await assert.rejects(
      () => materializeMeasuredCalibrationProjectPatch({ manifest, project, artifactRoot: root }),
      (error) => error.code === "CALIBRATION_ARTIFACT_HASH_MISMATCH",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
