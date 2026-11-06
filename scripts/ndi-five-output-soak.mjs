#!/usr/bin/env node
// Bounded localhost decode load test. Unique senders; never route a physical
// receiver, edit a project, open Arena, or change the release pointer.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NdiPatternTransport } from '../runtime/node/ndi-pattern-transport.mjs';
import { NdiVideoTransport } from '../runtime/node/ndi-video-transport.mjs';
import { createIdentityMesh } from '../runtime/shared/mapping.mjs';
const exec = promisify(execFile);
const required = ['PB_NDI_RUNTIME_DIR', 'PB_NDI_VIDEO_EXE', 'PB_NDI_PATTERN_EXE', 'PB_NDI_PROBE_EXE', 'PB_NDI_SHADER_DIR'];
if (process.platform !== 'win32' || required.some(k => !process.env[k]) || process.argv.length !== 2) throw new Error('Run on Windows with the five explicit native diagnostic paths and no arguments');
const width = 1920, height = 1200;
const fps = Number(process.env.PB_NDI_SOAK_FPS ?? 30);
if (![30, 60].includes(fps)) throw new Error('PB_NDI_SOAK_FPS must be 30 or 60');
const settings = { runtimeDirectory: process.env.PB_NDI_RUNTIME_DIR, timeoutMs: 20000 };
const input = new NdiPatternTransport({ ...settings, command: process.env.PB_NDI_PATTERN_EXE });
const video = new NdiVideoTransport({ ...settings, command: process.env.PB_NDI_VIDEO_EXE,
  shaderDirectory: process.env.PB_NDI_SHADER_DIR, assetDirectory: process.env.PB_NDI_SHADER_DIR });
const execOptions = { timeout: 25000, maxBuffer: 65536, windowsHide: true,
  env: { ...process.env, PATH: process.env.PB_NDI_RUNTIME_DIR + ';' + process.env.PATH } };
const report = { schema: 'pb-five-output-soak-v1', width, height, outputs: 5, targetFps: fps,
  syntheticInputFps: fps, composition: 'one synthetic 1920x1200 canvas repeated on five outputs', networkPath: 'local-host-decode-only', physicalProjectorVerified: false, rounds: [], cleanup: {} };
try {
  await input.begin({ frameRateNum: fps, outputs: [{ id: 'soak-input', width, height }] });
  await input.show({ id: 'soak-white', outputId: 'soak-input', pattern: { kind: 'solid', level: 180 } });
  const discovery = JSON.parse((await exec(process.env.PB_NDI_PROBE_EXE, ['--list'], execOptions)).stdout);
  const source = discovery.sources.find(s => s.name === input.sources[0].name);
  if (!source) throw new Error('Isolated load-test source not discovered');
  const canvas = { width, height, frameRateNum: fps, frameRateDen: 1 };
  const outputs = Array.from({ length: 5 }, (_, i) => ({ id: `soak${i + 1}`, enabled: true,
    resolution: { width, height, refreshNum: fps, refreshDen: 1 }, sourceViewport: { x: 0, y: 0, width, height },
    warp: { ...createIdentityMesh(32, 18), enabled: true }, blend: { enabled: false },
    color: { gain: [0.9, 0.95, 1], offset: [0, 0, 0], gamma: [1, 1, 1] } }));
  const ready = await video.begin({ source: { ...source, sourceIsSrgb: true, timeoutMs: 2000 }, canvas, outputs });
  report.adapter = ready.adapter;
  await video.setBlank(false);
  for (let round = 0; round < 4; round++) {
    const results = await Promise.all(video.sources.map(async s => {
      const r = JSON.parse((await exec(process.env.PB_NDI_PROBE_EXE, ['--receive', s.name], execOptions)).stdout).receive;
      return { outputId: s.outputId, ...r, observedFps: r.receivedFrames / r.observedSeconds };
    }));
    report.rounds.push({ index: round, outputs: results, telemetry: await video.status() });
    console.log(JSON.stringify({ event: 'soak-round', index: round, fps: results.map(r => Number(r.observedFps.toFixed(2))), dropped: results.map(r => r.sdkDroppedVideoFrames) }));
  }
  report.passedTargetFps = report.rounds.slice(1).every(r => r.telemetry.sourceValid === true && r.telemetry.black === false &&
    r.outputs.every(o => o.observedFps >= fps * 0.95 && o.timecodeRegressions === 0 && o.lastSampledMeanRgb8 > 150 && o.lastSampledMeanRgb8 < 195 &&
    o.formats.length === 1 && o.formats[0].width === width && o.formats[0].height === height));
  report.passed30Fps = fps === 30 && report.passedTargetFps;
  report.passed60Fps = fps === 60 && report.passedTargetFps;
  if (!report.passedTargetFps) process.exitCode = 2;
} catch (e) { report.error = e.message; process.exitCode = 1; }
finally {
  for (const [name, transport] of [['video', video], ['input', input]]) {
    try { report.cleanup[name] = await transport.end(); } catch (e) { report.cleanup[name] = { error: e.message }; process.exitCode = 1; }
  }
  console.log(JSON.stringify(report));
}
