import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

const MAX_FRAME_BYTES = 1920 * 1080 * 3;
const MAX_HEADER_BYTES = 16 * 1024;
const failure = (code, message) => Object.assign(new Error(message), { code });

export function parseUvcDevices(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 256 * 1024) throw failure('UVC_PROTOCOL', 'Device list exceeds limit');
  const input = JSON.parse(bytes.toString('utf8'));
  if (input.schema !== 'pb-uvc-devices-v1' || !Array.isArray(input.devices) || input.devices.length > 128) {
    throw failure('UVC_PROTOCOL', 'Invalid device list');
  }
  const ids = new Set();
  return input.devices.map(({ id, name }) => {
    if (typeof id !== 'string' || !id || id.length > 4096 || id.includes('\0')
        || typeof name !== 'string' || !name || name.length > 1024 || ids.has(id)) {
      throw failure('UVC_PROTOCOL', 'Invalid or duplicate camera identity');
    }
    ids.add(id);
    return { id, name };
  });
}

/** Separate from the verified RAW calibration contract on purpose. */
export function parseUvcFrame(bytes, expectedDeviceId) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FRAME_BYTES + MAX_HEADER_BYTES) {
    throw failure('UVC_PROTOCOL', 'Frame exceeds limit');
  }
  const newline = bytes.indexOf(10);
  if (newline < 1 || newline > MAX_HEADER_BYTES) throw failure('UVC_PROTOCOL', 'Missing frame header');
  const input = JSON.parse(bytes.subarray(0, newline).toString('utf8'));
  const data = bytes.subarray(newline + 1);
  if (input.schema !== 'pb-uvc-frame-v1' || typeof expectedDeviceId !== 'string' || !expectedDeviceId
      || input.deviceId !== expectedDeviceId || typeof input.deviceName !== 'string'
      || input.deviceName.length > 1024 || input.width !== 1920 || input.height !== 1080
      || !Number.isSafeInteger(input.fpsNumerator) || !Number.isSafeInteger(input.fpsDenominator)
      || input.fpsDenominator < 1 || input.fpsNumerator < 1 || input.fpsNumerator > 1_000_000
      || input.fpsNumerator !== 30 * input.fpsDenominator
      || input.pixelFormat !== 'rgb24-encoded' || input.byteLength !== MAX_FRAME_BYTES
      || data.length !== MAX_FRAME_BYTES || input.raw !== false || input.linearized !== false
      || input.manualLockVerified !== false || input.patternSynchronized !== false
      || input.purpose !== 'geometry-preview-only' || input.discardedStartupFrames !== 8
      || !Number.isSafeInteger(input.receivedAtUnixMs) || input.receivedAtUnixMs < 1
      || typeof input.sampleTime100ns !== 'string' || !/^-?\d{1,19}$/.test(input.sampleTime100ns)) {
    throw failure('UVC_PROTOCOL', 'UVC frame identity, layout or processed-video provenance is invalid');
  }
  return {
    metadata: { ...input, sha256: createHash('sha256').update(data).digest('hex') },
    data,
  };
}

export function uvcFrameBmp({ metadata, data }) {
  const { width, height } = metadata;
  if (!Number.isSafeInteger(width) || width < 1 || width > 1920
      || !Number.isSafeInteger(height) || height < 1 || height > 1080
      || metadata.pixelFormat !== 'rgb24-encoded' || !Buffer.isBuffer(data)
      || data.length !== width * height * 3) throw failure('UVC_PROTOCOL', 'Invalid BMP source');
  const stride = (width * 3 + 3) & ~3;
  const bmp = Buffer.alloc(54 + stride * height);
  bmp.write('BM', 0); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(width, 18); bmp.writeInt32LE(-height, 22);
  bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = (y * width + x) * 3, to = 54 + y * stride + x * 3;
    bmp[to] = data[from + 2]; bmp[to + 1] = data[from + 1]; bmp[to + 2] = data[from];
  }
  return bmp;
}

export class UvcCamera {
  #busy = false;
  constructor({ command, timeoutMs = 15000 }) {
    if (typeof command !== 'string' || !isAbsolute(command)) throw failure('UVC_CONFIG', 'Use an explicit absolute camera executable path');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw failure('UVC_CONFIG', 'Invalid camera timeout');
    this.command = command; this.timeoutMs = timeoutMs;
  }
  async #run(args, limit, signal) {
    if (this.#busy) throw failure('UVC_BUSY', 'A camera request is already running');
    if (signal?.aborted) throw failure('UVC_ABORTED', 'Camera request cancelled');
    this.#busy = true;
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(this.command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let chunks = [], length = 0, stderr = '', pendingError = null;
        const stop = (error) => { pendingError ||= error; child.kill(); };
        const cancel = () => stop(failure('UVC_ABORTED', 'Camera request cancelled'));
        const timer = setTimeout(() => stop(failure('UVC_TIMEOUT', 'Camera did not respond; check USB streaming mode and close other camera applications')), this.timeoutMs);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        child.stdout.on('data', (bytes) => {
          length += bytes.length;
          if (length > limit) { chunks = []; stop(failure('UVC_PROTOCOL', 'Camera output exceeds limit')); }
          else if (!pendingError) chunks.push(bytes);
        });
        child.stderr.on('data', (bytes) => { stderr = (stderr + bytes.toString('utf8')).slice(-8192); });
        child.on('error', (error) => { pendingError ||= error; });
        // Hold the busy lock until process termination, including timeout and
        // cancellation, so the next request cannot compete for the camera.
        child.on('close', (code) => {
          clearTimeout(timer); signal?.removeEventListener('abort', cancel);
          if (pendingError) return reject(pendingError);
          if (code !== 0) return reject(failure('UVC_CAPTURE_FAILED', stderr.trim() || `Camera exited ${code}`));
          resolve(Buffer.concat(chunks, length));
        });
      });
    } finally { this.#busy = false; }
  }
  async list({ signal } = {}) {
    return parseUvcDevices(await this.#run(['--list'], 256 * 1024, signal));
  }
  async capture(deviceId, { signal } = {}) {
    if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 4096 || deviceId.includes('\0')) {
      throw failure('UVC_DEVICE', 'Select one exact camera identity');
    }
    return parseUvcFrame(await this.#run(['--capture', deviceId], MAX_FRAME_BYTES + MAX_HEADER_BYTES, signal), deviceId);
  }
  async controls(deviceId, { signal } = {}) {
    if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 4096 || deviceId.includes('\0')) throw failure('UVC_DEVICE', 'Select one exact camera identity');
    const value = JSON.parse((await this.#run(['--controls', deviceId], 16384, signal)).toString('utf8'));
    if (value.schema !== 'pb-uvc-controls-v1' || value.deviceId !== deviceId || value.settingsChanged !== false || value.manualLockVerified !== false || !value.controls || typeof value.controls !== 'object') throw failure('UVC_PROTOCOL', 'Invalid camera controls response');
    for (const key of ['exposure','focus','iris','whiteBalance','gain','gamma']) {
      const control = value.controls[key];
      if (!control || typeof control.supported !== 'boolean' || (control.supported && (!Number.isSafeInteger(control.value) || !Number.isSafeInteger(control.flags) || typeof control.automatic !== 'boolean'))) throw failure('UVC_PROTOCOL', 'Invalid camera control evidence');
    }
    return value;
  }
}
