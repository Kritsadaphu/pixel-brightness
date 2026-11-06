import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NdiVideoTransport } from '../node/ndi-video-transport.mjs';
import { normalizeOutputConfig } from '../shared/mapping.mjs';
import { HttpError } from './errors.mjs';
import { prepareNdiCorrectionAssets } from './ndi-correction-assets.mjs';

const exec = promisify(execFile);
const invalid = message => new HttpError(400, 'ndi_video_plan', message);
export function projectNdiVideoPlan(project, request, source, { resolveAssets = false } = {}) {
  if (!request || Object.keys(request).some(k => !['expectedRevision', 'sourceName', 'outputIds'].includes(k))) throw invalid('Only revision, sourceName and outputIds are accepted');
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision !== project.revision) throw new HttpError(409, 'ndi_video_revision', 'Save/reload the current project before starting NDI');
  if (typeof request.sourceName !== 'string' || !request.sourceName || request.sourceName.length > 256) throw invalid('Exact NDI source name required');
  if (!Array.isArray(request.outputIds) || !request.outputIds.length || request.outputIds.length > 5 || new Set(request.outputIds).size !== request.outputIds.length) throw invalid('Select 1-5 unique saved outputs');
  if (!source || source.name !== request.sourceName || !source.address) throw invalid('Choose one currently discovered source');
  const outputs = request.outputIds.map(id => {
    const saved = project.outputs?.find(o => o.id === id);
    if (!saved || saved.enabled === false) throw invalid('Output is missing or disabled');
    const o = normalizeOutputConfig(saved);
    if (!resolveAssets && (o.blend.map || o.blackUniformity.map || o.mask.map || o.color.lut)) throw invalid('A correction asset resolver is required; existing maps will not be silently discarded');
    if (o.resolution.width % 2 || o.resolution.width > 4096 || o.resolution.height > 2160) throw invalid('NDI output needs an even width and at most 4096 x 2160');
    return { id: o.id, enabled: true, resolution: o.resolution, sourceViewport: o.sourceViewport,
      processing: { bypass: o.processing?.bypass === true }, overlap: o.overlap, warp: o.warp,
      blend: o.blend, blackUniformity: o.blackUniformity, color: o.color,
      mask: o.mask };
  });
  return { source: { name: source.name, address: source.address, timeoutMs: 1000,
    sourceIsSrgb: project.compositionSource?.colorEncoding !== 'linear' }, canvas: structuredClone(project.canvas), outputs };
}

/** Main-server local NDI preview. Uses a fixed saved project revision and unique
 * sender names, starts black, and never changes external receiver routing. */
export class NdiVideoControl {
  #transport; #operation; #timer; #closed = false; #job = null; #assets;
  constructor({ getProject, command, probeCommand, runtimeDirectory, shaderDirectory, assetDirectory, discover, inspectSource, transportFactory, pollMs = 1000 }) {
    this.getProject = getProject; this.pollMs = pollMs;
    this.assetDirectory = assetDirectory;
    if (!discover && (!isAbsolute(probeCommand) || !isAbsolute(runtimeDirectory))) throw invalid('Absolute server-configured probe/runtime required');
    this.discover = discover || (async () => {
      const { stdout } = await exec(probeCommand, ['--list'], { windowsHide: true, timeout: 12000, maxBuffer: 1024 * 1024,
        env: { ...process.env, PATH: runtimeDirectory + (process.platform === 'win32' ? ';' : ':') + process.env.PATH } });
      const value = JSON.parse(stdout);
      if (value.schema !== 'pb-ndi-probe-v1' || !Array.isArray(value.sources)) throw new Error('Invalid NDI discovery result');
      return value.sources;
    });
    this.transportFactory = transportFactory || (() => new NdiVideoTransport({ command, runtimeDirectory, shaderDirectory, assetDirectory, timeoutMs: 15000 }));
    this.inspectSource = inspectSource || (probeCommand && runtimeDirectory ? async name => {
      const { stdout } = await exec(probeCommand, ['--receive', name], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
        env: { ...process.env, PATH: runtimeDirectory + (process.platform === 'win32' ? ';' : ':') + process.env.PATH } });
      return JSON.parse(stdout).receive;
    } : null);
  }
  snapshot() { return { enabled: true, mode: 'local-ndi-video-preview', productionAutoReady: false, job: structuredClone(this.#job) }; }
  async #exclusive(action) {
    if (this.#closed) throw new HttpError(503, 'ndi_closing', 'NDI controller is closing');
    if (this.#operation) throw new HttpError(409, 'ndi_busy', 'NDI operation is still in progress');
    const promise = Promise.resolve().then(action); this.#operation = promise;
    try { return await promise; } finally { if (this.#operation === promise) this.#operation = undefined; }
  }
  async sources() { return this.#exclusive(async () => ({ sources: await this.discover() })); }
  async start(request) {
    return this.#exclusive(async () => {
      if (this.#transport) throw new HttpError(409, 'ndi_running', 'Stop the previous NDI preview before starting another');
      const project = structuredClone(this.getProject());
      // Validate shape/revision before invoking discovery or spawning anything.
      projectNdiVideoPlan(project, request, { name: request?.sourceName, address: 'preflight' }, { resolveAssets: Boolean(this.assetDirectory) });
      const found = (await this.discover()).filter(s => s.name === request.sourceName);
      if (found.length !== 1) throw invalid('Source name is missing or ambiguous');
      let plan = projectNdiVideoPlan(this.getProject(), request, found[0], { resolveAssets: Boolean(this.assetDirectory) });
      if (this.inspectSource) {
        const received = await this.inspectSource(found[0].name);
        const formats = received?.formats;
        if (received?.sourceName !== found[0].name || received?.sourceAddress !== found[0].address
            || !(received?.receivedFrames > 0) || formats?.length !== 1)
          throw invalid('NDI source has no stable, identity-matched video frames. Outputs were not started.');
        const f = formats[0], c = plan.canvas;
        if (f.width !== c.width || f.height !== c.height || !(f.fpsNumerator > 0) || !(f.fpsDenominator > 0)
            || f.fpsNumerator * c.frameRateDen !== c.frameRateNum * f.fpsDenominator)
          throw invalid(`NDI source is ${f.width}x${f.height} at ${f.fpsNumerator}/${f.fpsDenominator} fps; saved canvas is ${c.width}x${c.height} at ${c.frameRateNum}/${c.frameRateDen} fps. Match the settings before starting.`);
        if (this.#closed || this.getProject().revision !== project.revision)
          throw invalid('Project changed during NDI source preflight. Reload before starting.');
      }
      const job = { id: randomUUID(), state: 'starting', revision: project.revision,
        expectedFps: plan.canvas.frameRateNum / plan.canvas.frameRateDen,
        startedAt: new Date().toISOString(), sources: [], physicalOutputVerified: false };
      this.#job = job;
      const transport = this.transportFactory(); this.#transport = transport;
      try {
        if (this.assetDirectory) {
          this.#assets = await prepareNdiCorrectionAssets(plan, { root: this.assetDirectory });
          plan = this.#assets.plan; job.correctionAssetBytes = this.#assets.bytes;
        }
        if (this.#closed || this.getProject().revision !== job.revision) throw new Error('Project changed while resolving corrections');
        const ready = await transport.begin(plan);
        job.sources = ready.sources; job.adapter = ready.adapter ?? null; job.state = 'black';
        if (this.#closed || this.getProject().revision !== job.revision) throw new Error('Project changed during NDI startup');
        this.#schedule(); return this.snapshot();
      } catch (e) {
        job.state = 'failed'; job.error = e.message;
        try { await transport.end(); } catch (cleanup) { job.cleanupError = cleanup.message; }
        await this.#assets?.cleanup(); this.#assets = undefined;
        this.#transport = undefined; throw e;
      }
    });
  }
  #schedule() {
    clearTimeout(this.#timer);
    if (this.#closed || !this.#transport) return;
    this.#timer = setTimeout(() => {
      if (this.#operation) { this.#schedule(); return; }
      void this.#exclusive(async () => {
        const transport = this.#transport;
        if (!transport) return;
        try {
          if (this.getProject().revision !== this.#job.revision) {
            await transport.setBlank(true); this.#job.state = 'revision-changed';
          }
          this.#job.telemetry = await transport.status();
          this.#job.updatedAt = new Date().toISOString();
        } catch (e) {
          this.#job.state = 'failed'; this.#job.error = e.message;
          try { await transport.end(); } catch (cleanup) { this.#job.cleanupError = cleanup.message; }
          await this.#assets?.cleanup(); this.#assets = undefined;
          this.#transport = undefined;
        }
      }).catch(() => {}).finally(() => this.#schedule());
    }, this.pollMs);
    this.#timer.unref?.();
  }
  async blank(id, blank) {
    // Operator commands must not randomly lose to a telemetry poll.
    await this.#operation?.catch(() => {});
    return this.#exclusive(async () => {
      if (!this.#transport || this.#job?.id !== id) throw new HttpError(409, 'ndi_job', 'No matching active preview');
      if (typeof blank !== 'boolean') throw invalid('blank must be boolean');
      if (!blank && this.getProject().revision !== this.#job.revision) throw new HttpError(409, 'ndi_video_revision', 'Project changed: stop/restart with the saved revision');
      await this.#transport.setBlank(blank); this.#job.state = blank ? 'black' : 'sending';
      return this.snapshot();
    });
  }
  async stop(id) {
    await this.#operation?.catch(() => {});
    return this.#exclusive(async () => {
      if (!this.#transport || this.#job?.id !== id) throw new HttpError(409, 'ndi_job', 'No matching active preview');
      await this.#stop(); return this.snapshot();
    });
  }
  async #stop() {
    clearTimeout(this.#timer); const transport = this.#transport;
    if (!transport) return;
    try { this.#job.endResult = await transport.end(); this.#job.state = 'stopped'; }
    catch (e) { this.#job.state = 'failed'; this.#job.error = e.message; throw e; }
    finally { this.#transport = undefined; await this.#assets?.cleanup(); this.#assets = undefined; this.#job.finishedAt = new Date().toISOString(); this.#job.restorationRequired = true; }
  }
  async close() { this.#closed = true; clearTimeout(this.#timer); await this.#operation?.catch(() => {}); await this.#stop(); }
}
