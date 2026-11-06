#!/usr/bin/env node
// Assemble on Windows from the exact source archive plus already-built native
// binaries and installed npm dependencies. No SDK/runtime DLL redistribution.
import { cp, mkdir, mkdtemp, readFile, readdir, copyFile, lstat, writeFile, rm, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const exec = promisify(execFile), root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32' || process.argv.length !== 4) throw new Error('Usage on Windows: node package-windows-control.mjs SOURCE.zip NEW-DESTINATION.zip');
const source = resolve(process.argv[2]), destination = resolve(process.argv[3]);
try { await access(destination); throw new Error('Destination already exists; choose a new versioned bundle'); } catch(e) { if(e.code !== 'ENOENT') throw e; }
const stage = await mkdtemp(join(tmpdir(), 'pb-control-bundle-'));
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
async function walk(folder, relative = '') {
  const paths = [];
  for (const d of await readdir(folder, { withFileTypes: true })) {
    if (d.isSymbolicLink()) throw new Error('Bundle contains a link: ' + d.name);
    const p = relative ? relative + '/' + d.name : d.name;
    if (d.isDirectory()) paths.push(...await walk(join(folder, d.name), p)); else if (d.isFile()) paths.push(p);
  }
  return paths;
}
try {
  const listing = (await exec('tar.exe', ['-tf', source], { maxBuffer: 4 * 1024 * 1024 })).stdout.trim().split(/\r?\n/);
  if (listing.some(p => !p.startsWith('Pixel-Brightness-Windows-V3-Source/') || p.split('/').includes('..') || p.includes('\\') || p.includes(':'))) throw new Error('Unsafe source archive path');
  await exec('tar.exe', ['-xf', source, '-C', stage]);
  const bundle = join(stage, 'Pixel-Brightness-Windows-V3-Source');
  const manifest = (await readFile(join(bundle, 'MANIFEST-SHA256.txt'), 'utf8')).trimEnd().split('\n');
  for (const line of manifest) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || match[2].includes('..') || match[2].includes(':') || match[2].startsWith('/') || await sha(join(bundle, match[2])) !== match[1]) throw new Error('Source manifest mismatch');
  }
  await cp(join(root, 'node_modules'), join(bundle, 'node_modules'), { recursive: true, filter: async p => {
    if (/[\\/](\.bin|\.cache|\.vite)([\\/]|$)/.test(p)) return false;
    if ((await lstat(p)).isSymbolicLink()) throw new Error('Dependencies contain a link; build with a flat npm install');
    return true;
  } });
  const native = join(bundle, 'native', 'windows', 'bin'); await mkdir(native, { recursive: true });
  for (const file of ['pixel-brightness-uvc.exe', 'pixel-brightness-ndi-video.exe', 'pixel-brightness-ndi-patterns.exe', 'pixel-brightness-ndi-probe.exe']) await copyFile(join(root, 'native', 'windows', 'bin', file), join(native, file));
  await writeFile(join(bundle, 'INSTALL-CONTROL.cmd'), '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\\windows\\Install-ControlBundle.ps1"\r\npause\r\n');
  await writeFile(join(bundle, 'CONTROL-INSTALLER-README.txt'), 'Pixel Brightness local Control installer (USB SDR estimator / NDI preview).\r\nRequires Windows x64, Node.js 22+ and the already installed NDI 6 SDK runtime. These third-party prerequisites are not bundled.\r\nExtract ZIP, run INSTALL-CONTROL.cmd. Existing production and Arena remain untouched.\r\nCamera/receiver credentials, optical verification, full-rate five-projector acceptance and unattended show scheduling are NOT certified by this package.\r\n');
  const files = (await walk(bundle)).filter(f => f !== 'CONTROL-BUNDLE-SHA256.txt').sort(), lines = [];
  console.log(`Verifying ${files.length} bundle files`);
  for (let i = 0; i < files.length; i += 8) {
    lines.push(...await Promise.all(files.slice(i, i + 8).map(async file => `${await sha(join(bundle, file))}  ${file}`)));
    if (i % 1000 === 0) console.log(`Verified ${i}/${files.length}`);
  }
  await writeFile(join(bundle, 'CONTROL-BUNDLE-SHA256.txt'), lines.join('\n') + '\n');
  // Execute the same read-only validation customers can run, before packaging.
  console.log('Checking installer prerequisites and manifest');
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(bundle, 'deploy', 'windows', 'Install-ControlBundle.ps1'), '-ValidateOnly'], { timeout: 300000, maxBuffer: 65536 });
  console.log('Compressing verified Control bundle');
  await exec('tar.exe', ['-a', '-cf', destination, '-C', stage, 'Pixel-Brightness-Windows-V3-Source'], { timeout: 300000, maxBuffer: 65536 });
  const digest = await sha(destination);
  await writeFile(destination + '.sha256', digest + '\n');
  console.log(JSON.stringify({ destination, sha256: digest, files: files.length, nativeIncluded: true, npmDependenciesIncluded: true, nodeIncluded: false, ndiRuntimeIncluded: false, productionAutoReady: false }));
} finally { await rm(stage, { recursive: true, force: true }); }
