import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ExternalCameraHelperAdapter } from "../runtime/node/external-camera-helper.mjs";
import { createCameraLensProfile } from "../runtime/shared/camera-lens-profile.mjs";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "camera-helper-fixture.mjs");

function previewRequest() {
  const lensProfile = createCameraLensProfile({
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
  return {
    schemaVersion: 1,
    requestId: "survey-preview-fixture-001",
    nodeId: "fixture-node",
    cameraId: "sony-a7iv-fixture",
    cameraViewId: "north-wall-fixed-view",
    lensProfile,
    cameraSettings: {
      exposureMode: "manual",
      iso: 100,
      apertureF: 5.6,
      shutterUs: 16_667,
      whiteBalance: { mode: "kelvin", kelvin: 5_600 },
      focusMode: "manual",
      captureFormat: "linear-rgb",
    },
  };
}

test("external camera helper confines and verifies linear Sony capture rasters", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-camera-helper-"));
  await chmod(fixture, 0o755);
  const adapter = new ExternalCameraHelperAdapter({ command: fixture, captureRoot: root });
  try {
    const detection = await adapter.detect();
    assert.equal(detection.adapter.available, true);
    assert.equal(detection.cameras[0].model, "ILCE-7M4");
    await adapter.open(detection.cameras[0].id);
    const settings = {
      exposureMode: "manual",
      iso: 100,
      aperture: 5.6,
      shutterSeconds: 0.5,
      whiteBalance: "manual",
      focusMode: "manual",
    };
    assert.equal((await adapter.lockManualSettings(settings)).confirmed, true);
    const capture = await adapter.capture({
      step: {
        id: "dark-reference",
        outputId: "A",
        passId: "radiometry-long",
        referenceKind: "sensor-dark",
        captureConditions: { projectorState: "emission-off", opticalPath: "blocked", otherProjectors: "emission-off" },
      },
      repeat: 0,
      maxPixels: 4_194_304,
      maxWidth: 4_096,
      maxHeight: 4_096,
      preferredPixelFormat: "linear-rgb-f32",
    });
    assert.equal(capture.pixelFormat, "linear-rgb-f32");
    assert.equal(capture.data.length, 12);
    assert.equal(capture.provenance.linearized, true);
    assert.equal(capture.provenance.sourceBitDepth, 14);
    assert.match(capture.provenance.sourceSha256, /^[a-f0-9]{64}$/);
    assert.equal(capture.provenance.rasterSha256, capture.rasterSha256);
    assert.deepEqual(capture.provenance.decoder, {
      name: "fixture-raw-decoder",
      version: "1.0.0",
      binarySha256: capture.provenance.decoder.binarySha256,
    });
    assert.match(capture.provenance.decoder.binarySha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(capture.provenance.rawDecode, {
      rawFormat: "ARW",
      sensorWidth: 2,
      sensorHeight: 2,
      cfaPattern: "RGGB",
      blackLevels: [512, 512, 512, 512],
      whiteLevels: [16383, 16383, 16383, 16383],
    });
    assert.equal(capture.bitDepth, 14);
    assert.equal(capture.pipeline.sourcePixelFormat, "ARW-14");
    assert.equal(capture.pipeline.retainedPixelFormat, "linear-rgb-f32");
    assert.equal(capture.pipeline.captureMode, "single-shot");
    assert.equal(capture.pipeline.shutterMode, "efcs");
    assert.equal(capture.pipeline.rawEncoding, "lossless-compressed");
    assert.equal(capture.pipeline.blackLevelSubtracted, false);
    assert.equal(capture.pipeline.toneCurveApplied, false);
    assert.equal(capture.referenceKind, "sensor-dark");
    assert.equal(capture.conditionVerification.opticalPath, "blocked");
    assert.equal(capture.lens.focalLengthMm, 16);
    assert.ok(Math.abs(capture.data[11] - 0.9) < 1e-6);
  } finally {
    await adapter.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("external camera helper rejects unpinned or unbounded RAW decoder metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-camera-helper-provenance-"));
  await chmod(fixture, 0o755);
  const adapter = new ExternalCameraHelperAdapter({ command: fixture, captureRoot: root });
  try {
    for (const step of [
      { id: "bad-decoder-hash", fixtureDecoderOverride: { binarySha256: "not-a-digest" } },
      { id: "unknown-decoder-field", fixtureDecoderOverride: { binaryPayload: "forbidden" } },
      { id: "invalid-raw-levels", fixtureRawDecodeOverride: { whiteLevels: [511, 511, 511, 511] } },
      { id: "unbounded-raw-metadata", fixtureRawDecodeOverride: { makerNote: "forbidden" } },
    ]) {
      await assert.rejects(
        adapter.capture({
          step: { ...step, captureConditions: {} },
          repeat: 0,
          maxPixels: 4_194_304,
          maxWidth: 4_096,
          maxHeight: 4_096,
          preferredPixelFormat: "linear-rgb-f32",
        }),
        (error) => error?.code === "CAMERA_RAW_PROVENANCE_INVALID",
      );
    }
  } finally {
    await adapter.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("external camera helper independently verifies the downloaded RAW source file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-camera-helper-source-"));
  await chmod(fixture, 0o755);
  const adapter = new ExternalCameraHelperAdapter({ command: fixture, captureRoot: root });
  try {
    for (const step of [
      { id: "missing-source", fixtureSourceOverride: null },
      { id: "wrong-source-hash", fixtureSourceOverride: { sha256: "0".repeat(64) } },
      { id: "unknown-source-field", fixtureSourceOverride: { unboundedMetadata: "forbidden" } },
    ]) {
      await assert.rejects(
        adapter.capture({
          step: { ...step, captureConditions: {} },
          repeat: 0,
          maxPixels: 4_194_304,
          maxWidth: 4_096,
          maxHeight: 4_096,
          preferredPixelFormat: "linear-rgb-f32",
        }),
        (error) => new Set([
          "CAMERA_RAW_PROVENANCE_INVALID",
          "CAMERA_RAW_SOURCE_HASH_MISMATCH",
        ]).has(error?.code),
      );
      assert.deepEqual(await readdir(root), [], "rejected helper exchange files must not accumulate");
    }
  } finally {
    await adapter.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("external camera helper rejects lossy or electronic RAW acquisition modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-camera-helper-mode-"));
  await chmod(fixture, 0o755);
  const adapter = new ExternalCameraHelperAdapter({ command: fixture, captureRoot: root });
  try {
    await assert.rejects(
      adapter.capture({
        step: {
          id: "raw-mode-gate",
          captureConditions: {},
          fixturePipelineOverride: { shutterMode: "electronic", rawEncoding: "lossy-compressed" },
        },
        repeat: 0,
        maxPixels: 4_194_304,
        maxWidth: 4_096,
        maxHeight: 4_096,
        preferredPixelFormat: "linear-rgb-f32",
      }),
      (error) => error?.code === "CAMERA_CAPTURE_PIPELINE_MISMATCH",
    );
  } finally {
    await adapter.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("external camera helper rejects a capture whose RAW bit depth does not match the locked profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-camera-helper-depth-"));
  await chmod(fixture, 0o755);
  const adapter = new ExternalCameraHelperAdapter({
    command: fixture,
    captureRoot: root,
    requiredBitDepth: 12,
  });
  try {
    await assert.rejects(
      adapter.capture({
        step: { id: "raw-depth-gate", captureConditions: {} },
        repeat: 0,
        maxPixels: 4_194_304,
        maxWidth: 4_096,
        maxHeight: 4_096,
        preferredPixelFormat: "linear-rgb-f32",
      }),
      (error) => error?.code === "CAMERA_CAPTURE_PIPELINE_MISMATCH",
    );
  } finally {
    await adapter.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("external camera helper returns one exact-raster RAW-derived markerless survey preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-camera-helper-preview-"));
  await chmod(fixture, 0o755);
  const adapter = new ExternalCameraHelperAdapter({ command: fixture, captureRoot: root });
  try {
    const request = previewRequest();
    const capture = await adapter.captureSurveyPreview(request);
    assert.equal(capture.requestId, request.requestId);
    assert.equal(capture.cameraViewId, request.cameraViewId);
    assert.equal(capture.lensProfileSha256, request.lensProfile.sha256);
    assert.deepEqual({ width: capture.width, height: capture.height }, request.lensProfile.frame);
    assert.equal(capture.pixelFormat, "linear-rgb-f32");
    assert.equal(capture.data.length, 32 * 32 * 3);
    assert.equal(capture.rawSourceKind, "single-shot-linear-raw-decode-v1");
    assert.match(capture.rasterSha256, /^[a-f0-9]{64}$/);
    assert.match(capture.provenance.sourceSha256, /^[a-f0-9]{64}$/);
    assert.equal(capture.pipeline.lensCorrectionsApplied, false);
    assert.equal(capture.pipeline.blackLevelSubtracted, false);
    assert.equal(capture.lens.serial, "FIXTURE-LENS-001");
  } finally {
    await adapter.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
