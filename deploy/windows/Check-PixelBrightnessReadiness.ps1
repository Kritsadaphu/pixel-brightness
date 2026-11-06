[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$node=Join-Path $env:ProgramFiles 'nodejs\node.exe'
& $node (Join-Path $root 'scripts\check-windows-readiness.mjs')
if($LASTEXITCODE -ne 0){Write-Warning 'Configuration is incomplete. Review the false checks above; no equipment was changed.'}
