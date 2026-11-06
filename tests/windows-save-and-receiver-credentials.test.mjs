import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const scriptPath = name => fileURLToPath(new URL('../deploy/windows/' + name, import.meta.url)).replaceAll("'", "''");
test('receiver setup checks write access before prompting and uses a genuine null backup path on Windows PowerShell', async () => {
  const setup = await readFile(new URL('../deploy/windows/Configure-PixelBrightnessReceivers.ps1', import.meta.url), 'utf8');
  assert.ok(setup.indexOf("[IO.File]::Open($probe") < setup.indexOf("Read-Host 'Decoder password'"));
  assert.match(setup, /\[IO.File\]::Replace\(\$temp, \$file, \[NullString\]::Value\)/);
  const repair = await readFile(new URL('../deploy/windows/Repair-PixelBrightnessPreviewAccess.ps1', import.meta.url), 'utf8');
  assert.match(repair, /'Modify','ContainerInherit,ObjectInherit'/);
  assert.match(repair, /Set-Acl -LiteralPath \$data/);
  assert.doesNotMatch(repair, /Everyone|FullControl|Set-Acl -LiteralPath \$root/);
});
test('scheduler checks a new stable disk save before closing Arena and installer snapshots the helper', async () => {
  const scheduler = await readFile(new URL('../deploy/windows/ShowSchedule.ps1', import.meta.url), 'utf8');
  const save = scheduler.indexOf("$shell.SendKeys('^s')");
  const verify = scheduler.indexOf('Wait-ArenaCompositionSaved -Path', save);
  const close = scheduler.indexOf('$process.CloseMainWindow()', save);
  assert.ok(save > 0 && verify > save && close > verify);
  for (const path of ['Install-PixelBrightness.ps1', 'UpgradeTransaction.ps1', 'Setup-PixelBrightness.ps1']) {
    assert.match(await readFile(new URL('../deploy/windows/' + path, import.meta.url), 'utf8'), /ArenaSaveEvidence.ps1/);
  }
  const helper = await readFile(new URL('../deploy/windows/ReceiverCredentials.ps1', import.meta.url), 'utf8');
  assert.match(helper, /ConvertTo-SecureString/); assert.match(helper, /ZeroFreeBSTR/);
  assert.match(helper, /'Process'/); assert.doesNotMatch(helper, /'Machine'|'User'/);
});
test('Windows save evidence rejects no-op Save and DPAPI receiver secrets round-trip without printing', { skip: process.platform !== 'win32' }, async () => {
  const script = `
$ErrorActionPreference='Stop'
. '${scriptPath('ArenaSaveEvidence.ps1')}'
. '${scriptPath('ReceiverCredentials.ps1')}'
$root=Join-Path ([IO.Path]::GetTempPath()) ('pb-save-secret-test-'+[Guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $root
try {
 $file=Join-Path $root 'fixture.avc'
 [IO.File]::WriteAllText($file,'fixture-before')
 [IO.File]::SetLastWriteTimeUtc($file,[DateTime]::UtcNow.AddSeconds(-10))
 $before=Get-ArenaCompositionSaveEvidence $file
 $rejected=$false
 try { $null=Wait-ArenaCompositionSaved -Path $file -Before $before -RequestedAtUtc ([DateTime]::UtcNow) -TimeoutSeconds 1 } catch {$rejected=$true}
 if(-not $rejected){throw 'Unchanged save accepted'}
 $requested=[DateTime]::UtcNow
 [IO.File]::WriteAllText($file,'fixture-after')
 $saved=Wait-ArenaCompositionSaved -Path $file -Before $before -RequestedAtUtc $requested -TimeoutSeconds 2
 if($saved.sha256 -eq $before.sha256){throw 'Save digest did not change'}
 $secret=Join-Path $root 'receiver-secrets.json'
 $secure=ConvertTo-SecureString 'synthetic-fixture-only' -AsPlainText -Force
 $encrypted=ConvertFrom-SecureString $secure
 [IO.File]::WriteAllText($secret,(@{RECEIVER_TEST_PASSWORD=$encrypted}|ConvertTo-Json))
 Import-PixelReceiverCredentials $secret
 if([Environment]::GetEnvironmentVariable('RECEIVER_TEST_PASSWORD','Process') -cne 'synthetic-fixture-only'){throw 'DPAPI test failed'}
 [IO.File]::WriteAllText($secret,(@{PATH=$encrypted}|ConvertTo-Json))
 $rejected=$false
 try { Import-PixelReceiverCredentials $secret } catch {$rejected=$true}
 if(-not $rejected){throw 'Reserved environment variable accepted'}
 'save-and-dpapi-runtime-ok'
} finally {
 [Environment]::SetEnvironmentVariable('RECEIVER_TEST_PASSWORD',$null,'Process')
 [IO.Directory]::Delete($root,$true)
}
`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 15000, windowsHide: true });
  assert.match(stdout, /save-and-dpapi-runtime-ok/); assert.doesNotMatch(stdout, /synthetic-fixture-only/);
});
