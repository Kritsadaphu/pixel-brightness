import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseUvcDevices, parseUvcFrame, uvcFrameBmp, UvcCamera } from '../runtime/node/uvc-camera.mjs';

const data = Buffer.alloc(1920 * 1080 * 3, 127);
const metadata = { schema: 'pb-uvc-frame-v1', deviceId: 'test-only', deviceName: 'Fixture',
  width: 1920, height: 1080, fpsNumerator: 30, fpsDenominator: 1,
  pixelFormat: 'rgb24-encoded', byteLength: data.length, sampleTime100ns: '123',
  receivedAtUnixMs: 1_788_690_000_000, discardedStartupFrames: 8,
  raw: false, linearized: false, manualLockVerified: false,
  patternSynchronized: false, purpose: 'geometry-preview-only' };
const wire = (patch = {}, pixels = data) => Buffer.concat([Buffer.from(JSON.stringify({ ...metadata, ...patch }) + '\n'), pixels]);

test('UVC validates exact identity and labels processed video, not RAW', () => {
  const frame = parseUvcFrame(wire(), 'test-only');
  assert.equal(frame.data.length, data.length);
  assert.match(frame.metadata.sha256, /^[a-f0-9]{64}$/);
  assert.equal(frame.metadata.raw, false);
  assert.throws(() => parseUvcFrame(wire(), 'another-camera'));
});
test('UVC rejects truncation, extra bytes, missing headers and format changes', () => {
  for (const bytes of [wire({}, data.subarray(1)), wire({}, Buffer.concat([data, Buffer.of(0)])), Buffer.from('no header'),
    wire({ width: 1280 }), wire({ fpsNumerator: 25 }), wire({ fpsDenominator: 0 }), wire({ sampleTime100ns: 'not-time' })]) {
    assert.throws(() => parseUvcFrame(bytes, 'test-only'));
  }
});
test('UVC cannot assert calibration, RAW, exposure lock or pattern synchronization', () => {
  for (const patch of [{ raw: true }, { linearized: true }, { manualLockVerified: true },
    { patternSynchronized: true }, { purpose: 'black-level-calibration' }, { pixelFormat: 'linear-rgb-f32' }]) {
    assert.throws(() => parseUvcFrame(wire(patch), 'test-only'));
  }
});
test('device list handles none, rejects duplicates and malformed ids', () => {
  const list = (devices) => Buffer.from(JSON.stringify({ schema: 'pb-uvc-devices-v1', devices }));
  assert.deepEqual(parseUvcDevices(list([])), []);
  assert.deepEqual(parseUvcDevices(list([{ id: 'a', name: 'Canon' }])), [{ id: 'a', name: 'Canon' }]);
  assert.throws(() => parseUvcDevices(list([{ id: 'a', name: 'x' }, { id: 'a', name: 'y' }])));
  assert.throws(() => parseUvcDevices(list([{ id: '', name: 'x' }])));
});
test('BMP is top-down BGR with zero row padding, preserving encoded samples', () => {
  const bmp = uvcFrameBmp({ metadata: { width: 1, height: 2, pixelFormat: 'rgb24-encoded' }, data: Buffer.from([255,0,0,0,0,255]) });
  assert.equal(bmp.toString('ascii', 0, 2), 'BM');
  assert.equal(bmp.readInt32LE(22), -2);
  assert.deepEqual([...bmp.subarray(54)], [0,0,255,0,255,0,0,0]);
  assert.throws(() => uvcFrameBmp({ metadata: { width: 1, height: 2 }, data: Buffer.alloc(6) }));
});
test('configuration requires bounded timeout and an explicit executable', () => {
  assert.throws(() => new UvcCamera({ command: 'camera.exe' }));
  assert.throws(() => new UvcCamera({ command: '/camera.exe', timeoutMs: 0 }));
});
test('control inspection stays read-only and unsupported controls never assert exposure lock', {skip:process.platform==='win32'}, async()=>{
  const camera=new UvcCamera({command:fileURLToPath(new URL('./fixtures/uvc-camera-fixture.mjs',import.meta.url))});
  const result=await camera.controls('test-only');
  assert.equal(result.controls.exposure.supported,false);assert.equal(result.manualLockVerified,false);
  await assert.rejects(camera.controls('wrong-identity'),{code:'UVC_PROTOCOL'});
  await assert.rejects(camera.controls('false-claim'),{code:'UVC_PROTOCOL'});
  await assert.rejects(camera.controls(''),{code:'UVC_DEVICE'});
});

// POSIX shebang fixture; native executable/stride tests run separately on Windows.
test('process boundary serializes, times out, cancels, bounds output and recovers', { skip: process.platform === 'win32' }, async () => {
  const camera = new UvcCamera({ command: fileURLToPath(new URL('./fixtures/uvc-camera-fixture.mjs', import.meta.url)), timeoutMs: 3000 });
  assert.equal((await camera.list())[0].id, 'test-only');
  const waiting = camera.capture('wait');
  await assert.rejects(camera.list(), { code: 'UVC_BUSY' });
  await assert.rejects(waiting, { code: 'UVC_TIMEOUT' });
  const aborter = new AbortController();
  const cancelled = camera.capture('wait', { signal: aborter.signal });
  aborter.abort();
  await assert.rejects(cancelled, { code: 'UVC_ABORTED' });
  await assert.rejects(camera.capture('overflow'), { code: 'UVC_PROTOCOL' });
  await assert.rejects(camera.capture('fail'), { code: 'UVC_CAPTURE_FAILED' });
  assert.equal((await camera.list()).length, 1);
});
