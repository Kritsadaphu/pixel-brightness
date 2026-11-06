[CmdletBinding()]
param([switch]$ValidateOnly)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$bundle=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$node=Join-Path $env:ProgramFiles 'nodejs\node.exe'
$ndi=Join-Path $env:ProgramFiles 'NDI\NDI 6 SDK\Bin\x64\Processing.NDI.Lib.x64.dll'
foreach($dependency in @($node,$ndi)){if(-not(Test-Path -LiteralPath $dependency -PathType Leaf)){throw "Required installed dependency missing: $dependency"}}
$version=& $node --version
if($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.(\d+)\.' -or [int]$Matches[1] -lt 22 -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -lt 13)){throw 'Node.js 22.13 or newer is required.'}
$manifestPath=Join-Path $bundle 'CONTROL-BUNDLE-SHA256.txt'
if(-not(Test-Path -LiteralPath $manifestPath -PathType Leaf)){throw 'This source ZIP is not a prepared Control Installer bundle.'}
$verifiedText=& $node (Join-Path $bundle 'scripts\verify-control-bundle.mjs') $bundle
if($LASTEXITCODE -ne 0){throw 'Control bundle integrity check failed.'}
$files=@(($verifiedText | ConvertFrom-Json -ErrorAction Stop).files)
Write-Output ('Verified Control bundle files: '+$files.Count)
if($ValidateOnly){return}
foreach($port in @(3001,4101)){
 if(@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue).Count -gt 0){throw "Control is already running on port $port. Nothing was replaced. Stop the idle preview before installing another copy."}
}
$installRoot=Join-Path $env:LOCALAPPDATA ('Pixel Brightness Control\'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
$source=Join-Path $installRoot 'source'
$null=New-Item -ItemType Directory -Path $source
foreach($relative in $files){
 $target=Join-Path $source $relative
 $null=New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force
 Copy-Item -LiteralPath (Join-Path $bundle $relative) -Destination $target
}
Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $source 'CONTROL-BUNDLE-SHA256.txt')
$shell=New-Object -ComObject WScript.Shell
$shortcut=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) ('Pixel Control '+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.lnk')))
$shortcut.TargetPath=Join-Path $source 'START-NDI-PREVIEW.cmd'
$shortcut.WorkingDirectory=$source
$shortcut.Save()
Write-Output ('Installed a separate local Control copy: '+$source)
Write-Output 'Existing production release, schedules, Arena and receiver sources were not changed. Open the new desktop shortcut. Configure receiver accounts and verify optics before show use.'
