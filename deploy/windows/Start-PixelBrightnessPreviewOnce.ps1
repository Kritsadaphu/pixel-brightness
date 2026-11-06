[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot 'ReceiverCredentials.ps1')
try { Import-PixelReceiverCredentials (Join-Path (Split-Path $root -Parent) 'preview-data\ndi-receiver-secrets.json') }
catch { Write-Warning 'Receiver credentials are unavailable for this Windows user. Control will start; configure receiver login before automatic routing.' }
& (Join-Path $env:ProgramFiles 'nodejs\node.exe') (Join-Path $root 'scripts\run-windows-ndi-preview.mjs')
exit $LASTEXITCODE
