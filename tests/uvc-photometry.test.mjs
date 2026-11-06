import test from 'node:test';
import assert from 'node:assert/strict';
import { UvcPhotometryMeasurement, UVC_RAMP_LEVELS, srgbDecode, assertUvcPhotometryOptions,
  solveUvcPhotometry, photometryBlackRaster } from '../runtime/node/uvc-photometry.mjs';

const encode = v => v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
function measured(id = 'left', brightness = [0.6, 0.55, 0.5], floor = 0.01) {
  const map = { cameraWidth: 8, cameraHeight: 8, projectorWidth: 8, projectorHeight: 8,
    projectorX: Int32Array.from({ length: 64 }, (_, i) => i % 8), projectorY: Int32Array.from({ length: 64 }, (_, i) => Math.floor(i / 8)), confidence: new Float32Array(64).fill(1) };
  const frame = level => Uint8Array.from({ length: 192 }, (_, i) => Math.round(encode(floor + brightness[i % 3] * srgbDecode(level / 255)) * 255));
  const acquire = () => new UvcPhotometryMeasurement(map, { columns: 2, rows: 2 });
  const m = acquire(); for (const level of UVC_RAMP_LEVELS) m.add(level, frame(level));
  return { outputId: id, ...m.finish(frame(0), frame(255)), frame, acquire };
}

test('USB photometry is opt-in and never treats processed RGB as verified RAW', () => {
  assert.throws(() => assertUvcPhotometryOptions({ autoPhotometry: true }));
  assert.throws(() => assertUvcPhotometryOptions({ autoPhotometry: true, autoBlend: true, cameraSettingsLocked: true, cameraResponse: 'raw' }));
  assertUvcPhotometryOptions({ autoPhotometry: true, autoBlend: true, cameraSettingsLocked: true, cameraResponse: 'srgb-assumed' });
  const m = measured(); assert.equal(m.radiometryVerified, false); assert.ok(m.referenceDrift < 1e-6);
});
test('five measured RGB responses generate monotone inverse LUTs and match common brightness', () => {
  const inputs = Array.from({ length: 5 }, (_, i) => measured(`out${i}`, [0.6 - i * 0.03, 0.55 - i * 0.03, 0.5 - i * 0.03]));
  const result = solveUvcPhotometry(inputs);
  assert.equal(result.outputs.length, 5); assert.equal(result.physicalBeforeAfterVerified, false);
  for (const record of result.outputs) {
    assert.equal(record.lut.length, 33 ** 3 * 4);
    for (let c = 0; c < 3; c++) {
      let previous = 0;
      for (let n = 0; n < 33; n++) {
        const xyz = [0, 0, 0]; xyz[c] = n;
        const value = record.lut[((xyz[2] * 33 + xyz[1]) * 33 + xyz[0]) * 4 + c];
        assert.ok(value >= previous && value <= 1); previous = value;
      }
      const physicalWhite = previous * record.measurement.curves.at(-1).response[c];
      assert.ok(Math.abs(physicalWhite - result.referenceWhite[c]) < 0.012);
    }
  }
});
test('Black lift raises only the lower baseline and allocates contribution once across overlap', async () => {
  const result = solveUvcPhotometry([measured('dark', undefined, 0.01), measured('bright', undefined, 0.025)]);
  const blend = new Float32Array(64).fill(0.5);
  const dark = await photometryBlackRaster(result, result.outputs[0], blend, 8, 8);
  const bright = await photometryBlackRaster(result, result.outputs[1], blend, 8, 8);
  for (let c = 0; c < 3; c++) {
    const delta = result.blackTarget[c] - result.outputs[0].measurement.tiles[0].black[c];
    assert.ok(Math.abs(dark[c] * result.referenceWhite[c] - delta * 0.5) < 1e-6);
    assert.equal(bright[c], 0);
  }
  assert.ok(result.outputs[0].gain.every(v => v < 1));
  const stop = new AbortController(); stop.abort();
  await assert.rejects(photometryBlackRaster(result, result.outputs[0], blend, 8, 8, { signal: stop.signal }));
});
test('reject clipping, frame reordering, changed exposure, insufficient response and non-monotonic ramps', () => {
  const m = measured();
  assert.throws(() => m.acquire().add(16, m.frame(16)), /order/);
  assert.throws(() => m.acquire().add(0, new Uint8Array(192).fill(255)), /clipped/);
  const acquisition = m.acquire(); for (const level of UVC_RAMP_LEVELS) acquisition.add(level, m.frame(level));
  assert.throws(() => acquisition.finish(m.frame(32), m.frame(128)), /changed/);
  const flat = m.acquire(); for (const level of UVC_RAMP_LEVELS) flat.add(level, m.frame(0));
  assert.throws(() => flat.finish(m.frame(0), m.frame(0)), /Insufficient/);
  const bad = m.acquire(); for (const level of UVC_RAMP_LEVELS) bad.add(level, m.frame(level === 160 ? 64 : level));
  assert.throws(() => bad.finish(m.frame(0), m.frame(255)), /Non-monotonic/);
});
test('missing Black tiles, damaged evidence and impossible lift cannot generate an applicable result', async () => {
  const m = measured(); const result = solveUvcPhotometry([m]);
  result.outputs[0].measurement.tiles[0].count = 0;
  await assert.rejects(photometryBlackRaster(result, result.outputs[0], new Float32Array(64).fill(1), 8, 8), /unmeasured/);
  assert.throws(() => solveUvcPhotometry([measured(), measured()]), /output set/);
  const corrupt = measured(); corrupt.curves[3].response[0] = NaN;
  assert.throws(() => solveUvcPhotometry([corrupt]), /evidence/);
  const huge = measured('huge'); huge.tiles.forEach(t => { t.black = [1, 1, 1]; });
  assert.throws(() => solveUvcPhotometry([measured(), huge]), /brightness/);
});
