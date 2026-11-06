import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NdiPatternTransport } from '../runtime/node/ndi-pattern-transport.mjs';

test('NDI pattern process requires explicit runtime paths', () => {
  assert.throws(() => new NdiPatternTransport({ command: 'relative.exe', runtimeDirectory: '.' }));
});
const enabled = process.platform === 'win32' && process.env.PB_NDI_PATTERN_EXE && process.env.PB_NDI_PROBE_EXE && process.env.PB_NDI_RUNTIME_DIR;
test('Windows SDK: pattern IPC, target isolation, inverse Gray, shutdown and restart', { skip: !enabled, timeout: 90000 }, async () => {
  const transport = new NdiPatternTransport({ command: process.env.PB_NDI_PATTERN_EXE, runtimeDirectory: process.env.PB_NDI_RUNTIME_DIR });
  const plan = { outputs: [{ id: 'left', width: 64, height: 32 }, { id: 'right', width: 64, height: 32 }] };
  const exec = promisify(execFile);
  async function receive(outputId) {
    const source = transport.sources.find(s => s.outputId === outputId);
    const { stdout } = await exec(process.env.PB_NDI_PROBE_EXE, ['--receive', source.name], {
      windowsHide: true, timeout: 18000, maxBuffer: 65536,
      env: { ...process.env, PATH: process.env.PB_NDI_RUNTIME_DIR + ';' + process.env.PATH },
    });
    const result = JSON.parse(stdout).receive;
    assert.ok(result.receivedFrames > 10);
    assert.equal(result.formats[0].width, 64);
    assert.equal(result.formats[0].height, 32);
    return result;
  }
  try {
    await transport.begin(plan); assert.equal(transport.sources.length, 2);
    const readySources = transport.sources;
    const white = await transport.show({ id: 'white-left', outputId: 'left', pattern: { kind: 'solid', level: 255 } });
    assert.equal(white.submitted, true); assert.equal(white.physicalPresentationVerified, false);
    assert.ok((await receive('left')).lastSampledMeanRgb8 >= 235);
    assert.ok((await receive('right')).lastSampledMeanRgb8 <= 20);
    for (const inverse of [false, true]) {
      await transport.show({ id: `gray-${inverse}`, outputId: 'right', pattern: { kind: 'gray-code', axis: 'x', bit: 0, inverse } });
      // Probe samples x=0 and 32, which must fall in opposite MSB halves.
      const result = await receive('right');
      assert.ok(result.lastSampledMeanRgb8 > 105 && result.lastSampledMeanRgb8 < 150);
    }
    const status = await transport.status(); assert.equal(status.connections.length, 2);
    const end = await transport.end(); assert.equal(end.blackSubmitted, true); assert.equal(end.contentRestored, false);
    await transport.begin(plan); assert.notEqual(transport.sources[0].name, readySources[0].name);
  } finally { await transport.end(); }
});
