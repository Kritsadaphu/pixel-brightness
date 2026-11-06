[CmdletBinding()]
param(
  [switch]$RequireArena,
  [switch]$RequireRenderHost,
  [switch]$RequireNativeToolchain
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'RuntimeSecurity.ps1')

function Write-Check([string]$Name, [bool]$Pass, [string]$Detail) {
  $label = if ($Pass) { 'PASS' } else { 'FAIL' }
  $colour = if ($Pass) { 'Green' } else { 'Red' }
  Write-Host ("[{0}] {1} - {2}" -f $label, $Name, $Detail) -ForegroundColor $colour
  return $Pass
}

function Find-CommandPath([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $command) { return $null }
  return $command.Source
}

$failed = $false
$windows = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
$failed = -not (Write-Check 'Windows host' $windows ([System.Environment]::OSVersion.VersionString)) -or $failed

$is64 = [Environment]::Is64BitOperatingSystem
$failed = -not (Write-Check '64-bit operating system' $is64 $env:PROCESSOR_ARCHITECTURE) -or $failed

$caption = if ($windows) { (Get-CimInstance Win32_OperatingSystem).Caption } else { 'not Windows' }
$windows11 = $caption -match 'Windows 11'
$failed = -not (Write-Check 'Windows 11' $windows11 $caption) -or $failed

$nodePath = Find-CommandPath 'node.exe'
$nodeVersion = if ($nodePath) { (& $nodePath --version).TrimStart('v') } else { 'missing' }
$nodeOk = $nodePath -and ([version]$nodeVersion -ge [version]'22.13.0')
$failed = -not (Write-Check 'Node.js 22.13+' ([bool]$nodeOk) $nodeVersion) -or $failed

$npmPath = Find-CommandPath 'npm.cmd'
$npmDetail = if ($npmPath) { $npmPath } else { 'missing' }
$failed = -not (Write-Check 'npm' ([bool]$npmPath) $npmDetail) -or $failed

$runtimeProtectionDetail = 'Node.js/npm are missing'
$runtimeProtectionOk = $false
if ($nodePath -and $npmPath) {
  try {
    $protectedRuntime = Assert-ProtectedNodeRuntime $nodePath $npmPath
    $runtimeProtectionDetail = [string]$protectedRuntime.node
    $runtimeProtectionOk = $true
  } catch {
    $runtimeProtectionDetail = $_.Exception.Message
  }
}
$failed = -not (Write-Check 'Administrator-protected Node.js runtime' $runtimeProtectionOk $runtimeProtectionDetail) -or $failed

$nvidia = Find-CommandPath 'nvidia-smi.exe'
if (-not $nvidia) {
  $candidate = Join-Path $env:ProgramFiles 'NVIDIA Corporation\NVSMI\nvidia-smi.exe'
  if (Test-Path -LiteralPath $candidate) { $nvidia = $candidate }
}
$gpuDetail = 'NVIDIA driver not detected'
if ($nvidia) {
  $gpuDetail = (& $nvidia --query-gpu=name,driver_version --format=csv,noheader 2>$null | Select-Object -First 1)
}
Write-Check 'NVIDIA display driver' ([bool]$nvidia) $gpuDetail | Out-Null
if ($RequireRenderHost -and -not $nvidia) { $failed = $true }

$arenaCandidates = [System.Collections.Generic.List[string]]::new()
foreach ($programRoot in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
  if (-not $programRoot -or -not (Test-Path -LiteralPath $programRoot -PathType Container)) { continue }
  $standard = Join-Path $programRoot 'Resolume Arena\Arena.exe'
  if (Test-Path -LiteralPath $standard -PathType Leaf) { $arenaCandidates.Add($standard) }
  foreach ($directory in @(Get-ChildItem -LiteralPath $programRoot -Directory -Filter 'Resolume Arena*' -ErrorAction SilentlyContinue)) {
    $candidate = Join-Path $directory.FullName 'Arena.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $arenaCandidates.Add($candidate) }
  }
}
$arenaCandidates = @($arenaCandidates | Select-Object -Unique)
$arenaOk = $arenaCandidates.Count -gt 0
Write-Check 'Resolume Arena' $arenaOk ($(if ($arenaOk) { $arenaCandidates[0] } else { 'not found in the standard install path' })) | Out-Null
if ($RequireArena -and -not $arenaOk) { $failed = $true }

if ($RequireNativeToolchain) {
  $git = Find-CommandPath 'git.exe'
  $gitDetail = if ($git) { $git } else { 'missing (required by pinned CMake FetchContent dependencies)' }
  $failed = -not (Write-Check 'Git for Windows' ([bool]$git) $gitDetail) -or $failed
  $cmake = Find-CommandPath 'cmake.exe'
  $cmakeDetail = if ($cmake) { $cmake } else { 'missing' }
  $failed = -not (Write-Check 'CMake' ([bool]$cmake) $cmakeDetail) -or $failed
  $ctest = Find-CommandPath 'ctest.exe'
  $ctestDetail = if ($ctest) { $ctest } else { 'missing' }
  $failed = -not (Write-Check 'CTest' ([bool]$ctest) $ctestDetail) -or $failed
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  $msvc = Test-Path -LiteralPath $vswhere
  if ($msvc) {
    $install = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    $msvc = -not [string]::IsNullOrWhiteSpace($install)
  }
  $failed = -not (Write-Check 'MSVC C++ x64 toolchain' $msvc ($(if ($msvc) { $install } else { 'Visual Studio Build Tools C++ workload missing' }))) -or $failed
}

$remoteSession = $env:SESSIONNAME -like 'RDP-*'
Write-Check 'Physical console session' (-not $remoteSession) ($(if ($remoteSession) { $env:SESSIONNAME } else { 'local/console session' })) | Out-Null
if ($remoteSession) {
  Write-Warning 'Do not configure or validate projector topology through RDP.'
}

$networkProfiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object {
  $_.IPv4Connectivity -ne 'Disconnected' -or $_.IPv6Connectivity -ne 'Disconnected'
})
$privateProfiles = @($networkProfiles | Where-Object { $_.NetworkCategory -eq 'Private' })
$networkDetail = if ($networkProfiles.Count -eq 0) {
  'no active network profile'
} else {
  (($networkProfiles | ForEach-Object { "$($_.InterfaceAlias)=$($_.NetworkCategory)" }) -join ', ')
}
$failed = -not (Write-Check 'Private control network' ($privateProfiles.Count -gt 0) $networkDetail) -or $failed

if ($failed) {
  throw 'Pixel Brightness Windows preflight failed. Fix every FAIL item before installation.'
}

Write-Host 'Pixel Brightness Windows preflight passed.' -ForegroundColor Green
