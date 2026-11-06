[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$SourceRoot)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Resolve-Path -LiteralPath $SourceRoot -ErrorAction Stop).Path
$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$entry = Join-Path $root 'scripts\run-windows-ndi-preview.mjs'
. (Join-Path $PSScriptRoot 'ReceiverCredentials.ps1')
try { Import-PixelReceiverCredentials (Join-Path (Split-Path $root -Parent) 'preview-data\ndi-receiver-secrets.json') }
catch { Write-Warning 'Receiver credentials are unavailable for this Windows user. Control will start; configure receiver login before automatic routing.' }
foreach ($path in @($node, $entry)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing preview component: $path" }
}
$logs = Join-Path (Split-Path $root -Parent) 'preview-data\logs'
$null = New-Item -ItemType Directory -Path $logs -Force
# Use the same interactive desktop as Arena, never a SYSTEM graphics session.
# This wrapper owns only its Node launcher; the launcher owns cleanup of jobs.
$failures = 0
while ($failures -le 3) {
  $startedAt = [DateTime]::UtcNow
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $child = Start-Process -FilePath $node -ArgumentList ('"' + $entry + '"') `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logs "startup-$stamp.out.log") `
    -RedirectStandardError (Join-Path $logs "startup-$stamp.err.log")
  $child.WaitForExit()
  # Bound consecutive startup failures, not a lifetime number of restarts.
  # A healthy five-minute run restores the retry allowance.
  if (([DateTime]::UtcNow - $startedAt).TotalMinutes -ge 5) { $failures = 0 }
  else { $failures++ }
  if ($failures -le 3) { Start-Sleep -Seconds 10 }
}
# This task is a continuous service. Any launcher exit means its control pair
# is unavailable; do not let a null PowerShell Process.ExitCode become success.
exit 1
