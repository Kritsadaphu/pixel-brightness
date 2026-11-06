import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityMesh } from '../runtime/shared/mapping.mjs';
import { projectGeometryTargets, applyGeometryCandidate } from '../runtime/server/uvc-geometry-apply.mjs';
const project = { revision: 7, canvas: { width: 304, height: 64 }, outputs: Array.from({ length: 5 }, (_, i) => ({
  id: `p${i}`, resolution: { width: 64, height: 64 }, sourceViewport: { x: i * 60, y: 0, width: 64, height: 64 },
  warp: createIdentityMesh(2, 2), blend: { enabled: true, gamma: 2 }, color: { gain: [0.8, 0.9, 1] },
})) };
const outputs = project.outputs.map(o => ({ id: o.id, width: 64, height: 64 }));
const plan = { contrast: 18, outputs: projectGeometryTargets(project, outputs, { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }) };
const candidate = () => ({ schema: 'pb-uvc-geometry-candidate-v1', status: 'candidate-not-applied', outputs: outputs.map(o => ({
  outputId: o.id, referenceDrift: 0.01, mesh: { ...createIdentityMesh(2, 2), holes: 0, confidence: 0.9 },
})) });
test('five-projector geometry targets follow saved viewports and apply atomically while preserving all other corrections', () => {
  assert.equal(plan.outputs[0].targetMesh.points[0].cameraX, 0.1);
  assert.ok(Math.abs(plan.outputs[4].targetMesh.points.at(-1).cameraX - 0.9) < 1e-9);
  const c = candidate(); c.outputs[2].mesh.points[4].x = 0.6;
  const result = applyGeometryCandidate(project, c, plan);
  assert.equal(result.outputs[2].warp.points[4].x, 0.6);
  assert.equal(project.outputs[2].warp.points[4].x, 0.5);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(result.outputs[i].blend, project.outputs[i].blend);
    assert.deepEqual(result.outputs[i].color, project.outputs[i].color);
    assert.deepEqual(result.outputs[i].sourceViewport, project.outputs[i].sourceViewport);
  }
});
test('incomplete, duplicate, drifting, folded or low-confidence geometry cannot alter a project', () => {
  for (const mutate of [c => c.outputs.pop(), c => c.outputs[1].outputId = 'p0', c => c.outputs[0].referenceDrift = 0.2,
    c => c.outputs[0].mesh.holes = 1, c => c.outputs[0].mesh.confidence = 0,
    c => c.outputs[0].mesh.points[4].x = -1]) {
    const c = candidate(); mutate(c); assert.throws(() => applyGeometryCandidate(project, c, plan));
    assert.equal(project.outputs[0].warp.points[4].x, 0.5);
  }
  assert.throws(() => projectGeometryTargets(project, outputs, { x: 0.5, y: 0, width: 1, height: 1 }));
});
