import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { requiredGrayBits, grayToBinary, buildWarpMeshFromCameraMap } from '../shared/calibration.mjs';
import { assertUvcPhotometryOptions, UvcPhotometryMeasurement, UVC_RAMP_LEVELS } from './uvc-photometry.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw fail('GEOMETRY_CONFIG', `Invalid ${label}`);
  return value;
}
export function geometryPlan({ outputs, deviceId, settleMs = 1000, contrast = 18, sampleStride = 3, autoBlend = false,
  autoPhotometry = false, cameraResponse, cameraSettingsLocked }) {
  assertUvcPhotometryOptions({ autoPhotometry, autoBlend, cameraResponse, cameraSettingsLocked });
  if (typeof autoBlend !== 'boolean') throw fail('GEOMETRY_CONFIG', 'autoBlend must be boolean');
  if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 4096) throw fail('GEOMETRY_CONFIG', 'Select an exact USB camera');
  if (!Array.isArray(outputs) || !outputs.length || outputs.length > 5) throw fail('GEOMETRY_CONFIG', 'Select one to five outputs');
  const ids = new Set();
  const normalized = outputs.map(({ id, width, height, targetMesh }) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id)) throw fail('GEOMETRY_CONFIG', 'Invalid/duplicate output id');
    ids.add(id);
    integer(width, 2, 4096, 'output width'); integer(height, 2, 2160, 'output height');
    if (width % 2) throw fail('GEOMETRY_CONFIG', 'NDI output width must be even');
    if (targetMesh && (!Array.isArray(targetMesh.points) || targetMesh.points.some(p =>
      !Number.isFinite(p.cameraX) || !Number.isFinite(p.cameraY) || p.cameraX < 0 || p.cameraX > 1 || p.cameraY < 0 || p.cameraY > 1))) {
      throw fail('GEOMETRY_CONFIG', 'Invalid camera-space target mesh');
    }
    if (targetMesh) {
      integer(targetMesh.columns, 2, 128, 'mesh columns'); integer(targetMesh.rows, 2, 128, 'mesh rows');
      if (targetMesh.points.length !== (targetMesh.columns + 1) * (targetMesh.rows + 1)) throw fail('GEOMETRY_CONFIG', 'Mesh point count mismatch');
    }
    return { id, width, height, ...(targetMesh ? { targetMesh: structuredClone(targetMesh) } : {}) };
  });
  return { deviceId, outputs: normalized, settleMs: integer(settleMs, 100, 10000, 'settle time'),
    contrast: integer(contrast, 4, 128, 'contrast'), sampleStride: integer(sampleStride, 1, 8, 'sample stride'), autoBlend,
    autoPhotometry, ...(autoPhotometry ? { cameraResponse, cameraSettingsLocked } : {}) };
}

/** Streaming bit-pair decoder: keeps at most a pair of luma frames, not the
 * entire 40+ frame sequence. Coordinates are physical output pixels. */
export class GeometryDecoder {
  constructor({ width, height, outputWidth, outputHeight, contrast = 18 }) {
    integer(width, 1, 1920, 'camera width'); integer(height, 1, 1080, 'camera height');
    integer(outputWidth, 2, 4096, 'output width'); integer(outputHeight, 2, 2160, 'output height');
    integer(contrast, 4, 128, 'contrast');
    this.width = width; this.height = height; this.outputWidth = outputWidth; this.outputHeight = outputHeight;
    this.contrast = contrast; this.count = width * height;
    this.grayX = new Uint16Array(this.count); this.grayY = new Uint16Array(this.count);
    this.confidence = new Float32Array(this.count).fill(1);
    this.next = { x: 0, y: 0 }; this.reference = false; this.finished = false;
  }
  #frame(frame) {
    if (!(frame instanceof Uint8Array) || frame.length !== this.count) throw fail('GEOMETRY_FRAME', 'Luma frame dimensions changed');
  }
  references(black, white) {
    this.#frame(black); this.#frame(white);
    if (this.reference) throw fail('GEOMETRY_ORDER', 'References already set');
    this.reference = true;
    let usablePixels = 0;
    for (let i = 0; i < this.count; i++) {
      const range = white[i] - black[i];
      this.confidence[i] = range >= this.contrast * 2 ? Math.min(1, range / 255) : 0;
      if (this.confidence[i] > 0) usablePixels++;
    }
    if (usablePixels < Math.max(4, Math.ceil(this.count * 0.005))) throw Object.assign(fail('GEOMETRY_NO_SURFACE', 'Black/white references show no usable projected surface; scan stopped before Gray-code capture'), { details: { usablePixels, sampledPixels: this.count } });
  }
  pair(axis, bit, normal, inverse) {
    if (!this.reference || this.finished || !['x', 'y'].includes(axis) || bit !== this.next[axis]
        || bit >= requiredGrayBits(axis === 'x' ? this.outputWidth : this.outputHeight)) {
      throw fail('GEOMETRY_ORDER', 'Gray-code pairs must arrive once in bit order');
    }
    this.#frame(normal); this.#frame(inverse);
    const codes = axis === 'x' ? this.grayX : this.grayY;
    for (let i = 0; i < this.count; i++) {
      const difference = normal[i] - inverse[i], strength = Math.abs(difference);
      codes[i] = (codes[i] << 1) | (difference > 0 ? 1 : 0);
      this.confidence[i] = strength >= this.contrast ? Math.min(this.confidence[i], strength / 255) : 0;
    }
    this.next[axis]++;
  }
  finish() {
    if (this.finished || this.next.x !== requiredGrayBits(this.outputWidth) || this.next.y !== requiredGrayBits(this.outputHeight)) {
      throw fail('GEOMETRY_ORDER', 'Incomplete or already-finished Gray sequence');
    }
    this.finished = true;
    const projectorX = new Int32Array(this.count).fill(-1), projectorY = new Int32Array(this.count).fill(-1);
    let validPixels = 0;
    for (let i = 0; i < this.count; i++) {
      const x = grayToBinary(this.grayX[i]), y = grayToBinary(this.grayY[i]);
      if (this.confidence[i] > 0 && x < this.outputWidth && y < this.outputHeight) {
        projectorX[i] = x; projectorY[i] = y; validPixels++;
      } else this.confidence[i] = 0;
    }
    if (validPixels < Math.max(4, Math.ceil(this.count * 0.005))) throw fail('GEOMETRY_NO_SURFACE', 'No usable projected Gray-code surface; check routing, camera view and exposure');
    return { cameraWidth: this.width, cameraHeight: this.height, projectorWidth: this.outputWidth,
      projectorHeight: this.outputHeight, projectorX, projectorY, confidence: this.confidence,
      validPixels, sampledPixels: this.count };
  }
}

function luma(frame, deviceId, stride, notBefore, lastTime) {
  const m = frame?.metadata, data = frame?.data;
  if (!m || m.deviceId !== deviceId || m.raw !== false || m.linearized !== false || m.pixelFormat !== 'rgb24-encoded'
      || !Buffer.isBuffer(data) || !Number.isSafeInteger(m.width) || !Number.isSafeInteger(m.height)
      || m.width < 1 || m.height < 1 || m.width > 1920 || m.height > 1080 || data.length !== m.width * m.height * 3) {
    throw fail('GEOMETRY_FRAME', 'Camera identity or processed RGB layout changed');
  }
  if (!Number.isSafeInteger(m.receivedAtUnixMs) || m.receivedAtUnixMs < notBefore || m.receivedAtUnixMs <= lastTime
      || m.receivedAtUnixMs > Date.now() + 2000) throw fail('GEOMETRY_STALE_FRAME', 'Camera frame predates the requested pattern capture');
  const sha256 = createHash('sha256').update(data).digest('hex');
  if (m.sha256 !== sha256) throw fail('GEOMETRY_FRAME', 'Camera raster digest mismatch');
  const width = Math.ceil(m.width / stride), height = Math.ceil(m.height / stride), values = new Uint8Array(width * height), rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    // Nearest-pixel sampling preserves both endpoints of normalized camera
    // coordinates. No luma interpolation invents Gray-code edge contrast.
    const sourceX = width === 1 ? 0 : Math.round(x * (m.width - 1) / (width - 1));
    const sourceY = height === 1 ? 0 : Math.round(y * (m.height - 1) / (height - 1));
    const i = (sourceY * m.width + sourceX) * 3;
    values[y * width + x] = (54 * data[i] + 183 * data[i + 1] + 19 * data[i + 2] + 128) >> 8;
    rgb.set(data.subarray(i, i + 3), (y * width + x) * 3);
  }
  return { width, height, sourceWidth: m.width, sourceHeight: m.height, values, rgb, sha256, receivedAtUnixMs: m.receivedAtUnixMs };
}

/** Executes a complete geometry acquisition, but returns a candidate only.
 * Submitted NDI frames + settling are not proof of optical presentation.
 * No RAW/radiometry manifest or production project is created or activated. */
export class UvcGeometrySession {
  #busy = false;
  constructor({ camera, patterns, wait = (ms, signal) => delay(ms, undefined, { signal }) }) {
    if (typeof camera?.capture !== 'function' || ['begin', 'show', 'end'].some(k => typeof patterns?.[k] !== 'function')) {
      throw fail('GEOMETRY_CONFIG', 'Camera and pattern transport are required');
    }
    this.camera = camera; this.patterns = patterns; this.wait = wait;
  }
  async run(input, { signal, onProgress = () => {}, onOutput = async () => {} } = {}) {
    if (this.#busy) throw fail('GEOMETRY_BUSY', 'A geometry session is already running');
    const plan = geometryPlan(input); signal?.throwIfAborted();
    this.#busy = true;
    let attemptedBegin = false, failure, endResult;
    const evidence = [], results = [];
    let sequence = 0, lastTime = 0, captureDimensions;
    const capture = async (outputId, pattern) => {
      signal?.throwIfAborted();
      const step = { id: `uvc-${sequence++}`, outputId, pattern };
      const receipt = await this.patterns.show(step, { signal });
      if (receipt?.stepId !== step.id || receipt.submitted !== true || receipt.otherOutputsBlack !== true) {
        throw fail('GEOMETRY_PATTERN', 'Pattern transport did not acknowledge exact target isolation');
      }
      await this.wait(plan.settleMs, signal);
      const notBefore = Date.now();
      const raw = await this.camera.capture(plan.deviceId, { signal });
      signal?.throwIfAborted();
      const frame = luma(raw, plan.deviceId, plan.sampleStride, notBefore, lastTime);
      const dimensions = `${frame.sourceWidth}x${frame.sourceHeight}`;
      if (captureDimensions && captureDimensions !== dimensions) throw fail('GEOMETRY_FRAME', 'Camera resolution changed during sequence');
      captureDimensions = dimensions; lastTime = frame.receivedAtUnixMs;
      evidence.push({ ...step, sha256: frame.sha256, receivedAtUnixMs: frame.receivedAtUnixMs,
        synchronization: 'submission-plus-settle-delay-only' });
      await onProgress({ state: 'capturing', completedCaptures: evidence.length, outputId, pattern });
      return frame;
    };
    try {
      attemptedBegin = true;
      await this.patterns.begin(plan, { signal });
      for (const output of plan.outputs) {
        const black = await capture(output.id, { kind: 'solid', level: 0 });
        const white = await capture(output.id, { kind: 'solid', level: 255 });
        const decoder = new GeometryDecoder({ width: white.width, height: white.height,
          outputWidth: output.width, outputHeight: output.height, contrast: plan.contrast });
        decoder.references(black.values, white.values);
        for (const axis of ['x', 'y']) for (let bit = 0; bit < requiredGrayBits(axis === 'x' ? output.width : output.height); bit++) {
          const normal = await capture(output.id, { kind: 'gray-code', axis, bit, inverse: false });
          const inverse = await capture(output.id, { kind: 'gray-code', axis, bit, inverse: true });
          decoder.pair(axis, bit, normal.values, inverse.values);
        }
        const afterWhite = await capture(output.id, { kind: 'solid', level: 255 });
        const afterBlack = await capture(output.id, { kind: 'solid', level: 0 });
        let difference = 0, reference = 0;
        for (let i = 0; i < white.values.length; i++) {
          if (white.values[i] - black.values[i] < plan.contrast * 2) continue;
          difference += Math.abs(white.values[i] - afterWhite.values[i]) + Math.abs(black.values[i] - afterBlack.values[i]);
          reference += 2 * (white.values[i] - black.values[i]);
        }
        if (!reference || difference / reference > 0.08) throw Object.assign(fail('GEOMETRY_SCENE_CHANGED', 'References changed during capture; check movement and automatic camera settings'), { details: { outputId: output.id, referenceDrift: reference ? difference / reference : null, maximumReferenceDrift: 0.08 } });
        const map = decoder.finish();
        const targetMesh = output.targetMesh || null;
        if (targetMesh && (white.width < 2 || white.height < 2)) throw fail('GEOMETRY_FRAME', 'Camera sampling grid is too small for a mesh');
        const mesh = targetMesh ? buildWarpMeshFromCameraMap({ ...map, targetMesh, minimumConfidence: plan.contrast / 255,
          maxSearchRadius: 2, allowHoles: false }) : null;
        let photometry;
        if (plan.autoPhotometry) {
          const measurement = new UvcPhotometryMeasurement(map);
          for (const level of UVC_RAMP_LEVELS) measurement.add(level, (await capture(output.id, { kind: 'solid', level })).rgb);
          const lastWhite = await capture(output.id, { kind: 'solid', level: 255 });
          const lastBlack = await capture(output.id, { kind: 'solid', level: 0 });
          photometry = { outputId: output.id, ...measurement.finish(lastBlack.rgb, lastWhite.rgb) };
        }
        await onOutput({ outputId: output.id, map, mesh, photometry });
        results.push({ outputId: output.id, validPixels: map.validPixels, sampledPixels: map.sampledPixels,
          referenceDrift: difference / reference, mesh, ...(photometry ? { photometry } : {}) });
      }
    } catch (error) { failure = error; }
    finally {
      try { if (attemptedBegin) endResult = await this.patterns.end(); }
      catch (error) { failure = new AggregateError([...(failure ? [failure] : []), error], 'Geometry cleanup failed; check projector output'); }
      this.#busy = false;
    }
    if (failure) throw failure;
    return { schema: 'pb-uvc-geometry-candidate-v1', status: 'candidate-not-applied', outputs: results, captures: evidence,
      raw: false, linearized: false, manualLockVerified: false, opticalSynchronizationVerified: false,
      radiometryVerified: false, physicalBeforeAfterVerified: false, endResult };
  }
}
