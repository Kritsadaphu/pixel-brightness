import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Windows camera authority validates constructed dictionaries and JSON without weakening exact keys", {
  skip: process.platform !== "win32",
}, async () => {
  const policy = fileURLToPath(new URL("../deploy/windows/CameraRuntime.ps1", import.meta.url));
  const script = `
$ErrorActionPreference = 'Stop'
. '${policy.replaceAll("'", "''")}'
foreach ($profile in @('CanonR50RfS1018', 'SonyA7IV', 'Disabled')) {
  $authority = New-PixelBrightnessUnconfiguredCameraAuthority -DataRoot 'C:\\ProgramData\\Pixel Brightness' -Profile $profile
  foreach ($value in @($authority, ($authority | ConvertTo-Json -Depth 20 | ConvertFrom-Json))) {
    $result = Assert-PixelBrightnessCameraAuthorityObject -Authority $value -DataRoot 'C:\\ProgramData\\Pixel Brightness'
    if ($result.State -cne 'unconfigured') { throw 'Unexpected state' }
  }
  $authority['unexpected'] = $true
  $rejected = $false
  try { $null = Assert-PixelBrightnessCameraAuthorityObject -Authority $authority -DataRoot 'C:\\ProgramData\\Pixel Brightness' }
  catch { $rejected = $true }
  if (-not $rejected) { throw 'Extra dictionary key was accepted' }
}
'camera-authority-runtime-ok'
`;
  const { stdout } = await promisify(execFile)("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
  ], { timeout: 30_000, windowsHide: true });
  assert.match(stdout, /camera-authority-runtime-ok/);
});
