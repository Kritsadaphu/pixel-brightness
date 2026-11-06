import assert from "node:assert/strict";
import test from "node:test";

import {
  applyHomography,
  buildAutomaticBlendMaps,
  buildBlackUniformityMap,
  buildWarpMeshFromCameraMap,
  createCameraTargetMesh,
  createGrayCodeFrame,
  createGridPattern,
  decodeGrayCodeFrames,
  normalizeBlendContributions,
  requiredGrayBits,
  solveHomography,
} from "../runtime/shared/calibration.mjs";

test("32 pixel grid pattern is generated as an RGBA calibration texture", () => {
  const pattern = createGridPattern({ width: 96, height: 64, cellSize: 32 });
  assert.equal(pattern.length, 96 * 64 * 4);
  assert.equal(pattern[3], 255);
  assert.notDeepEqual([...pattern.slice(0, 3)], [...pattern.slice((16 * 96 + 16) * 4, (16 * 96 + 16) * 4 + 3)]);
});

test("Gray-code normal/inverse pairs decode every projector x coordinate", () => {
  const width = 8;
  const height = 2;
  const bits = requiredGrayBits(width);
  const normalFrames = Array.from({ length: bits }, (_, bit) => createGrayCodeFrame({ width, height, bit }));
  const inverseFrames = Array.from({ length: bits }, (_, bit) => createGrayCodeFrame({ width, height, bit, inverse: true }));
  const decoded = decodeGrayCodeFrames({ normalFrames, inverseFrames, width, height });
  assert.deepEqual([...decoded.codes.slice(0, width)], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(decoded.confidence[0], 1);
});

test("four-point homography maps a square into a keystoned quadrilateral", () => {
  const source = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const destination = [{ x: 0.1, y: 0.2 }, { x: 1.2, y: 0 }, { x: 0.9, y: 1.1 }, { x: -0.1, y: 0.8 }];
  const transform = solveHomography(source, destination);
  destination.forEach((expected, index) => {
    const actual = applyHomography(transform, source[index]);
    assert.ok(Math.abs(actual.x - expected.x) < 1e-9);
    assert.ok(Math.abs(actual.y - expected.y) < 1e-9);
  });
});

test("black uniformity only adds light up to the measured target floor", () => {
  const result = buildBlackUniformityMap(new Float32Array([0.02, 0.04, 0.08]), { targetPercentile: 1 });
  assert.ok(Math.abs(result.target - 0.08) < 1e-6);
  assert.ok(Math.abs(result.lift[0] - 0.06) < 1e-6);
  assert.ok(Math.abs(result.lift[1] - 0.04) < 1e-6);
  assert.equal(result.lift[2], 0);
});

test("blend normalization keeps every overlap pixel at unity", () => {
  const [left, right] = normalizeBlendContributions([
    new Float32Array([1, 0.75, 0]),
    new Float32Array([0, 0.25, 1]),
  ]);
  for (let index = 0; index < left.length; index += 1) {
    assert.ok(Math.abs(left[index] + right[index] - 1) < 1e-6);
  }
});

test("dense camera correspondence becomes a curved projector warp mesh", () => {
  const cameraWidth = 17;
  const cameraHeight = 17;
  const projectorWidth = 101;
  const projectorHeight = 101;
  const projectorX = new Int32Array(cameraWidth * cameraHeight);
  const projectorY = new Int32Array(cameraWidth * cameraHeight);
  const confidence = new Float32Array(cameraWidth * cameraHeight).fill(0.95);
  for (let y = 0; y < cameraHeight; y += 1) {
    for (let x = 0; x < cameraWidth; x += 1) {
      const u = x / (cameraWidth - 1);
      const v = y / (cameraHeight - 1);
      const index = y * cameraWidth + x;
      projectorX[index] = Math.round((u + 0.08 * Math.sin(Math.PI * v)) * 90);
      projectorY[index] = Math.round((v + 0.05 * Math.sin(Math.PI * u)) * 90);
    }
  }
  const targetMesh = createCameraTargetMesh({
    columns: 4,
    rows: 4,
    corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  });
  const mesh = buildWarpMeshFromCameraMap({
    cameraWidth,
    cameraHeight,
    projectorWidth,
    projectorHeight,
    projectorX,
    projectorY,
    confidence,
    targetMesh,
  });
  assert.equal(mesh.points.length, 25);
  assert.equal(mesh.holes, 0);
  assert.ok(mesh.confidence > 0.9);
  const center = mesh.points[12];
  assert.ok(center.x > 0.49, "the dense mesh must retain the synthetic horizontal curve");
  assert.ok(center.y > 0.46, "the dense mesh must retain the synthetic vertical curve");
});

test("automatic camera-space blending is zero outside footprints and unity where covered", () => {
  const width = 7;
  const height = 3;
  const leftMask = Float32Array.from({ length: width * height }, (_, index) => index % width <= 4 ? 1 : 0);
  const rightMask = Float32Array.from({ length: width * height }, (_, index) => index % width >= 2 && index % width <= 5 ? 1 : 0);
  const [left, right] = buildAutomaticBlendMaps([leftMask, rightMask], { width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (x === 6) assert.equal(left[index] + right[index], 0);
      else assert.ok(Math.abs(left[index] + right[index] - 1) < 1e-6);
    }
  }
  assert.equal(right[0], 0);
  assert.equal(left[5], 0);
});
