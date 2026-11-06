#!/usr/bin/env node
// Side-by-side, local-only preview. Never installs a service, changes the
// production release pointer, launches Arena, or changes receiver subscriptions.
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const native = join(root, 'native', 'windows', 'bin');
const runtime = join(process.env.ProgramFiles || 'C:\\Program Files', 'NDI', 'NDI 6 SDK', 'Bin', 'x64');
const data = resolve(root, '..', 'preview-data');
const children = new Set();
let closing = false;
const api = 'http://127.0.0.1:4101';

async function freePort(port) {
  const socket = createServer();
  await new Promise((yes, no) => { socket.once('error', no); socket.listen(port, '127.0.0.1', yes); });
  await new Promise((yes, no) => socket.close(e => e ? no(e) : yes()));
}
function launch(args, environment) {
  const child = spawn(process.execPath, args, { cwd: root, env: environment, stdio: 'inherit', windowsHide: false });
  children.add(child);
  const done = new Promise((yes, no) => {
    child.once('error', no);
    child.once('exit', (code, signal) => { children.delete(child); yes({ code, signal }); });
  });
  return { child, done };
}
async function request(path, body) {
  const response = await fetch(api + path, { signal: AbortSignal.timeout(20000),
    headers: { Origin: 'http://127.0.0.1:3001', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`Preview ${path}: HTTP ${response.status}`);
  return response.json();
}
async function stop() {
  if (closing) return;
  closing = true;
  try {
    const state = await request('/v1/outputs/ndi-preview');
    if (state.job && !['stopped', 'failed'].includes(state.job.state))
      await request('/v1/outputs/ndi-preview/stop', { id: state.job.id });
  } catch (e) { console.error(`NDI cleanup: ${e.message}. Physical black/restoration is not verified.`); }
  try {
    let state = await request('/v1/calibrations/uvc-geometry');
    const terminal = ['candidate-not-applied', 'applied-to-project', 'restored-to-project', 'cancelled', 'failed'];
    if (state.job && !terminal.includes(state.job.state)) {
      await request('/v1/calibrations/uvc-geometry/cancel', { id: state.job.id });
      const deadline = Date.now() + 20000;
      while (state.job && !terminal.includes(state.job.state) && Date.now() < deadline) {
        await delay(200); state = await request('/v1/calibrations/uvc-geometry');
      }
      if (state.job && !terminal.includes(state.job.state)) throw new Error('Camera cleanup did not complete');
    }
  } catch (e) { console.error(`Geometry cleanup: ${e.message}. Restore decoder sources before show use.`); }
  // Windows kill is not a graceful server-close signal. Explicitly stop owned
  // output jobs above first; native heartbeat expiry is a final fallback only.
  for (const child of children) child.kill();
}

try {
  if (process.platform !== 'win32') throw new Error('Run this preview on Windows, not the Mac');
  if (process.argv.length !== 2) throw new Error('This isolated preview takes no arguments');
  for (const path of [join(runtime, 'Processing.NDI.Lib.x64.dll'),
    ...['pixel-brightness-ndi-video.exe', 'pixel-brightness-ndi-probe.exe', 'pixel-brightness-ndi-patterns.exe', 'pixel-brightness-uvc.exe'].map(f => join(native, f)),
    join(root, 'node_modules', 'vinext', 'dist', 'cli.js')]) await access(path);
  await freePort(3001); await freePort(4101);
  // Do not inherit production data/ports, camera credentials or power switches.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PB_|PIXEL_)/i.test(key)));
  const receiverProfiles = join(data, 'ndi-receivers.json');
  let receiverConfigured = false;
  try { await access(receiverProfiles); receiverConfigured = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const built = await launch(['scripts/run-vinext.mjs', 'build'], { ...environment, PB_WEB_API_PORT: '4101' }).done;
  if (built.code !== 0) throw new Error('Preview web build failed');
  const server = launch([join(root, 'runtime', 'server', 'index.mjs')], { ...environment,
    PB_SERVER_HOST: '127.0.0.1', PB_SERVER_PORT: '4101', PB_SERVER_DATA_DIR: data,
    PB_WEB_CONTROL_PORT: '3001',
    ...(receiverConfigured ? { PB_NDI_RECEIVER_PROFILES_FILE: receiverProfiles } : {}),
    PB_ALLOW_POWER_ACTIONS: '0', PB_UVC_GEOMETRY_ENABLED: '1', PB_NDI_VIDEO_ENABLED: '1',
    PB_UVC_CAMERA_COMMAND: join(native, 'pixel-brightness-uvc.exe'),
    PB_NDI_PATTERN_COMMAND: join(native, 'pixel-brightness-ndi-patterns.exe'),
    PB_NDI_VIDEO_COMMAND: join(native, 'pixel-brightness-ndi-video.exe'),
    PB_NDI_PROBE_COMMAND: join(native, 'pixel-brightness-ndi-probe.exe'),
    PB_NDI_RUNTIME_DIRECTORY: runtime, PB_NDI_SHADER_DIRECTORY: join(root, 'native', 'windows', 'shaders'),
  });
  let ready = false;
  for (let i = 0; i < 50 && server.child.exitCode === null; i++) {
    try { await request('/v1/outputs/ndi-preview'); ready = true; break; } catch { await delay(200); }
  }
  if (!ready) throw new Error('Preview API did not start');
  const web = launch(['node_modules/vinext/dist/cli.js', 'start', '--hostname', '127.0.0.1', '--port', '3001'], environment);
  console.log(`\nPIXEL NDI PREVIEW: http://127.0.0.1:3001/\nData: ${data}\nNo output starts automatically. Production ports 3000/4100 are unchanged.\nUse Ctrl+C to stop this preview; restore decoder sources after a test.\n`);
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  const ended = await Promise.race([server.done, web.done]);
  // A child exiting unexpectedly, even with code zero, is a lost service.
  // Report failure so the Windows startup task can restart the complete pair.
  if (!closing) process.exitCode = 1;
  await stop();
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
  if (children.size) await stop();
}
