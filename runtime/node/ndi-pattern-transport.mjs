import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

const error = (code, message) => Object.assign(new Error(message), { code });
/** A separately supervised pattern-only process. It cannot overwrite an Arena
 * sender name. Receiver routing is outside this adapter's authority. */
export class NdiPatternTransport {
  #child; #pending; #heartbeat; #close; #sources; #failure;
  constructor({ command, runtimeDirectory, timeoutMs = 5000 }) {
    if (!isAbsolute(command) || !isAbsolute(runtimeDirectory) || !Number.isSafeInteger(timeoutMs)
        || timeoutMs < 100 || timeoutMs > 30000) throw error('NDI_CONFIG', 'Use absolute executable/runtime paths and a bounded timeout');
    this.command = command; this.runtimeDirectory = runtimeDirectory; this.timeoutMs = timeoutMs;
  }
  get sources() { return structuredClone(this.#sources || []); }
  configuration(plan) {
    const frameRateNum = plan.frameRateNum ?? 30;
    if (![30, 60].includes(frameRateNum)) throw error('NDI_CONFIG', 'Pattern source supports only explicit 30 or 60 fps');
    return { prefix: `PB-GEOMETRY-${randomUUID()}`, frameRateNum, outputs: plan.outputs.map(({ id, width, height }) => ({ id, width, height })) };
  }
  launchArguments(config) { return ['--config', JSON.stringify(config)]; }
  #reject(reason) {
    this.#failure ||= reason;
    if (this.#pending) { clearTimeout(this.#pending.timer); this.#pending.reject(reason); this.#pending = null; }
  }
  #expect(event) {
    if (this.#pending) throw error('NDI_BUSY', 'A pattern command is still pending');
    if (this.#failure) throw this.#failure;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#reject(error('NDI_TIMEOUT', 'Pattern process stopped responding; physical output is unverified')); this.#child?.kill(); }, this.timeoutMs);
      this.#pending = { event, resolve, reject, timer };
    });
  }
  #send(message) {
    if (!this.#child?.stdin.writable) { this.#reject(error('NDI_CLOSED', 'Pattern process is not writable')); return; }
    this.#child.stdin.write(JSON.stringify(message) + '\n');
  }
  async begin(plan, { signal } = {}) {
    signal?.throwIfAborted();
    if (this.#child) throw error('NDI_BUSY', 'A pattern process is already active');
    this.#failure = null; this.#sources = [];
    const config = this.configuration(plan);
    const args = this.launchArguments(config);
    const ready = this.#expect('ready');
    // No shell, no copied third-party DLLs, no persistent PATH change.
    const separator = process.platform === 'win32' ? ';' : ':';
    this.#child = spawn(this.command, args, { shell: false, windowsHide: true,
      env: { ...process.env, PATH: this.runtimeDirectory + separator + (process.env.PATH || '') }, stdio: ['pipe', 'pipe', 'pipe'] });
    const child = this.#child;
    let output = '', stderr = '';
    child.stdin.on('error', e => this.#reject(e));
    child.stderr.on('data', b => { stderr = (stderr + b.toString('utf8')).slice(-4096); });
    child.stdout.on('data', b => {
      output += b.toString('utf8');
      if (output.length > 65536) { this.#reject(error('NDI_PROTOCOL', 'Oversized pattern response')); child.kill(); return; }
      let index;
      while ((index = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, index); output = output.slice(index + 1);
        try {
          const message = JSON.parse(line);
          if (message.event === 'error') { this.#reject(error('NDI_PROCESS', message.error)); continue; }
          if (this.#pending?.event === message.event) {
            const pending = this.#pending; this.#pending = null; clearTimeout(pending.timer); pending.resolve(message);
          }
        } catch (e) { this.#reject(error('NDI_PROTOCOL', e.message)); child.kill(); }
      }
    });
    this.#close = new Promise(resolve => {
      child.once('error', e => this.#reject(e));
      child.once('close', (code, terminationSignal) => {
        clearInterval(this.#heartbeat);
        if (this.#pending) this.#reject(error('NDI_EXIT', stderr || `Pattern process exited ${code ?? terminationSignal}`));
        resolve({ code, terminationSignal });
      });
    });
    this.#heartbeat = setInterval(() => this.#send({ command: 'ping' }), 1000);
    const abort = () => { this.#reject(error('NDI_ABORTED', 'Pattern initialization cancelled')); child.kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) abort();
      const result = await ready;
      if (!Array.isArray(result.sources) || result.sources.length !== plan.outputs.length
          || result.sources.some((s, i) => s.outputId !== plan.outputs[i].id || typeof s.name !== 'string' || !s.name.includes(config.prefix))) {
        throw error('NDI_PROTOCOL', 'Pattern source identity mismatch');
      }
      this.#sources = result.sources;
      return { ...result, sources: this.sources, physicalRoutingVerified: false };
    } catch (e) { this.#reject(e); child.kill(); await this.#close; throw e; }
    finally { signal?.removeEventListener('abort', abort); }
  }
  async show(step, { signal } = {}) {
    signal?.throwIfAborted();
    const response = this.#expect('pattern');
    const abort = () => { this.#reject(error('NDI_ABORTED', 'Pattern request cancelled')); this.#child?.kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      this.#send({ command: 'pattern', stepId: step.id, outputId: step.outputId, pattern: step.pattern });
      if (signal?.aborted) abort();
      const result = await response;
      if (result.stepId !== step.id) throw error('NDI_PROTOCOL', 'Pattern acknowledgement belongs to another step');
      return result;
    } finally { signal?.removeEventListener('abort', abort); }
  }
  async status() {
    const response = this.#expect('status'); this.#send({ command: 'status' }); return response;
  }
  async setBlank(blank) {
    if (typeof blank !== 'boolean') throw error('NDI_CONFIG', 'blank must be boolean');
    const response = this.#expect('blank'); this.#send({ command: 'blank', blank }); return response;
  }
  async end() {
    if (!this.#child) return { blackSubmitted: false, contentRestored: false };
    const child = this.#child;
    let stopped;
    try {
      if (this.#failure || child.exitCode !== null || child.signalCode !== null) throw this.#failure || error('NDI_EXIT', 'Pattern process exited');
      const response = this.#expect('stopped'); this.#send({ command: 'stop' }); stopped = await response;
      child.stdin.end();
      let timer;
      const exit = await Promise.race([this.#close, new Promise((resolve, reject) => {
        timer = setTimeout(() => { child.kill(); reject(error('NDI_TIMEOUT', 'Pattern process did not exit after stop')); }, this.timeoutMs);
      })]).finally(() => clearTimeout(timer));
      if (exit.code !== 0) throw error('NDI_EXIT', 'Pattern shutdown was not clean');
      return stopped;
    } finally {
      clearInterval(this.#heartbeat);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await this.#close; this.#child = null; this.#pending = null;
    }
  }
}
