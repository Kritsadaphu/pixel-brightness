import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareNdiCorrectionAssets } from '../runtime/server/ndi-correction-assets.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ndi-assets-test-')); await mkdir(join(root, 'assets'));
  const bytes = Buffer.alloc(16); for (let i = 0; i < 4; i++) bytes.writeFloatLE(0.25, i * 4);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = join(root, 'assets', sha256); await writeFile(file, bytes);
  const ref = { sha256, width: 2, height: 2, format: 'r32_float', byteLength: 16 };
  const plan = { outputs: [{ id: 'left', blend: { enabled: true, map: ref }, blackUniformity: {}, mask: {}, color: {} }] };
  return { root, file, ref, plan, bytes };
}
test('NDI resolves measured blend/black/mask and snapshots digest-verified bytes without changing project refs', async () => {
  const f = await fixture(); let prepared;
  try {
    f.plan.outputs[0].blackUniformity.map = structuredClone(f.ref);
    f.plan.outputs[0].mask.map = structuredClone(f.ref);
    prepared = await prepareNdiCorrectionAssets(f.plan, { root: f.root });
    assert.equal(prepared.bytes, 48);
    const asset = prepared.plan.outputs[0].blend.map;
    assert.deepEqual(Object.keys(asset).sort(), ['format', 'height', 'path', 'width']);
    assert.equal(f.plan.outputs[0].blend.map.path, undefined);
    await writeFile(f.file, Buffer.alloc(16));
    assert.deepEqual(await readFile(asset.path), f.bytes);
    await prepared.cleanup(); await assert.rejects(readFile(asset.path));
  } finally { await prepared?.cleanup(); await rm(f.root, { recursive: true, force: true }); }
});
test('NDI rejects corrupt hashes, sizes, NaNs, wrong formats, excessive bytes and escaping paths', async () => {
  const f = await fixture();
  try {
    for (const patch of [{ byteLength: 12 }, { format: 'rgb24' }, { width: 0 }, { path: '../outside' }, { sha256: 'bad' }]) {
      const plan = structuredClone(f.plan); Object.assign(plan.outputs[0].blend.map, patch);
      await assert.rejects(prepareNdiCorrectionAssets(plan, { root: f.root }));
    }
    await assert.rejects(prepareNdiCorrectionAssets(f.plan, { root: f.root, maximumBytes: 8 }));
    await writeFile(f.file, Buffer.alloc(16));
    await assert.rejects(prepareNdiCorrectionAssets(f.plan, { root: f.root }), /digest/);
    for (const value of [NaN, Infinity, -0.1, 1.1]) {
      const bytes = Buffer.alloc(16); bytes.writeFloatLE(value);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      await writeFile(join(f.root, 'assets', sha256), bytes);
      f.plan.outputs[0].blend.map.sha256 = sha256;
      await assert.rejects(prepareNdiCorrectionAssets(f.plan, { root: f.root }), /float/);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('NDI resolves RGBA black maps and 3D LUT, rejecting linked paths', async () => {
  const f = await fixture(); let prepared;
  try {
    const bytes = Buffer.alloc(128), sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(f.root, 'assets', sha256), bytes);
    f.plan.outputs[0].color.lut = { sha256, size: 2, format: 'rgba32_float', byteLength: 128 };
    f.plan.outputs[0].blackUniformity.map = { sha256, width: 4, height: 2, format: 'rgba32_float' };
    prepared = await prepareNdiCorrectionAssets(f.plan, { root: f.root });
    assert.equal(prepared.plan.outputs[0].color.lut.size, 2);
    if (process.platform !== 'win32') {
      await symlink(f.file, join(f.root, 'linked'));
      f.plan.outputs[0].blend.map.path = 'linked';
      await assert.rejects(prepareNdiCorrectionAssets(f.plan, { root: f.root }), /links/);
    }
  } finally { await prepared?.cleanup(); await rm(f.root, { recursive: true, force: true }); }
});
