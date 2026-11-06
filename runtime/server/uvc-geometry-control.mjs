import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { UvcCamera } from '../node/uvc-camera.mjs';
import { NdiPatternTransport } from '../node/ndi-pattern-transport.mjs';
import { UvcGeometrySession, geometryPlan } from '../node/uvc-geometry-session.mjs';
import { HttpError } from './errors.mjs';
import { projectGeometryTargets, applyGeometryCandidate } from './uvc-geometry-apply.mjs';
import { geometryBlendOutputs, rasterizeGeometryBlend } from '../node/geometry-blend.mjs';
import { prepareNdiCorrectionAssets } from './ndi-correction-assets.mjs';
import { solveUvcPhotometry, photometryBlackRaster } from '../node/uvc-photometry.mjs';

/** Local Windows acquisition attached to the control server, not a remote-node
 * RAW adapter. All executable paths come from server configuration, never HTTP. */
export class UvcGeometryControl {
  #run; #latest = null; #closed = false; #applying = false; #completed;
  constructor({ dataDir, cameraCommand, patternCommand, runtimeDirectory, camera,
    transportFactory, sessionFactory, routingTimeoutMs = 120000, getProject, saveProject, canApply = () => true, receiverRouting }) {
    this.dataDir = dataDir; this.root = join(dataDir, 'uvc-geometry');
    this.camera = camera || new UvcCamera({ command: cameraCommand });
    this.transportFactory = transportFactory || (() => new NdiPatternTransport({ command: patternCommand, runtimeDirectory }));
    this.sessionFactory = sessionFactory || (options => new UvcGeometrySession(options));
    this.routingTimeoutMs = routingTimeoutMs;
    this.getProject = getProject; this.saveProject = saveProject; this.canApply = canApply;
    this.receiverRouting = receiverRouting;
  }
  snapshot() {
    const job = this.#latest ? structuredClone(this.#latest) : null;
    if (job && this.#run?.job === this.#latest && job.state === 'candidate-not-applied') {
      job.state = 'finalizing'; job.applyAvailable = false;
    }
    return { enabled: true, mode: 'local-uvc-geometry-candidate', productionAutoReady: false,
      routing: this.receiverRouting?.snapshot() ?? { enabled: false, outputIds: [], pendingRecovery: false },
      job };
  }
  async devices() {
    if (this.#closed) throw new HttpError(503, 'uvc_closing', 'Server is closing');
    if (this.#run) throw new HttpError(409, 'uvc_busy', 'Geometry acquisition owns the camera');
    return { devices: await this.camera.list() };
  }
  async controls(deviceId) {
    if (this.#closed) throw new HttpError(503, 'uvc_closing', 'Server is closing');
    if (this.#run) throw new HttpError(409, 'uvc_busy', 'Geometry acquisition owns the camera');
    if (typeof this.camera.controls !== 'function') throw new HttpError(503, 'uvc_controls_unavailable', 'Camera control inspection is unavailable');
    if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 4096 || deviceId.includes('\0')) throw new HttpError(400, 'uvc_device', 'Select an exact USB camera');
    return this.camera.controls(deviceId);
  }
  async start(input) {
    if (this.#closed) throw new HttpError(503, 'uvc_closing', 'Server is closing');
    if (this.#run || this.#applying) throw new HttpError(409, 'uvc_busy', 'A geometry job is already running');
    const allowed = new Set(['deviceId', 'outputs', 'settleMs', 'contrast', 'sampleStride', 'expectedRevision', 'targetArea', 'autoBlend', 'autoRoute', 'autoPhotometry', 'cameraResponse', 'cameraSettingsLocked']);
    if (!input || Object.keys(input).some(k => !allowed.has(k))) throw new HttpError(400, 'uvc_invalid_plan', 'Only geometry plan fields are accepted');
    let plan, base;
    try {
      if (input.autoRoute != null && typeof input.autoRoute !== 'boolean') throw new Error('autoRoute must be boolean');
      if (this.receiverRouting?.snapshot().pendingRecovery) throw new Error('Restore pending receiver sources first');
      if (input.targetArea) {
        if (!this.getProject || !this.saveProject) throw new Error('Project application is not configured');
        base = structuredClone(this.getProject());
        if (input.expectedRevision !== base.revision) throw new Error('Save/reload the current project before calibration');
        plan = geometryPlan({ ...input, outputs: projectGeometryTargets(base, input.outputs, input.targetArea) });
      } else plan = geometryPlan(input);
      if (plan.autoBlend) {
        if (!base) throw new Error('Auto Blend requires a saved project and shared camera target area');
        geometryBlendOutputs({ ...base, outputs: base.outputs.map(o => ({ ...o, warp: { ...o.warp, enabled: true } })) }, plan.outputs.map(o => o.id));
      }
      if (plan.autoPhotometry && plan.outputs.reduce((sum, o) => sum + o.width * o.height * 20 + 33 ** 3 * 16, 0) > 256 * 1024 * 1024) throw new Error('USB correction maps exceed the 256 MiB native asset budget');
      plan.autoRoute = input.autoRoute === true;
      if (plan.autoRoute && (!this.receiverRouting?.snapshot().enabled || plan.outputs.some(o => !this.receiverRouting.snapshot().outputIds.includes(o.id)))) throw new Error('Receiver profiles must be configured for every selected output');
    } catch (e) { throw new HttpError(400, 'uvc_invalid_plan', e.message); }
    const job = { id: randomUUID(), state: 'preflight', startedAt: new Date().toISOString(),
      sources: [], completedCaptures: 0, candidateApplied: false, physicalOutputVerified: false };
    const run = { job, plan, base, abort: new AbortController(), routingConfirmed: false, task: null };
    this.#run = run; this.#latest = job;
    try {
      const devices = await this.camera.list({ signal: run.abort.signal });
      if (!devices.some(d => d.id === plan.deviceId)) throw new HttpError(409, 'uvc_camera_missing', 'Selected USB camera is not connected');
      run.abort.signal.throwIfAborted();
      run.directory = join(this.root, job.id);
      await mkdir(this.root, { recursive: true }); await mkdir(run.directory);
      await writeFile(join(run.directory, 'plan.json'), JSON.stringify(plan, null, 2), { flag: 'wx' });
      run.transport = this.transportFactory();
      run.task = this.#execute(run);
      return this.snapshot();
    } catch (e) {
      job.state = 'failed'; job.error = e.message; this.#run = null; throw e;
    }
  }
  async #execute(run) {
    const { job, plan, abort, transport, directory } = run;
    const artifacts = [];
    const patterns = {
      begin: async (value, options) => {
        const receipt = await transport.begin(value, options);
        job.sources = receipt.sources; job.state = 'awaiting-routing';
        if (plan.autoRoute) {
          job.state = 'routing-receivers';
          await this.receiverRouting.route(job.id, receipt.sources);
          for (let attempt = 0; attempt < 25; attempt++) {
            abort.signal.throwIfAborted();
            const status = await transport.status();
            if (plan.outputs.every(o => status.connections?.some(c => c.outputId === o.id && c.connections > 0))) { run.routingConfirmed = true; break; }
            await delay(200, undefined, { signal: abort.signal });
          }
          if (!run.routingConfirmed) throw new Error('Automatic receiver routing has no confirmed NDI connection');
          job.routingReadbackVerified = true;
        }
        const deadline = Date.now() + this.routingTimeoutMs;
        while (!run.routingConfirmed) {
          if (Date.now() >= deadline) throw new Error('Receiver routing confirmation timed out');
          await delay(100, undefined, { signal: abort.signal });
        }
        abort.signal.throwIfAborted(); return receipt;
      },
      show: (...args) => transport.show(...args),
      end: async () => {
        const errors = []; let result;
        try { result = await transport.end(); } catch (e) { errors.push(e); }
        if (plan.autoRoute && this.receiverRouting.snapshot().jobId === job.id) {
          try { await this.receiverRouting.restore(job.id); job.routingRestored = true; } catch (e) { errors.push(e); }
        }
        if (errors.length) throw new AggregateError(errors, 'Pattern/receiver cleanup failed; recovery required');
        return result;
      },
    };
    try {
      const result = await this.sessionFactory({ camera: this.camera, patterns }).run(plan, {
        signal: abort.signal,
        onProgress(value) { job.state = 'capturing'; job.completedCaptures = value.completedCaptures; job.outputId = value.outputId; job.pattern = value.pattern; },
        async onOutput({ outputId, map, mesh }) {
          const files = {};
          for (const field of ['projectorX', 'projectorY', 'confidence']) {
            const values = map[field], bytes = Buffer.alloc(values.length * 4);
            for (let i = 0; i < values.length; i++) {
              if (field === 'confidence') bytes.writeFloatLE(values[i], i * 4); else bytes.writeInt32LE(values[i], i * 4);
            }
            const file = `${outputId}-${field}.bin`;
            await writeFile(join(directory, file), bytes, { flag: 'wx' });
            files[field] = { file, elements: values.length, encoding: field === 'confidence' ? 'float32-le' : 'int32-le',
              sha256: createHash('sha256').update(bytes).digest('hex') };
          }
          artifacts.push({ outputId, files, cameraWidth: map.cameraWidth, cameraHeight: map.cameraHeight,
            projectorWidth: map.projectorWidth, projectorHeight: map.projectorHeight, mesh });
        },
      });
      if (plan.autoBlend) {
        job.state = 'building-blend';
        const warped = applyGeometryCandidate(run.base, result, { ...plan, autoBlend: false, autoPhotometry: false });
        const outputs = geometryBlendOutputs(warped, plan.outputs.map(o => o.id)), records = [];
        const photo = plan.autoPhotometry ? solveUvcPhotometry(result.outputs.map(o => o.photometry)) : null;
        const photoRecords = [];
        const saveFloatAsset = async (values, file, dimensions) => {
          const bytes = Buffer.alloc(values.length * 4);
          for (let k = 0; k < values.length; k++) bytes.writeFloatLE(values[k], k * 4);
          await writeFile(join(directory, file), bytes, { flag: 'wx' });
          return { path: join('uvc-geometry', job.id, file), sha256: createHash('sha256').update(bytes).digest('hex'),
            format: 'rgba32_float', ...dimensions, byteLength: bytes.length };
        };
        for (let i = 0; i < outputs.length; i++) {
          const { values, coveredPixels } = await rasterizeGeometryBlend(outputs, i, { signal: abort.signal });
          const data = Buffer.alloc(values.length * 4);
          for (let pixel = 0; pixel < values.length; pixel++) data.writeFloatLE(values[pixel], pixel * 4);
          const file = `${outputs[i].id}-geometry-blend.bin`;
          await writeFile(join(directory, file), data, { flag: 'wx' });
          records.push({ outputId: outputs[i].id, coveredPixels, ref: {
            path: join('uvc-geometry', job.id, file), sha256: createHash('sha256').update(data).digest('hex'),
            format: 'r32_float', ...outputs[i].resolution, byteLength: data.length,
          } });
          if (photo) {
            abort.signal.throwIfAborted();
            const record = photo.outputs.find(o => o.outputId === outputs[i].id), { width, height } = outputs[i].resolution;
            const black = await photometryBlackRaster(photo, record, values, width, height, { signal: abort.signal });
            photoRecords.push({ outputId: record.outputId, gain: record.gain,
              black: await saveFloatAsset(black, `${record.outputId}-usb-black.bin`, { width, height }),
              lut: await saveFloatAsset(record.lut, `${record.outputId}-usb-lut.bin`, { size: record.lutSize }) });
            job.photometryOutputsCompleted = i + 1;
          }
          job.blendOutputsCompleted = i + 1;
        }
        result.geometricBlend = { method: 'geometry-partition-of-unity-v1', radiometryVerified: false, outputs: records };
        if (photo) {
          result.usbPhotometry = { method: photo.method, cameraResponse: photo.cameraResponse, radiometryVerified: false,
            physicalBeforeAfterVerified: false, blackTarget: photo.blackTarget, referenceWhite: photo.referenceWhite, outputs: photoRecords };
          job.photometryGenerated = true;
        }
        job.blendGenerated = true;
      }
      abort.signal.throwIfAborted();
      const bytes = JSON.stringify({ ...result, artifacts }, null, 2);
      await writeFile(join(directory, 'candidate.json'), bytes, { flag: 'wx' });
      job.candidateSha256 = createHash('sha256').update(bytes).digest('hex');
      job.applyAvailable = Boolean(run.base && result.outputs.length === plan.outputs.length && result.outputs.every(o => o.mesh && o.mesh.holes === 0));
      job.baseRevision = run.base?.revision;
      this.#completed = run;
      job.state = 'candidate-not-applied'; job.outputs = result.outputs; job.candidateFile = 'candidate.json';
      job.endResult = result.endResult;
    } catch (e) {
      job.state = abort.signal.aborted ? 'cancelled' : 'failed'; job.error = e.message;
      if (e.code === 'GEOMETRY_SCENE_CHANGED' || e.code === 'GEOMETRY_NO_SURFACE') { job.errorCode = e.code; job.measurementDetails = e.details; }
      if (e instanceof AggregateError) job.errors = e.errors.map(v => v.message);
    } finally {
      const finishedAt = new Date().toISOString();
      job.restorationRequired = plan.autoRoute ? this.receiverRouting.snapshot().pendingRecovery : job.routingRestored !== true;
      try { await writeFile(join(directory, 'job.json'), JSON.stringify({ ...job, finishedAt }, null, 2), { flag: 'wx' }); }
      catch (e) { job.state = 'failed'; job.persistenceError = e.message; }
      job.finishedAt = finishedAt;
      if (this.#run === run) this.#run = null;
    }
  }
  async confirmRouting(id) {
    const run = this.#run;
    if (!run || run.job.id !== id || run.job.state !== 'awaiting-routing') throw new HttpError(409, 'uvc_job_state', 'This job is not waiting for routing');
    const status = await run.transport.status();
    if (this.#run !== run || run.abort.signal.aborted) throw new HttpError(409, 'uvc_job_state', 'Job changed while checking receivers');
    if (!run.plan.outputs.every(o => status.connections?.some(c => c.outputId === o.id && c.connections > 0))) {
      throw new HttpError(409, 'uvc_receivers_missing', 'Every test source needs a receiver before capture');
    }
    run.job.routingConfirmedByOperator = true; run.routingConfirmed = true;
    return this.snapshot();
  }
  async apply(input) {
    if (this.#closed || this.#run || this.#applying) throw new HttpError(409, 'uvc_busy', 'Wait for the current operation');
    const run = this.#completed, job = this.#latest;
    if (!input || Object.keys(input).some(k => !['id', 'expectedRevision'].includes(k)) || !run || job !== run.job || input.id !== job.id ||
        job.state !== 'candidate-not-applied' || !job.applyAvailable) throw new HttpError(409, 'uvc_candidate', 'No matching applicable geometry candidate');
    this.#applying = true;
    try {
      if (!this.canApply()) throw new HttpError(409, 'uvc_output_active', 'Stop NDI preview before applying geometry');
      const current = this.getProject();
      if (input.expectedRevision !== run.base.revision || current.revision !== run.base.revision) throw new HttpError(409, 'uvc_revision', 'Project changed after measurement; acquire again');
      const bytes = await readFile(join(run.directory, 'candidate.json'));
      if (createHash('sha256').update(bytes).digest('hex') !== job.candidateSha256) throw new Error('Geometry candidate digest mismatch');
      const project = applyGeometryCandidate(current, JSON.parse(bytes), run.plan);
      if (run.plan.autoBlend) {
        const assets = await prepareNdiCorrectionAssets({ outputs: project.outputs.filter(o => run.plan.outputs.some(p => p.id === o.id)).map(o => ({ id: o.id, blend: { map: o.blend.map },
          ...(run.plan.autoPhotometry ? { blackUniformity: { map: o.blackUniformity.map }, color: { lut: o.color.lut } } : {}) })) }, { root: this.dataDir });
        await assets.cleanup();
      }
      const backup = await open(join(run.directory, `project-before-apply-${randomUUID()}.json`), 'wx');
      try { await backup.writeFile(JSON.stringify(current, null, 2)); await backup.sync(); } finally { await backup.close(); }
      if (!this.canApply() || this.#closed) throw new HttpError(409, 'uvc_output_active', 'Output state changed before apply');
      const saved = await this.saveProject(project, { ifMatchRevision: current.revision });
      job.state = 'applied-to-project'; job.candidateApplied = true; job.appliedRevision = saved.project.revision; job.applyAvailable = false;
      // This acknowledges saved settings, not measured optical success.
      job.physicalOutputVerified = false;
      try { await writeFile(join(run.directory, 'apply-receipt.json'), JSON.stringify(job, null, 2), { flag: 'wx' }); }
      catch (e) { job.receiptError = e.message; }
      return this.snapshot();
    } finally { this.#applying = false; }
  }
  cancel(id) {
    if (!this.#run || this.#run.job.id !== id) throw new HttpError(409, 'uvc_job_state', 'No matching active geometry job');
    this.#run.abort.abort(); this.#run.job.state = 'cancelling'; return this.snapshot();
  }
  async restoreRouting(input) {
    if (this.#closed || this.#run || this.#applying || !this.receiverRouting || !input ||
        Object.keys(input).some(k => k !== 'id') || typeof input.id !== 'string' ||
        this.receiverRouting.snapshot().jobId !== input.id) throw new HttpError(409, 'uvc_routing', 'No matching idle receiver recovery available');
    try { await this.receiverRouting.restore(input.id); }
    catch (e) { throw new HttpError(409, 'uvc_routing_recovery', e.message, { errors: e.errors?.map(error => error.message) }); }
    if (this.#latest?.id === input.id) { this.#latest.routingRestored = true; this.#latest.restorationRequired = false; }
    return this.snapshot();
  }
  async restore(input) {
    const run = this.#completed, job = this.#latest;
    if (this.#closed || this.#run || this.#applying || !run || job !== run.job || job.state !== 'applied-to-project' ||
        !input || Object.keys(input).some(k => !['id', 'expectedRevision'].includes(k)) || input.id !== job.id) throw new HttpError(409, 'uvc_candidate', 'No applied candidate to restore');
    this.#applying = true;
    try {
      if (!this.canApply()) throw new HttpError(409, 'uvc_output_active', 'Stop NDI preview before restoring geometry');
      if (input.expectedRevision !== job.appliedRevision || this.getProject().revision !== job.appliedRevision) throw new HttpError(409, 'uvc_revision', 'Project was edited after apply; refusing to overwrite newer work');
      const saved = await this.saveProject(structuredClone(run.base), { ifMatchRevision: job.appliedRevision });
      job.state = 'restored-to-project'; job.candidateApplied = false; job.restoredRevision = saved.project.revision;
      return this.snapshot();
    } finally { this.#applying = false; }
  }
  async close() { this.#closed = true; const run = this.#run; run?.abort.abort(); if (run?.task) await run.task; }
}
