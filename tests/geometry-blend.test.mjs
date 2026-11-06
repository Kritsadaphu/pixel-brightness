import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityMesh } from '../runtime/shared/mapping.mjs';
import { geometryBlendOutputs, geometryBlendWeight, rasterizeGeometryBlend } from '../runtime/node/geometry-blend.mjs';

function project(n = 5) {
  return { canvas: { width: 64 + (n - 1) * 56, height: 64 }, outputs: Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, wallId: 'same-plane', resolution: { width: 64, height: 64 },
    sourceViewport: { x: i * 56, y: 0, width: 64, height: 64 },
    warp: { ...createIdentityMesh(2, 2), enabled: true },
  })) };
}
test('five geometric overlap maps partition unity in common canvas, including triple overlaps', async () => {
  const p = project(), outputs = geometryBlendOutputs(p, p.outputs.map(o => o.id));
  const maps = await Promise.all(outputs.map((_, i) => rasterizeGeometryBlend(outputs, i)));
  assert.ok(maps.every(m => m.coveredPixels === 4096 && m.radiometryVerified === false));
  for (let y = 0; y < 64; y++) for (let x = 0; x < p.canvas.width; x++) {
    let sum = 0;
    for (let i = 0; i < outputs.length; i++) {
      const local = x - i * 56;
      if (local >= 0 && local < 64) sum += maps[i].values[y * 64 + local];
    }
    assert.ok(Math.abs(sum - 1) < 1e-6, `partition ${x},${y} = ${sum}`);
  }
  outputs[2].sourceViewport.x = 28;
  for (let x = 56.5; x < 64; x++) assert.ok(Math.abs(outputs.reduce((sum, _, i) => sum + geometryBlendWeight(outputs, i, x, 32), 0) - 1) < 1e-10);
});
test('blend is rasterized after Warp, with no correction outside its physical triangles', async () => {
  const p = project(1);
  p.outputs[0].warp.points = p.outputs[0].warp.points.map(q => ({ ...q, x: 0.25 + q.x * 0.5, y: 0.25 + q.y * 0.5 }));
  const outputs = geometryBlendOutputs(p, ['p0']), m = await rasterizeGeometryBlend(outputs, 0);
  assert.equal(m.coveredPixels, 1024);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) assert.equal(m.values[y * 64 + x], x >= 16 && x < 48 && y >= 16 && y < 48 ? 1 : 0);
});
test('reject partial selection, separate surfaces, bypass, folds, budget and cancellation', async () => {
  assert.throws(() => geometryBlendOutputs(project(), ['p0']));
  const p = project(2); p.outputs[1].wallId = 'other';
  assert.throws(() => geometryBlendOutputs(p, ['p0', 'p1']));
  p.outputs[1].wallId = 'same-plane'; p.outputs[0].processing = { bypass: true };
  assert.throws(() => geometryBlendOutputs(p, ['p0', 'p1']));
  delete p.outputs[0].processing; p.outputs[0].warp.points[4].x = -1;
  assert.throws(() => geometryBlendOutputs(p, ['p0', 'p1']));
  const q = project(1); q.outputs[0].resolution.width = 8192;
  assert.throws(() => geometryBlendOutputs(q, ['p0']));
  const r = project(1), outputs = geometryBlendOutputs(r, ['p0']);
  await assert.rejects(rasterizeGeometryBlend(outputs, 0, { signal: AbortSignal.abort() }));
  outputs[0].warp.points = outputs[0].warp.points.map(q => ({ ...q, x: q.x + 2 }));
  await assert.rejects(rasterizeGeometryBlend(outputs, 0), /no visible/);
});
