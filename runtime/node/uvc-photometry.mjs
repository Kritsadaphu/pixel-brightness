/** Processed USB video is not RAW radiometry. This opt-in SDR estimator assumes
 * an sRGB camera response and independent RGB channels. It matches neutral
 * ramps, not a color-chart / spectral calibration. Never promote its evidence
 * to verified radiometry without an optical before/after measurement. */
import { setImmediate as yieldTurn } from 'node:timers/promises';
export const UVC_RAMP_LEVELS = Object.freeze([0, 16, 32, 64, 96, 128, 160, 192, 224, 255]);
export const srgbDecode = v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const fail = message => Object.assign(new Error(message), { code: 'UVC_PHOTOMETRY' });

export function assertUvcPhotometryOptions(plan) {
  if (plan.autoPhotometry != null && typeof plan.autoPhotometry !== 'boolean') throw fail('autoPhotometry must be boolean');
  if (plan.autoPhotometry && (plan.autoBlend !== true || plan.cameraResponse !== 'srgb-assumed' || plan.cameraSettingsLocked !== true)) {
    throw fail('USB photometry requires Auto Blend, acknowledged sRGB assumption and manually locked exposure/white balance');
  }
}

/** Streaming accumulation: retain one black raster and coarse measured tiles,
 * not all RGB frames. Map coordinates come from this same acquisition session. */
export class UvcPhotometryMeasurement {
  constructor(map, { columns = 16, rows = 9 } = {}) {
    const count = map.cameraWidth * map.cameraHeight;
    if (!Number.isSafeInteger(count) || count < 4 || count > 1920 * 1080 ||
        ![columns, rows].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 64) ||
        ['projectorX', 'projectorY', 'confidence'].some(k => map[k]?.length !== count)) throw fail('Invalid photometry map');
    this.map = map; this.count = count; this.columns = columns; this.rows = rows; this.curves = [];
    this.tiles = Array.from({ length: columns * rows }, () => ({ count: 0, black: [0, 0, 0], white: [0, 0, 0] }));
    this.valid = []; this.black = null;
    for (let i = 0; i < count; i++) if (map.confidence[i] > 0 && map.projectorX[i] >= 0 && map.projectorY[i] >= 0 &&
        map.projectorX[i] < map.projectorWidth && map.projectorY[i] < map.projectorHeight) this.valid.push(i);
    if (this.valid.length < 4) throw fail('Insufficient mapped camera pixels');
  }
  #tile(i) {
    return Math.min(this.rows - 1, Math.floor(this.map.projectorY[i] / this.map.projectorHeight * this.rows)) * this.columns +
      Math.min(this.columns - 1, Math.floor(this.map.projectorX[i] / this.map.projectorWidth * this.columns));
  }
  add(level, rgb) {
    if (level !== UVC_RAMP_LEVELS[this.curves.length] || !(rgb instanceof Uint8Array) || rgb.length !== this.count * 3) throw fail('Wrong RGB ramp order or dimensions');
    if (level === 0) this.black = Uint8Array.from(rgb);
    const sums = [0, 0, 0]; let clipped = 0;
    for (const i of this.valid) {
      const tile = this.tiles[this.#tile(i)];
      if (level === 0) tile.count++;
      for (let c = 0; c < 3; c++) {
        const sample = srgbDecode(rgb[i * 3 + c] / 255), baseline = srgbDecode(this.black[i * 3 + c] / 255);
        if (rgb[i * 3 + c] >= 250) clipped++;
        sums[c] += sample - baseline;
        if (level === 0) tile.black[c] += baseline;
        if (level === 255) tile.white[c] += sample - baseline;
      }
    }
    if (clipped / (this.valid.length * 3) > 0.01) throw fail('Camera highlights clipped; lower fixed exposure and reacquire');
    this.curves.push({ level, response: sums.map(v => v / this.valid.length) });
  }
  finish(afterBlack, afterWhite) {
    if (this.curves.length !== UVC_RAMP_LEVELS.length || ![afterBlack, afterWhite].every(f => f instanceof Uint8Array && f.length === this.count * 3)) throw fail('Incomplete photometry references');
    const white = this.curves.at(-1).response;
    if (white.some(v => v < 0.03)) throw fail('Insufficient RGB response / exposure');
    let drift = 0;
    const after = [0, 0, 0];
    for (const i of this.valid) for (let c = 0; c < 3; c++) {
      const black = srgbDecode(this.black[i * 3 + c] / 255);
      drift += Math.abs(srgbDecode(afterBlack[i * 3 + c] / 255) - black) / white[c];
      after[c] += srgbDecode(afterWhite[i * 3 + c] / 255) - black;
    }
    drift /= this.valid.length * 3;
    const whiteDrift = Math.max(...after.map((v, c) => Math.abs(v / this.valid.length - white[c]) / white[c]));
    if (drift > 0.025 || whiteDrift > 0.05) throw fail('Exposure, white balance or scene changed during neutral ramps');
    for (let c = 0; c < 3; c++) for (let j = 1; j < this.curves.length; j++) {
      if (this.curves[j].response[c] < this.curves[j - 1].response[c] - 0.002) throw fail('Non-monotonic RGB response; disable automatic camera/projector processing');
      this.curves[j].response[c] = Math.max(this.curves[j].response[c], this.curves[j - 1].response[c]);
    }
    const tiles = this.tiles.map(t => ({ count: t.count, black: t.black.map(v => t.count ? v / t.count : 0), white: t.white.map(v => t.count ? v / t.count : 0) }));
    // A global per-output LUT cannot repair strong spatial/color variations.
    // Reject these rather than pretending a neutral ramp is a full 3D solve.
    const spatialDeviation = Math.max(...tiles.filter(t => t.count >= 4).flatMap(t => t.white.map((v, c) => Math.abs(v / white[c] - 1))));
    if (!Number.isFinite(spatialDeviation) || spatialDeviation > 0.15) throw fail('Brightness varies spatially by more than 15%; this USB neutral-ramp model cannot safely correct it');
    return { columns: this.columns, rows: this.rows, curves: this.curves, tiles, referenceDrift: Math.max(drift, whiteDrift), spatialDeviation,
      validPixels: this.valid.length, cameraResponse: 'srgb-assumed', radiometryVerified: false };
  }
}

function inverse(curves, channel, value) {
  if (value <= 0) return 0;
  for (let j = 1; j < curves.length; j++) if (curves[j].response[channel] >= value) {
    const a = curves[j - 1], b = curves[j], range = b.response[channel] - a.response[channel];
    const encoded = (a.level + (b.level - a.level) * (range > 0 ? (value - a.response[channel]) / range : 0)) / 255;
    // Renderer transfer-encodes after LUT, so store linear input commands.
    return srgbDecode(encoded);
  }
  throw fail('Requested correction exceeds measured projector response');
}

export function solveUvcPhotometry(measurements, { lutSize = 33 } = {}) {
  if (!Array.isArray(measurements) || measurements.length < 1 || measurements.length > 5 ||
      !Number.isSafeInteger(lutSize) || lutSize < 2 || lutSize > 65 || new Set(measurements.map(m => m.outputId)).size !== measurements.length) throw fail('Invalid photometry output set');
  for (const m of measurements) {
    if (m.cameraResponse !== 'srgb-assumed' || m.radiometryVerified !== false || !Number.isFinite(m.referenceDrift) || m.referenceDrift > 0.05 ||
        !Array.isArray(m.curves) || m.curves.length !== UVC_RAMP_LEVELS.length || !Array.isArray(m.tiles) || m.tiles.length !== m.columns * m.rows ||
        m.curves.some((p, i) => p.level !== UVC_RAMP_LEVELS[i] || p.response.length !== 3 || p.response.some(v => !Number.isFinite(v) || v < 0)) ||
        m.tiles.some(t => !Number.isSafeInteger(t.count) || t.count < 0 || t.black.length !== 3 || t.black.some(v => !Number.isFinite(v) || v < 0))) throw fail('Invalid measured photometry evidence');
    for (let c = 0; c < 3; c++) for (let i = 1; i < m.curves.length; i++) if (m.curves[i].response[c] < m.curves[i - 1].response[c]) throw fail('Non-monotonic measured curve');
  }
  const tiles = measurements.flatMap(m => m.tiles.filter(t => t.count >= 4));
  if (!tiles.length) throw fail('No measured black tiles');
  const blackTarget = [0, 1, 2].map(c => Math.max(...tiles.map(t => t.black[c])));
  const blackMinimum = [0, 1, 2].map(c => Math.min(...tiles.map(t => t.black[c])));
  const referenceWhite = [0, 1, 2].map(c => 0.9 * Math.min(...measurements.map(m => m.curves.at(-1).response[c])) - (blackTarget[c] - blackMinimum[c]));
  if (referenceWhite.some(v => v < 0.02)) throw fail('Black equalization would consume too much available brightness');
  return { method: 'uvc-sdr-neutral-ramp-v1', cameraResponse: 'srgb-assumed', radiometryVerified: false, physicalBeforeAfterVerified: false,
    blackTarget, referenceWhite, outputs: measurements.map(m => {
      const lut = new Float32Array(lutSize ** 3 * 4);
      // Reserve headroom for the additive Black term; content gain is applied
      // separately below. This avoids saturating content+lift at LUT input 1.
      const headroom = referenceWhite.map((v, c) => (blackTarget[c] - blackMinimum[c]) / v);
      const domain = 1 + Math.max(...headroom);
      for (let b = 0; b < lutSize; b++) for (let g = 0; g < lutSize; g++) for (let r = 0; r < lutSize; r++) {
        const i = ((b * lutSize + g) * lutSize + r) * 4;
        [r, g, b].forEach((v, c) => { lut[i + c] = inverse(m.curves, c, v / (lutSize - 1) * referenceWhite[c] * domain); });
        lut[i + 3] = 1;
      }
      return { outputId: m.outputId, measurement: m, lut, lutSize, gain: [1 / domain, 1 / domain, 1 / domain] };
    }) };
}

/** Coarse camera-derived black tiles are interpolated in physical projector
 * space. Missing interior tiles reject the candidate, never silently fill. */
export async function photometryBlackRaster(solution, record, blend, width, height, { signal } = {}) {
  if (blend.length !== width * height) throw fail('Blend/Black dimensions mismatch');
  const { columns, rows, tiles } = record.measurement, values = new Float32Array(width * height * 4);
  const sample = (x, y, c) => {
    const fx = Math.max(0, Math.min(columns - 1, x * columns - 0.5)), fy = Math.max(0, Math.min(rows - 1, y * rows - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), dx = fx - x0, dy = fy - y0;
    let value = 0;
    for (const [tx, ty, w] of [[x0, y0, (1 - dx) * (1 - dy)], [Math.min(x0 + 1, columns - 1), y0, dx * (1 - dy)],
      [x0, Math.min(y0 + 1, rows - 1), (1 - dx) * dy], [Math.min(x0 + 1, columns - 1), Math.min(y0 + 1, rows - 1), dx * dy]]) {
      if (w < 1e-8) continue;
      const tile = tiles[ty * columns + tx];
      if (tile.count < 4) throw fail('Black map has unmeasured tiles inside the active Warp; widen camera coverage');
      value += tile.black[c] * w;
    }
    return value;
  };
  for (let y = 0; y < height; y++) {
    if ((y & 15) === 0) { signal?.throwIfAborted(); await yieldTurn(); }
    for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (!Number.isFinite(blend[i]) || blend[i] < 0 || blend[i] > 1) throw fail('Invalid Black allocation weight');
    if (blend[i] > 0) for (let c = 0; c < 3; c++) values[i * 4 + c] = Math.max(0, solution.blackTarget[c] - sample((x + 0.5) / width, (y + 0.5) / height, c)) / solution.referenceWhite[c] * blend[i];
    values[i * 4 + 3] = 1;
    }
  }
  signal?.throwIfAborted();
  return values;
}
