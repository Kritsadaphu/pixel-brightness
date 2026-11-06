[CmdletBinding()]
param(
  [string]$SourceRoot = '',
  [string]$ShowUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name,
  [ValidateSet('All', 'Server', 'Node')]
  [string]$Role = 'All',
  [ValidateSet('CanonR50RfS1018', 'SonyA7IV', 'Disabled')]
  [string]$CameraProfile = 'CanonR50RfS1018',
  [string]$ServerUrl = 'http://127.0.0.1:4100',
  [string]$NodeTokenFile = '',
  [string]$ClusterTokenFile = '',
  [string]$NodeId = 'render-01',
  [string[]]$TrustedWebClient = @(),
  [string[]]$TrustedWebHost = @(),
  [switch]$SkipNativeBuild,
  [string]$ExpectedSourceManifestSha256 = '',
  [switch]$AllowUnverifiedDeveloperSource,
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Resolve script-relative defaults after parameter binding. Windows PowerShell
# can evaluate a parameter default before PSScriptRoot is populated.
if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
  $SourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..') -ErrorAction Stop).Path
}

$sourceIntegrityPath = Join-Path $PSScriptRoot 'SourceIntegrity.ps1'
if (-not (Test-Path -LiteralPath $sourceIntegrityPath -PathType Leaf)) {
  throw "Source-integrity policy is missing beside Setup: $sourceIntegrityPath"
}
. $sourceIntegrityPath

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function ConvertTo-SingleQuotedLiteral([string]$Value) {
  return "'" + $Value.Replace("'", "''") + "'"
}

function Get-BytesSha256([byte[]]$Value) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return -join ($algorithm.ComputeHash($Value) | ForEach-Object { $_.ToString('x2') })
  } finally {
    $algorithm.Dispose()
  }
}

function Assert-SourceArtifacts([string]$Root, [bool]$RequirePrebuilt) {
  $required = @(
    'deploy\windows\Install-PixelBrightness.ps1',
    'deploy\windows\RuntimeSecurity.ps1',
    'deploy\windows\UpgradeTransaction.ps1',
    'deploy\windows\Recover-PixelBrightnessUpgrade.ps1',
    'deploy\windows\CameraRuntime.ps1',
    'deploy\windows\Provision-PixelBrightnessCanonCamera.ps1',
    'deploy\windows\Start-PixelBrightness.ps1',
    'deploy\windows\ShowSchedule.ps1',
    'deploy\windows\ArenaSaveEvidence.ps1',
    'scripts\probe-camera-helper.mjs',
    'native\windows\CMakeLists.txt',
    'native\windows\shaders\fullscreen_vs.hlsl',
    'native\windows\shaders\final_ps.hlsl',
    'native\windows\config\renderer.example.json',
    'native\windows\config\renderer.schema.json',
    'config\windows-arena-final-processor.example.json'
  )
  if ($RequirePrebuilt) {
    $required += @(
      'native\windows\bin\pixel-brightness-renderer.exe',
      'native\windows\bin\shaders\fullscreen_vs.hlsl',
      'native\windows\bin\shaders\final_ps.hlsl'
    )
  }
  foreach ($relative in $required) {
    $path = Join-Path $Root $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -le 0) {
      throw "Required Windows build artifact is missing or empty: $path"
    }
  }
  if ($RequirePrebuilt) {
    $rendererPath = Join-Path $Root 'native\windows\bin\pixel-brightness-renderer.exe'
    $pe = [IO.File]::ReadAllBytes($rendererPath)
    if ($pe.Length -lt 256 -or $pe[0] -ne 0x4D -or $pe[1] -ne 0x5A) {
      throw "Prebuilt native renderer is not a Windows PE executable: $rendererPath"
    }
    $peOffset = [BitConverter]::ToInt32($pe, 0x3C)
    if ($peOffset -lt 0 -or $peOffset + 6 -gt $pe.Length -or
        $pe[$peOffset] -ne 0x50 -or $pe[$peOffset + 1] -ne 0x45 -or
        [BitConverter]::ToUInt16($pe, $peOffset + 4) -ne 0x8664) {
      throw "Prebuilt native renderer is not x64: $rendererPath"
    }
  }
  foreach ($relative in @(
    'native\windows\config\renderer.example.json',
    'native\windows\config\renderer.schema.json',
    'config\windows-arena-final-processor.example.json'
  )) {
    $path = Join-Path $Root $relative
    try { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json | Out-Null }
    catch { throw "Windows contract is invalid JSON ($path): $($_.Exception.Message)" }
  }
  $cmake = Get-Content -LiteralPath (Join-Path $Root 'native\windows\CMakeLists.txt') -Raw
  foreach ($token in @('pixel-brightness-renderer', 'fullscreen_vs.hlsl', 'final_ps.hlsl')) {
    if ($cmake -notmatch [regex]::Escape($token)) { throw "Native CMake target is missing $token" }
  }
}

try {
  if (-not [string]::IsNullOrWhiteSpace($ClusterTokenFile)) {
    throw 'ClusterTokenFile is retired and cannot be elevated or installed. Generate a nodeId-bound credential and pass -NodeTokenFile.'
  }
  $sourceIntegrity = Assert-PixelBrightnessSourceManifest -SourceRoot $SourceRoot `
    -ExpectedManifestSha256 $ExpectedSourceManifestSha256 `
    -AllowMissing:$AllowUnverifiedDeveloperSource
  if ($null -ne $sourceIntegrity.ManifestSha256) {
    $ExpectedSourceManifestSha256 = [string]$sourceIntegrity.ManifestSha256
  }
  # A browser opened on the same all-in-one Windows host is a trusted local
  # operator and should not require the control-token Pair step. This does not
  # trust any LAN address: remote controllers remain token-protected unless the
  # operator supplies their exact IP and host explicitly.
  if ($Role -eq 'All' -and $TrustedWebClient.Count -eq 0 -and $TrustedWebHost.Count -eq 0) {
    $TrustedWebClient = @('127.0.0.1', '::1')
    $TrustedWebHost = @('localhost', '127.0.0.1', '::1')
  }

  if (-not (Test-Administrator)) {
    if ($Elevated) { throw 'Administrator elevation did not succeed.' }
    Write-Host 'Windows will now request Administrator approval through UAC. Pixel Brightness never asks for or stores the Windows password.' -ForegroundColor Yellow
    $scriptLiteral = ConvertTo-SingleQuotedLiteral $PSCommandPath
    $showUserLiteral = ConvertTo-SingleQuotedLiteral $ShowUser
    $sourceLiteral = ConvertTo-SingleQuotedLiteral $SourceRoot
    $roleLiteral = ConvertTo-SingleQuotedLiteral $Role
    $cameraProfileLiteral = ConvertTo-SingleQuotedLiteral $CameraProfile
    $serverLiteral = ConvertTo-SingleQuotedLiteral $ServerUrl
    $nodeIdLiteral = ConvertTo-SingleQuotedLiteral $NodeId
    $nodeTokenArgument = ''
    if (-not [string]::IsNullOrWhiteSpace($NodeTokenFile)) {
      $nodeTokenArgument = " -NodeTokenFile $(ConvertTo-SingleQuotedLiteral $NodeTokenFile)"
    }
    $trustedArguments = ''
    if ($TrustedWebClient.Count -gt 0) {
      $clientExpression = ($TrustedWebClient | ForEach-Object { ConvertTo-SingleQuotedLiteral ([string]$_) }) -join ','
      $trustedArguments += " -TrustedWebClient $clientExpression"
    }
    if ($TrustedWebHost.Count -gt 0) {
      $hostExpression = ($TrustedWebHost | ForEach-Object { ConvertTo-SingleQuotedLiteral ([string]$_) }) -join ','
      $trustedArguments += " -TrustedWebHost $hostExpression"
    }
    $skip = if ($SkipNativeBuild) { ' -SkipNativeBuild' } else { '' }
    $manifestArgument = if ([string]::IsNullOrWhiteSpace($ExpectedSourceManifestSha256)) { '' } else {
      " -ExpectedSourceManifestSha256 $(ConvertTo-SingleQuotedLiteral $ExpectedSourceManifestSha256)"
    }
    $developerArgument = if ($AllowUnverifiedDeveloperSource) { ' -AllowUnverifiedDeveloperSource' } else { '' }
    if (-not [string]::IsNullOrWhiteSpace([string]$sourceIntegrity.ManifestSha256)) {
      $bootstrapRelative = 'deploy/windows/ElevatedBootstrap.ps1'
      if ($null -eq $sourceIntegrity.FileDigests -or -not $sourceIntegrity.FileDigests.ContainsKey($bootstrapRelative)) {
        throw "Source manifest does not bind the protected elevation bootstrap: $bootstrapRelative"
      }
      $bootstrapPath = Join-Path $SourceRoot 'deploy\windows\ElevatedBootstrap.ps1'
      $bootstrapBytes = [IO.File]::ReadAllBytes($bootstrapPath)
      $bootstrapDigest = Get-BytesSha256 $bootstrapBytes
      if (-not [string]::Equals(
        $bootstrapDigest,
        [string]$sourceIntegrity.FileDigests[$bootstrapRelative],
        [StringComparison]::Ordinal
      )) {
        throw 'Elevation bootstrap changed after source verification; UAC was not requested.'
      }
      $bootstrapText = [Text.UTF8Encoding]::new($false, $true).GetString($bootstrapBytes)
      $setupOptions = [ordered]@{
        showUser = $ShowUser
        role = $Role
        cameraProfile = $CameraProfile
        serverUrl = $ServerUrl
        nodeTokenFile = $NodeTokenFile
        nodeId = $NodeId
        trustedWebClient = @($TrustedWebClient)
        trustedWebHost = @($TrustedWebHost)
        skipNativeBuild = [bool]$SkipNativeBuild
      }
      $optionsJson = $setupOptions | ConvertTo-Json -Compress -Depth 4
      $optionsBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($optionsJson))
      $command = $bootstrapText + "`r`nInvoke-PixelBrightnessElevatedBootstrap" +
        " -SourceRoot $sourceLiteral" +
        " -ExpectedManifestSha256 $(ConvertTo-SingleQuotedLiteral $ExpectedSourceManifestSha256)" +
        " -SetupOptionsBase64 $(ConvertTo-SingleQuotedLiteral $optionsBase64)"
    } else {
      Write-Warning 'Developer bypass selected: elevated Setup will execute from the unverified checkout. Never use this path for a release installation.'
      $command = "& $scriptLiteral -SourceRoot $sourceLiteral -ShowUser $showUserLiteral -Role $roleLiteral -CameraProfile $cameraProfileLiteral -ServerUrl $serverLiteral -NodeId $nodeIdLiteral$nodeTokenArgument$trustedArguments$manifestArgument$developerArgument -Elevated$skip"
    }
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $process = Start-Process -FilePath $powerShell -Verb RunAs -ArgumentList @(
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded
    ) -Wait -PassThru
    exit $process.ExitCode
  }

  $installNode = $Role -in @('All', 'Node')
  Assert-SourceArtifacts $SourceRoot ([bool]($installNode -and $SkipNativeBuild))
  $preflight = Join-Path $PSScriptRoot 'Preflight-PixelBrightness.ps1'
  $installer = Join-Path $PSScriptRoot 'Install-PixelBrightness.ps1'
  & $preflight -RequireRenderHost:$installNode -RequireArena:$installNode `
    -RequireNativeToolchain:($installNode -and -not $SkipNativeBuild)
  & $installer -SourceRoot $SourceRoot -ShowUser $ShowUser -Role $Role -CameraProfile $CameraProfile `
    -ServerUrl $ServerUrl -NodeTokenFile $NodeTokenFile -NodeId $NodeId `
    -TrustedWebClient $TrustedWebClient -TrustedWebHost $TrustedWebHost `
    -ExpectedSourceManifestSha256 $ExpectedSourceManifestSha256 `
    -AllowUnverifiedDeveloperSource:$AllowUnverifiedDeveloperSource `
    -Appliance -SkipNativeBuild:$SkipNativeBuild -Confirm:$false

  Write-Host ''
  if ($installNode) {
    Write-Host 'Installation finished safely. PixelBrightness-Show is DISABLED until physical projectors are committed by Bind-PixelBrightnessDisplays.ps1.' -ForegroundColor Green
    Write-Host "Next: & 'C:\ProgramData\Pixel Brightness\Bind-PixelBrightnessDisplays.ps1' -GdiName '\\.\DISPLAY2','\\.\DISPLAY3' -Overlap 240 -StartShow"
  } else {
    Write-Host 'Central Pixel Brightness Server/Web installation finished safely.' -ForegroundColor Green
  }
} catch {
  Write-Error $_ -ErrorAction Continue
  if ($Elevated) {
    Write-Host ''
    Write-Host 'Setup stopped before completion. Read the error above, then press Enter to close this Administrator window.' -ForegroundColor Red
    [void](Read-Host)
  }
  exit 1
}
