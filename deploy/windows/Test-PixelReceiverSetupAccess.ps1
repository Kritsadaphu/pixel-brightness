[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SourceRoot)
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath $SourceRoot).Path
$data=Join-Path (Split-Path $root -Parent) 'preview-data'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
$elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if($elevated){throw 'Run this check with the normal interactive account, not elevated.'}
$stem=Join-Path $data ('receiver-access-test-'+[Guid]::NewGuid().ToString('N'))
$one=$stem+'.one'; $two=$stem+'.two'
try {
 [IO.File]::WriteAllText($one,'before')
 [IO.File]::WriteAllText($two,'after')
 [IO.File]::Replace($two,$one,[NullString]::Value)
 if([IO.File]::ReadAllText($one) -ne 'after'){throw 'Atomic replacement failed'}
 . (Join-Path $PSScriptRoot 'ReceiverCredentials.ps1')
 Import-PixelReceiverCredentials (Join-Path $data 'ndi-receiver-secrets.json')
 $profiles=Get-Content -LiteralPath (Join-Path $data 'ndi-receivers.json') -Raw | ConvertFrom-Json
 foreach($profile in $profiles){if(-not [Environment]::GetEnvironmentVariable($profile.passwordEnv,'Process')){throw 'Configured credential missing'}}
 $report=@{passed=$true;account=$identity.Name;elevated=$elevated;atomicReplace=$true;credentialsLoaded=$true;profileCount=@($profiles).Count;time=[DateTime]::UtcNow.ToString('o')}
 [IO.File]::WriteAllText((Join-Path $data 'receiver-access-check.json'),($report|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
 $report|ConvertTo-Json
} finally {
 foreach($file in @($one,$two)){if([IO.File]::Exists($file)){[IO.File]::Delete($file)}}
}
