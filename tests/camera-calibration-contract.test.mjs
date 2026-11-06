import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CAMERA_CALIBRATION_REFERENCE_KIND,
  CAMERA_CALIBRATION_REPEAT_LIMITS,
  CAMERA_CALIBRATION_SCHEMA_VERSION,
  assertCalibrationManifestApplicable,
  createCameraCalibrationPlan,
  createCameraCalibrationSession,
  normalizeCameraCalibrationManifest,
  normalizeCameraCalibrationPlan,
} from "../runtime/shared/camera-calibration.mjs";
import { createCameraLensProfile } from "../runtime/shared/camera-lens-profile.mjs";
import { derivePlanarOutputTargets } from "../runtime/shared/camera-survey.mjs";

function output(id = "A", width = 8, height = 4) {
  return { id, resolution: { width, height } };
}

function markerlessLensProfile(frame = { width: 2_432, height: 1_621 }) {
  return createCameraLensProfile({
    schema: "pixel-brightness.camera-lens-profile.v1",
    camera: { manufacturer: "Sony", model: "ILCE-7M4", serialNumber: "A7IV-UNIT-001" },
    lens: { manufacturer: "Sony", model: "FE 16-35mm F2.8 GM II", serialNumber: "GM2-UNIT-001" },
    frame,
    capture: { focalLengthMm: 16, focusDistanceM: 4.2, apertureFNumber: 5.6 },
    intrinsics: {
      fx: frame.width * 0.55,
      fy: frame.height * 0.74,
      cx: frame.width * 0.5,
      cy: frame.height * 0.5,
    },
    distortion: { model: "brown-conrady-v1", k1: -0.1, k2: 0.02, k3: -0.001, p1: 0, p2: 0 },
    calibration: {
      method: "opencv-charuco-brown-conrady-v1",
      calibratedAt: "2026-08-01T00:00:00.000Z",
      rmsResidualPx: 0.2,
      maxResidualPx: 0.7,
      imageCount: 36,
    },
  });
}

function plan(overrides = {}) {
  return createCameraCalibrationPlan({
    sessionId: "contract-v2-test",
    projectId: "room-a",
    projectRevision: 11,
    outputs: [output()],
    mesh: { columns: 2, rows: 2, minimumConfidence: 0.05 },
    settleFrames: 2,
    ...overrides,
  });
}

function camera() {
  return {
    id: "sony-a7iv-001",
    vendor: "Sony",
    model: "ILCE-7M4",
    serial: "A7IV-TEST-001",
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

function sha(character) {
  return character.repeat(64);
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function artifact({ digest, format, width, height, size, extra = {} }) {
  return {
    uri: `calibration://contract-v2/${digest.slice(0, 8)}`,
    sha256: digest,
    byteLength: 256,
    format,
    ...(width == null ? {} : { width }),
    ...(height == null ? {} : { height }),
    ...(size == null ? {} : { size }),
    ...extra,
  };
}

function physicalCaptures(calibrationPlan) {
  let timestamp = Date.parse("2026-08-24T01:00:00.000Z");
  return calibrationPlan.steps.filter((step) => step.capture).flatMap((step) => (
    Array.from({ length: step.repeats }, (_value, repeat) => {
      const capture = {
        id: `${step.id}#${repeat}`,
        stepId: step.id,
        repeat,
        outputId: step.outputId,
        passId: step.passId,
        exposureProfileId: step.exposureProfileId,
        referenceKind: step.referenceKind,
        capturedAt: new Date(timestamp).toISOString(),
        sourceSha256: digest(`raw:${step.id}#${repeat}`),
        rasterSha256: digest(`raster:${step.id}#${repeat}`),
        exposure: structuredClone(step.exposure),
        frame: {
          width: 12,
          height: 8,
          pixelFormat: "linear-rgb-f32",
          bitDepth: 14,
          linearized: true,
        },
        conditionsVerified: true,
        conditionVerification: {
          projectorState: step.captureConditions.projectorState,
          opticalPath: step.captureConditions.opticalPath,
          otherProjectors: step.captureConditions.otherProjectors,
          method: step.requiresOperatorConfirmation ? "operator-confirmation-v1" : "adapter-readback-v1",
          verifiedAt: new Date(timestamp).toISOString(),
          confirmationLeaseId: step.confirmationLeaseId,
          confirmationId: step.requiresOperatorConfirmation
            ? `confirmation:${step.confirmationLeaseId}`
            : null,
        },
      };
      timestamp += 10;
      return capture;
    })
  ));
}

function measuredManifest(calibrationPlan = plan()) {
  const captures = physicalCaptures(calibrationPlan);
  const outputPlan = calibrationPlan.outputs[0];
  const lutDigest = sha("6");
  const shortProfile = calibrationPlan.exposureProfiles.find((profile) => profile.role === "geometry");
  const longProfile = calibrationPlan.exposureProfiles.find((profile) => profile.role === "radiometry");
  const shortBridge = calibrationPlan.steps.find((step) => (
    step.outputId === outputPlan.id && step.semantic === "exposure-bridge" && step.bridgeRole === "short"
  ));
  const longBridge = calibrationPlan.steps.find((step) => (
    step.outputId === outputPlan.id && step.semantic === "exposure-bridge" && step.bridgeRole === "long"
  ));
  const capturesForStep = (step) => captures.filter((capture) => capture.stepId === step.id).map((capture) => capture.id);
  const references = (kind, outputId, profileId = longProfile.id) => captures.filter((capture) => (
    capture.referenceKind === kind
    && (profileId == null || capture.exposureProfileId === profileId)
    && (outputId === undefined || capture.outputId === outputId || capture.outputId == null)
  )).map((capture) => capture.id);
  const outputCaptureIds = captures
    .filter((capture) => capture.outputId == null || capture.outputId === outputPlan.id)
    .map((capture) => capture.id);
  return {
    schemaVersion: CAMERA_CALIBRATION_SCHEMA_VERSION,
    sessionId: calibrationPlan.sessionId,
    project: calibrationPlan.project,
    provenance: "measured",
    applicable: true,
    camera: camera(),
    cameraSettings: structuredClone(calibrationPlan.cameraSettings),
    exposureProfiles: structuredClone(calibrationPlan.exposureProfiles),
    sourcePolicy: structuredClone(calibrationPlan.sourcePolicy),
    startedAt: "2026-08-24T01:00:00.000Z",
    completedAt: "2026-08-24T01:10:00.000Z",
    captureProvenance: {
      version: 2,
      device: camera(),
      lens: {
        id: "sony-fe-16-35-gm2",
        vendor: "Sony",
        model: "FE 16-35mm F2.8 GM II",
        serial: "LENS-TEST-001",
        mount: "Sony E",
        focalLengthMm: 24,
        apertureF: calibrationPlan.cameraSettings.apertureF,
        focusDistanceM: 8,
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
      decoder: {
        name: "LibRaw",
        version: "0.21.4-pinned",
        binarySha256: digest("libraw-fixture-binary"),
      },
      rawDecode: {
        rawFormat: "ARW",
        sensorWidth: 7008,
        sensorHeight: 4672,
        cfaPattern: "RGGB",
        blackLevels: [512, 512, 512, 512],
        whiteLevels: [16383, 16383, 16383, 16383],
      },
      colorCharacterization: {
        status: "uncharacterized",
        method: "none",
        targetColorSpace: null,
        profileSha256: null,
        characterizedAt: null,
        matrixRgbToXyz: null,
        maximumDeltaE: null,
      },
      exposureProfiles: structuredClone(calibrationPlan.exposureProfiles),
      expectedCaptureIds: captures.map((capture) => capture.id),
      captures,
      stacks: calibrationPlan.steps.filter((step) => step.capture).map((step) => {
        const sourceCaptureIds = captures.filter((capture) => capture.stepId === step.id).map((capture) => capture.id);
        const groupCount = Math.min(3, sourceCaptureIds.length);
        const groupCounts = Array.from({ length: groupCount }, (_value, group) => (
          sourceCaptureIds.filter((_id, index) => index % groupCount === group).length
        ));
        return {
          id: `${step.id}#stack`,
          stepId: step.id,
          method: step.retention.aggregationMethod,
          channels: step.retention.channels,
          sourceCaptureIds,
          groupCounts,
          groupSpreadP95: sourceCaptureIds.length >= 3 ? 0.001 : null,
          statistics: [...step.retention.statistics],
        };
      }),
    },
    outputs: [{
      outputId: outputPlan.id,
      captureIds: outputCaptureIds,
      artifacts: {
        warp: artifact({
          digest: sha("1"),
          format: "pb-warp-mesh-v1",
          extra: { columns: 2, rows: 2, interpolation: "bicubic", pointCount: 9 },
        }),
        blendWeight: artifact({ digest: sha("2"), format: "r32_float", width: 8, height: 4 }),
        blackPedestal: artifact({ digest: sha("3"), format: "r32_float", width: 8, height: 4 }),
        mask: artifact({ digest: sha("4"), format: "r32_float", width: 8, height: 4 }),
        confidence: artifact({ digest: sha("5"), format: "r32_float", width: 8, height: 4 }),
        gamma: { rgb: [2.2, 2.18, 2.22], confidence: 0.95, method: "multi-exposure-tone-v2" },
        lut: {
          ...artifact({ digest: lutDigest, format: "rgba32_float", size: 17 }),
          status: "measured-relative",
          confidence: 0.9,
        },
      },
      radiometry: {
        method: "dark-subtracted-multi-exposure-v2",
        status: "passed",
        colorBasis: "camera-relative-rgb",
        colorimetric: false,
        measuredExposureNormalization: {
          bridgeId: shortBridge.bridgeId,
          shortStepId: shortBridge.id,
          longStepId: longBridge.id,
          shortProfileId: shortProfile.id,
          longProfileId: longProfile.id,
          inputRgb: [...shortBridge.inputRgb],
          shortCaptureIds: capturesForStep(shortBridge),
          longCaptureIds: capturesForStep(longBridge),
          nominalScale: longProfile.normalizationScale,
          measuredScaleRgb: Array(3).fill(longProfile.normalizationScale),
          measuredScaleLuma: longProfile.normalizationScale,
          relativeErrorRgb: [0, 0, 0],
          relativeErrorLuma: 0,
          uncertaintyRgb: [0.005, 0.005, 0.005],
          uncertaintyLuma: 0.005,
          snrDb: 35,
          clippedFraction: 0,
          status: "passed",
          gates: {
            passed: true,
            maximumRelativeError: calibrationPlan.exposureBridgePolicy.maximumRelativeError,
            maximumUncertainty: calibrationPlan.exposureBridgePolicy.maximumUncertainty,
            minimumSnrDb: calibrationPlan.exposureBridgePolicy.minimumSnrDb,
            maximumClippedFraction: calibrationPlan.exposureBridgePolicy.maximumClippedFraction,
          },
        },
        ambientDiagnostic: {
          status: "passed",
          medianProjectorLeakage: 0.001,
          negativeBeyondUncertaintyFraction: 0.01,
          uncertaintyP95: 0.002,
          captureIds: [
            ...references(CAMERA_CALIBRATION_REFERENCE_KIND.PROJECTORS_OFF_AMBIENT),
            ...references(CAMERA_CALIBRATION_REFERENCE_KIND.PROJECTOR_BLACK, outputPlan.id),
          ],
          maximumNegativeBeyondUncertaintyFraction: 0.05,
        },
        referenceCaptureIds: {
          sensorDark: references(CAMERA_CALIBRATION_REFERENCE_KIND.SENSOR_DARK, undefined, null),
          projectorsOffAmbient: references(CAMERA_CALIBRATION_REFERENCE_KIND.PROJECTORS_OFF_AMBIENT),
          projectorBlack: references(CAMERA_CALIBRATION_REFERENCE_KIND.PROJECTOR_BLACK, outputPlan.id),
        },
        samples: {
          total: 10_000,
          usable: 9_500,
          rejectedClipped: 200,
          rejectedLowSnr: 200,
          rejectedNonMonotonic: 100,
        },
        fit: {
          rmse: 0.01,
          maxAbsoluteError: 0.04,
          snrDb: 42,
          nearBlackSnrDb: 26,
          coverage: 0.98,
          clippedFraction: 0.02,
          gammaRgb: [2.2, 2.18, 2.22],
          channelRmse: [0.01, 0.011, 0.012],
          matrixDeterminant: 0.91,
          matrixCondition: 2.4,
          identityVerified: true,
        },
        black: {
          basis: "total-observed-projector-black-after-sensor-dark",
          status: "passed",
          uncertaintyP95: 0.002,
          nonuniformityRange: 0.025,
          snrDb: 28,
          target: 0.02,
          maxLift: 0.012,
        },
        gates: {
          passed: true,
          minimumUsableSamples: 8_000,
          maximumRmse: 0.03,
          minimumSnrDb: 30,
          minimumNearBlackSnrDb: 20,
          minimumCoverage: 0.95,
          maximumClippedFraction: 0.05,
          maximumBlackUncertaintyP95: 0.005,
          maximumBlackLift: 0.02,
        },
        lut: { method: "camera-relative-primary-matrix-v2", artifactSha256: lutDigest },
      },
    }],
  };
}

test("V2 plan explicitly separates short geometry and long radiometry with matched dark references", () => {
  const value = plan();
  assert.equal(value.schemaVersion, 2);
  assert.deepEqual(value.repeatPolicy, {
    geometry: CAMERA_CALIBRATION_REPEAT_LIMITS.geometry.default,
    radiometry: CAMERA_CALIBRATION_REPEAT_LIMITS.radiometry.default,
    nearBlack: CAMERA_CALIBRATION_REPEAT_LIMITS.nearBlack.default,
    references: CAMERA_CALIBRATION_REPEAT_LIMITS.references.default,
  });
  const geometry = value.exposureProfiles.find((profile) => profile.role === "geometry");
  const radiometry = value.exposureProfiles.find((profile) => profile.role === "radiometry");
  assert.equal(geometry.normalizationScale, 1);
  assert.equal(radiometry.normalizationScale, 60);
  assert.ok(radiometry.settings.shutterUs > geometry.settings.shutterUs);

  const dark = value.steps.filter((step) => step.referenceKind === "sensor-dark");
  assert.deepEqual(dark.map((step) => step.exposureProfileId).sort(), [geometry.id, radiometry.id].sort());
  assert.ok(dark.every((step) => step.captureConditions.opticalPath === "blocked"
    && step.requiresOperatorConfirmation && step.repeats === value.repeatPolicy.references));
  assert.equal(new Set(dark.map((step) => step.confirmationLeaseId)).size, 1);
  const ambient = value.steps.find((step) => step.referenceKind === "projectors-off-ambient");
  assert.equal(ambient.exposureProfileId, radiometry.id);
  assert.equal(ambient.captureConditions.projectorState, "emission-off");
  const black = value.steps.find((step) => step.referenceKind === "projector-black");
  assert.equal(black.exposureProfileId, radiometry.id);
  assert.equal(black.outputId, null);
  assert.equal(value.steps.filter((step) => step.referenceKind === "projector-black").length, 1);
  assert.equal(black.repeats, value.repeatPolicy.references);
  assert.equal(black.requiresOperatorConfirmation, true);
  const bridges = value.steps.filter((step) => step.semantic === "exposure-bridge");
  assert.equal(bridges.length, 2);
  assert.equal(new Set(bridges.map((step) => step.bridgeId)).size, 1);
  assert.equal(new Set(bridges.map((step) => step.inputRgb[0])).size, 1);
  assert.deepEqual(bridges.map((step) => step.bridgeRole).sort(), ["long", "short"]);
  assert.ok(bridges.every((step) => step.inputRgb[0] * step.exposure.normalizationScale <= 0.5 + 1e-12));
  assert.ok(value.steps.filter((step) => step.purpose === "near-black")
    .every((step) => step.repeats === value.repeatPolicy.nearBlack
      && step.pattern.rgb[0] * step.exposure.normalizationScale <= 0.9));
  assert.ok(value.steps.filter((step) => step.purpose === "near-black")
    .some((step) => step.exposureProfileId === radiometry.id));
  assert.ok(value.steps.filter((step) => step.purpose === "gray-code")
    .every((step) => step.exposureProfileId === geometry.id && step.repeats === value.repeatPolicy.geometry));
  assert.ok(value.steps.filter((step) => step.purpose === "tone" || step.purpose.startsWith("primary-"))
    .every((step) => step.inputRgb?.length === 3
      && step.exposureProfileId === geometry.id
      && step.repeats === value.repeatPolicy.radiometry));
  assert.ok(value.steps.filter((step) => step.purpose.startsWith("low-primary-"))
    .every((step) => step.inputRgb?.length === 3
      && step.exposureProfileId === radiometry.id
      && step.repeats === value.repeatPolicy.radiometry));
  assert.ok(value.passes.every((pass) => pass.retention.retainSourceFrames === 0));

  const immersive = plan({ outputs: [output("wall-a"), output("wall-b"), output("floor")] });
  assert.equal(immersive.steps.filter((step) => step.referenceKind === "projector-black").length, 1);
  assert.equal(immersive.steps.filter((step) => step.semantic === "exposure-bridge").length, 6);
  assert.deepEqual(
    [...new Set(immersive.steps.filter((step) => step.requiresOperatorConfirmation)
      .map((step) => step.confirmationLeaseId))].sort(),
    ["projector-black-restored", "projectors-off-ambient", "sensor-dark-optical-blocked"],
  );
});

test("custom exposure requests require a calibrated scale and fixed optical settings", () => {
  const customGeometry = structuredClone(plan().cameraSettings);
  assert.throws(
    () => plan({ cameraSettings: customGeometry }),
    (error) => error.code === "INVALID_CALIBRATION_CONTRACT" && /explicit radiometry/.test(error.message),
  );
  const customLong = {
    exposureMode: "manual",
    iso: 100,
    apertureF: 5.6,
    shutterUs: 500_000,
    whiteBalance: { mode: "kelvin", kelvin: 5_600 },
    focusMode: "manual",
    captureFormat: "linear-rgb",
  };
  assert.throws(
    () => plan({ radiometryCameraSettings: customLong }),
    (error) => error.code === "INVALID_CALIBRATION_CONTRACT" && /normalizationScale/i.test(error.message),
  );
  assert.equal(plan({ radiometryCameraSettings: customLong, radiometryNormalizationScale: 30 })
    .exposureProfiles.find((profile) => profile.role === "radiometry").normalizationScale, 30);

  const profiles = structuredClone(plan().exposureProfiles);
  profiles[1].settings.apertureF = 8;
  assert.throws(
    () => plan({ exposureProfiles: profiles }),
    (error) => error.code === "INVALID_CALIBRATION_CONTRACT" && /apertureF/.test(error.message),
  );
  const notLong = structuredClone(plan().exposureProfiles);
  notLong[1].settings.shutterUs = notLong[0].settings.shutterUs;
  assert.throws(
    () => plan({ exposureProfiles: notLong }),
    (error) => error.code === "INVALID_CALIBRATION_CONTRACT" && /longer shutter/.test(error.message),
  );
  assert.throws(
    () => plan({ repeatPolicy: { nearBlack: 33 } }),
    (error) => error.code === "INVALID_CALIBRATION_CONTRACT" && /nearBlack/.test(error.message),
  );
  assert.throws(
    () => plan({ repeatPolicy: { radiometry: 2 } }),
    (error) => error.code === "INVALID_CALIBRATION_CONTRACT" && /radiometry/.test(error.message),
  );
  assert.throws(
    () => plan({ repeatPolicy: { near_black: 16 } }),
    (error) => error.code === "INVALID_CALIBRATION_CONTRACT" && /unknown fields/.test(error.message),
  );
  assert.throws(
    () => plan({ repeatPolicy: { geometry: 1 }, repeats: 1 }),
    (error) => error.code === "INVALID_CALIBRATION_CONTRACT" && /cannot be combined/.test(error.message),
  );
  assert.throws(
    () => plan({ radiometryNormalizationScale: 1_000 }),
    (error) => error.code === "INVALID_CALIBRATION_CONTRACT" && /too long/.test(error.message),
  );
});

test("persisted V2 plans are canonical and fail closed when a pass or exposure snapshot is altered", () => {
  const value = plan();
  assert.deepEqual(normalizeCameraCalibrationPlan(value), value);
  assert.equal(createCameraCalibrationSession(value).schemaVersion, 2);

  for (const mutate of [
    (broken) => { broken.schemaVersion = 1; },
    (broken) => { broken.steps.find((step) => step.capture).repeats += 1; },
    (broken) => { broken.steps.find((step) => step.referenceKind === "sensor-dark").referenceKind = null; },
    (broken) => { broken.steps.find((step) => step.purpose === "near-black").exposure.normalizationScale = 1; },
    (broken) => { broken.passes[0].retention.retainSourceFrames = 1; },
  ]) {
    const broken = structuredClone(value);
    mutate(broken);
    assert.throws(
      () => normalizeCameraCalibrationPlan(broken),
      (error) => error.code === "INVALID_CALIBRATION_CONTRACT",
    );
  }
});

test("an applicable measured manifest carries exact physical captures, bounded stacks and passed radiometry", () => {
  const calibrationPlan = plan();
  const manifest = measuredManifest(calibrationPlan);
  const normalized = normalizeCameraCalibrationManifest(manifest, { plan: calibrationPlan });
  assert.equal(normalized.applicable, true);
  assert.equal(normalized.captureProvenance.pipeline.bitDepth, 14);
  assert.equal(normalized.captureProvenance.pipeline.captureMode, "single-shot");
  assert.equal(normalized.captureProvenance.pipeline.shutterMode, "efcs");
  assert.equal(normalized.captureProvenance.pipeline.rawEncoding, "lossless-compressed");
  assert.equal(normalized.captureProvenance.version, 2);
  assert.equal(normalized.captureProvenance.decoder.name, "LibRaw");
  assert.equal(normalized.captureProvenance.rawDecode.cfaPattern, "RGGB");
  assert.equal(new Set(normalized.captureProvenance.captures.map((capture) => capture.sourceSha256)).size,
    normalized.captureProvenance.captures.length);
  assert.equal(normalized.captureProvenance.lens.stabilization, "off");
  assert.equal(normalized.captureProvenance.stacks.length, calibrationPlan.steps.filter((step) => step.capture).length);
  assert.equal(normalized.outputs[0].radiometry.gates.passed, true);
  assert.equal(normalized.outputs[0].radiometry.measuredExposureNormalization.status, "passed");
  assert.equal(assertCalibrationManifestApplicable(normalized).sessionId, calibrationPlan.sessionId);
});

test("a colorimetric LUT claim requires a validated camera characterization profile", () => {
  const calibrationPlan = plan();
  const manifest = measuredManifest(calibrationPlan);
  manifest.captureProvenance.colorCharacterization = {
    status: "validated",
    method: "charted-rgb-to-xyz-profile-v1",
    targetColorSpace: "CIE XYZ D65",
    profileSha256: sha("a"),
    characterizedAt: "2026-08-23T12:00:00.000Z",
    matrixRgbToXyz: [
      [0.41, 0.36, 0.18],
      [0.21, 0.72, 0.07],
      [0.02, 0.12, 0.95],
    ],
    maximumDeltaE: 1.8,
  };
  manifest.outputs[0].artifacts.lut.status = "measured";
  manifest.outputs[0].radiometry.colorBasis = "characterized-colorimetric";
  manifest.outputs[0].radiometry.colorimetric = true;
  const normalized = normalizeCameraCalibrationManifest(manifest, { plan: calibrationPlan });
  assert.equal(normalized.outputs[0].artifacts.lut.status, "measured");
  assert.equal(normalized.captureProvenance.colorCharacterization.status, "validated");
});

test("measured manifests reject missing or falsified dark, exposure, condition, stack and gate provenance", () => {
  const calibrationPlan = plan();
  const mutations = [
    (manifest) => { delete manifest.captureProvenance; },
    (manifest) => { manifest.captureProvenance.version = 1; },
    (manifest) => { delete manifest.captureProvenance.decoder.binarySha256; },
    (manifest) => { manifest.captureProvenance.decoder.binarySha256 = manifest.captureProvenance.decoder.binarySha256.toUpperCase(); },
    (manifest) => { manifest.captureProvenance.decoder.binaryPayload = "forbidden"; },
    (manifest) => { manifest.captureProvenance.rawDecode.cfaPattern = "RGGBRGGB"; },
    (manifest) => { manifest.captureProvenance.rawDecode.whiteLevels[0] = 511; },
    (manifest) => { manifest.captureProvenance.rawDecode.makerNote = { binary: true }; },
    (manifest) => { delete manifest.captureProvenance.captures[0].sourceSha256; },
    (manifest) => { manifest.captureProvenance.captures[0].sourceSha256 = manifest.captureProvenance.captures[1].sourceSha256; },
    (manifest) => { manifest.captureProvenance.captures[0].rasterSha256 = "A".repeat(64); },
    (manifest) => { manifest.captureProvenance.pipeline.captureMode = "continuous"; },
    (manifest) => { manifest.captureProvenance.pipeline.shutterMode = "electronic"; },
    (manifest) => { manifest.captureProvenance.pipeline.rawEncoding = "lossy-compressed"; },
    (manifest) => { manifest.captureProvenance.pipeline.silentShutter = true; },
    (manifest) => { manifest.captureProvenance.pipeline.blackLevelSubtracted = true; },
    (manifest) => { manifest.captureProvenance.pipeline.whiteBalanceApplied = true; },
    (manifest) => { manifest.captureProvenance.pipeline.lensCorrectionsApplied = true; },
    (manifest) => { manifest.captureProvenance.lens.focusLocked = false; },
    (manifest) => { manifest.captureProvenance.lens.zoomLocked = false; },
    (manifest) => { manifest.captureProvenance.lens.stabilization = "tripod-verified"; },
    (manifest) => { manifest.outputs[0].artifacts.lut.status = "measured"; },
    (manifest) => { manifest.outputs[0].radiometry.colorimetric = true; },
    (manifest) => { manifest.captureProvenance.captures[0].exposure.normalizationScale = 2; },
    (manifest) => { manifest.captureProvenance.captures[0].frame.pixelFormat = "linear-luma-f32"; },
    (manifest) => { manifest.captureProvenance.captures[0].conditionsVerified = false; },
    (manifest) => {
      const capture = manifest.captureProvenance.captures[0];
      capture.capturedAt = new Date(Date.parse(capture.conditionVerification.verifiedAt) - 1).toISOString();
    },
    (manifest) => {
      const secondDark = manifest.captureProvenance.captures.find((capture) => (
        capture.referenceKind === "sensor-dark" && capture.exposureProfileId === "radiometry-long"
      ));
      secondDark.conditionVerification.confirmationId = "confirmation:replayed-as-another-click";
    },
    (manifest) => { manifest.captureProvenance.stacks[0].sourceCaptureIds.pop(); },
    (manifest) => { manifest.outputs[0].radiometry.measuredExposureNormalization.shortStepId += "-wrong"; },
    (manifest) => { manifest.outputs[0].radiometry.measuredExposureNormalization.shortCaptureIds.pop(); },
    (manifest) => { manifest.outputs[0].radiometry.measuredExposureNormalization.measuredScaleRgb[0] = 50; },
    (manifest) => {
      const bridge = manifest.outputs[0].radiometry.measuredExposureNormalization;
      bridge.measuredScaleLuma = bridge.nominalScale * 1.1;
      bridge.relativeErrorLuma = 0.1;
      bridge.status = "failed";
      bridge.gates.passed = false;
    },
    (manifest) => {
      manifest.outputs[0].radiometry.measuredExposureNormalization.gates.maximumRelativeError = 0.2;
    },
    (manifest) => { manifest.outputs[0].radiometry.black.basis = "ambient-subtracted-projector-leakage"; },
    (manifest) => { manifest.outputs[0].radiometry.ambientDiagnostic.captureIds.pop(); },
    (manifest) => {
      manifest.outputs[0].radiometry.ambientDiagnostic.negativeBeyondUncertaintyFraction = 0.1;
    },
    (manifest) => { manifest.outputs[0].radiometry.referenceCaptureIds.sensorDark.pop(); },
    (manifest) => { manifest.outputs[0].radiometry.fit.rmse = 0.2; },
    (manifest) => { manifest.outputs[0].radiometry.lut.artifactSha256 = sha("f"); },
    (manifest) => {
      const globalId = manifest.captureProvenance.captures.find((capture) => capture.outputId == null).id;
      manifest.outputs[0].captureIds = manifest.outputs[0].captureIds.filter((id) => id !== globalId);
    },
  ];
  for (const mutate of mutations) {
    const broken = measuredManifest(calibrationPlan);
    mutate(broken);
    assert.throws(
      () => normalizeCameraCalibrationManifest(broken, { plan: calibrationPlan }),
      (error) => ["INVALID_CALIBRATION_MANIFEST", "INVALID_CALIBRATION_CONTRACT"].includes(error.code),
    );
  }
});

test("legacy-compatible simulation remains non-applicable and cannot bypass measured evidence", () => {
  const calibrationPlan = plan();
  const candidate = measuredManifest(calibrationPlan);
  candidate.provenance = "simulated";
  candidate.applicable = false;
  delete candidate.captureProvenance;
  delete candidate.exposureProfiles;
  delete candidate.outputs[0].radiometry;
  candidate.outputs[0].captureIds = calibrationPlan.steps
    .filter((step) => step.capture && step.outputId === "A")
    .flatMap((step) => Array.from({ length: step.repeats }, (_value, repeat) => `${step.id}#${repeat}`));
  const normalized = normalizeCameraCalibrationManifest(candidate, { plan: calibrationPlan });
  assert.equal(normalized.provenance, "simulated");
  assert.equal(normalized.applicable, false);
  assert.throws(
    () => assertCalibrationManifestApplicable(normalized),
    (error) => error.code === "CALIBRATION_ARTIFACT_NOT_APPLICABLE",
  );

  const forgedMeasured = measuredManifest(calibrationPlan);
  forgedMeasured.camera.transport = "simulation";
  forgedMeasured.camera.backend = "deterministic-simulator";
  forgedMeasured.captureProvenance.device = structuredClone(forgedMeasured.camera);
  assert.throws(
    () => normalizeCameraCalibrationManifest(forgedMeasured, { plan: calibrationPlan }),
    (error) => error.code === "INVALID_CALIBRATION_MANIFEST" && /simulated camera/.test(error.message),
  );
});

test("markerless planar targets are canonical, wall-bound and limited to one fixed camera view", () => {
  const lensProfile = markerlessLensProfile();
  const projectOutputs = [
    {
      id: "A",
      wallId: "wall-north",
      resolution: { width: 1_920, height: 1_080 },
      sourceViewport: { x: 0, y: 0, width: 1_920, height: 1_080 },
    },
    {
      id: "B",
      wallId: "wall-north",
      resolution: { width: 1_920, height: 1_080 },
      sourceViewport: { x: 1_680, y: 0, width: 1_920, height: 1_080 },
    },
  ];
  const surfaceTargets = derivePlanarOutputTargets({
    surveys: [{
      id: "north-survey",
      wallId: "wall-north",
      cameraViewId: "a7iv-fixed-north",
      frame: { width: 2_432, height: 1_621 },
      lensProfileSha256: lensProfile.sha256,
      boundary: [{ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.15 }, { x: 0.85, y: 0.85 }, { x: 0.15, y: 0.9 }],
    }],
    outputs: projectOutputs,
    lensProfile,
  });
  const calibrationPlan = createCameraCalibrationPlan({
    sessionId: "surface-target-contract",
    projectId: "room-test",
    projectRevision: 8,
    outputs: projectOutputs,
    surfaceTargets,
    lensProfile,
  });
  assert.equal(calibrationPlan.outputs[0].surfaceTarget.wallId, "wall-north");
  assert.ok(calibrationPlan.outputs[0].surfaceTarget.corners[1].x
    > calibrationPlan.outputs[1].surfaceTarget.corners[0].x);
  assert.deepEqual(normalizeCameraCalibrationPlan(calibrationPlan), calibrationPlan);

  const moved = structuredClone(surfaceTargets);
  moved[1].cameraViewId = "camera-moved";
  assert.throws(
    () => createCameraCalibrationPlan({
      sessionId: "surface-target-moved",
      projectId: "room-test",
      projectRevision: 8,
      outputs: projectOutputs,
      surfaceTargets: moved,
      lensProfile,
    }),
    (error) => error.code === "MULTIPLE_CAMERA_VIEWS_UNSUPPORTED",
  );

  assert.throws(
    () => createCameraCalibrationPlan({
      sessionId: "surface-target-without-profile",
      projectId: "room-test",
      projectRevision: 8,
      outputs: projectOutputs,
      surfaceTargets,
    }),
    (error) => error.code === "CAMERA_LENS_PROFILE_REQUIRED",
  );
});
