import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBlendWeights,
  createIdentityMesh,
  normalizeOutputConfig,
  sampleMesh,
  validateMesh,
} from "../runtime/shared/mapping.mjs";

test("identity mesh supports dense 128 by 128 geometry", () => {
  const mesh = createIdentityMesh(128, 128);
  assert.equal(mesh.points.length, 129 * 129);
  assert.deepEqual(sampleMesh(mesh, 0.25, 0.75), { x: 0.25, y: 0.75 });
});

test("omitted mesh points create an explicit bounded identity default", () => {
  const mesh = validateMesh({ columns: 99_999, rows: Number.NaN, points: null });
  assert.equal(mesh.columns, 128);
  assert.equal(mesh.rows, 18);
  assert.equal(mesh.points.length, 129 * 19);
});

test("authoritative mesh points reject wrong counts, non-finite values and folded cells", () => {
  assert.throws(
    () => validateMesh({ enabled: true, columns: 2, rows: 2, points: [{ u: 0, v: 0, x: 0, y: 0 }] }),
    /points count must equal/,
  );
  const nonFinite = createIdentityMesh(2, 2);
  nonFinite.points[4].x = Number.NaN;
  assert.throws(() => validateMesh({ ...nonFinite, enabled: true }), /must be finite/);
  const folded = createIdentityMesh(2, 2);
  folded.points[1].x = -0.25;
  assert.throws(() => validateMesh({ ...folded, enabled: true }), /folded or degenerate cell/);
});

test("overlap and color controls are normalized for the renderer", () => {
  const output = normalizeOutputConfig({
    id: "A",
    resolution: { width: 1920, height: 1080, refreshNum: 60, refreshDen: 1 },
    overlap: { left: 1_900, right: 900, top: 0, bottom: 0 },
    blend: { feather: 99, gamma: -4 },
    blackUniformity: { lift: 2 },
    color: { gain: [2, Number.NaN, 0.5], offset: [-9, 0, 9] },
  });

  assert.equal(output.overlap.left + output.overlap.right < output.resolution.width, true);
  assert.equal(output.blend.feather, 1);
  assert.equal(output.blend.gamma, 0.1);
  assert.equal(output.blackUniformity.lift, 1);
  assert.deepEqual(output.color.gain, [2, 1, 0.5]);
  assert.deepEqual(output.color.offset, [-1, 0, 1]);
});

test("exact DXGI rational refresh timing survives shared output normalization", () => {
  const output = normalizeOutputConfig({
    id: "render-01-A",
    resolution: { width: 1920, height: 1080, refreshNum: 60_000, refreshDen: 1_001 },
  });
  assert.deepEqual(output.resolution, {
    width: 1920,
    height: 1080,
    refreshNum: 60_000,
    refreshDen: 1_001,
  });
});

test("blend weights are deterministic, monotonic, and bounded", () => {
  const weights = buildBlendWeights(64, 0.8, 2.2, "out");
  assert.equal(weights.length, 64);
  assert.equal(weights[0], 1);
  assert.equal(weights.at(-1), 0);
  for (let index = 1; index < weights.length; index += 1) {
    assert.equal(weights[index] <= weights[index - 1], true);
    assert.equal(weights[index] >= 0 && weights[index] <= 1, true);
  }
});
