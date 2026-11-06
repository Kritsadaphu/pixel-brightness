import assert from "node:assert/strict";
import test from "node:test";

import {
  CameraSurveyError,
  derivePlanarOutputTargets,
  normalizePlanarSurfaceTargets,
  normalizePlanarSurfaceSurveys,
} from "../runtime/shared/camera-survey.mjs";
import { createCameraLensProfile } from "../runtime/shared/camera-lens-profile.mjs";

const lensProfile = createCameraLensProfile({
  schema: "pixel-brightness.camera-lens-profile.v1",
  camera: { manufacturer: "Sony", model: "ILCE-7M4", serialNumber: "SURVEY-CAMERA-001" },
  lens: { manufacturer: "Sony", model: "FE 16-35mm F2.8 GM II", serialNumber: "SURVEY-LENS-001" },
  frame: { width: 2_432, height: 1_621 },
  capture: { focalLengthMm: 16, focusDistanceM: 4, apertureFNumber: 5.6 },
  intrinsics: { fx: 1_600, fy: 1_600, cx: 1_216, cy: 810.5 },
  distortion: { model: "brown-conrady-v1", k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 },
  calibration: {
    method: "opencv-charuco-brown-conrady-v1",
    calibratedAt: "2026-08-01T00:00:00.000Z",
    rmsResidualPx: 0.2,
    maxResidualPx: 0.6,
    imageCount: 30,
  },
});
const digest = lensProfile.sha256;

function survey(overrides = {}) {
  return {
    id: "north-survey",
    wallId: "wall-north",
    cameraViewId: "a7iv-north-001",
    frame: { width: 2_432, height: 1_621 },
    lensProfileSha256: digest,
    boundary: [
      { x: 0.1, y: 0.2 },
      { x: 0.9, y: 0.15 },
      { x: 0.85, y: 0.85 },
      { x: 0.15, y: 0.9 },
    ],
    ...overrides,
  };
}

function assertPointClose(actual, expected, tolerance = 1e-12) {
  assert.ok(Math.abs(actual.x - expected.x) <= tolerance, `x ${actual.x} != ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) <= tolerance, `y ${actual.y} != ${expected.y}`);
}

test("planar survey derives overlapping projector targets without venue markers", () => {
  const targets = derivePlanarOutputTargets({
    surveys: [survey()],
    lensProfile,
    outputs: [
      { id: "A", wallId: "wall-north", sourceViewport: { x: 0, y: 0, width: 1_920, height: 1_080 } },
      { id: "B", wallId: "wall-north", sourceViewport: { x: 1_680, y: 0, width: 1_920, height: 1_080 } },
    ],
  });
  assert.equal(targets.length, 2);
  assert.equal(targets[0].method, "operator-four-corner-planar-v1");
  assert.equal(targets[0].lensProfileSha256, digest);
  assertPointClose(targets[0].corners[0], { x: 0.1, y: 0.2 });
  assertPointClose(targets[1].corners[2], { x: 0.85, y: 0.85 });
  assert.ok(targets[0].corners[1].x > targets[1].corners[0].x,
    "the 240-pixel source overlap must remain a physical target overlap");
});

test("one calibration session rejects targets from camera poses or lens profiles that differ", () => {
  const targets = derivePlanarOutputTargets({
    surveys: [survey()],
    lensProfile,
    outputs: [{ id: "A", wallId: "wall-north", sourceViewport: { x: 0, y: 0, width: 1_920, height: 1_080 } }],
  });
  assert.throws(
    () => normalizePlanarSurfaceTargets([
      targets[0],
      { ...targets[0], outputId: "B", cameraViewId: "camera-moved" },
    ]),
    (error) => error instanceof CameraSurveyError && error.code === "MULTIPLE_CAMERA_VIEWS_UNSUPPORTED",
  );
});

test("one independent survey can be supplied for each immersive wall", () => {
  const east = survey({
    id: "east-survey",
    wallId: "wall-east",
    cameraViewId: "a7iv-east-001",
    boundary: [{ x: 0.2, y: 0.1 }, { x: 0.8, y: 0.1 }, { x: 0.8, y: 0.9 }, { x: 0.2, y: 0.9 }],
  });
  const targets = derivePlanarOutputTargets({
    surveys: [survey(), east],
    lensProfile,
    outputs: [
      { id: "A", wallId: "wall-north", sourceViewport: { x: 0, y: 0, width: 1_920, height: 1_080 } },
      { id: "C", wallId: "wall-east", sourceViewport: { x: 0, y: 0, width: 1_920, height: 1_080 } },
    ],
  });
  assert.equal(targets[1].surveyId, "east-survey");
  targets[1].corners.forEach((point, index) => assertPointClose(point, east.boundary[index]));
});

test("one fixed camera view can survey adjacent immersive walls for a bridge observation", () => {
  const east = survey({
    id: "east-bridge-survey",
    wallId: "wall-east",
    cameraViewId: "a7iv-north-001",
    boundary: [{ x: 0.55, y: 0.12 }, { x: 0.92, y: 0.18 }, { x: 0.9, y: 0.88 }, { x: 0.57, y: 0.82 }],
  });
  const targets = derivePlanarOutputTargets({
    surveys: [survey(), east],
    lensProfile,
    outputs: [
      { id: "A", wallId: "wall-north", sourceViewport: { x: 0, y: 0, width: 1_920, height: 1_080 } },
      { id: "C", wallId: "wall-east", sourceViewport: { x: 1_920, y: 0, width: 1_920, height: 1_080 } },
    ],
  });
  assert.equal(targets.length, 2);
  assert.deepEqual(new Set(targets.map((target) => target.cameraViewId)), new Set(["a7iv-north-001"]));
  assert.doesNotThrow(() => normalizePlanarSurfaceTargets(targets));
});

test("surface survey rejects folded boundaries, duplicate walls and missing wall targets", () => {
  assert.throws(
    () => normalizePlanarSurfaceSurveys([survey({
      boundary: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
    })]),
    (error) => error instanceof CameraSurveyError && error.code === "INVALID_SURFACE_BOUNDARY",
  );
  assert.throws(
    () => normalizePlanarSurfaceSurveys([survey(), survey({ id: "duplicate", cameraViewId: "other" })]),
    /wallId must be unique/,
  );
  assert.throws(
    () => derivePlanarOutputTargets({
      surveys: [survey()],
      lensProfile,
      outputs: [{ id: "C", wallId: "wall-east", sourceViewport: { x: 0, y: 0, width: 1_920, height: 1_080 } }],
    }),
    (error) => error instanceof CameraSurveyError && error.code === "MISSING_SURFACE_SURVEY",
  );
});
