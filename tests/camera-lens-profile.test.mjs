import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CameraLensProfileError,
  cameraLensProfilePayloadSha256,
  createCameraLensProfile,
  createDistortionAwarePlanarGrid,
  distortNormalizedImagePoint,
  mapPlanarWallPointsToRaw,
  normalizeCameraLensProfile,
  undistortNormalizedImagePoint,
} from "../runtime/shared/camera-lens-profile.mjs";

const NOW = Date.parse("2026-08-24T12:00:00.000Z");

function payload(distortion = {}) {
  return {
    schema: "pixel-brightness.camera-lens-profile.v1",
    camera: {
      manufacturer: "Sony",
      model: "ILCE-7M4",
      serialNumber: "A7IV-UNIT-001",
    },
    lens: {
      manufacturer: "Sony",
      model: "FE 16-35mm F2.8 GM II",
      serialNumber: "GM2-UNIT-001",
    },
    frame: { width: 4_000, height: 3_000 },
    capture: {
      focalLengthMm: 16,
      focusDistanceM: 4.2,
      apertureFNumber: 5.6,
    },
    intrinsics: { fx: 2_200, fy: 2_210, cx: 2_012, cy: 1_493 },
    distortion: {
      model: "brown-conrady-v1",
      k1: -0.14,
      k2: 0.025,
      k3: -0.002,
      p1: 0.0008,
      p2: -0.0005,
      ...distortion,
    },
    calibration: {
      method: "opencv-charuco-brown-conrady-v1",
      calibratedAt: "2026-08-01T00:00:00.000Z",
      rmsResidualPx: 0.19,
      maxResidualPx: 0.61,
      imageCount: 42,
    },
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function createProfile(distortion = {}) {
  return createCameraLensProfile(payload(distortion), { now: NOW });
}

function assertPointClose(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual.x - expected.x) <= tolerance, `x ${actual.x} != ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) <= tolerance, `y ${actual.y} != ${expected.y}`);
}

function naiveHomographyPoint(corners, u, v) {
  const [topLeft, topRight, bottomRight, bottomLeft] = corners;
  const dx1 = topRight.x - bottomRight.x;
  const dx2 = bottomLeft.x - bottomRight.x;
  const dx3 = topLeft.x - topRight.x + bottomRight.x - bottomLeft.x;
  const dy1 = topRight.y - bottomRight.y;
  const dy2 = bottomLeft.y - bottomRight.y;
  const dy3 = topLeft.y - topRight.y + bottomRight.y - bottomLeft.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / denominator;
  const h = (dx1 * dy3 - dx3 * dy1) / denominator;
  const a = topRight.x - topLeft.x + g * topRight.x;
  const b = bottomLeft.x - topLeft.x + h * bottomLeft.x;
  const d = topRight.y - topLeft.y + g * topRight.y;
  const e = bottomLeft.y - topLeft.y + h * bottomLeft.y;
  const scale = g * u + h * v + 1;
  return {
    x: (a * u + b * v + topLeft.x) / scale,
    y: (d * u + e * v + topLeft.y) / scale,
  };
}

test("zero-distortion profile is identity and has a verified canonical SHA-256", () => {
  const source = payload({ k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 });
  const profile = createCameraLensProfile(source, { now: NOW });
  const nodeDigest = createHash("sha256").update(canonicalJson(source)).digest("hex");
  assert.equal(profile.sha256, nodeDigest);
  assert.equal(cameraLensProfilePayloadSha256(source, { now: NOW }), nodeDigest);
  assert.deepEqual(normalizeCameraLensProfile(profile, { now: NOW }), profile);

  for (const point of [{ x: 0, y: 0 }, { x: 0.23, y: 0.71 }, { x: 1, y: 1 }]) {
    assertPointClose(distortNormalizedImagePoint(profile, point, { now: NOW }), point, 1e-14);
    assertPointClose(undistortNormalizedImagePoint(profile, point, { now: NOW }), point, 1e-14);
  }
});

test("Brown-Conrady distortion and iterative inverse round-trip normalized image points", () => {
  const profile = createProfile();
  for (const point of [
    { x: 0.18, y: 0.2 },
    { x: 0.38, y: 0.73 },
    { x: 0.51, y: 0.49 },
    { x: 0.81, y: 0.78 },
  ]) {
    const distorted = distortNormalizedImagePoint(profile, point, { now: NOW });
    const recovered = undistortNormalizedImagePoint(profile, distorted, { now: NOW });
    assertPointClose(recovered, point, 2e-11);
  }
});

test("planar wall grid is undistorted before homography and redistorted for Gray-map coordinates", () => {
  const profile = createProfile();
  const boundary = [
    { x: 0.18, y: 0.18 },
    { x: 0.87, y: 0.21 },
    { x: 0.79, y: 0.83 },
    { x: 0.11, y: 0.76 },
  ];
  const result = createDistortionAwarePlanarGrid({
    profile,
    boundary,
    columns: 5,
    rows: 5,
    now: NOW,
  });
  assert.equal(result.coordinateSpace, "raw-sensor-normalized-v1");
  assert.equal(result.profileSha256, profile.sha256);
  assert.equal(result.grid.vertices.length, 25);
  assertPointClose(result.grid.vertices[0], boundary[0]);
  assertPointClose(result.grid.vertices[4], boundary[1]);
  assertPointClose(result.grid.vertices[24], boundary[2]);
  assertPointClose(result.grid.vertices[20], boundary[3]);

  const correctedCenter = result.grid.vertices[12];
  const naiveCenter = naiveHomographyPoint(boundary, 0.5, 0.5);
  assert.ok(
    Math.hypot(correctedCenter.x - naiveCenter.x, correctedCenter.y - naiveCenter.y) > 1e-4,
    "non-zero lens distortion must change interior targets relative to a naive raw-frame homography",
  );
});

test("wall viewport subdivision happens on the undistorted plane, not by raw-image bilinear interpolation", () => {
  const profile = createProfile();
  const boundary = [
    { x: 0.12, y: 0.15 },
    { x: 0.9, y: 0.19 },
    { x: 0.82, y: 0.88 },
    { x: 0.08, y: 0.79 },
  ];
  const mapped = mapPlanarWallPointsToRaw({
    profile,
    boundary,
    points: [{ u: 0.25, v: 0.5 }, { u: 0.75, v: 0.5 }],
    now: NOW,
  });
  const grid = createDistortionAwarePlanarGrid({
    profile,
    boundary,
    columns: 5,
    rows: 3,
    now: NOW,
  });
  assertPointClose(mapped.points[0], grid.grid.vertices[6]);
  assertPointClose(mapped.points[1], grid.grid.vertices[8]);

  const naive = naiveHomographyPoint(boundary, 0.25, 0.5);
  assert.ok(Math.hypot(mapped.points[0].x - naive.x, mapped.points[0].y - naive.y) > 1e-4,
    "an interior source viewport boundary must be divided in undistorted wall coordinates");
});

test("profile validation rejects identity changes, weak calibration and folded distortion", () => {
  const profile = createProfile();
  assert.throws(
    () => normalizeCameraLensProfile({
      ...profile,
      capture: { ...profile.capture, focalLengthMm: 17 },
    }, { now: NOW }),
    (error) => error instanceof CameraLensProfileError && error.code === "LENS_PROFILE_IDENTITY_MISMATCH",
  );
  assert.throws(
    () => createCameraLensProfile({
      ...payload(),
      calibration: { ...payload().calibration, rmsResidualPx: 0.8 },
    }, { now: NOW }),
    (error) => error instanceof CameraLensProfileError && error.code === "LENS_PROFILE_RESIDUAL_GATE_FAILED",
  );
  assert.throws(
    () => createCameraLensProfile({
      ...payload(),
      calibration: { ...payload().calibration, method: "unchecked-manual-fit" },
    }, { now: NOW }),
    (error) => error instanceof CameraLensProfileError && error.code === "INVALID_LENS_PROFILE_METHOD",
  );
  assert.throws(
    () => createCameraLensProfile({
      ...payload(),
      calibration: { ...payload().calibration, calibratedAt: "2023-01-01T00:00:00.000Z" },
    }, { now: NOW }),
    (error) => error instanceof CameraLensProfileError && error.code === "LENS_PROFILE_CALIBRATION_EXPIRED",
  );
  assert.throws(
    () => createProfile({ k1: -0.8, k2: 0, k3: 0, p1: 0, p2: 0 }),
    (error) => error instanceof CameraLensProfileError && error.code === "LENS_PROFILE_FOLDED",
  );
});

test("geometry operations fail closed on non-finite, out-of-frame and nonconvergent points", () => {
  const profile = createProfile({ k1: 0.25, k2: 0.02, k3: 0, p1: 0, p2: 0 });
  assert.throws(
    () => distortNormalizedImagePoint(profile, { x: Number.NaN, y: 0.5 }, { now: NOW }),
    (error) => error instanceof CameraLensProfileError && error.code === "INVALID_IMAGE_POINT",
  );
  assert.throws(
    () => distortNormalizedImagePoint(profile, { x: 1, y: 0.5 }, { now: NOW }),
    (error) => error instanceof CameraLensProfileError && error.code === "LENS_POINT_OUT_OF_FRAME",
  );
  assert.throws(
    () => undistortNormalizedImagePoint(profile, { x: 0.9, y: 0.8 }, {
      now: NOW,
      maxIterations: 1,
      tolerance: 1e-15,
    }),
    (error) => error instanceof CameraLensProfileError && error.code === "LENS_UNDISTORT_NONCONVERGENT",
  );
  assert.throws(
    () => createDistortionAwarePlanarGrid({
      profile,
      boundary: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.9 },
        { x: 0.9, y: 0.1 },
        { x: 0.1, y: 0.9 },
      ],
      now: NOW,
    }),
    (error) => error instanceof CameraLensProfileError && error.code === "INVALID_WALL_BOUNDARY",
  );
});
