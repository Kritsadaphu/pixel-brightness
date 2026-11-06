import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGridPattern } from "../shared/calibration.mjs";
import { normalizeOutputConfig } from "../shared/mapping.mjs";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SHADER_DIRECTORY = join(MODULE_DIRECTORY, "shaders");

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

// normalizeOutputConfig already validated the mesh. Sampling it directly here
// avoids allocating/cloning up to 16,641 points for every diagnostic probe.
function sampleNormalizedMesh(mesh, uInput, vInput) {
  const u = clamp(uInput);
  const v = clamp(vInput);
  const gx = u * mesh.columns;
  const gy = v * mesh.rows;
  const column = Math.min(mesh.columns - 1, Math.floor(gx));
  const row = Math.min(mesh.rows - 1, Math.floor(gy));
  const tx = gx - column;
  const ty = gy - row;
  const stride = mesh.columns + 1;
  const p00 = mesh.points[row * stride + column];
  const p10 = mesh.points[row * stride + column + 1];
  const p01 = mesh.points[(row + 1) * stride + column];
  const p11 = mesh.points[(row + 1) * stride + column + 1];
  const mix = (a, b, amount) => a + (b - a) * amount;
  return {
    x: mix(mix(p00.x, p10.x, tx), mix(p01.x, p11.x, tx), ty),
    y: mix(mix(p00.y, p10.y, tx), mix(p01.y, p11.y, tx), ty),
  };
}

function mergeNested(physical, mapped) {
  const merged = { ...physical, ...mapped };
  for (const key of ["resolution", "sourceViewport", "overlap", "warp", "blend", "blackUniformity", "mask", "color"]) {
    merged[key] = { ...(physical?.[key] || {}), ...(mapped?.[key] || {}) };
  }
  // Connector selection belongs to the physical node even when mapping is
  // imported from another machine.
  merged.connector = physical?.connector || mapped?.connector;
  return merged;
}

function polygonContains(path, x, y) {
  if (!Array.isArray(path) || path.length < 3) return true;
  let inside = false;
  for (let current = 0, previous = path.length - 1; current < path.length; previous = current, current += 1) {
    const a = path[current];
    const b = path[previous];
    const crosses = (a.y > y) !== (b.y > y)
      && x < (b.x - a.x) * (y - a.y) / ((b.y - a.y) || Number.EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= Number.EPSILON) return Math.hypot(point.x - start.x, point.y - start.y);
  const amount = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared);
  return Math.hypot(point.x - (start.x + amount * dx), point.y - (start.y + amount * dy));
}

function maskWeight(mask, u, v) {
  if (!mask?.enabled || !Array.isArray(mask.path) || mask.path.length < 3) return 1;
  const inside = polygonContains(mask.path, u, v);
  if (!mask.softness) return inside ? 1 : 0;
  let edgeDistance = Infinity;
  for (let index = 0; index < mask.path.length; index += 1) {
    edgeDistance = Math.min(edgeDistance, distanceToSegment(
      { x: u, y: v },
      mask.path[index],
      mask.path[(index + 1) % mask.path.length],
    ));
  }
  const soft = clamp(edgeDistance / mask.softness);
  return inside ? soft : 0;
}

function sampleScalarMap(map, uInput, vInput) {
  if (typeof map === "number") return clamp(map);
  const values = map?.values || map?.data;
  const width = Math.round(Number(map?.width));
  const height = Math.round(Number(map?.height));
  if (!values || !Number.isFinite(width) || !Number.isFinite(height)
    || width < 1 || height < 1 || values.length < width * height) return 1;
  const x = clamp(uInput) * (width - 1);
  const y = clamp(vInput) * (height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const mix = (a, b, amount) => a + (b - a) * amount;
  const p00 = clamp(values[y0 * width + x0]);
  const p10 = clamp(values[y0 * width + x1]);
  const p01 = clamp(values[y1 * width + x0]);
  const p11 = clamp(values[y1 * width + x1]);
  return mix(mix(p00, p10, tx), mix(p01, p11, tx), ty);
}

function edgeRamp(pixelsFromEdge, overlapPixels, feather, gamma) {
  if (overlapPixels <= 0) return 1;
  const normalized = clamp(pixelsFromEdge / overlapPixels);
  const t = clamp(normalized / Math.max(feather, 0.0001));
  const smooth = t * t * (3 - 2 * t);
  return Math.pow(smooth, Math.max(gamma, 0.0001));
}

function blendWeight(output, u, v) {
  if (!output.blend.enabled) return 1;
  const { width, height } = output.resolution;
  return clamp(
    edgeRamp(u * width, output.overlap.left, output.blend.feather, output.blend.gamma)
    * edgeRamp((1 - u) * width, output.overlap.right, output.blend.feather, output.blend.gamma)
    * edgeRamp(v * height, output.overlap.top, output.blend.feather, output.blend.gamma)
    * edgeRamp((1 - v) * height, output.overlap.bottom, output.blend.feather, output.blend.gamma),
  );
}

function deterministicSource(frame, u, v, seed, mode = "content", output = null, cellSize = 32) {
  if (mode === "black") return [0, 0, 0];
  if (mode === "white") return [1, 1, 1];
  if (mode === "blue") return [0, 0.25, 1];
  if (mode === "gray" || mode === "grey") return [0.18, 0.18, 0.18];
  if (mode === "grid" || mode === "identify") {
    const pixelX = Math.min(output.resolution.width - 1, Math.floor(u * output.resolution.width));
    const pixelY = Math.min(output.resolution.height - 1, Math.floor(v * output.resolution.height));
    const gridX = pixelX % cellSize < 2;
    const gridY = pixelY % cellSize < 2;
    if (gridX || gridY) return mode === "identify" ? [0, 0.72, 1] : [0.82, 0.88, 0.94];
    return [0.01, 0.015, 0.02];
  }
  const phase = Number(BigInt(frame) % 216_000n) / 60;
  return [
    0.5 + 0.5 * Math.sin(phase * 0.71 + u * 5.3 + seed),
    0.5 + 0.5 * Math.sin(phase * 0.83 + v * 7.1 + seed * 0.7),
    0.5 + 0.5 * Math.sin(phase * 0.47 + (u + v) * 4.7 + seed * 1.3),
  ];
}

function outputSeed(output) {
  let result = 0;
  for (const character of `${output.id}:${output.connector}`) result = (result * 31 + character.charCodeAt(0)) >>> 0;
  return (result % 10_000) / 1_591.549;
}

function evaluatePipeline(output, frame, probeColumns = 9, probeRows = 6, sourceMode = "content", cellSize = 32) {
  const digest = createHash("sha256");
  const minimum = [1, 1, 1];
  const maximum = [0, 0, 0];
  const sum = [0, 0, 0];
  const seed = outputSeed(output);
  let clipped = 0;
  let masked = 0;
  let count = 0;
  for (let row = 0; row < probeRows; row += 1) {
    for (let column = 0; column < probeColumns; column += 1) {
      const u = probeColumns === 1 ? 0.5 : column / (probeColumns - 1);
      const v = probeRows === 1 ? 0.5 : row / (probeRows - 1);
      const warped = sampleNormalizedMesh(output.warp, u, v);
      const blend = blendWeight(output, warped.x, warped.y);
      const mask = maskWeight(output.mask, warped.x, warped.y);
      if (mask === 0) masked += 1;
      const canvas = output.masterCanvas || output.resolution;
      const sourceU = (output.sourceViewport.x + u * output.sourceViewport.width) / canvas.width;
      const sourceV = (output.sourceViewport.y + v * output.sourceViewport.height) / canvas.height;
      const pattern = sourceMode !== "content";
      const source = deterministicSource(
        frame,
        pattern ? u : sourceU,
        pattern ? v : sourceV,
        seed,
        sourceMode,
        output,
        cellSize,
      );
      const hasBlackMap = output.blackUniformity.map != null;
      const blackLift = output.blackUniformity.enabled
        ? (hasBlackMap
          ? sampleScalarMap(output.blackUniformity.map, warped.x, warped.y)
          : output.blackUniformity.lift)
        : 0;
      const rgb = source.map((channel, index) => {
        const linear = channel * blend + blackLift;
        const corrected = Math.pow(
          Math.max(0, linear * output.color.gain[index] + output.color.offset[index]),
          1 / output.color.gamma[index],
        ) * mask;
        if (corrected > 1) clipped += 1;
        return clamp(corrected);
      });
      for (let channel = 0; channel < 3; channel += 1) {
        minimum[channel] = Math.min(minimum[channel], rgb[channel]);
        maximum[channel] = Math.max(maximum[channel], rgb[channel]);
        sum[channel] += rgb[channel];
      }
      digest.update(`${sourceU.toFixed(6)},${sourceV.toFixed(6)}>${warped.x.toFixed(6)},${warped.y.toFixed(6)}:${rgb.map((value) => value.toFixed(6)).join(",")};`);
      count += 1;
    }
  }
  return {
    signature: digest.digest("hex").slice(0, 16),
    probes: count,
    rgbMinimum: minimum,
    rgbMaximum: maximum,
    rgbAverage: sum.map((value) => value / count),
    clippedChannels: clipped,
    fullyMaskedProbes: masked,
  };
}

export class ShaderBundle {
  constructor({ vertex, fragment, hash }) {
    this.vertex = vertex;
    this.fragment = fragment;
    this.hash = hash;
  }

  static async load(directory = SHADER_DIRECTORY) {
    const [vertex, fragment] = await Promise.all([
      readFile(join(directory, "mesh.vert"), "utf8"),
      readFile(join(directory, "pipeline.frag"), "utf8"),
    ]);
    ShaderBundle.validate(vertex, fragment);
    const hash = createHash("sha256").update(vertex).update("\0").update(fragment).digest("hex");
    return new ShaderBundle({ vertex, fragment, hash });
  }

  static validate(vertex, fragment) {
    const vertexTokens = ["#version", "aSourceUv", "aOutputPosition", "gl_Position"];
    const fragmentTokens = [
      "#version", "uSourceRect", "uOverlapPixels", "uBlackLiftMap", "uColorLut",
      "uMaskMap", "edgeBlendWeight", "applyColorPipeline", "clamp",
    ];
    for (const token of vertexTokens) if (!vertex.includes(token)) throw new Error(`Vertex shader is missing ${token}`);
    for (const token of fragmentTokens) if (!fragment.includes(token)) throw new Error(`Fragment shader is missing ${token}`);
    for (const [name, source] of [["vertex", vertex], ["fragment", fragment]]) {
      let depth = 0;
      for (const character of source) {
        if (character === "{") depth += 1;
        if (character === "}") depth -= 1;
        if (depth < 0) throw new Error(`${name} shader contains unmatched braces`);
      }
      if (depth !== 0) throw new Error(`${name} shader contains unmatched braces`);
    }
  }
}

/** Adapter contract for future OpenGL/Vulkan/Metal/NDI output implementations. */
export class OutputAdapter {
  constructor({ output, shaders }) {
    this.output = normalizeOutputConfig(output);
    this.shaders = shaders;
  }

  async start() {}
  async apply(output) { this.output = normalizeOutputConfig(output); }
  renderFrame() { throw new Error("OutputAdapter.renderFrame must be implemented"); }
  async stop() {}
  diagnostics() { return { id: this.output.id, connector: this.output.connector }; }
}

export class SimulatorOutputAdapter extends OutputAdapter {
  constructor(options) {
    super(options);
    this.metrics = {
      framesRendered: 0,
      droppedFrames: 0,
      repeatedFrames: 0,
      lateFrames: 0,
      lastFrame: null,
      lastSignature: null,
      maximumLatenessNs: 0n,
      renderTimeNs: 0n,
    };
    this.lastEvaluation = null;
    this.mode = "content";
    this.pattern = null;
    this.patternCellSize = 32;
  }

  renderFrame(frame, context = {}) {
    const started = process.hrtime.bigint();
    const current = BigInt(frame);
    if (this.metrics.lastFrame === null && context.baseFrame != null && current > BigInt(context.baseFrame)) {
      this.metrics.droppedFrames += Number(current - BigInt(context.baseFrame));
    } else if (this.metrics.lastFrame !== null) {
      const previous = BigInt(this.metrics.lastFrame);
      if (current === previous) this.metrics.repeatedFrames += 1;
      else if (current > previous + 1n) this.metrics.droppedFrames += Number(current - previous - 1n);
    }
    const latenessNs = context.deadlineNs == null ? 0n : BigInt(context.nowNs) - BigInt(context.deadlineNs);
    if (latenessNs > 1_000_000n) this.metrics.lateFrames += 1;
    if (latenessNs > this.metrics.maximumLatenessNs) this.metrics.maximumLatenessNs = latenessNs;

    const evaluatedFrame = this.mode === "content" ? current : 0n;
    this.lastEvaluation = evaluatePipeline(this.output, evaluatedFrame, 9, 6, this.mode, this.patternCellSize);
    if (this.mode !== "content") {
      this.lastEvaluation.pattern = this.mode;
      this.lastEvaluation.patternBytes = this.pattern?.byteLength || 0;
    }
    this.metrics.framesRendered += 1;
    this.metrics.lastFrame = current;
    this.metrics.lastSignature = this.lastEvaluation.signature;
    this.metrics.renderTimeNs = process.hrtime.bigint() - started;
    return this.lastEvaluation;
  }

  setPattern(mode, options = {}) {
    this.mode = mode || "content";
    this.patternCellSize = Math.max(2, Math.min(2_048, Math.round(Number(options.cellSize) || 32)));
    if (this.mode === "grid" || this.mode === "identify") {
      // The simulator validates the exact grid generator with a bounded preview;
      // a GPU adapter generates it procedurally at native output resolution.
      this.pattern = createGridPattern({
        width: Math.min(this.output.resolution.width, 512),
        height: Math.min(this.output.resolution.height, 512),
        cellSize: this.patternCellSize,
        lineWidth: options.lineWidth || 1,
      });
    } else {
      this.pattern = null;
    }
  }

  resetCadence() {
    this.metrics.lastFrame = null;
  }

  diagnostics() {
    const metrics = {
      ...this.metrics,
      lastFrame: this.metrics.lastFrame?.toString() ?? null,
      maximumLatenessNs: this.metrics.maximumLatenessNs.toString(),
      renderTimeNs: this.metrics.renderTimeNs.toString(),
    };
    return {
      id: this.output.id,
      name: this.output.name,
      connector: this.output.connector,
      enabled: this.output.enabled,
      backend: "deterministic-simulator",
      mode: this.mode,
      resolution: this.output.resolution,
      mesh: { columns: this.output.warp.columns, rows: this.output.warp.rows, points: this.output.warp.points.length },
      pipeline: {
        crop: this.output.sourceViewport,
        overlap: this.output.overlap,
        blend: this.output.blend,
        blackUniformity: {
          enabled: this.output.blackUniformity.enabled,
          lift: this.output.blackUniformity.lift,
          mapLoaded: Boolean(this.output.blackUniformity.map),
        },
        mask: { enabled: this.output.mask.enabled, points: this.output.mask.path?.length || 0, softness: this.output.mask.softness },
        color: {
          gain: this.output.color.gain,
          offset: this.output.color.offset,
          gamma: this.output.color.gamma,
          lutLoaded: Boolean(this.output.color.lut),
        },
      },
      metrics,
      evaluation: this.lastEvaluation,
      shaderHash: this.shaders.hash,
    };
  }
}

export class RenderEngine {
  constructor({ nodeId, physicalOutputs, log = () => {}, adapterFactory } = {}) {
    this.nodeId = nodeId;
    this.physicalOutputs = physicalOutputs || [];
    this.log = log;
    this.adapterFactory = adapterFactory || ((options) => new SimulatorOutputAdapter(options));
    this.adapters = new Map();
    this.shaders = null;
    this.project = null;
    this.preparedAssets = [];
  }

  async initialize() {
    this.shaders = await ShaderBundle.load();
    this.log("info", "render.shaders.valid", { sha256: this.shaders.hash });
  }

  resolveOutputs(project) {
    const projectOutputs = project?.outputs || [];
    const consumed = new Set();
    const resolved = [];
    for (const physical of this.physicalOutputs) {
      const mapped = projectOutputs.find((output) => output.id === physical.id)
        || projectOutputs.find((output) => output.connector === physical.connector);
      if (mapped && mapped.nodeId && mapped.nodeId !== this.nodeId) continue;
      if (mapped) consumed.add(mapped.id);
      resolved.push({
        ...normalizeOutputConfig(mergeNested(physical, mapped || { id: physical.id })),
        masterCanvas: project.canvas,
      });
    }
    // Explicit assignment permits server-generated virtual/output adapters even
    // when the connector was not present in the boot config.
    for (const mapped of projectOutputs) {
      if (mapped.nodeId === this.nodeId && !consumed.has(mapped.id)) {
        resolved.push({ ...normalizeOutputConfig(mapped), masterCanvas: project.canvas });
      }
    }
    return resolved;
  }

  async configure(project) {
    if (!this.shaders) await this.initialize();
    this.project = project;
    const outputs = this.resolveOutputs(project);
    const wanted = new Set(outputs.map((output) => output.id));
    for (const [id, adapter] of this.adapters) {
      if (!wanted.has(id)) {
        await adapter.stop();
        this.adapters.delete(id);
      }
    }
    for (const output of outputs) {
      const existing = this.adapters.get(output.id);
      if (existing) await existing.apply(output);
      else {
        const adapter = this.adapterFactory({ output, shaders: this.shaders });
        await adapter.start();
        this.adapters.set(output.id, adapter);
      }
    }
    this.log("info", "render.outputs.configured", { outputs: outputs.map(({ id, connector }) => ({ id, connector })) });
    return this.diagnostics();
  }

  async prepare({ assets = [] } = {}) {
    this.preparedAssets = assets.map((asset) => asset.sha256);
    for (const adapter of this.adapters.values()) adapter.resetCadence?.();
    return this.diagnostics();
  }

  renderFrame(frame, context) {
    const results = [];
    for (const adapter of this.adapters.values()) {
      if (adapter.output.enabled) results.push({ outputId: adapter.output.id, ...adapter.renderFrame(frame, context) });
    }
    return results;
  }

  async applyOutput(output) {
    if (!output?.id) throw new Error("Output id is required");
    const existing = this.adapters.get(String(output.id));
    const baseline = existing?.output
      || this.project?.outputs?.find((candidate) => candidate.id === String(output.id))
      || this.physicalOutputs.find((candidate) => candidate.id === String(output.id))
      || { id: String(output.id) };
    const normalized = {
      ...normalizeOutputConfig(mergeNested(baseline, output)),
      masterCanvas: this.project?.canvas || baseline.masterCanvas,
    };
    if (existing) await existing.apply(normalized);
    else {
      const adapter = this.adapterFactory({ output: normalized, shaders: this.shaders });
      await adapter.start();
      this.adapters.set(normalized.id, adapter);
    }
    return this.diagnostics();
  }

  setPattern({ outputId = null, type = "grid", ...options } = {}) {
    for (const [id, adapter] of this.adapters) {
      if (!outputId || outputId === id) adapter.setPattern?.(type, options);
    }
  }

  clearPattern(outputId = null) {
    this.setPattern({ outputId, type: "content" });
  }

  async blank(enabled = true, outputId = null) {
    if (enabled) this.setPattern({ outputId, type: "black" });
    else this.clearPattern(outputId);
    return {
      mode: enabled ? "black" : "content",
      failClosed: enabled,
      outputId,
    };
  }

  async restart() {
    const project = this.project;
    await this.stop();
    this.shaders = await ShaderBundle.load();
    if (project) await this.configure(project);
  }

  async stop() {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.stop()));
    this.adapters.clear();
  }

  diagnostics() {
    const outputs = [...this.adapters.values()].map((adapter) => adapter.diagnostics());
    return {
      backend: "deterministic-simulator",
      shaderHash: this.shaders?.hash || null,
      preparedAssetSha256: [...this.preparedAssets],
      outputs,
      framesRendered: outputs.reduce((sum, output) => sum + output.metrics.framesRendered, 0),
      droppedFrames: outputs.reduce((sum, output) => sum + output.metrics.droppedFrames, 0),
      repeatedFrames: outputs.reduce((sum, output) => sum + output.metrics.repeatedFrames, 0),
      lateFrames: outputs.reduce((sum, output) => sum + output.metrics.lateFrames, 0),
    };
  }
}
