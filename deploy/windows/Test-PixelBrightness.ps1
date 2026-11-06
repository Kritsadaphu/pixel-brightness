[CmdletBinding()]
param(
  [switch]$Full,
  [string]$DataRoot = (Join-Path $env:ProgramData 'Pixel Brightness'),
  [string]$ControlTokenFile = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'RuntimeSecurity.ps1')
$upgradeTransactionPath = Join-Path $PSScriptRoot 'UpgradeTransaction.ps1'
if (-not (Test-Path -LiteralPath $upgradeTransactionPath -PathType Leaf)) {
  throw "Display binding authority policy is missing beside acceptance: $upgradeTransactionPath"
}
$null = Assert-AdminProtectedItem (Get-Item -LiteralPath $upgradeTransactionPath -Force -ErrorAction Stop) 'Display binding authority policy'
. $upgradeTransactionPath
$cameraRuntimePath = Join-Path $PSScriptRoot 'CameraRuntime.ps1'
if (-not (Test-Path -LiteralPath $cameraRuntimePath -PathType Leaf)) {
  throw "Camera-runtime authority policy is missing beside acceptance: $cameraRuntimePath"
}
$null = Assert-AdminProtectedItem (Get-Item -LiteralPath $cameraRuntimePath -Force -ErrorAction Stop) 'Camera-runtime authority policy'
. $cameraRuntimePath

$failures = [System.Collections.Generic.List[string]]::new()
function Test-Item([string]$Name, [scriptblock]$Probe) {
  try {
    $detail = & $Probe
    Write-Host "[PASS] $Name - $detail" -ForegroundColor Green
  } catch {
    $failures.Add("${Name}: $($_.Exception.Message)")
    Write-Host "[FAIL] $Name - $($_.Exception.Message)" -ForegroundColor Red
  }
}

function Read-RequiredJson([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing: $Path" }
  try {
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
  } catch {
    throw "$Label is not valid JSON: $($_.Exception.Message)"
  }
}

function Read-ProtectedDisplayBindingAuthority([string]$Root) {
  # The copies below config\ are replaceable by the interactive Show user and
  # are never acceptance authority. This helper applies the same active-gate,
  # protected-parent, generation and exact-hash verification as the launcher.
  $null = Assert-PixelBrightnessDisplayBindingLauncherGate $Root
  $binding = Read-PixelBrightnessDisplayBindingCommit $Root
  if ($null -eq $binding) {
    throw 'Protected display binding commit is missing; run the binder as Administrator.'
  }
  if (-not [string]::Equals([string]$binding.releaseRoot, (Get-CurrentRelease), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Protected display binding commit belongs to a different release.'
  }
  $nodeConfig = Read-RequiredJson ([string]$binding.generation.NodePath) 'Immutable display binding Node config'
  return [pscustomobject]@{ Binding = $binding; NodeConfig = $nodeConfig }
}

function Read-ControlToken([string]$Root, [string]$TransportFile) {
  $path = if ([string]::IsNullOrWhiteSpace($TransportFile)) {
    Join-Path $Root 'secrets\control-token.txt'
  } else {
    (Resolve-Path -LiteralPath $TransportFile -ErrorAction Stop).Path
  }
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Control token is missing: $path. A render-only host requires -ControlTokenFile from the central Server for operator acceptance."
  }
  $token = (Get-Content -LiteralPath $path -Raw).Trim()
  if ($token -notmatch '^[A-Za-z0-9_-]{43,128}$') {
    throw 'Control token is empty or invalid; authenticated operator acceptance cannot continue.'
  }
  return $token
}

function Assert-AcceptanceAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run Test-PixelBrightness.ps1 from Windows Terminal as Administrator; the Node process never receives the operator control token.'
  }
}

function Assert-SameText([string]$Left, [string]$Right, [string]$Label) {
  if (-not [string]::Equals($Left, $Right, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label does not match the committed display binding"
  }
}

function Assert-OptionalCameraHelper([object]$NodeConfig, [string]$ReleasePath) {
  $helperValue = [string]$NodeConfig.cameraHelperCommand
  if ([string]::IsNullOrWhiteSpace($helperValue)) {
    throw 'Sony camera helper is not installed; measured camera calibration is unavailable'
  }
  if ([string]$NodeConfig.cameraBackend -cne 'sony-sdk') {
    throw 'cameraHelperCommand is configured for an unexpected camera backend'
  }
  $helper = [IO.Path]::GetFullPath($helperValue)
  $releasePrefix = [IO.Path]::GetFullPath($ReleasePath).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $helper.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "camera helper is outside the protected immutable release: $helper"
  }
  if (-not (Test-Path -LiteralPath $helper -PathType Leaf) -or (Get-Item -LiteralPath $helper -Force).Length -le 0) {
    throw "configured camera helper is missing or empty: $helper"
  }
  $item = Get-Item -LiteralPath $helper -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "camera helper is a reparse point: $helper"
  }
  return "$helper / protected release descendant"
}

function Invoke-CanonCameraPhysicalProbe {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$ReleasePath,
    [Parameter(Mandatory = $true)][object]$VerifiedAuthority
  )
  $runtimeConfig = Read-RequiredJson (Join-Path $Root 'secrets\runtime.json') 'Pinned Node.js runtime config'
  $node = (Assert-ProtectedNodeRuntime ([string]$runtimeConfig.node) ([string]$runtimeConfig.npm)).node
  $probe = Join-Path $ReleasePath 'scripts\probe-camera-helper.mjs'
  $probeItem = Assert-PixelBrightnessPlainFile $probe 'Canon camera physical probe'
  if ($null -eq $probeItem) { throw "Canon camera physical probe is missing: $probe" }
  $logRoot = Join-Path $Root 'logs\show'
  $null = Assert-PixelBrightnessPlainFile ([string]$VerifiedAuthority.AuthorityPath) 'Canon camera runtime authority'
  $nonce = [guid]::NewGuid().ToString('N')
  $stdoutPath = Join-Path $logRoot "canon-camera-probe-$nonce.out.json"
  $stderrPath = Join-Path $logRoot "canon-camera-probe-$nonce.err.log"
  $arguments = "scripts/probe-camera-helper.mjs --authority `"$($VerifiedAuthority.AuthorityPath)`" --timeout-ms 45000"
  $process = $null
  try {
    $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $ReleasePath `
      -PassThru -NoNewWindow -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    if (-not $process.WaitForExit(90000)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      throw 'Canon EOS R50 USB/RAW physical probe exceeded 90 seconds'
    }
    $stdoutItem = Get-Item -LiteralPath $stdoutPath -Force -ErrorAction Stop
    if ($stdoutItem.Length -le 0 -or $stdoutItem.Length -gt 1MB) {
      throw 'Canon camera physical probe returned an empty or oversized result'
    }
    $lines = @(Get-Content -LiteralPath $stdoutPath -Encoding UTF8 | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($lines.Count -ne 1) { throw 'Canon camera physical probe must return exactly one JSON record' }
    try { $result = $lines[0] | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "Canon camera physical probe returned invalid JSON: $($_.Exception.Message)" }
    if ($process.ExitCode -ne 0 -or $result.ok -ne $true -or
        $result.configured -ne $true -or $result.physicallyAccepted -ne $true) {
      $message = [string]$result.error.message
      if ([string]::IsNullOrWhiteSpace($message)) {
        $message = "probe exited $($process.ExitCode) without physicallyAccepted=true"
      }
      throw $message
    }
    if ([string]$result.backend -cne 'canon-edsdk' -or [string]$result.model -cne 'EOS R50' -or
        [string]$result.lens -cne 'RF-S10-18mm F4.5-6.3 IS STM' -or
        [string]$result.transport -cne 'usb' -or [string]$result.rawFormat -cne 'CR3' -or
        [int]$result.sourceBitDepth -ne 14) {
      throw 'Canon camera physical probe returned a different body, lens, transport, or RAW contract'
    }
    return 'configured=true / physicallyAccepted=true / EOS R50 USB / RF-S10-18 at 10 mm / 14-bit CR3'
  } finally {
    if ($null -ne $process -and -not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    foreach ($path in @($stdoutPath, $stderrPath)) {
      if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    }
  }
}

function Get-CurrentRelease {
  $pointer = Join-Path $DataRoot 'current-release.txt'
  if (-not (Test-Path -LiteralPath $pointer -PathType Leaf)) { throw "missing $pointer" }
  $release = (Get-Content -LiteralPath $pointer -Raw).Trim()
  if (-not (Test-Path -LiteralPath $release -PathType Container)) { throw "missing $release" }
  return $release
}

function Assert-NativeBundle([string]$ReleasePath) {
  $nativeBin = Join-Path $ReleasePath 'native\windows\bin'
  foreach ($relative in @(
    'pixel-brightness-renderer.exe',
    'shaders\fullscreen_vs.hlsl',
    'shaders\final_ps.hlsl'
  )) {
    $path = Join-Path $nativeBin $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -le 0) {
      throw "missing or empty $path"
    }
  }
  $rendererPath = Join-Path $nativeBin 'pixel-brightness-renderer.exe'
  $pe = [IO.File]::ReadAllBytes($rendererPath)
  if ($pe.Length -lt 256 -or $pe[0] -ne 0x4D -or $pe[1] -ne 0x5A) { throw 'renderer is not a Windows PE executable' }
  $peOffset = [BitConverter]::ToInt32($pe, 0x3C)
  if ($peOffset -lt 0 -or $peOffset + 6 -gt $pe.Length -or
      $pe[$peOffset] -ne 0x50 -or $pe[$peOffset + 1] -ne 0x45 -or
      [BitConverter]::ToUInt16($pe, $peOffset + 4) -ne 0x8664) {
    throw 'renderer is not an x64 Windows PE executable'
  }
  return $rendererPath
}

function Assert-AcPowerIndexZero([string]$Subgroup, [string]$Setting, [string]$Label) {
  $powerRoot = 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes'
  $active = [string](Get-ItemProperty -LiteralPath $powerRoot -Name ActivePowerScheme -ErrorAction Stop).ActivePowerScheme
  $active = $active.Trim([char[]]'{}')
  $settingPath = Join-Path (Join-Path (Join-Path $powerRoot $active) $Subgroup) $Setting
  $index = [uint32](Get-ItemProperty -LiteralPath $settingPath -Name ACSettingIndex -ErrorAction Stop).ACSettingIndex
  if ($index -ne 0) { throw "$Label ACSettingIndex is $index, expected 0 (never)" }
}

function Assert-FreshTelemetry([object]$Telemetry) {
  $updated = [DateTimeOffset]::Parse([string]$Telemetry.updatedAt).ToUniversalTime()
  $age = [DateTimeOffset]::UtcNow - $updated
  if ($age.TotalSeconds -lt -5 -or $age.TotalSeconds -gt 5) {
    throw "renderer telemetry is stale by $([Math]::Round($age.TotalSeconds, 1)) seconds"
  }
}

function Get-UInt32CounterDelta([object]$Before, [object]$After, [string]$Label) {
  try {
    $beforeValue = [uint64]$Before
    $afterValue = [uint64]$After
  } catch {
    throw "$Label is not an unsigned 32-bit counter"
  }
  if ($beforeValue -gt [uint32]::MaxValue -or $afterValue -gt [uint32]::MaxValue) {
    throw "$Label is outside the unsigned 32-bit range"
  }
  if ($afterValue -ge $beforeValue) { return $afterValue - $beforeValue }
  return ([uint64][uint32]::MaxValue + 1) - $beforeValue + $afterValue
}

function Send-OutputPatternCommand(
  [string]$ServerUrl,
  [hashtable]$Headers,
  [string]$NodeId,
  [string]$OutputId,
  [bool]$Enabled,
  [ValidateSet('identify', 'content')][string]$Type
) {
  $encodedOutputId = [Uri]::EscapeDataString($OutputId)
  $body = [ordered]@{
    enabled = $Enabled
    type = $Type
    cellSize = 32
    nodeIds = @($NodeId)
  } | ConvertTo-Json -Depth 4 -Compress
  $response = Invoke-RestMethod `
    -Uri "$ServerUrl/v1/outputs/$encodedOutputId/pattern" `
    -Method Post `
    -Headers $Headers `
    -ContentType 'application/json' `
    -Body $body `
    -TimeoutSec 5
  $ownerIds = @($response.nodeIds | ForEach-Object { [string]$_ })
  if ($ownerIds.Count -ne 1 -or $ownerIds[0] -cne $NodeId) {
    throw "Pattern command for output $OutputId was not assigned exclusively to node $NodeId"
  }
  $commands = @($response.commands)
  if ($commands.Count -ne 1 -or [int64]$commands[0].sequence -lt 1) {
    throw "Server did not return one durable command sequence for output $OutputId"
  }
  return [pscustomobject]@{
    Id = [string]$commands[0].id
    Sequence = [int64]$commands[0].sequence
    Type = [string]$commands[0].type
  }
}

function Wait-NodeCommandAck(
  [string]$ServerUrl,
  [hashtable]$Headers,
  [string]$NodeId,
  [int64]$Sequence,
  [int]$TimeoutSeconds = 20
) {
  $encodedNodeId = [Uri]::EscapeDataString($NodeId)
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $lastAck = -1
  $lastStatus = 'unknown'
  while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    $detail = Invoke-RestMethod -Uri "$ServerUrl/v1/nodes/$encodedNodeId" -Headers $Headers -TimeoutSec 5
    $lastAck = [int64]$detail.node.ackSequence
    $lastStatus = [string]$detail.node.status
    if ($lastStatus -eq 'offline') { throw "Node $NodeId went offline while waiting for command $Sequence" }
    if ($lastAck -ge $Sequence) { return $detail }
    Start-Sleep -Milliseconds 250
  }
  throw "Node $NodeId did not acknowledge command $Sequence in ${TimeoutSeconds}s (last ack $lastAck, status $lastStatus)"
}

function Wait-NativeOutputPatterns(
  [string]$TelemetryPath,
  [string[]]$ExpectedOutputIds,
  [ValidateSet('identify', 'content')][string]$Mode,
  [string]$TargetOutputId = '',
  [int]$TimeoutSeconds = 12
) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $lastSummary = 'telemetry unavailable'
  while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    try {
      $telemetry = Read-RequiredJson $TelemetryPath 'Native renderer telemetry'
      Assert-FreshTelemetry $telemetry
      $reported = @($telemetry.outputs)
      $matches = $reported.Count -eq $ExpectedOutputIds.Count
      if ($matches) {
        foreach ($expectedOutputId in $ExpectedOutputIds) {
          if (@($reported | Where-Object { [string]$_.id -ceq $expectedOutputId }).Count -ne 1) {
            $matches = $false
            break
          }
        }
      }
      $lastSummary = @($reported | ForEach-Object { "$($_.id)=$($_.pattern)/active:$($_.active)/blank:$($_.blank)" }) -join ', '
      if ($matches) {
        foreach ($output in $reported) {
          if ($output.active -ne $true -or $output.blank -eq $true) { $matches = $false; break }
          $expectedPattern = if ($Mode -eq 'content') {
            'content'
          } elseif ([string]$output.id -ceq $TargetOutputId) {
            'identify'
          } else {
            'black'
          }
          if ([string]$output.pattern -cne $expectedPattern) { $matches = $false; break }
        }
      }
      if ($matches -and $Mode -eq 'content' -and $telemetry.compositionSource.state -ne 'connected') {
        $matches = $false
        $lastSummary += ", source=$($telemetry.compositionSource.state)"
      }
      if ($matches) { return $telemetry }
    } catch {
      $lastSummary = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 200
  }
  if ($Mode -eq 'identify') {
    throw "Native renderer did not isolate identify pattern on $TargetOutputId in ${TimeoutSeconds}s ($lastSummary)"
  }
  throw "Native renderer did not restore every output to live content in ${TimeoutSeconds}s ($lastSummary)"
}

Assert-AcceptanceAdministrator
# Acceptance is read-only but must observe one coherent launch/binding
# generation. Holding the shared barrier for the whole run prevents a binder
# or installer from publishing its gate immediately after an early authority
# check and turning the remaining probes into a stale false pass.
$acceptanceLaunchBarrier = Enter-PixelBrightnessReleaseLaunchBarrier
try {
$protectedDataRoot = Assert-PixelBrightnessControlPlane -DataRoot $DataRoot -IncludeSystemDirectories
$installationPath = Join-Path $DataRoot 'secrets\installation.json'
$installation = if (Test-Path -LiteralPath $installationPath -PathType Leaf) {
  Read-RequiredJson $installationPath 'Installation role'
} else {
  # Backward-compatible audit for pre-role single-PC installs.
  [pscustomobject]@{ role = 'All'; serverUrl = 'http://127.0.0.1:4100' }
}
$installedRole = [string]$installation.role
if ($installedRole -notin @('All', 'Server', 'Node')) { throw "Unknown installed role: $installedRole" }
$installServer = $installedRole -in @('All', 'Server')
$installNode = $installedRole -in @('All', 'Node')
$serverBaseUrl = ([string]$installation.serverUrl).Trim().TrimEnd('/')

Test-Item 'Protected ProgramData control plane' {
  "$protectedDataRoot / trusted owner and no low-privilege control-file writer"
}

Test-Item 'Current release' {
  Get-CurrentRelease
}

Test-Item 'Immutable release ACL and reparse safety' {
  $release = Assert-AdminProtectedReleaseLocation (Get-CurrentRelease)
  "$release / protected Program Files parent and every descendant administrator-owned and Show read-only"
}

Test-Item 'Administrator-protected Node.js runtime' {
  $runtime = Read-RequiredJson (Join-Path $DataRoot 'secrets\runtime.json') 'Pinned Node.js runtime config'
  $protectedRuntime = Assert-ProtectedNodeRuntime ([string]$runtime.node) ([string]$runtime.npm)
  "$($protectedRuntime.node) / protected Program Files ACL"
}

if ($installNode) {
  Test-Item 'Exact native renderer bundle' {
    $renderer = Assert-NativeBundle (Get-CurrentRelease)
    "$renderer plus both HLSL shaders"
  }

  $cameraAuthority = Read-PixelBrightnessCameraRuntimeAuthority -DataRoot $DataRoot `
    -InstallRoot (Split-Path (Split-Path (Get-CurrentRelease) -Parent) -Parent) -AllowMissing
  if ($null -eq $cameraAuthority) {
    Test-Item 'Explicit legacy Sony camera helper configured' {
      $nodeConfig = (Read-ProtectedDisplayBindingAuthority $DataRoot).NodeConfig
      if ([string]$nodeConfig.cameraBackend -cne 'sony-sdk' -or [string]$nodeConfig.cameraExpectedModel -cne 'ILCE-7M4') {
        throw 'No protected camera authority exists and immutable Node config is not the explicit Sony A7 IV legacy profile'
      }
      Assert-OptionalCameraHelper $nodeConfig (Get-CurrentRelease)
    }
  } elseif ([string]$cameraAuthority.Authority.backend -ceq 'disabled') {
    Test-Item 'Camera explicitly disabled' { 'configured=false / physicallyAccepted=false / operator-selected disabled profile' }
  } else {
    Test-Item 'Canon camera runtime configured' {
      $verified = Read-PixelBrightnessCameraRuntimeAuthority -DataRoot $DataRoot `
        -InstallRoot (Split-Path (Split-Path (Get-CurrentRelease) -Parent) -Parent) -RequireConfigured
      if ([string]$verified.Authority.backend -cne 'canon-edsdk' -or
          [string]$verified.Authority.profile.camera.model -cne 'EOS R50' -or
          [string]$verified.Authority.profile.lens.model -cne 'RF-S10-18mm F4.5-6.3 IS STM') {
        throw 'Protected camera authority is not the exact Canon R50 + RF-S10-18 profile'
      }
      "configured=true / manifest $($verified.Runtime.ManifestSha256) / $($verified.Runtime.FileCount) exact runtime files"
    }
    if ($Full) {
      Test-Item 'Canon EOS R50 USB, lens and 14-bit CR3 physical acceptance' {
        $verified = Read-PixelBrightnessCameraRuntimeAuthority -DataRoot $DataRoot `
          -InstallRoot (Split-Path (Split-Path (Get-CurrentRelease) -Parent) -Parent) -RequireConfigured
        Invoke-CanonCameraPhysicalProbe -Root $DataRoot -ReleasePath (Get-CurrentRelease) -VerifiedAuthority $verified
      }
    }
  }

  Test-Item 'Protected committed display binding authority' {
    $binding = (Read-ProtectedDisplayBindingAuthority $DataRoot).Binding
    $count = @($binding.outputs).Count
    if ($count -lt 1) { throw 'binding has no outputs' }
    "$count stable outputs"
  }
}

$expectedTasks = @()
if ($installServer) { $expectedTasks += @('PixelBrightness-Server', 'PixelBrightness-Web') }
if ($installNode) { $expectedTasks += 'PixelBrightness-Show' }
foreach ($name in $expectedTasks) {
  Test-Item "Scheduled task $name" {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
    if ($Full -and $task.State -ne 'Running') { throw "task state is $($task.State), expected Running" }
    if ($name -eq 'PixelBrightness-Show' -and $task.State -eq 'Disabled') { throw 'Show is disabled/unbound' }
    "$($task.State) / $($task.Settings.ExecutionTimeLimit)"
  }
}

Test-Item 'Pixel Server health' {
  $health = Invoke-RestMethod -Uri "$serverBaseUrl/v1/health" -TimeoutSec 5
  if ($health.accessMode -eq 'open') { throw 'control API is running without authentication' }
  "$($health.service) $($health.version) / $($health.accessMode)"
}

if ($installNode) {
  Test-Item 'Authenticated Node registration and heartbeat' {
    $authority = Read-ProtectedDisplayBindingAuthority $DataRoot
    $nodeConfig = $authority.NodeConfig
    $binding = $authority.Binding
    $nodeId = [string]$nodeConfig.nodeId
    if ($nodeId -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$') { throw 'Node config contains an invalid nodeId' }
    $token = Read-ControlToken $DataRoot $ControlTokenFile
    $headers = @{ Authorization = "Bearer $token" }
    $encodedNodeId = [Uri]::EscapeDataString($nodeId)
    $detail = Invoke-RestMethod -Uri "$serverBaseUrl/v1/nodes/$encodedNodeId" -Headers $headers -TimeoutSec 5
    if ([string]$detail.node.nodeId -ne $nodeId) { throw "Server returned a different nodeId: $($detail.node.nodeId)" }
    if ([string]$detail.node.status -eq 'offline') { throw 'Server reports this render node offline' }
    $lastSeen = [DateTimeOffset]::Parse([string]$detail.node.lastSeenAt).ToUniversalTime()
    $heartbeatAge = [DateTimeOffset]::UtcNow - $lastSeen
    if ($heartbeatAge.TotalSeconds -lt -5 -or $heartbeatAge.TotalSeconds -gt 10) {
      throw "Node heartbeat is stale by $([Math]::Round($heartbeatAge.TotalSeconds, 1)) seconds"
    }
    $configuredIds = @($nodeConfig.outputs | Where-Object { $_.enabled -eq $true } | ForEach-Object { [string]$_.id } | Sort-Object)
    $registeredIds = @($detail.node.capabilities.outputs | ForEach-Object { [string]$_.id } | Sort-Object)
    if ($configuredIds.Count -lt 1 -or ($configuredIds -join "`n") -ne ($registeredIds -join "`n")) {
      throw "Server output capabilities do not match node.json (configured: $($configuredIds -join ','), registered: $($registeredIds -join ','))"
    }
    if ([int64]$binding.serverProjectRevision -lt 1) {
      throw 'Committed display binding has no authoritative Server project revision'
    }
    $projectResponse = Invoke-RestMethod -Uri "$serverBaseUrl/v1/projects/default" -Headers $headers -TimeoutSec 5
    $project = $projectResponse.project
    if ([int64]$project.revision -lt [int64]$binding.serverProjectRevision) {
      throw "Authoritative project revision $($project.revision) is older than committed binding revision $($binding.serverProjectRevision)"
    }
    $authoritativeOutputs = @($project.outputs | Where-Object { [string]$_.nodeId -eq $nodeId })
    $boundOutputs = @($binding.outputs)
    $authoritativeIds = @($authoritativeOutputs | ForEach-Object { [string]$_.id } | Sort-Object)
    $boundIds = @($boundOutputs | ForEach-Object { [string]$_.id } | Sort-Object)
    if ($boundIds.Count -lt 1 -or ($boundIds -join "`n") -ne ($authoritativeIds -join "`n")) {
      throw "Authoritative project outputs do not match the committed binding (bound: $($boundIds -join ','), project: $($authoritativeIds -join ','))"
    }
    foreach ($bound in $boundOutputs) {
      $authoritative = @($authoritativeOutputs | Where-Object { [string]$_.id -ceq [string]$bound.id })
      if ($authoritative.Count -ne 1) { throw "Authoritative project output $($bound.id) is missing or duplicated" }
      foreach ($property in @('devicePath', 'gdiName', 'adapterLuid', 'targetId')) {
        Assert-SameText ([string]$bound.$property) ([string]$authoritative[0].display.$property) "Authoritative output $($bound.id) $property"
      }
    }
    "$nodeId / heartbeat age $([Math]::Round($heartbeatAge.TotalSeconds, 1))s / $($registeredIds.Count) outputs / project r$($project.revision)"
  }
}

if ($installServer) {
  Test-Item 'Web Control' {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/' -TimeoutSec 10 -UseBasicParsing
    if ($response.StatusCode -ne 200 -or $response.Content -notmatch 'PIXEL') { throw "HTTP $($response.StatusCode)" }
    'HTTP 200'
  }
}

if ($installNode) {
  Test-Item 'Native renderer process' {
    $processes = @(Get-Process 'pixel-brightness-renderer' -ErrorAction Stop)
    if ($processes.Count -ne 1) { throw "expected exactly one renderer, found $($processes.Count)" }
    "PID $($processes[0].Id) / session $($processes[0].SessionId)"
  }

  Test-Item 'Not running through RDP' {
    if ($env:SESSIONNAME -like 'RDP-*') { throw $env:SESSIONNAME }
    $env:SESSIONNAME
  }
}

Test-Item 'No-sleep policy on AC power' {
  Assert-AcPowerIndexZero '238c9fa8-0aad-41ed-83f4-97be242c8f20' '29f6c1db-86da-48c5-9fdb-f2b67b1f44da' 'Sleep timeout'
  Assert-AcPowerIndexZero '238c9fa8-0aad-41ed-83f4-97be242c8f20' '9d7815a6-7ee4-497e-8888-515a05f02364' 'Hibernate timeout'
  Assert-AcPowerIndexZero '7516b95f-f776-4464-8c53-06167f40cc99' '3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e' 'Display timeout'
  Assert-AcPowerIndexZero '0012ee47-9041-4b5d-9b77-535fba8b1442' '6738e2c4-e8a5-4a42-b16a-e040e769756e' 'Disk timeout'
  'sleep, hibernate, display and disk timeouts disabled on AC'
}

if ($Full) {
  if ($installNode) {
    Test-Item 'NVIDIA GPU and driver' {
      $nvidiaCommand = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
      $nvidiaSmi = if ($nvidiaCommand) { [string]$nvidiaCommand.Source } else { $null }
      if (-not $nvidiaSmi) {
        $candidate = Join-Path $env:ProgramFiles 'NVIDIA Corporation\NVSMI\nvidia-smi.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $nvidiaSmi = $candidate }
      }
      if (-not $nvidiaSmi) { throw 'nvidia-smi.exe is missing from PATH and the standard NVSMI directory' }
      $line = & $nvidiaSmi --query-gpu=name,driver_version,display_active --format=csv,noheader | Select-Object -First 1
      if ($LASTEXITCODE -ne 0) { throw 'nvidia-smi failed' }
      $line
    }
  }
  if ($installServer) {
    Test-Item 'Private firewall rules' {
      $expected = @{
        'Pixel Brightness Web Control' = '3000'
        'Pixel Brightness Control API' = '4100'
      }
      $rules = @(Get-NetFirewallRule -DisplayName 'Pixel Brightness *' -ErrorAction Stop)
      if ($rules.Count -ne $expected.Count) { throw "expected $($expected.Count) rules, found $($rules.Count)" }
      foreach ($rule in $rules) {
        if (-not $expected.ContainsKey([string]$rule.DisplayName)) { throw "unexpected rule $($rule.DisplayName)" }
        if ([string]$rule.Profile -ne 'Private' -or [string]$rule.Direction -ne 'Inbound' -or
            [string]$rule.Action -ne 'Allow' -or [string]$rule.Enabled -ne 'True') {
          throw "rule $($rule.DisplayName) is not enabled inbound/allow on Private only"
        }
        $filter = $rule | Get-NetFirewallPortFilter
        $expectedPort = $expected[([string]$rule.DisplayName)]
        if ([string]$filter.Protocol -ne 'TCP' -or [string]$filter.LocalPort -ne $expectedPort) {
          throw "rule $($rule.DisplayName) has the wrong protocol or local port"
        }
      }
      "$($rules.Count) exact Private/TCP rules"
    }
  }
  if ($installNode) {
    Test-Item 'Arena process' {
    $arenas = @(Get-Process 'Arena' -ErrorAction Stop)
    $renderers = @(Get-Process 'pixel-brightness-renderer' -ErrorAction Stop)
    if ($arenas.Count -ne 1 -or $renderers.Count -ne 1) { throw 'expected exactly one Arena and one native renderer process' }
    if ($arenas[0].SessionId -eq 0 -or $arenas[0].SessionId -ne $renderers[0].SessionId) {
      throw "Arena session $($arenas[0].SessionId) does not match interactive renderer session $($renderers[0].SessionId)"
    }
    "PID $($arenas[0].Id) / shared interactive session $($arenas[0].SessionId)"
  }
  Test-Item 'Native renderer is receiving and presenting the Arena composition' {
    $telemetryPath = Join-Path $DataRoot 'config\renderer-status.json'
    $rendererConfigPath = Join-Path $DataRoot 'config\renderer.json'
    $rendererConfig = Read-RequiredJson $rendererConfigPath 'Native renderer config'
    $authority = Read-ProtectedDisplayBindingAuthority $DataRoot
    $nodeConfig = $authority.NodeConfig
    $binding = $authority.Binding
    $rendererIsInitialCandidate = (Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes($rendererConfigPath))) -ceq [string]$binding.rendererConfigSha256
    if (($rendererIsInitialCandidate -and [int64]$rendererConfig.revision -ne [int64]$binding.rendererRevision) -or
        (-not $rendererIsInitialCandidate -and [int64]$rendererConfig.revision -le [int64]$binding.rendererRevision)) {
      throw 'Native renderer cache is neither the exact bind candidate nor a strictly later compatible revision'
    }
    $expectedRenderer = Assert-NativeBundle (Get-CurrentRelease)
    $processes = @(Get-Process 'pixel-brightness-renderer' -ErrorAction Stop)
    if ($rendererConfig.vsync -ne $true) {
      throw 'Physical display-timing acceptance requires native vsync=true (Present sync interval 1)'
    }
    if ($processes.Count -ne 1) { throw "expected exactly one renderer, found $($processes.Count)" }
    if (-not [string]::Equals([string]$processes[0].Path, $expectedRenderer, [StringComparison]::OrdinalIgnoreCase)) {
      throw "renderer path is $($processes[0].Path), expected $expectedRenderer"
    }

    Assert-SameText ([string]$binding.nodeId) ([string]$nodeConfig.nodeId) 'Node id'
    Assert-SameText ([string]$binding.nodeId) ([string]$rendererConfig.nodeId) 'Native node id'
    Assert-SameText ([string]$binding.pipeName) ([string]$nodeConfig.rendererPipe) 'Node renderer pipe'
    Assert-SameText ([string]$binding.pipeName) ([string]$rendererConfig.pipeName) 'Native renderer pipe'
    Assert-SameText ([string]$binding.adapterLuid) ([string]$nodeConfig.adapterLuid) 'Node GPU adapter LUID'
    Assert-SameText ([string]$binding.adapterLuid) ([string]$rendererConfig.adapterLuid) 'GPU adapter LUID'
    Assert-SameText ([string]$binding.compositionSource.senderName) ([string]$nodeConfig.compositionSource.senderName) 'Node Spout sender'
    if ($rendererIsInitialCandidate) {
      Assert-SameText ([string]$binding.compositionSource.senderName) ([string]$rendererConfig.compositionSource.senderName) 'Bind-time native Spout sender'
    }
    foreach ($property in @('width', 'height', 'frameRateNum', 'frameRateDen')) {
      if ([int64]$binding.canvas.$property -ne [int64]$nodeConfig.canvas.$property -or
          [int64]$binding.canvas.$property -ne [int64]$rendererConfig.canvas.$property) {
        throw "Canvas $property does not match the committed display binding"
      }
    }

    $boundOutputs = @($binding.outputs)
    $nodeOutputs = @($nodeConfig.outputs | Where-Object { $_.enabled -eq $true })
    $expectedOutputs = @($rendererConfig.outputs | Where-Object { $_.enabled -eq $true })
    if ($boundOutputs.Count -lt 1 -or $nodeOutputs.Count -ne $boundOutputs.Count -or $expectedOutputs.Count -ne $boundOutputs.Count) {
      throw 'Enabled output count does not match the committed display binding'
    }
    foreach ($bound in $boundOutputs) {
      $nodeMatch = @($nodeOutputs | Where-Object { $_.id -eq $bound.id })
      $rendererMatch = @($expectedOutputs | Where-Object { $_.id -eq $bound.id })
      if ($nodeMatch.Count -ne 1 -or $rendererMatch.Count -ne 1) {
        throw "output $($bound.id) is missing or duplicated relative to the committed binding"
      }
      foreach ($property in @('devicePath', 'gdiName', 'adapterLuid', 'targetId')) {
        Assert-SameText ([string]$bound.$property) ([string]$nodeMatch[0].display.$property) "Node output $($bound.id) $property"
        Assert-SameText ([string]$bound.$property) ([string]$rendererMatch[0].display.$property) "Native output $($bound.id) $property"
      }
    }

    $first = Read-RequiredJson $telemetryPath 'Native renderer telemetry'
    Assert-FreshTelemetry $first
    Start-Sleep -Milliseconds 2500
    $second = Read-RequiredJson $telemetryPath 'Native renderer telemetry'
    Assert-FreshTelemetry $second

    foreach ($telemetry in @($first, $second)) {
      if ([int64]$telemetry.schemaVersion -ne 2) {
        throw "native telemetry schema $($telemetry.schemaVersion) does not contain the required physical display-timing contract"
      }
      if ($telemetry.state -ne 'running') { throw "renderer state is $($telemetry.state)" }
      if ($telemetry.compositionSource.state -ne 'connected') {
        throw "Spout input is $($telemetry.compositionSource.state): $($telemetry.compositionSource.detail)"
      }
      if ([uint64]$telemetry.compositionSource.rejectedFrames -ne 0) {
        throw "Spout rejected $($telemetry.compositionSource.rejectedFrames) frames"
      }
      if ($telemetry.compositionSource.frameRateValidated -ne $true) {
        throw 'Spout sender frame rate has not completed native validation'
      }
      $configuredFps = [double]$rendererConfig.compositionSource.frameRateNum / [double]$rendererConfig.compositionSource.frameRateDen
      $expectedFps = [double]$telemetry.compositionSource.expectedFps
      $senderFps = [double]$telemetry.compositionSource.senderFps
      $fpsTolerance = [Math]::Max(0.5, $configuredFps * 0.01)
      if ([Math]::Abs($expectedFps - $configuredFps) -gt 0.001 -or
          [Math]::Abs($senderFps - $configuredFps) -gt $fpsTolerance) {
        throw "Spout sender cadence is ${senderFps}fps, expected ${configuredFps}fps (tolerance ${fpsTolerance})"
      }
      if ([int64]$telemetry.revision -ne [int64]$rendererConfig.revision) {
        throw "telemetry revision $($telemetry.revision) does not match config $($rendererConfig.revision)"
      }
      if ([string]$telemetry.nodeId -ne [string]$rendererConfig.nodeId) { throw 'telemetry nodeId does not match config' }
      if ([string]$telemetry.adapter.luid -ne [string]$rendererConfig.adapterLuid) { throw 'telemetry GPU adapter does not match config' }
    }
    if ([uint64]$second.compositionSource.receivedFrames -le [uint64]$first.compositionSource.receivedFrames) {
      throw 'Spout receivedFrames did not advance during the acceptance window'
    }
    if ([uint64]$second.compositionSource.receivedFrames -eq 0) {
      throw 'Spout receivedFrames is zero'
    }
    $elapsedSeconds = ([DateTimeOffset]::Parse([string]$second.updatedAt) - [DateTimeOffset]::Parse([string]$first.updatedAt)).TotalSeconds
    if ($elapsedSeconds -le 0) { throw 'renderer telemetry observation window did not advance' }
    $configuredFps = [double]$rendererConfig.compositionSource.frameRateNum / [double]$rendererConfig.compositionSource.frameRateDen
    $expectedFrameDelta = $configuredFps * $elapsedSeconds
    # Short-window cadence must remain close to the configured rational. This
    # is deliberately much stricter than a liveness check, while still
    # allowing two frames of sampling/telemetry boundary jitter.
    $frameDeltaTolerance = [Math]::Max(2, [Math]::Ceiling($expectedFrameDelta * 0.05))
    $minimumFrameDelta = [Math]::Max(1, [Math]::Floor($expectedFrameDelta - $frameDeltaTolerance))
    $maximumFrameDelta = [Math]::Ceiling($expectedFrameDelta + $frameDeltaTolerance)
    $receivedDelta = [uint64]$second.compositionSource.receivedFrames - [uint64]$first.compositionSource.receivedFrames
    if ($receivedDelta -lt $minimumFrameDelta -or $receivedDelta -gt $maximumFrameDelta) {
      throw "Spout received $receivedDelta new frames in ${elapsedSeconds}s; expected $([Math]::Round($expectedFrameDelta, 1)) +/- $frameDeltaTolerance"
    }

    $firstOutputs = @($first.outputs)
    $secondOutputs = @($second.outputs)
    if ($expectedOutputs.Count -lt 1 -or $firstOutputs.Count -ne $expectedOutputs.Count -or $secondOutputs.Count -ne $expectedOutputs.Count) {
      throw "renderer reports the wrong physical output count ($($secondOutputs.Count)/$($expectedOutputs.Count))"
    }
    $submissionDeltas = [System.Collections.Generic.List[uint64]]::new()
    $displayPresentDeltas = [System.Collections.Generic.List[uint64]]::new()
    $displayRefreshDeltas = [System.Collections.Generic.List[uint64]]::new()
    $lastSubmissionQpcs = [System.Collections.Generic.List[int64]]::new()
    $displaySyncQpcs = [System.Collections.Generic.List[int64]]::new()
    foreach ($expected in $expectedOutputs) {
      $before = @($firstOutputs | Where-Object { $_.id -eq $expected.id })
      $after = @($secondOutputs | Where-Object { $_.id -eq $expected.id })
      if ($before.Count -ne 1 -or $after.Count -ne 1) { throw "output $($expected.id) is missing or duplicated" }
      if ($after[0].active -ne $true) { throw "output $($expected.id) is not active" }
      if ($after[0].blank -eq $true -or $after[0].pattern -ne 'content') {
        throw "output $($expected.id) is blank or still showing pattern $($after[0].pattern)"
      }
      if (-not [string]::Equals([string]$after[0].devicePath, [string]$expected.display.devicePath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "output $($expected.id) is presenting to a different Windows device path"
      }
      foreach ($sample in @($before[0], $after[0])) {
        if ($sample.occluded -ne $false) { throw "output $($expected.id) is occluded" }
        if ([string]$sample.presentSubmissions.lastHresult -ne '0x00000000' -or
            [string]$sample.presentSubmissions.lastPresentIdHresult -ne '0x00000000') {
          throw "output $($expected.id) has non-success DXGI submission status $($sample.presentSubmissions.lastHresult)"
        }
        if ([uint64]$sample.presentSubmissions.failures -ne 0) {
          throw "output $($expected.id) has $($sample.presentSubmissions.failures) failed Present submissions"
        }
        if ([string]$sample.displayTiming.source -cne 'IDXGISwapChain::GetFrameStatistics' -or
            [int64]$sample.displayTiming.syncInterval -ne 1 -or
            $sample.displayTiming.cadenceMetricsApplicable -ne $true -or
            $sample.displayTiming.phaseProof -ne $false -or
            [string]$sample.displayTiming.multiMonitorReliability -cne 'platform-dependent' -or
            $sample.displayTiming.available -ne $true -or
            [string]$sample.displayTiming.status -cne 'available' -or
            [string]$sample.displayTiming.lastQueryHresult -ne '0x00000000') {
          throw "output $($expected.id) physical display statistics are unavailable ($($sample.displayTiming.status) / $($sample.displayTiming.lastQueryHresult))"
        }
        $sampleAgeMilliseconds = [double]$sample.displayTiming.sampleAgeMilliseconds
        if ([double]::IsNaN($sampleAgeMilliseconds) -or [double]::IsInfinity($sampleAgeMilliseconds) -or
            $sampleAgeMilliseconds -lt 0 -or $sampleAgeMilliseconds -gt 1000) {
          throw "output $($expected.id) physical display statistics are stale by ${sampleAgeMilliseconds}ms"
        }
      }
      if ([uint64]$after[0].presentSubmissions.accepted -le [uint64]$before[0].presentSubmissions.accepted) {
        throw "output $($expected.id) accepted Present submissions did not advance"
      }
      if ([uint64]$after[0].presentSubmissions.accepted -eq 0) {
        throw "output $($expected.id) accepted Present submission count is zero"
      }
      if ([int64]$after[0].presentSubmissions.lastSubmissionQpc -le [int64]$before[0].presentSubmissions.lastSubmissionQpc) {
        throw "output $($expected.id) Present submission timestamp did not advance"
      }
      $submissionDelta = [uint64]$after[0].presentSubmissions.accepted - [uint64]$before[0].presentSubmissions.accepted
      if ($submissionDelta -lt $minimumFrameDelta -or $submissionDelta -gt $maximumFrameDelta) {
        throw "output $($expected.id) submitted $submissionDelta accepted presents; expected $([Math]::Round($expectedFrameDelta, 1)) +/- $frameDeltaTolerance"
      }
      $attemptDelta = [uint64]$after[0].presentSubmissions.attempted - [uint64]$before[0].presentSubmissions.attempted
      $occludedDelta = [uint64]$after[0].presentSubmissions.occluded - [uint64]$before[0].presentSubmissions.occluded
      $otherStatusDelta = [uint64]$after[0].presentSubmissions.otherStatuses - [uint64]$before[0].presentSubmissions.otherStatuses
      if ($attemptDelta -ne $submissionDelta -or $occludedDelta -ne 0 -or $otherStatusDelta -ne 0) {
        throw "output $($expected.id) had a non-presenting DXGI submission during the observation window"
      }

      $displayPresentDelta = Get-UInt32CounterDelta `
        $before[0].displayTiming.presentCount $after[0].displayTiming.presentCount "output $($expected.id) PresentCount"
      $displayRefreshDelta = Get-UInt32CounterDelta `
        $before[0].displayTiming.presentRefreshCount $after[0].displayTiming.presentRefreshCount "output $($expected.id) PresentRefreshCount"
      $syncRefreshDelta = Get-UInt32CounterDelta `
        $before[0].displayTiming.syncRefreshCount $after[0].displayTiming.syncRefreshCount "output $($expected.id) SyncRefreshCount"
      foreach ($observed in @(
        [pscustomobject]@{ Label = 'displayed images'; Value = $displayPresentDelta },
        [pscustomobject]@{ Label = 'display refreshes'; Value = $displayRefreshDelta },
        [pscustomobject]@{ Label = 'scheduler refresh samples'; Value = $syncRefreshDelta }
      )) {
        if ($observed.Value -lt $minimumFrameDelta -or $observed.Value -gt $maximumFrameDelta) {
          throw "output $($expected.id) observed $($observed.Value) $($observed.Label); expected $([Math]::Round($expectedFrameDelta, 1)) +/- $frameDeltaTolerance"
        }
      }
      if ([uint64]$after[0].displayTiming.sampleSequence -le [uint64]$before[0].displayTiming.sampleSequence -or
          [int64]$after[0].displayTiming.syncQpcTime -le [int64]$before[0].displayTiming.syncQpcTime) {
        throw "output $($expected.id) physical display-timing sample did not advance"
      }
      foreach ($counter in @('discontinuities', 'droppedPresents', 'repeatedRefreshes', 'latePresentEvents')) {
        if ([uint64]$after[0].displayTiming.$counter -ne [uint64]$before[0].displayTiming.$counter) {
          throw "output $($expected.id) physical display timing reported $counter during the observation window"
        }
      }
      $submissionDeltas.Add($submissionDelta)
      $displayPresentDeltas.Add($displayPresentDelta)
      $displayRefreshDeltas.Add($displayRefreshDelta)
      $lastSubmissionQpcs.Add([int64]$after[0].presentSubmissions.lastSubmissionQpc)
      $displaySyncQpcs.Add([int64]$after[0].displayTiming.syncQpcTime)
    }
    if (($submissionDeltas | Measure-Object -Maximum).Maximum - ($submissionDeltas | Measure-Object -Minimum).Minimum -gt 1) {
      throw "physical outputs did not submit the same number of presents: $($submissionDeltas -join ',')"
    }
    if (($displayPresentDeltas | Measure-Object -Maximum).Maximum - ($displayPresentDeltas | Measure-Object -Minimum).Minimum -gt 1 -or
        ($displayRefreshDeltas | Measure-Object -Maximum).Maximum - ($displayRefreshDeltas | Measure-Object -Minimum).Minimum -gt 1) {
      throw "physical outputs did not advance equal display counts: presents=$($displayPresentDeltas -join ',') refreshes=$($displayRefreshDeltas -join ',')"
    }
    $submissionSpreadQpc = ($lastSubmissionQpcs | Measure-Object -Maximum).Maximum - ($lastSubmissionQpcs | Measure-Object -Minimum).Minimum
    $displaySyncSpreadQpc = ($displaySyncQpcs | Measure-Object -Maximum).Maximum - ($displaySyncQpcs | Measure-Object -Minimum).Minimum
    $oneFrameQpc = [Diagnostics.Stopwatch]::Frequency / $configuredFps
    if ($submissionSpreadQpc -gt $oneFrameQpc) {
      throw "output Present submissions span more than one frame ($submissionSpreadQpc QPC ticks)"
    }
    if ($displaySyncSpreadQpc -gt $oneFrameQpc) {
      throw "output DXGI display-statistics samples span more than one frame ($displaySyncSpreadQpc QPC ticks)"
    }
      "$($secondOutputs.Count) DXGI outputs: $($submissionDeltas[0]) accepted submissions, $($displayPresentDeltas[0]) monitor-presented images and $receivedDelta Spout frames at $([Math]::Round($configuredFps, 3))fps"
    }

    Test-Item 'Authenticated identify and content restore for every committed output' {
      $telemetryPath = Join-Path $DataRoot 'config\renderer-status.json'
      $authority = Read-ProtectedDisplayBindingAuthority $DataRoot
      $nodeConfig = $authority.NodeConfig
      $binding = $authority.Binding
      $nodeId = [string]$nodeConfig.nodeId
      Assert-SameText ([string]$binding.nodeId) $nodeId 'Node id for pattern acceptance'
      $outputIds = @($binding.outputs | ForEach-Object { [string]$_.id })
      $invalidOutputIds = @($outputIds | Where-Object { -not $_ })
      if ($outputIds.Count -lt 1 -or $invalidOutputIds.Count -gt 0) {
        throw 'Committed display binding has no valid output ids for pattern acceptance'
      }
      $token = Read-ControlToken $DataRoot $ControlTokenFile
      $headers = @{ Authorization = "Bearer $token" }
      $identifiedOutputs = [System.Collections.Generic.List[string]]::new()
      foreach ($targetOutputId in $outputIds) {
        $identifyFailure = $null
        $restoreFailure = $null
        $identifySequence = 0
        $restoreSequence = 0
        try {
          $identify = Send-OutputPatternCommand `
            -ServerUrl $serverBaseUrl `
            -Headers $headers `
            -NodeId $nodeId `
            -OutputId $targetOutputId `
            -Enabled $true `
            -Type 'identify'
          $identifySequence = [int64]$identify.Sequence
          Wait-NodeCommandAck `
            -ServerUrl $serverBaseUrl `
            -Headers $headers `
            -NodeId $nodeId `
            -Sequence $identifySequence | Out-Null
          Wait-NativeOutputPatterns `
            -TelemetryPath $telemetryPath `
            -ExpectedOutputIds $outputIds `
            -Mode 'identify' `
            -TargetOutputId $targetOutputId | Out-Null
        } catch {
          $identifyFailure = $_.Exception
        } finally {
          # Restore all outputs before testing the next physical surface, even
          # when the identify command or its native observation failed.
          try {
            $restore = Send-OutputPatternCommand `
              -ServerUrl $serverBaseUrl `
              -Headers $headers `
              -NodeId $nodeId `
              -OutputId $targetOutputId `
              -Enabled $false `
              -Type 'content'
            $restoreSequence = [int64]$restore.Sequence
            Wait-NodeCommandAck `
              -ServerUrl $serverBaseUrl `
              -Headers $headers `
              -NodeId $nodeId `
              -Sequence $restoreSequence | Out-Null
            Wait-NativeOutputPatterns `
              -TelemetryPath $telemetryPath `
              -ExpectedOutputIds $outputIds `
              -Mode 'content' | Out-Null
          } catch {
            $restoreFailure = $_.Exception
          }
        }
        if ($restoreFailure) {
          $prefix = if ($identifyFailure) { "Identify failed for output ${targetOutputId}: $($identifyFailure.Message). " } else { '' }
          throw "${prefix}Content restoration failed after output ${targetOutputId}: $($restoreFailure.Message)"
        }
        if ($identifyFailure) { throw $identifyFailure }
        $identifiedOutputs.Add("${targetOutputId}:identify=${identifySequence},content=${restoreSequence}")
      }
      "$($identifiedOutputs.Count) outputs individually identified and restored: $($identifiedOutputs -join '; ')"
    }
  }
}

if ($failures.Count -gt 0) {
  throw ("Pixel Brightness acceptance failed:`n - " + ($failures -join "`n - "))
}
Write-Host 'Pixel Brightness Windows acceptance passed.' -ForegroundColor Green
} finally {
  Exit-PixelBrightnessReleaseLaunchBarrier $acceptanceLaunchBarrier
}
