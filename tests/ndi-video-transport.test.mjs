import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NdiPatternTransport } from '../runtime/node/ndi-pattern-transport.mjs';
import { NdiVideoTransport } from '../runtime/node/ndi-video-transport.mjs';
import { projectNdiVideoPlan } from '../runtime/server/ndi-video-control.mjs';
import { prepareNdiCorrectionAssets } from '../runtime/server/ndi-correction-assets.mjs';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { geometryBlendOutputs, rasterizeGeometryBlend } from '../runtime/node/geometry-blend.mjs';
import { createIdentityMesh } from '../runtime/shared/mapping.mjs';

const output = (id, x, gain = 1) => ({ id, enabled: true,
  resolution: { width: 64, height: 64, refreshNum: 30, refreshDen: 1 },
  sourceViewport: { x, y: 0, width: 64, height: 64 },
  blend: { enabled: false }, color: { gain: [gain, gain, gain] },
});
const canvas = { width: 128, height: 64, frameRateNum: 30, frameRateDen: 1 };
test('NDI video config cannot impersonate geometry, physical display or caller-selected process arguments', () => {
  const transport = new NdiVideoTransport({ command: join(tmpdir(), 'video.exe'), runtimeDirectory: tmpdir(), shaderDirectory: tmpdir(), assetDirectory: tmpdir() });
  const plan = { source: { name: 'test', address: '127.0.0.1:5961', timeoutMs: 500, sourceIsSrgb: true }, canvas, outputs: [output('left', 0)] };
  const config = transport.configuration(plan);
  assert.match(config.prefix, /^PB-VIDEO-/); assert.equal(config.schema, 'pb-ndi-video-v1');
  assert.throws(() => transport.configuration({ ...plan, prefix: 'Arena' }));
  assert.throws(() => transport.configuration({ ...plan, outputs: [{ ...output('left', 0), display: {} }] }));
  assert.throws(() => transport.configuration({ ...plan, outputs: [output('left', 0), output('left', 64)] }));
});
const enabled = process.platform === 'win32' && ['PB_NDI_VIDEO_EXE', 'PB_NDI_PATTERN_EXE', 'PB_NDI_PROBE_EXE', 'PB_NDI_RUNTIME_DIR', 'PB_NDI_SHADER_DIR'].every(k => process.env[k]);
test('Windows: generated geometric Blend assets drive five simultaneous GPU/NDI outputs', { skip: !enabled, timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pb-generated-blend-gpu-')); await mkdir(join(root, 'assets'));
  const options = { runtimeDirectory: process.env.PB_NDI_RUNTIME_DIR, timeoutMs: 15000 };
  const input = new NdiPatternTransport({ ...options, command: process.env.PB_NDI_PATTERN_EXE });
  const video = new NdiVideoTransport({ ...options, command: process.env.PB_NDI_VIDEO_EXE, shaderDirectory: process.env.PB_NDI_SHADER_DIR, assetDirectory: root });
  const exec = promisify(execFile); let prepared;
  const execOptions = { timeout: 18000, maxBuffer: 65536, windowsHide: true, env: { ...process.env, PATH: process.env.PB_NDI_RUNTIME_DIR + ';' + process.env.PATH } };
  try {
    const project = { revision: 1, canvas: { ...canvas, width: 64 }, outputs: Array.from({ length: 5 }, (_, i) => ({
      ...output(`blend${i}`, 0), warp: { ...createIdentityMesh(2, 2), enabled: true },
    })) };
    const normalized = geometryBlendOutputs(project, project.outputs.map(o => o.id));
    for (let i = 0; i < normalized.length; i++) {
      const { values } = await rasterizeGeometryBlend(normalized, i), bytes = Buffer.alloc(values.length * 4);
      values.forEach((v, k) => bytes.writeFloatLE(v, k * 4));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      await writeFile(join(root, 'assets', sha256), bytes);
      project.outputs[i].blend = { enabled: true, map: { sha256, format: 'r32_float', width: 64, height: 64, byteLength: bytes.length } };
    }
    await input.begin({ outputs: [{ id: 'input', width: 64, height: 64 }] });
    await input.show({ id: 'white', outputId: 'input', pattern: { kind: 'solid', level: 255 } });
    const { stdout } = await exec(process.env.PB_NDI_PROBE_EXE, ['--list'], execOptions);
    const source = JSON.parse(stdout).sources.find(s => s.name === input.sources[0].name); assert.ok(source);
    prepared = await prepareNdiCorrectionAssets(projectNdiVideoPlan(project, { expectedRevision: 1, sourceName: source.name, outputIds: project.outputs.map(o => o.id) }, source, { resolveAssets: true }), { root });
    await video.begin(prepared.plan); await video.setBlank(false);
    const means = await Promise.all(video.sources.map(async s => {
      const { stdout } = await exec(process.env.PB_NDI_PROBE_EXE, ['--receive', s.name], execOptions);
      const r = JSON.parse(stdout).receive; assert.ok(r.receivedFrames > 20); return r.lastSampledMeanRgb8;
    }));
    t.diagnostic(`five generated blend means: ${means}`);
    assert.equal(means.length, 5); assert.ok(means.every(v => v > 112 && v < 135), 'equal 0.2 linear contribution must survive all five native outputs');
  } finally { await Promise.allSettled([video.end(), input.end()]); await prepared?.cleanup(); await rm(root, { recursive: true, force: true }); }
});
test('Windows: verified blend/black/mask/LUT assets reach GPU and NDI frames', { skip: !enabled, timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pb-ndi-map-gpu-')); await mkdir(join(root, 'assets'));
  const options = { runtimeDirectory: process.env.PB_NDI_RUNTIME_DIR, timeoutMs: 15000 };
  const input = new NdiPatternTransport({ ...options, command: process.env.PB_NDI_PATTERN_EXE });
  const video = new NdiVideoTransport({ ...options, command: process.env.PB_NDI_VIDEO_EXE, shaderDirectory: process.env.PB_NDI_SHADER_DIR, assetDirectory: root });
  const exec = promisify(execFile); let prepared;
  const execOptions = { timeout: 18000, maxBuffer: 65536, windowsHide: true, env: { ...process.env, PATH: process.env.PB_NDI_RUNTIME_DIR + ';' + process.env.PATH } };
  async function ref(values, fields) {
    const bytes = Buffer.alloc(values.length * 4); values.forEach((v, i) => bytes.writeFloatLE(v, i * 4));
    const sha256 = createHash('sha256').update(bytes).digest('hex'); await writeFile(join(root, 'assets', sha256), bytes);
    return { ...fields, sha256, byteLength: bytes.length };
  }
  async function means() {
    return Promise.all(video.sources.map(async s => {
      const { stdout } = await exec(process.env.PB_NDI_PROBE_EXE, ['--receive', s.name], execOptions);
      const r = JSON.parse(stdout).receive; assert.ok(r.receivedFrames > 20); return r.lastSampledMeanRgb8;
    }));
  }
  try {
    const scalar = v => ref([v], { width: 1, height: 1, format: 'r32_float' });
    const outputs = ['blend', 'black', 'mask', 'lut'].map(id => output(id, 0));
    outputs[0].blend = { enabled: true, map: await scalar(0.25) };
    outputs[1].blackUniformity = { enabled: true, map: await scalar(0.1) };
    outputs[2].mask = { enabled: true, map: await scalar(0) };
    outputs[3].color.lut = await ref(Array.from({ length: 32 }, (_, i) => i % 4 === 3 ? 1 : 0.25), { size: 2, format: 'rgba32_float' });
    await input.begin({ outputs: [{ id: 'input', width: 64, height: 64 }] });
    await input.show({ id: 'white', outputId: 'input', pattern: { kind: 'solid', level: 255 } });
    const { stdout } = await exec(process.env.PB_NDI_PROBE_EXE, ['--list'], execOptions);
    const source = JSON.parse(stdout).sources.find(s => s.name === input.sources[0].name); assert.ok(source);
    const project = { revision: 1, canvas: { ...canvas, width: 64 }, outputs };
    prepared = await prepareNdiCorrectionAssets(projectNdiVideoPlan(project, { expectedRevision: 1, sourceName: source.name, outputIds: outputs.map(o => o.id) }, source, { resolveAssets: true }), { root });
    await video.begin(prepared.plan); await video.setBlank(false);
    const white = await means(); t.diagnostic(`asset white means ${white}`);
    assert.ok(white[0] > 120 && white[0] < 150); assert.ok(white[2] < 10); assert.ok(white[3] > 120 && white[3] < 150);
    await input.show({ id: 'black', outputId: 'input', pattern: { kind: 'solid', level: 0 } });
    const black = await means(); t.diagnostic(`asset black means ${black}`);
    assert.ok(black[0] < 10); assert.ok(black[1] > 70 && black[1] < 110); assert.ok(black[2] < 10); assert.ok(black[3] > 120 && black[3] < 150);
  } finally { await Promise.allSettled([video.end(), input.end()]); await prepared?.cleanup(); await rm(root, { recursive: true, force: true }); }
});
test('Windows: NDI input -> GPU crop/color -> two NDI outputs, blank and source-loss', { skip: !enabled, timeout: 120000 }, async t => {
  const options = { runtimeDirectory: process.env.PB_NDI_RUNTIME_DIR, timeoutMs: 15000 };
  const input = new NdiPatternTransport({ ...options, command: process.env.PB_NDI_PATTERN_EXE });
  const video = new NdiVideoTransport({ ...options, command: process.env.PB_NDI_VIDEO_EXE,
    shaderDirectory: process.env.PB_NDI_SHADER_DIR, assetDirectory: process.env.PB_NDI_SHADER_DIR });
  const exec = promisify(execFile);
  async function receive(id) {
    const source = video.sources.find(s => s.outputId === id);
    const { stdout } = await exec(process.env.PB_NDI_PROBE_EXE, ['--receive', source.name], { timeout: 18000, maxBuffer: 65536, windowsHide: true,
      env: { ...process.env, PATH: process.env.PB_NDI_RUNTIME_DIR + ';' + process.env.PATH } });
    const result = JSON.parse(stdout).receive;
    assert.ok(result.receivedFrames > 20); assert.equal(result.formats.length, 1);
    assert.equal(result.formats[0].width, 64); assert.equal(result.formats[0].height, 64);
    assert.equal(result.timecodeRegressions, 0);
    return result.lastSampledMeanRgb8;
  }
  try {
    await input.begin({ outputs: [{ id: 'canvas', width: 128, height: 64 }] });
    await input.show({ id: 'halves', outputId: 'canvas', pattern: { kind: 'gray-code', axis: 'x', bit: 0, inverse: false } });
    const discovered = await exec(process.env.PB_NDI_PROBE_EXE, ['--list'], { timeout: 12000, maxBuffer: 65536, windowsHide: true,
      env: { ...process.env, PATH: process.env.PB_NDI_RUNTIME_DIR + ';' + process.env.PATH } });
    const identity = JSON.parse(discovered.stdout).sources.find(s => s.name === input.sources[0].name);
    assert.ok(identity?.address, 'Exact input must be discoverable');
    const project = { revision: 1, canvas, outputs: [output('left', 0), output('right', 64, 0.25)] };
    await video.begin(projectNdiVideoPlan(project, { expectedRevision: 1, sourceName: identity.name, outputIds: ['left', 'right'] }, identity));
    assert.equal((await video.status()).black, true);
    await video.setBlank(false);
    const values = await Promise.all([receive('left'), receive('right')]);
    t.diagnostic(`crop/color means: ${values}`);
    assert.ok(values[0] <= 20, 'left crop must be black');
    assert.ok(values[1] >= 110 && values[1] <= 160, 'white right crop must pass linear gain and sRGB encoding');
    const state = await video.status(); assert.equal(state.sourceValid, true); assert.ok(state.receivedFrames > 20);
    await input.show({ id: 'inverse', outputId: 'canvas', pattern: { kind: 'gray-code', axis: 'x', bit: 0, inverse: true } });
    const inverse = await Promise.all([receive('left'), receive('right')]);
    t.diagnostic(`inverted crop means: ${inverse}`);
    assert.ok(inverse[0] >= 235); assert.ok(inverse[1] <= 20);
    await video.setBlank(true);
    assert.ok((await receive('left')) <= 20);
    await video.setBlank(false); await input.end(); await delay(1200);
    const lost = await video.status(); assert.equal(lost.sourceValid, false); assert.equal(lost.black, true);
    const black = await Promise.all([receive('left'), receive('right')]);
    assert.ok(black.every(v => v <= 20));
    const stopped = await video.end(); assert.equal(stopped.blackSubmitted, true); assert.equal(stopped.physicalBlackVerified, false);
  } finally { await Promise.allSettled([video.end(), input.end()]); }
});
