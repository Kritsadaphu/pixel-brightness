import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { NdiPatternTransport } from './ndi-pattern-transport.mjs';

/** Shares process supervision only. Native video parser independently validates
 * every correction; it never accepts physical-display selectors. */
export class NdiVideoTransport extends NdiPatternTransport {
  #directory;
  #active = false;
  constructor({ shaderDirectory, assetDirectory, ...options }) {
    super(options);
    if (!isAbsolute(shaderDirectory) || !isAbsolute(assetDirectory)) throw new Error('Absolute shader/asset directories required');
    this.shaderDirectory = shaderDirectory; this.assetDirectory = assetDirectory;
  }
  configuration(plan) {
    if (!plan || Object.keys(plan).some(k => !['source', 'canvas', 'outputs', 'adapterLuid'].includes(k))) throw new Error('Invalid NDI video plan');
    if (!Array.isArray(plan.outputs) || !plan.outputs.length || plan.outputs.length > 5) throw new Error('Expected 1-5 outputs');
    const ids = new Set();
    for (const output of plan.outputs) {
      if (!output || !/^[A-Za-z0-9._-]{1,64}$/.test(output.id) || ids.has(output.id) || 'display' in output) throw new Error('Invalid network output identity/display');
      ids.add(output.id);
    }
    return { schema: 'pb-ndi-video-v1', prefix: `PB-VIDEO-${randomUUID()}`, ...structuredClone(plan),
      shaderDirectory: this.shaderDirectory, assetDirectory: this.assetDirectory };
  }
  launchArguments(config) {
    const bytes = JSON.stringify(config);
    if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw new Error('NDI video config exceeds 8 MiB');
    this.#directory = mkdtempSync(join(tmpdir(), 'pb-ndi-video-'));
    const file = join(this.#directory, 'config.json');
    try { writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (e) { this.#cleanup(); throw e; }
    return ['--config-file', file];
  }
  async begin(plan, options) {
    if (this.#active) throw new Error('NDI video process is already active');
    this.#active = true;
    try { return await super.begin(plan, options); }
    catch (e) { this.#active = false; this.#cleanup(); throw e; }
  }
  async end() { try { return await super.end(); } finally { this.#active = false; this.#cleanup(); } }
  #cleanup() {
    if (this.#directory) { rmSync(this.#directory, { recursive: true, force: true }); this.#directory = undefined; }
  }
  async show() { throw new Error('Video transport does not expose calibration patterns'); }
}
