import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('preview launcher pins separate local data, ports and compiled API port and clears inherited show settings', async () => {
  const source = await readFile(new URL('../scripts/run-windows-ndi-preview.mjs', import.meta.url), 'utf8');
  assert.match(source, /freePort\(3001\).*freePort\(4101\)/);
  assert.match(source, /PB_WEB_API_PORT: '4101'/);
  assert.match(source, /PB_WEB_CONTROL_PORT: '3001'/);
  assert.match(source, /Origin: 'http:\/\/127\.0\.0\.1:3001'/);
  assert.match(source, /PB_SERVER_HOST: '127\.0\.0\.1', PB_SERVER_PORT: '4101', PB_SERVER_DATA_DIR: data/);
  assert.match(source, /PB_ALLOW_POWER_ACTIONS: '0'/);
  assert.match(source, /resolve\(root, '\.\.', 'preview-data'\)/);
  assert.ok(source.includes('!/^(PB_|PIXEL_)/i.test(key)'));
  assert.ok(source.indexOf("request('/v1/outputs/ndi-preview/stop'") < source.indexOf('child.kill()'));
  assert.ok(source.indexOf("request('/v1/calibrations/uvc-geometry/cancel'") < source.indexOf('child.kill()'));
  assert.doesNotMatch(source, /schtasks|shutdown\.exe|current-release\.txt|Arena\.exe/);
});
test('preview startup persists only the interactive preview with bounded restart and log files', async () => {
  const installer = await readFile(new URL('../deploy/windows/Install-PixelBrightnessPreviewStartup.ps1', import.meta.url), 'utf8');
  const wrapper = await readFile(new URL('../deploy/windows/Start-PixelBrightnessPreview.ps1', import.meta.url), 'utf8');
  const launcher = await readFile(new URL('../scripts/run-windows-ndi-preview.mjs', import.meta.url), 'utf8');
  assert.match(installer, /-AtLogOn -User \$user/);
  assert.match(installer, /-LogonType Interactive -RunLevel Highest/);
  assert.match(installer, /-MultipleInstances IgnoreNew/);
  assert.match(wrapper, /while \(\$failures -le 3\)/);
  assert.match(wrapper, /TotalMinutes -ge 5\) \{ \$failures = 0 \}/);
  assert.match(wrapper, /else \{ \$failures\+\+ \}/);
  assert.match(wrapper, /Start-Sleep -Seconds 10/);
  assert.match(installer, /already running; leave its live jobs untouched/);
  assert.match(wrapper, /RedirectStandardOutput/);
  assert.match(wrapper, /RedirectStandardError/);
  assert.match(wrapper, /\$child\.WaitForExit\(\)/);
  assert.match(wrapper, /\$child\.WaitForExit\(\)[\s\S]*exit 1/);
  assert.match(launcher, /if \(!closing\) process\.exitCode = 1/);
  assert.doesNotMatch(installer + wrapper, /Stop-Process|Stop-ScheduledTask|shutdown\.exe|Arena\.exe|current-release\.txt/);
});
test('non-Windows launcher refuses before building or starting services', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/run-windows-ndi-preview.mjs']), e => {
    assert.equal(e.code, 1); assert.match(e.stderr, /Run this preview on Windows/); return true;
  });
});
