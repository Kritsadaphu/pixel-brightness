import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyControlBundle(root) {
  root = resolve(root);
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Bundle root cannot be a link');
  const text = await readFile(join(root, 'CONTROL-BUNDLE-SHA256.txt'), 'utf8');
  if (text.length > 32 * 1024 * 1024 || !text.endsWith('\n')) throw new Error('Invalid bundle manifest');
  const lines = text.trimEnd().split('\n'), expected = new Map();
  if (!lines.length || lines.length > 100000) throw new Error('Invalid bundle entry count');
  for (const line of lines) {
    const m = /^([a-f0-9]{64})  ([^\x00-\x1f<>:"\\|?*]+)$/.exec(line);
    if (!m || m[2].split('/').some(s => !s || s === '.' || s === '..' || /[ .]$/.test(s)) ||
        m[2].toLowerCase() === 'control-bundle-sha256.txt' || expected.has(m[2].toLowerCase())) throw new Error('Unsafe/duplicate manifest path');
    expected.set(m[2].toLowerCase(), { path: m[2], digest: m[1] });
  }
  const actual = [];
  async function walk(folder, relative = '') {
    for (const d of await readdir(folder, { withFileTypes: true })) {
      if (d.isSymbolicLink()) throw new Error('Bundle contains a link');
      const p = relative ? relative + '/' + d.name : d.name;
      if (d.isDirectory()) await walk(join(folder, d.name), p);
      else if (d.isFile() && p !== 'CONTROL-BUNDLE-SHA256.txt') actual.push(p);
      else if (!d.isFile()) throw new Error('Unsupported bundle entry');
    }
  }
  await walk(root);
  if (actual.length !== expected.size) throw new Error('Extra or missing bundle files');
  for (let i = 0; i < actual.length; i += 8) await Promise.all(actual.slice(i, i + 8).map(async path => {
    const entry = expected.get(path.toLowerCase());
    if (!entry || entry.path !== path || createHash('sha256').update(await readFile(join(root, path))).digest('hex') !== entry.digest) throw new Error('Bundle digest mismatch: ' + path);
  }));
  return actual.sort();
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node verify-control-bundle.mjs BUNDLE_ROOT');
  console.log(JSON.stringify({ files: await verifyControlBundle(process.argv[2]) }));
}
