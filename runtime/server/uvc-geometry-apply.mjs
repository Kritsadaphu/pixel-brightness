import { normalizeOutputConfig, validateMesh } from '../shared/mapping.mjs';

/** The operator's camera-space target area is shared by all selected outputs.
 * Project viewports determine target positions; output ordering is never guessed. */
export function projectGeometryTargets(project, outputs, area) {
  if (!area || Object.keys(area).some(k => !['x', 'y', 'width', 'height'].includes(k)) ||
      !['x', 'y', 'width', 'height'].every(k => Number.isFinite(area[k])) ||
      area.x < 0 || area.y < 0 || area.width <= 0 || area.height <= 0 || area.x + area.width > 1 || area.y + area.height > 1) {
    throw new Error('Select a normalized camera target area inside 0..1');
  }
  return outputs.map(selected => {
    const raw = project.outputs.find(o => o.id === selected.id);
    if (!raw || raw.enabled === false) throw new Error('Selected project output is missing or disabled');
    const o = normalizeOutputConfig(raw), v = o.sourceViewport;
    if (o.resolution.width !== selected.width || o.resolution.height !== selected.height) throw new Error('Save/reload output resolution before measuring');
    if (v.x < 0 || v.y < 0 || v.x + v.width > project.canvas.width || v.y + v.height > project.canvas.height) throw new Error('Viewport exceeds the saved canvas');
    const columns = o.warp.columns, rows = o.warp.rows, points = [];
    for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) points.push({
      cameraX: area.x + area.width * (v.x + column / columns * v.width) / project.canvas.width,
      cameraY: area.y + area.height * (v.y + row / rows * v.height) / project.canvas.height,
    });
    return { ...selected, targetMesh: { columns, rows, points } };
  });
}

export function applyGeometryCandidate(project, candidate, plan) {
  if (candidate.schema !== 'pb-uvc-geometry-candidate-v1' || candidate.status !== 'candidate-not-applied' ||
      !Array.isArray(candidate.outputs) || candidate.outputs.length !== plan.outputs.length) throw new Error('Incomplete geometry candidate');
  const result = structuredClone(project), seen = new Set();
  for (const acquired of candidate.outputs) {
    const requested = plan.outputs.find(o => o.id === acquired.outputId), output = result.outputs.find(o => o.id === acquired.outputId);
    if (!requested || !output || seen.has(output.id) || output.enabled === false) throw new Error('Geometry output identity mismatch');
    seen.add(output.id);
    if (output.resolution.width !== requested.width || output.resolution.height !== requested.height) throw new Error('Geometry output resolution changed');
    const m = acquired.mesh;
    if (!requested.targetMesh || !m || m.holes !== 0 || !Number.isFinite(m.confidence) || m.confidence < plan.contrast / 255 ||
        !Number.isFinite(acquired.referenceDrift) || acquired.referenceDrift > 0.08 || acquired.referenceDrift < 0 ||
        m.columns !== requested.targetMesh.columns || m.rows !== requested.targetMesh.rows) throw new Error('Geometry quality or target evidence is incomplete');
    // Validates all triangles, point ranges and UV ordering before changing any
    // output. Preserve source viewports, Blend, Black, masks, color and identity.
    output.warp = validateMesh({ ...m, enabled: true });
  }
  if (plan.autoBlend) {
    const blend = candidate.geometricBlend;
    if (blend?.method !== 'geometry-partition-of-unity-v1' || blend.radiometryVerified !== false ||
        !Array.isArray(blend.outputs) || blend.outputs.length !== plan.outputs.length ||
        new Set(blend.outputs.map(o => o.outputId)).size !== plan.outputs.length) throw new Error('Incomplete geometric blend candidate');
    for (const output of result.outputs.filter(o => seen.has(o.id))) {
      const record = blend.outputs.find(o => o.outputId === output.id), ref = record?.ref;
      if (!ref || ref.format !== 'r32_float' || !/^[a-f0-9]{64}$/.test(ref.sha256 || '') ||
          ref.width !== output.resolution.width || ref.height !== output.resolution.height ||
          ref.byteLength !== ref.width * ref.height * 4 || !(record.coveredPixels > 0)) throw new Error('Invalid geometric blend artifact');
      output.blend = { ...output.blend, enabled: true, map: structuredClone(ref) };
    }
  }
  if (plan.autoPhotometry) {
    const photo = candidate.usbPhotometry;
    if (!plan.autoBlend || plan.cameraResponse !== 'srgb-assumed' || plan.cameraSettingsLocked !== true ||
        photo?.method !== 'uvc-sdr-neutral-ramp-v1' || photo.cameraResponse !== 'srgb-assumed' || photo.radiometryVerified !== false ||
        !Array.isArray(photo.outputs) || photo.outputs.length !== plan.outputs.length || new Set(photo.outputs.map(o => o.outputId)).size !== plan.outputs.length) throw new Error('Incomplete USB photometry candidate');
    for (const output of result.outputs.filter(o => seen.has(o.id))) {
      const p = photo.outputs.find(o => o.outputId === output.id);
      if (!p || !Array.isArray(p.gain) || p.gain.length !== 3 || p.gain.some(v => !Number.isFinite(v) || v <= 0 || v > 1) ||
          [p.black, p.lut].some(ref => !ref || ref.format !== 'rgba32_float' || !/^[a-f0-9]{64}$/.test(ref.sha256 || '')) ||
          p.black.width !== output.resolution.width || p.black.height !== output.resolution.height ||
          p.black.byteLength !== p.black.width * p.black.height * 16 || p.lut.size !== 33 || p.lut.byteLength !== 33 ** 3 * 16) throw new Error('Invalid USB correction artifacts');
      output.blackUniformity = { ...output.blackUniformity, enabled: true, lift: 0, map: structuredClone(p.black) };
      output.color = { ...output.color, gain: p.gain, gamma: [1, 1, 1], offset: [0, 0, 0], lut: structuredClone(p.lut) };
    }
  }
  return result;
}
