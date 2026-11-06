import { createHash } from 'node:crypto';
import { lstat, realpath, readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const slots = [['blend', 'map', ['r32_float']], ['blackUniformity', 'map', ['r32_float', 'rgba32_float']],
  ['mask', 'map', ['r32_float']], ['color', 'lut', ['rgba32_float']]];
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const inside = (root, file) => { const p = relative(root, file); return p && p !== '..' && !p.startsWith('..' + sep) && !isAbsolute(p); };

/** Resolve only local, digest-bound correction files. Copy verified bytes into
 * a job-owned snapshot so later edits cannot change the native startup input. */
export async function prepareNdiCorrectionAssets(plan, { root, maximumBytes = 256 * 1024 * 1024 }) {
  const result = structuredClone(plan); let directory, total = 0;
  if (!Array.isArray(result?.outputs) || result.outputs.length < 1 || result.outputs.length > 5 ||
      result.outputs.some(o => !/^[A-Za-z0-9._-]{1,64}$/.test(o.id)) ||
      new Set(result.outputs.map(o => o.id)).size !== result.outputs.length) throw new Error('Invalid correction output identities');
  const cleanup = async () => { if (directory) await rm(directory, { recursive: true, force: true }); };
  try {
    for (const output of result.outputs) for (const [group, field, formats] of slots) {
      const ref = output[group]?.[field]; if (ref == null) continue;
      if (!ref || typeof ref !== 'object' || !/^[a-f0-9]{64}$/.test(ref.sha256 || '') || !formats.includes(ref.format)) {
        throw new Error(`Invalid digest/format for ${output.id}.${group}.${field}`);
      }
      const lut = field === 'lut', channels = ref.format === 'rgba32_float' ? 4 : 1;
      if (lut ? !integer(ref.size, 2, 128) : !integer(ref.width, 1, 16384) || !integer(ref.height, 1, 16384)) {
        throw new Error('Invalid correction dimensions');
      }
      const bytes = (lut ? ref.size ** 3 : ref.width * ref.height) * channels * 4;
      total += bytes;
      if (total > maximumBytes || (ref.byteLength != null && ref.byteLength !== bytes)) throw new Error('Correction byte budget or length mismatch');
      const base = await realpath(root);
      const requested = ref.path ?? (ref.uri?.startsWith('file:') ? fileURLToPath(ref.uri) : join('assets', ref.sha256));
      const file = resolve(base, requested);
      if (!inside(base, file)) throw new Error('Correction file must be inside the configured data directory');
      let part = base;
      for (const segment of relative(base, file).split(sep)) {
        part = join(part, segment);
        if ((await lstat(part)).isSymbolicLink()) throw new Error('Correction path cannot contain links');
      }
      const canonical = await realpath(file), stat = await lstat(canonical);
      if (!inside(base, canonical) || !stat.isFile() || stat.size !== bytes) throw new Error('Correction file size/type mismatch');
      const data = await readFile(canonical);
      if (data.length !== bytes || createHash('sha256').update(data).digest('hex') !== ref.sha256) throw new Error('Correction digest mismatch');
      for (let i = 0; i < data.length; i += 4) {
        const value = data.readFloatLE(i);
        if (!Number.isFinite(value) || ((group === 'blend' || group === 'mask') && (value < 0 || value > 1))) throw new Error('Invalid correction float');
      }
      directory ??= await mkdtemp(join(tmpdir(), 'pb-ndi-corrections-'));
      const path = join(directory, `${output.id}-${group}-${field}.bin`);
      await writeFile(path, data, { flag: 'wx', mode: 0o600 });
      output[group][field] = { path, format: ref.format, ...(lut ? { size: ref.size } : { width: ref.width, height: ref.height }) };
    }
    return { plan: result, cleanup, bytes: total };
  } catch (e) { await cleanup(); throw e; }
}
