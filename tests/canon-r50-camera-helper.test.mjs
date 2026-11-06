import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CANON_RF_S_10_18_LENS_MODEL,
  CanonR50ExternalCameraHelperAdapter,
} from "../runtime/node/external-camera-helper.mjs";
import { createCameraLensProfile } from "../runtime/shared/camera-lens-profile.mjs";

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "canon-camera-helper-fixture.mjs",
);

const cameraSettings = Object.freeze({
  exposureMode: "manual",
  iso: 100,
  apertureF: 5.6,
  shutterUs: 16_667,
  whiteBalance: { mode: "kelvin", kelvin: 5_600 },
  focusMode: "manual",
  captureFormat: "linear-rgb",
});

async function adapter(root, options = {}) {
  const captureRoot = join(root, "captures");
  const runtimeRoot = join(root, "canon-edsdk-runtime");
  const runtimeManifestPath = join(runtimeRoot, "runtime-manifest.json");
  const runtimeFile = {
    name: "EDSDK.dll",
    bytes: Buffer.from("pixel-brightness-test-only-canon-edsdk-runtime", "utf8"),
  };
  await Promise.all([
    mkdir(captureRoot, { recursive: true }),
    mkdir(runtimeRoot, { recursive: true }),
  ]);
  await writeFile(join(runtimeRoot, runtimeFile.name), runtimeFile.bytes);
  await writeFile(runtimeManifestPath, `${JSON.stringify({
    schema: "pixel-brightness.canon-edsdk-runtime.v1",
    sdkVersion: "13.19.10-fixture",
    architecture: "x64",
    entry: runtimeFile.name,
    files: [{
      name: runtimeFile.name,
      sha256: createHash("sha256").update(runtimeFile.bytes).digest("hex"),
    }],
  })}\n`, "utf8");
  return new CanonR50ExternalCameraHelperAdapter({
    command: fixture,
    captureRoot,
    runtimeManifestPath,
    expectedSerial: "R50-FIXTURE-0001",
    expectedLensSerial: "RFS1018-FIXTURE-0001",
    expectedFocalLengthMm: 10,
    timeoutMs: 5_000,
    ...options,
  });
}

async function openAndLock(camera) {
  const detection = await camera.detect();
  assert.equal(detection.adapter.available, true);
  assert.deepEqual(detection.cameras.map(({ model, serial }) => ({ model, serial })), [{
    model: "EOS R50",
    serial: "R50-FIXTURE-0001",
  }]);
  const opened = await camera.open(detection.cameras[0].id);
  assert.equal(opened.backend, "canon-edsdk");
  const lock = await camera.lockManualSettings(cameraSettings);
  assert.equal(lock.confirmed, true);
  assert.deepEqual(lock.applied, cameraSettings);
}

function captureInput(step = {}) {
  return {
    step: {
      id: "canon-r50-raw-001",
      outputId: "A",
      captureConditions: {
        projectorState: "emission-off",
        opticalPath: "blocked",
        otherProjectors: "emission-off",
      },
      ...step,
    },
    repeat: 0,
    maxPixels: 4_194_304,
    maxWidth: 4_096,
    maxHeight: 4_096,
    maxRawBytes: 64 * 1024 * 1024,
    preferredPixelFormat: "linear-rgb-f32",
    exposureProfileId: "geometry",
    exposureSettings: cameraSettings,
  };
}

test("Canon EOS R50 helper binds the exact body and RF-S 10-18 before accepting one CR3", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-canon-r50-"));
  await chmod(fixture, 0o755);
  const camera = await adapter(root);
  try {
    await openAndLock(camera);
    const capture = await camera.capture(captureInput());
    assert.equal(capture.cameraDevice.vendor, "Canon");
    assert.equal(capture.cameraDevice.model, "EOS R50");
    assert.equal(capture.cameraDevice.serial, "R50-FIXTURE-0001");
    assert.equal(capture.lens.model, CANON_RF_S_10_18_LENS_MODEL);
    assert.equal(capture.lens.serial, "RFS1018-FIXTURE-0001");
    assert.equal(capture.bitDepth, 14);
    assert.equal(capture.provenance.rawFormat, "CR3");
    assert.equal(capture.provenance.rawDecode.rawFormat, "CR3");
    assert.deepEqual(capture.provenance.rawDecode.blackLevels, [256, 257, 258, 259]);
    assert.deepEqual(capture.provenance.rawDecode.whiteLevels, [16383, 16380, 16382, 16381]);
    assert.equal(capture.provenance.source.mediaType, "image/x-canon-cr3");
    assert.equal(capture.provenance.source.acquisition, "single-shot-download");
    assert.deepEqual(capture.provenance.sourcePolicy, {
      kind: "single-shot-linear-raw-decode-v1",
      processedJpeg: false,
      liveView: false,
      spatialTransform: "none",
    });
    assert.deepEqual(capture.provenance.manualLock.applied, cameraSettings);
    assert.equal(capture.pipeline.blackLevelSubtracted, false);
    assert.equal(capture.pipeline.whiteBalanceApplied, false);
    assert.equal(capture.pipeline.toneCurveApplied, false);
    assert.equal(capture.pipeline.lensCorrectionsApplied, false);
    assert.deepEqual(await readdir(join(root, "captures")), []);
  } finally {
    await camera.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("Canon helper fails closed before open on a configured body or lens serial mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-canon-binding-"));
  await chmod(fixture, 0o755);
  for (const options of [
    { expectedSerial: "WRONG-BODY" },
    { expectedLensSerial: "WRONG-LENS" },
  ]) {
    const camera = await adapter(root, options);
    try {
      const detection = await camera.detect();
      assert.equal(detection.adapter.available, false);
      assert.deepEqual(detection.cameras, []);
      await assert.rejects(
        camera.open("canon-r50-fixture"),
        (error) => error?.code === "CAMERA_NOT_FOUND",
      );
    } finally {
      await camera.close().catch(() => {});
    }
  }
  await rm(root, { recursive: true, force: true });
});

test("Canon helper rejects lens swaps, JPEG/live-view substitution and non-CR3 provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-canon-source-policy-"));
  await chmod(fixture, 0o755);
  const cases = [
    [{ fixtureLensOverride: { model: "RF-S18-45mm F4.5-6.3 IS STM" } }, "CAMERA_LENS_BINDING_MISMATCH"],
    [{ fixtureSourceMediaType: "image/jpeg" }, "CAMERA_RAW_SOURCE_POLICY_MISMATCH"],
    [{ fixtureSourcePolicyOverride: { liveView: true } }, "CAMERA_RAW_SOURCE_POLICY_MISMATCH"],
    [{ fixtureRawSourceKind: "live-view-frame-v1" }, "CAMERA_RAW_SOURCE_POLICY_MISMATCH"],
    [{ fixtureRawFormat: "JPEG" }, "CAMERA_RAW_SOURCE_POLICY_MISMATCH"],
  ];
  try {
    for (const [step, code] of cases) {
      const camera = await adapter(root);
      try {
        await openAndLock(camera);
        await assert.rejects(camera.capture(captureInput(step)), (error) => error?.code === code);
        await assert.rejects(
          camera.capture(captureInput()),
          (error) => error?.code === "CAMERA_NOT_LOCKED",
          "a rejected Canon response must invalidate the helper session",
        );
        assert.deepEqual(await readdir(join(root, "captures")), [], "rejected helper files must be removed");
      } finally {
        await camera.close().catch(() => {});
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Canon helper requires detect/open/manual-lock state and aborts one in-flight helper process", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-canon-cancel-"));
  await chmod(fixture, 0o755);
  const camera = await adapter(root);
  try {
    await assert.rejects(camera.capture(captureInput()), (error) => error?.code === "CAMERA_NOT_LOCKED");
    await openAndLock(camera);
    const controller = new AbortController();
    const capture = camera.capture({
      ...captureInput({ fixtureDelayMs: 2_000 }),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(capture, (error) => error?.code === "CALIBRATION_CANCELLED");
    await assert.rejects(
      camera.capture(captureInput()),
      (error) => error?.code === "CAMERA_NOT_LOCKED",
    );
  } finally {
    await camera.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("Canon helper timeout terminates the helper and invalidates the manual-lock session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-canon-timeout-"));
  await chmod(fixture, 0o755);
  const camera = await adapter(root, { timeoutMs: 1_000 });
  try {
    await openAndLock(camera);
    await assert.rejects(
      camera.capture(captureInput({ fixtureDelayMs: 1_500 })),
      (error) => error?.code === "CAMERA_HELPER_TIMEOUT" && error?.details?.method === "capture",
    );
    await assert.rejects(
      camera.capture(captureInput()),
      (error) => error?.code === "CAMERA_NOT_LOCKED",
    );
  } finally {
    await camera.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("Canon markerless preview performs the same exact CR3 body/lens/manual-lock chain", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-canon-preview-"));
  await chmod(fixture, 0o755);
  const camera = await adapter(root);
  const lensProfile = createCameraLensProfile({
    schema: "pixel-brightness.camera-lens-profile.v1",
    camera: { manufacturer: "Canon", model: "EOS R50", serialNumber: "R50-FIXTURE-0001" },
    lens: {
      manufacturer: "Canon",
      model: CANON_RF_S_10_18_LENS_MODEL,
      serialNumber: "RFS1018-FIXTURE-0001",
    },
    frame: { width: 32, height: 32 },
    capture: { focalLengthMm: 10, focusDistanceM: 4, apertureFNumber: 5.6 },
    intrinsics: { fx: 24, fy: 24, cx: 16, cy: 16 },
    distortion: { model: "brown-conrady-v1", k1: -0.03, k2: 0.002, k3: 0, p1: 0, p2: 0 },
    calibration: {
      method: "opencv-charuco-brown-conrady-v1",
      calibratedAt: "2026-08-25T00:00:00.000Z",
      rmsResidualPx: 0.18,
      maxResidualPx: 0.55,
      imageCount: 32,
    },
  });
  try {
    const capture = await camera.captureSurveyPreview({
      schemaVersion: 1,
      requestId: "canon-preview-001",
      nodeId: "fixture-node",
      cameraId: "canon-r50-fixture",
      cameraViewId: "north-wall-fixed-view",
      lensProfile,
      cameraSettings,
    });
    assert.equal(capture.rawSourceKind, "single-shot-linear-raw-decode-v1");
    assert.equal(capture.provenance.rawFormat, "CR3");
    assert.equal(capture.lensProfileSha256, lensProfile.sha256);
    assert.deepEqual(await readdir(join(root, "captures")), []);
  } finally {
    await camera.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
