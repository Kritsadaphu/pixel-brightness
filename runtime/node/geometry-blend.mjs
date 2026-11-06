import { setImmediate as yieldTurn } from 'node:timers/promises';
import { normalizeOutputConfig } from '../shared/mapping.mjs';

/** Geometric partition of unity, NOT a measurement of projector brightness.
 * The viewports share one camera target plane. We rasterize the exact triangle
 * topology used by FinalPipeline into physical output texels, not source UVs. */
export function geometryBlendOutputs(project, ids) {
  const enabled = project.outputs.filter(o => o.enabled !== false);
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5 || new Set(ids).size !== ids.length ||
      enabled.length !== ids.length || enabled.some(o => !ids.includes(o.id))) {
    throw new Error('Geometry blend requires every enabled output in the project');
  }
  if (new Set(enabled.map(o => o.wallId ?? 'default')).size !== 1) throw new Error('Geometry blend requires one shared physical surface');
  const outputs = ids.map(id => normalizeOutputConfig(enabled.find(o => o.id === id)));
  let total = 0;
  for (const o of outputs) {
    const { width, height } = o.resolution, v = o.sourceViewport;
    if (width > 4096 || height > 2160 || !o.warp.enabled || o.processing?.bypass) throw new Error('Geometry blend requires active bounded Warp outputs');
    if (v.x < 0 || v.y < 0 || v.x + v.width > project.canvas.width || v.y + v.height > project.canvas.height) throw new Error('Blend viewport exceeds canvas');
    total += width * height;
  }
  if (total > 44_236_800) throw new Error('Geometry blend exceeds pixel budget');
  return outputs;
}

export function geometryBlendWeight(outputs, index, x, y) {
  let total = 0, own = 0;
  for (let i = 0; i < outputs.length; i++) {
    const v = outputs[i].sourceViewport;
    const distance = Math.max(0, Math.min(x - v.x, v.x + v.width - x, y - v.y, v.y + v.height - y));
    total += distance;
    if (i === index) own = distance;
  }
  return total > 0 ? own / total : 0;
}

export async function rasterizeGeometryBlend(outputs, index, { signal } = {}) {
  const o = outputs[index], { width, height } = o.resolution, { columns, rows, points } = o.warp;
  const values = new Float32Array(width * height), covered = new Uint8Array(width * height);
  let coveredPixels = 0;
  const v = o.sourceViewport;
  for (let row = 0; row < rows; row++) {
    signal?.throwIfAborted(); await yieldTurn();
    for (let col = 0; col < columns; col++) {
      const tl = row * (columns + 1) + col, tr = tl + 1, bl = tl + columns + 1, br = bl + 1;
      for (const ids of [[tl, tr, bl], [tr, br, bl]]) {
        const [a, b, c] = ids.map(i => points[i]);
        const cross = (x, y, u, w) => x * w - y * u;
        const area = cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
        if (!(area > 1e-8)) throw new Error('Folded geometry blend triangle');
        const x0 = Math.max(0, Math.ceil(Math.min(a.x, b.x, c.x) * width - 0.5));
        const x1 = Math.min(width - 1, Math.floor(Math.max(a.x, b.x, c.x) * width - 0.5));
        const y0 = Math.max(0, Math.ceil(Math.min(a.y, b.y, c.y) * height - 0.5));
        const y1 = Math.min(height - 1, Math.floor(Math.max(a.y, b.y, c.y) * height - 0.5));
        for (let y = y0; y <= y1; y++) {
          if ((y & 31) === 0) { signal?.throwIfAborted(); await yieldTurn(); }
          for (let x = x0; x <= x1; x++) {
            const px = (x + 0.5) / width - a.x, py = (y + 0.5) / height - a.y;
            const wb = cross(px, py, c.x - a.x, c.y - a.y) / area;
            const wc = cross(b.x - a.x, b.y - a.y, px, py) / area, wa = 1 - wb - wc;
            if (wa < -1e-7 || wb < -1e-7 || wc < -1e-7) continue;
            const i = y * width + x;
            if (covered[i]) continue; // shared triangle boundary is owned once
            const u = a.u * wa + b.u * wb + c.u * wc, t = a.v * wa + b.v * wb + c.v * wc;
            values[i] = geometryBlendWeight(outputs, index, v.x + u * v.width, v.y + t * v.height);
            covered[i] = 1; coveredPixels++;
          }
        }
      }
    }
  }
  if (!coveredPixels) throw new Error('Warp has no visible physical output pixels');
  signal?.throwIfAborted();
  return { values, coveredPixels, method: 'geometry-partition-of-unity-v1', radiometryVerified: false };
}
