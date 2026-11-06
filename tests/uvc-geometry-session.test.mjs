import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGrayCodeFrame, requiredGrayBits, createCameraTargetMesh } from '../runtime/shared/calibration.mjs';
import { geometryPlan, GeometryDecoder, UvcGeometrySession } from '../runtime/node/uvc-geometry-session.mjs';

const input = { deviceId: 'r50-fixture-only', outputs: [{ id: 'left', width: 6, height: 5 }, { id: 'right', width: 6, height: 5 }], settleMs: 100, sampleStride: 1 };
function fixture({ modify, showModify, captureFailure, onShow, endFailure } = {}) {
  let step, captures = 0, endCalls = 0, time = 0;
  const patterns = {
    async begin() {},
    async show(value) { step = value; await onShow?.(value); return showModify?.(value) ?? { stepId: value.id, submitted: true, otherOutputsBlack: true }; },
    async end() { endCalls++; if (endFailure) throw new Error('end failed'); return { blackSubmitted: true, contentRestored: false }; },
  };
  const camera = { async capture(deviceId) {
    captures++;
    if (captureFailure) throw Object.assign(new Error('USB disconnected'), { code: 'UVC_CAPTURE_FAILED' });
    const p = step.pattern, width = 6, height = 5;
    const gray = p.kind === 'solid' ? new Uint8Array(width * height).fill(p.level) : createGrayCodeFrame({ width, height, ...p });
    const data = Buffer.alloc(width * height * 3);
    gray.forEach((v, i) => data.fill(v ? 220 : 20, i * 3, i * 3 + 3));
    const frame = { data, metadata: { deviceId, width, height, pixelFormat: 'rgb24-encoded', raw: false, linearized: false,
      receivedAtUnixMs: time = Math.max(Date.now(), time + 1), sha256: createHash('sha256').update(data).digest('hex') } };
    modify?.(frame, step, captures); return frame;
  } };
  return { patterns, camera, get endCalls() { return endCalls; }, get captures() { return captures; } };
}
test('streaming Gray decoder handles non-power-of-two dimensions and exact coordinates', () => {
  const d = new GeometryDecoder({ width: 6, height: 5, outputWidth: 6, outputHeight: 5 });
  d.references(new Uint8Array(30), new Uint8Array(30).fill(255));
  for (const axis of ['x', 'y']) for (let bit = 0; bit < requiredGrayBits(axis === 'x' ? 6 : 5); bit++) {
    d.pair(axis, bit, createGrayCodeFrame({ width: 6, height: 5, axis, bit }), createGrayCodeFrame({ width: 6, height: 5, axis, bit, inverse: true }));
  }
  const map = d.finish();
  assert.equal(map.validPixels, 30);
  for (let i = 0; i < 30; i++) { assert.equal(map.projectorX[i], i % 6); assert.equal(map.projectorY[i], Math.floor(i / 6)); }
  assert.throws(() => d.finish(), { code: 'GEOMETRY_ORDER' });
});
test('complete two-output acquisition produces candidates without claiming RAW or applied correction', async () => {
  const f = fixture(), maps = [];
  const session = new UvcGeometrySession({ ...f, wait: async () => {} });
  const result = await session.run(input, { onOutput: async o => maps.push(o) });
  assert.equal(result.outputs.length, 2); assert.equal(result.captures.length, 32);
  assert.equal(result.status, 'candidate-not-applied'); assert.equal(result.opticalSynchronizationVerified, false);
  assert.equal(result.radiometryVerified, false); assert.equal(result.manualLockVerified, false);
  assert.equal(maps[0].map.validPixels, 30); assert.equal(f.endCalls, 1);
});
test('reject missing steps and duplicate/out-of-order bits', () => {
  const d = new GeometryDecoder({ width: 6, height: 5, outputWidth: 6, outputHeight: 5 });
  assert.throws(() => d.finish()); assert.throws(() => d.pair('x', 0, new Uint8Array(30), new Uint8Array(30)));
  d.references(new Uint8Array(30), new Uint8Array(30).fill(255));
  assert.throws(() => d.pair('x', 1, new Uint8Array(30), new Uint8Array(30)));
});
for (const [name, modify, code] of [
  ['wrong camera', f => { f.metadata.deviceId = 'other'; }, 'GEOMETRY_FRAME'],
  ['stale frame', f => { f.metadata.receivedAtUnixMs = 1; }, 'GEOMETRY_STALE_FRAME'],
  ['modified raster', f => { f.data[0] ^= 255; }, 'GEOMETRY_FRAME'],
  ['changed size', f => { f.metadata.width = 7; }, 'GEOMETRY_FRAME'],
  ['RAW mislabel', f => { f.metadata.raw = true; }, 'GEOMETRY_FRAME'],
]) test(`reject ${name} and always release the pattern process`, async () => {
  const f = fixture({ modify });
  await assert.rejects(new UvcGeometrySession({ ...f, wait: async () => {} }).run(input), { code });
  assert.equal(f.endCalls, 1);
});
test('camera failure and mismatched pattern acknowledgement cannot finish', async () => {
  for (const options of [{ captureFailure: true }, { showModify: () => ({ stepId: 'old', submitted: true, otherOutputsBlack: true }) }]) {
    const f = fixture(options);
    await assert.rejects(new UvcGeometrySession({ ...f, wait: async () => {} }).run(input));
    assert.equal(f.endCalls, 1);
  }
});
test('reference drift detects changes and never emits a map', async () => {
  const f = fixture({ modify(frame, step, count) {
    if (count === 15) { frame.data.fill(100); frame.metadata.sha256 = createHash('sha256').update(frame.data).digest('hex'); }
  } });
  await assert.rejects(new UvcGeometrySession({ ...f, wait: async () => {} }).run(input), { code: 'GEOMETRY_SCENE_CHANGED' });
});
test('cancel and concurrent start are handled without overlapping ownership', async () => {
  const f = fixture(), controller = new AbortController(); let release, entered;
  const waiting = new Promise(r => { entered = r; });
  const session = new UvcGeometrySession({ ...f, wait: async () => { entered(); await new Promise(r => { release = r; }); controller.signal.throwIfAborted(); } });
  const first = session.run(input, { signal: controller.signal }); await waiting;
  await assert.rejects(session.run(input), { code: 'GEOMETRY_BUSY' });
  controller.abort(); release(); await assert.rejects(first); assert.equal(f.endCalls, 1);
});
test('cleanup errors remain visible and configuration is validated before side effects', async () => {
  const f = fixture({ captureFailure: true, endFailure: true });
  await assert.rejects(new UvcGeometrySession({ ...f, wait: async () => {} }).run(input), AggregateError);
  assert.throws(() => geometryPlan({ ...input, outputs: [input.outputs[0], input.outputs[0]] }));
  assert.throws(() => geometryPlan({ ...input, sampleStride: 0 }));
  assert.throws(() => geometryPlan({ ...input, outputs: [{ id: 'left', width: 5, height: 5 }] }));
});
test('candidate warp uses explicit target geometry; downsampling keeps camera endpoints', async () => {
  const targetMesh = createCameraTargetMesh({ columns: 2, rows: 2,
    corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] });
  const f = fixture();
  const result = await new UvcGeometrySession({ ...f, wait: async () => {} }).run({ ...input,
    sampleStride: 2, outputs: [{ ...input.outputs[0], targetMesh }] });
  const points = result.outputs[0].mesh.points;
  assert.equal(points[0].x, 0); assert.equal(points[0].y, 0);
  assert.equal(points.at(-1).x, 1); assert.equal(points.at(-1).y, 1);
});
test('five output sessions stay ordered and do not retain camera rasters in evidence', async () => {
  const f = fixture();
  const outputs = Array.from({ length: 5 }, (_, i) => ({ id: `output-${i + 1}`, width: 6, height: 5 }));
  const result = await new UvcGeometrySession({ ...f, wait: async () => {} }).run({ ...input, outputs });
  assert.deepEqual(result.outputs.map(o => o.outputId), outputs.map(o => o.id));
  assert.equal(result.captures.length, 80);
  assert.ok(result.captures.every(c => !('data' in c) && /^[a-f0-9]{64}$/.test(c.sha256)));
});
test('no-contrast decoder rejects a scene rather than fabricating a surface', () => {
  const d = new GeometryDecoder({ width: 6, height: 5, outputWidth: 6, outputHeight: 5 });
  const flat = new Uint8Array(30).fill(20);
  assert.throws(() => d.references(flat, flat), { code: 'GEOMETRY_NO_SURFACE' });
  for (const axis of ['x', 'y']) for (let bit = 0; bit < 3; bit++) d.pair(axis, bit, flat, flat);
  assert.throws(() => d.finish(), { code: 'GEOMETRY_NO_SURFACE' });
});
