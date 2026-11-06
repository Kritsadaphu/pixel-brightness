[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Server', 'Web', 'Show')]
  [string]$Role,
  [string]$DataRoot = (Join-Path $env:ProgramData 'Pixel Brightness'),
  [string]$UpgradeHealthTransactionId = '',
  [string]$UpgradeHealthTokenPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# PixelBrightnessUpgradeGateContract:v1
# The installer audits this exact marker and the executable gate assignment
# below before it will create the first durable gate on an existing host.
# PixelBrightnessReleaseLaunchBarrierContract:v1

$runtimeSecurityPath = Join-Path $PSScriptRoot 'RuntimeSecurity.ps1'
if (-not (Test-Path -LiteralPath $runtimeSecurityPath -PathType Leaf)) {
  throw "Runtime security policy is missing beside the launcher: $runtimeSecurityPath"
}
. $runtimeSecurityPath
$upgradeTransactionPath = Join-Path $PSScriptRoot 'UpgradeTransaction.ps1'
if (-not (Test-Path -LiteralPath $upgradeTransactionPath -PathType Leaf)) {
  throw "Upgrade boot-gate policy is missing beside the launcher: $upgradeTransactionPath"
}
$null = Assert-AdminProtectedItem (Get-Item -LiteralPath $upgradeTransactionPath -Force -ErrorAction Stop) 'Upgrade boot-gate policy'
. $upgradeTransactionPath
$cameraRuntimePath = Join-Path $PSScriptRoot 'CameraRuntime.ps1'
if (-not (Test-Path -LiteralPath $cameraRuntimePath -PathType Leaf)) {
  throw "Camera-runtime authority policy is missing beside the launcher: $cameraRuntimePath"
}
$null = Assert-AdminProtectedItem (Get-Item -LiteralPath $cameraRuntimePath -Force -ErrorAction Stop) 'Camera-runtime authority policy'
. $cameraRuntimePath
$script:PixelBrightnessLauncherBarrier = $null
function Complete-PixelBrightnessLauncherBarrier {
  if ($null -eq $script:PixelBrightnessLauncherBarrier) { return }
  try { Exit-PixelBrightnessReleaseLaunchBarrier $script:PixelBrightnessLauncherBarrier }
  finally { $script:PixelBrightnessLauncherBarrier = $null }
}
$script:PixelBrightnessLauncherBarrier = Enter-PixelBrightnessReleaseLaunchBarrier
try {
# This is deliberately the first control-state decision. Every scheduled-task
# role must reject an unresolved/corrupt gate before it audits or reads the
# generation pointer. Only one Server/Web precommit health process can consume
# its exact protected transaction token; Show has no bypass.
$upgradeGate = Assert-PixelBrightnessUpgradeLauncherGate -DataRoot $DataRoot -Role $Role `
  -HealthTransactionId $UpgradeHealthTransactionId -HealthTokenPath $UpgradeHealthTokenPath
if ($Role -ceq 'Show') {
  # Server/Web must remain available so an interrupted all-in-one bind can GET
  # and reconcile its protected A/B intent. Only Show consumes this gate.
  $null = Assert-PixelBrightnessDisplayBindingLauncherGate $DataRoot
  $null = Assert-PixelBrightnessCameraLauncherGate $DataRoot
}
$null = Assert-PixelBrightnessControlPlane -DataRoot $DataRoot -IncludeSystemDirectories:($Role -ne 'Show')

$currentFile = Join-Path $DataRoot 'current-release.txt'
if (-not (Test-Path -LiteralPath $currentFile)) {
  throw "Current release pointer is missing: $currentFile"
}
$releaseRoot = (Get-Content -LiteralPath $currentFile -Raw).Trim()
if (-not (Test-Path -LiteralPath $releaseRoot -PathType Container)) {
  throw "Current release does not exist: $releaseRoot"
}
$releaseRoot = Assert-AdminProtectedReleaseLocation $releaseRoot
# The pointer is not executable authority by itself. Hash the exact protected
# all-file inventory before reading runtime config or resolving any Server,
# Web, Node, native renderer, shader, helper, or package entrypoint. Missing,
# extra, truncated, reparse-backed, or digest-mismatched payload remains behind
# the upgrade gate (when present) and always fails closed.
$null = Assert-PixelBrightnessReleaseManifest $releaseRoot

function Read-RequiredJson([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing: $Path" }
  try {
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
  } catch {
    throw "$Label is not valid JSON: $($_.Exception.Message)"
  }
}

function Read-RendererJsonWithRecovery([string]$Path) {
  try {
    return Read-RequiredJson $Path 'Native renderer config'
  } catch {
    $primaryError = $_.Exception.Message
    $backupPath = "$Path.last-known-good.json"
    $null = Assert-PixelBrightnessPlainFile $backupPath 'Native renderer last-known-good config'
    if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
      throw "$primaryError No native renderer last-known-good config is available."
    }
    $bytes = [IO.File]::ReadAllBytes($backupPath)
    try {
      $null = ([Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json)
    } catch {
      throw "$primaryError Native renderer last-known-good config is invalid JSON: $($_.Exception.Message)"
    }
    # UpgradeTransaction.ps1 publishes through MoveFileExW with
    # REPLACE_EXISTING|WRITE_THROUGH and FlushFileBuffers. A recovered file is
    # still subjected to every display-binding check below before Show starts.
    Write-PixelBrightnessAtomicBytes -Path $Path -Bytes $bytes
    return Read-RequiredJson $Path 'Recovered native renderer config'
  }
}

function Assert-SameText([string]$Left, [string]$Right, [string]$Label) {
  if (-not [string]::Equals($Left, $Right, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label does not match the committed display binding. Re-run Bind-PixelBrightnessDisplays.ps1."
  }
}

function Assert-OptionalCameraHelper([object]$NodeConfig, [string]$ReleasePath) {
  $helperValue = [string]$NodeConfig.cameraHelperCommand
  if ([string]::IsNullOrWhiteSpace($helperValue)) { return }
  if ([string]$NodeConfig.cameraBackend -cne 'sony-sdk') {
    throw 'A camera helper command is configured for an unexpected camera backend.'
  }
  $helper = [IO.Path]::GetFullPath($helperValue)
  $releasePrefix = [IO.Path]::GetFullPath($ReleasePath).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $helper.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Camera helper must be installed inside the protected immutable release: $helper"
  }
  if (-not (Test-Path -LiteralPath $helper -PathType Leaf) -or (Get-Item -LiteralPath $helper -Force).Length -le 0) {
    throw "Configured camera helper is missing or empty: $helper"
  }
  $item = Get-Item -LiteralPath $helper -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Camera helper cannot be a reparse point: $helper"
  }
}

function Assert-RealLogDirectory([string]$Path, [string]$Parent) {
  foreach ($candidate in @($Parent, $Path)) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
      throw "Required log directory is missing: $candidate"
    }
    $item = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing to write logs through a reparse point: $candidate"
    }
  }
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
      throw "Native renderer bundle is incomplete or empty: $path"
    }
  }
  $rendererPath = Join-Path $nativeBin 'pixel-brightness-renderer.exe'
  $pe = [IO.File]::ReadAllBytes($rendererPath)
  if ($pe.Length -lt 256 -or $pe[0] -ne 0x4D -or $pe[1] -ne 0x5A) {
    throw "Native renderer is not a Windows PE executable: $rendererPath"
  }
  $peOffset = [BitConverter]::ToInt32($pe, 0x3C)
  if ($peOffset -lt 0 -or $peOffset + 6 -gt $pe.Length -or
      $pe[$peOffset] -ne 0x50 -or $pe[$peOffset + 1] -ne 0x45 -or
      [BitConverter]::ToUInt16($pe, $peOffset + 4) -ne 0x8664) {
    throw "Native renderer is not an x64 Windows PE executable: $rendererPath"
  }
  return $rendererPath
}

function Read-RoleSecret([string]$Root, [string]$Name, [string]$Label, [string]$Pattern) {
  $path = Join-Path $Root "secrets\$Name"
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "$Label is missing: $path" }
  $token = (Get-Content -LiteralPath $path -Raw).Trim()
  if ($token -notmatch $Pattern) { throw "$Label is empty or invalid; refusing startup." }
  return $token
}

function Read-ControlToken([string]$Root) {
  return Read-RoleSecret $Root 'control-token.txt' 'Control token' '^[A-Za-z0-9_-]{43,128}$'
}

function Read-NodeSigningKey([string]$Root) {
  return Read-RoleSecret $Root 'node-signing-key.txt' 'Render Node signing key' '^[A-Za-z0-9_-]{43,128}$'
}

function Read-NodeToken([string]$Root) {
  return Read-RoleSecret $Root 'node-token.txt' 'Render Node credential' '^pbnode\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$'
}

function New-RendererBootToken {
  $bytes = New-Object byte[] 32
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Assert-ShowBinding([string]$Root, [string]$ReleasePath, [string]$ExpectedRenderer) {
  $binding = Read-PixelBrightnessDisplayBindingCommit $Root
  if ($null -eq $binding) {
    throw 'Protected display binding commit is missing. Run Bind-PixelBrightnessDisplays.ps1.'
  }
  $bindingPath = [string]$binding.commitPath
  $nodePath = [string]$binding.generation.NodePath
  $rendererSnapshotPath = [string]$binding.generation.RendererPath
  $rendererPath = Join-Path $Root 'config\renderer.json'
  foreach ($pathContract in @(
    @{ Actual = [string]$binding.generationRoot; Expected = [string]$binding.generation.Root; Label = 'generation root' },
    @{ Actual = [string]$binding.nodeConfigPath; Expected = $nodePath; Label = 'immutable Node config path' },
    @{ Actual = [string]$binding.rendererBindSnapshotPath; Expected = $rendererSnapshotPath; Label = 'bind-time renderer snapshot path' },
    @{ Actual = [string]$binding.targetProjectPath; Expected = [string]$binding.generation.TargetProjectPath; Label = 'target project path' },
    @{ Actual = [string]$binding.rendererCachePath; Expected = $rendererPath; Label = 'mutable renderer cache path' }
  )) {
    if (-not [string]::Equals(
      [IO.Path]::GetFullPath($pathContract.Actual),
      [IO.Path]::GetFullPath($pathContract.Expected),
      [StringComparison]::OrdinalIgnoreCase
    )) {
      throw "Display binding $($pathContract.Label) escaped its exact protected contract."
    }
  }
  $nodeConfig = Read-RequiredJson $nodePath 'Node config'
  $rendererConfig = Read-RendererJsonWithRecovery $rendererPath
  $rendererItem = Assert-PixelBrightnessPlainFile $rendererPath 'Native renderer config'
  if ($null -eq $rendererItem) { throw "Native renderer config is missing: $rendererPath" }
  Assert-OptionalCameraHelper $nodeConfig $ReleasePath

  if ($binding.valid -ne $true) { throw 'PixelBrightness-Show is blocked until display binding commits successfully.' }
  if ([int]$binding.schemaVersion -ne 2) {
    throw 'PixelBrightness-Show requires a hash-bound display binding schema v2. Run the binder again.'
  }
  $bindingTransactionId = [guid]::Empty
  if (-not [guid]::TryParseExact([string]$binding.transactionId, 'D', [ref]$bindingTransactionId) -or
      $bindingTransactionId -eq [guid]::Empty) {
    throw 'Display binding commit has an invalid transaction identity.'
  }
  if ([string]::IsNullOrWhiteSpace([string]$binding.serverProjectId) -or
      ([string]$binding.serverProjectId).Length -gt 128 -or
      [int64]$binding.serverProjectBaseRevision -lt 1 -or
      [int64]$binding.serverProjectRevision -ne ([int64]$binding.serverProjectBaseRevision + 1)) {
    throw 'Display binding commit does not prove one exact authoritative Server revision transition.'
  }
  if ([string]$binding.nodeConfigSha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$binding.rendererConfigSha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$binding.outputSelectorsSha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$binding.serverProjectSha256 -notmatch '^[0-9a-f]{64}$') {
    throw 'Display binding commit contains an invalid exact-byte digest.'
  }
  $targetProject = Read-RequiredJson ([string]$binding.generation.TargetProjectPath) 'Protected target Server project'
  if ([string]$targetProject.id -cne [string]$binding.serverProjectId -or
      [int64]$targetProject.revision -ne [int64]$binding.serverProjectRevision -or
      (Get-PixelBrightnessServerProjectAuthoritySha256 $targetProject) -cne [string]$binding.serverProjectSha256) {
    throw 'Protected target Server project differs from the exact committed A-to-B authority.'
  }
  $nodeConfigSha256 = Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes($nodePath))
  $rendererSnapshotSha256 = Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes($rendererSnapshotPath))
  $rendererConfigSha256 = Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes($rendererPath))
  if ($nodeConfigSha256 -cne [string]$binding.nodeConfigSha256 -or
      $rendererSnapshotSha256 -cne [string]$binding.rendererConfigSha256) {
    throw 'Immutable Node or bind-time renderer snapshot bytes differ from the protected display binding commit.'
  }
  $rendererIsInitialCandidate = $rendererConfigSha256 -ceq [string]$binding.rendererConfigSha256
  if (($rendererIsInitialCandidate -and [int64]$binding.rendererRevision -ne [int64]$rendererConfig.revision) -or
      (-not $rendererIsInitialCandidate -and [int64]$rendererConfig.revision -le [int64]$binding.rendererRevision)) {
    throw 'Native renderer cache is neither the exact bind candidate nor a strictly later compatible revision.'
  }
  Assert-SameText ([string]$binding.releaseRoot) $ReleasePath 'Display binding release'
  Assert-SameText ([string]$binding.nodeId) ([string]$nodeConfig.nodeId) 'Node id'
  Assert-SameText ([string]$binding.nodeId) ([string]$rendererConfig.nodeId) 'Native node id'
  Assert-SameText ([string]$binding.pipeName) ([string]$nodeConfig.rendererPipe) 'Node renderer pipe'
  Assert-SameText ([string]$binding.pipeName) ([string]$rendererConfig.pipeName) 'Native renderer pipe'
  Assert-SameText ([string]$nodeConfig.rendererCommand) $ExpectedRenderer 'Native renderer executable'
  Assert-SameText ([string]$nodeConfig.rendererConfigPath) $rendererPath 'Native renderer config path'
  Assert-SameText ([string]$binding.adapterLuid) ([string]$nodeConfig.adapterLuid) 'Node GPU adapter LUID'
  Assert-SameText ([string]$binding.adapterLuid) ([string]$rendererConfig.adapterLuid) 'GPU adapter LUID'
  Assert-SameText ([string]$binding.compositionSource.senderName) ([string]$nodeConfig.compositionSource.senderName) 'Node Spout sender'
  if ($rendererIsInitialCandidate) {
    Assert-SameText ([string]$binding.compositionSource.senderName) ([string]$rendererConfig.compositionSource.senderName) 'Bind-time native Spout sender'
  }

  foreach ($property in @('width', 'height', 'frameRateNum', 'frameRateDen')) {
    if ([int64]$binding.canvas.$property -ne [int64]$nodeConfig.canvas.$property -or
        [int64]$binding.canvas.$property -ne [int64]$rendererConfig.canvas.$property) {
      throw "Canvas $property does not match the committed display binding."
    }
  }
  foreach ($property in @('width', 'height')) {
    if ([int64]$binding.compositionSource.$property -ne [int64]$nodeConfig.compositionSource.$property -or
        [int64]$binding.compositionSource.$property -ne [int64]$rendererConfig.compositionSource.$property) {
      throw "Spout composition $property does not match the committed display binding."
    }
  }

  $boundOutputs = @($binding.outputs)
  $nodeOutputs = @($nodeConfig.outputs | Where-Object { $_.enabled -eq $true })
  $rendererOutputs = @($rendererConfig.outputs | Where-Object { $_.enabled -eq $true })
  if ($boundOutputs.Count -lt 1 -or $nodeOutputs.Count -ne $boundOutputs.Count -or $rendererOutputs.Count -ne $boundOutputs.Count) {
    throw 'Enabled output count does not match the committed display binding.'
  }
  if (@($boundOutputs | Group-Object id | Where-Object Count -gt 1).Count -gt 0) {
    throw 'Display binding contains duplicate output ids.'
  }
  if ((Get-PixelBrightnessDisplayOutputSelectorsSha256 $boundOutputs) -cne
      [string]$binding.outputSelectorsSha256) {
    throw 'Display binding output selectors differ from their protected commit digest.'
  }
  foreach ($bound in $boundOutputs) {
    $nodeMatch = @($nodeOutputs | Where-Object { $_.id -eq $bound.id })
    $rendererMatch = @($rendererOutputs | Where-Object { $_.id -eq $bound.id })
    if ($nodeMatch.Count -ne 1 -or $rendererMatch.Count -ne 1) {
      throw "Output $($bound.id) is missing or duplicated in Node/native config."
    }
    if ([string]$bound.devicePath -match 'replace-with' -or [string]::IsNullOrWhiteSpace([string]$bound.devicePath)) {
      throw "Output $($bound.id) has no stable Windows device path."
    }
    foreach ($property in @('devicePath', 'gdiName', 'adapterLuid', 'targetId')) {
      Assert-SameText ([string]$bound.$property) ([string]$nodeMatch[0].display.$property) "Node output $($bound.id) $property"
      Assert-SameText ([string]$bound.$property) ([string]$rendererMatch[0].display.$property) "Native output $($bound.id) $property"
    }
  }

  return [pscustomobject]@{
    NodePath = $nodePath
    RendererPath = $rendererPath
    NodeId = [string]$nodeConfig.nodeId
    PipeName = [string]$binding.pipeName
  }
}

$runtimeConfig = Read-RequiredJson (Join-Path $DataRoot 'secrets\runtime.json') 'Pinned Node.js runtime config'
$node = [string]$runtimeConfig.node
$npm = [string]$runtimeConfig.npm
$protectedRuntime = Assert-ProtectedNodeRuntime $node $npm
$node = [string]$protectedRuntime.node
$npm = [string]$protectedRuntime.npm
$requiredRuntime = $node
if ([string]::IsNullOrWhiteSpace($requiredRuntime) -or -not (Test-Path -LiteralPath $requiredRuntime -PathType Leaf)) {
  throw "Pinned runtime executable for $Role is missing: $requiredRuntime"
}

$logsParent = Join-Path $DataRoot 'logs'
$logRoot = Join-Path $logsParent $(if ($Role -eq 'Show') { 'show' } else { 'system' })
Assert-RealLogDirectory $logRoot $logsParent
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $logRoot ("{0}-{1}.log" -f $Role.ToLowerInvariant(), $stamp)

function Invoke-Logged([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory) {
  $argumentLine = (@($Arguments) | ForEach-Object { '"' + ([string]$_).Replace('"', '\"') + '"' }) -join ' '
  "[$(Get-Date -Format o)] START $FilePath $argumentLine" | Tee-Object -FilePath $logFile -Append
  $child = Start-Process -FilePath $FilePath -ArgumentList $argumentLine -WorkingDirectory $WorkingDirectory `
    -PassThru -NoNewWindow `
    -RedirectStandardOutput "$logFile.service.out" -RedirectStandardError "$logFile.service.err"
  # Process creation is the final side of the serialized launch decision. The
  # installer may publish a gate only after this point, while the still-live
  # launcher parent lets its post-gate drain identify the complete child tree.
  Complete-PixelBrightnessLauncherBarrier
  $child.WaitForExit()
  $child.Refresh()
  $exitCode = $child.ExitCode
  "[$(Get-Date -Format o)] EXIT $exitCode" | Tee-Object -FilePath $logFile -Append
  exit $exitCode
}

function Stop-UpgradeHealthProcessTree([int]$RootProcessId) {
  $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $owned = [System.Collections.Generic.HashSet[int]]::new()
  $null = $owned.Add($RootProcessId)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($process in $processes) {
      if ($owned.Contains([int]$process.ParentProcessId) -and $owned.Add([int]$process.ProcessId)) { $changed = $true }
    }
  }
  foreach ($processId in @($owned | Sort-Object -Descending)) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
  return @($owned)
}

function Wait-UpgradeHealthPortClosed([int]$Port, [int[]]$OwnedProcessIds, [int]$TimeoutSeconds = 10) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) { return }
    foreach ($listener in $listeners) {
      try {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction Stop
        if ([int]$listener.OwningProcess -notin $OwnedProcessIds -and
            [string]$process.CommandLine -notmatch '(?:runtime[\\/]server[\\/]index\.mjs|vinext[\\/].*cli\.js.*start)') {
          throw 'listener is not provably owned by the candidate health process'
        }
        Stop-Process -Id ([int]$listener.OwningProcess) -Force -ErrorAction Stop
      } catch {
        throw "Candidate health listener on port $Port could not be closed: $($_.Exception.Message)"
      }
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Candidate health listener remained open on port $Port."
}

function Invoke-UpgradeHealthLogged([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory, [object]$Gate) {
  if ($null -eq $Gate -or -not $UpgradeHealthTransactionId) {
    throw 'Upgrade health process is missing its consumed gate contract.'
  }
  $argumentLine = (@($Arguments) | ForEach-Object { '"' + ([string]$_).Replace('"', '\"') + '"' }) -join ' '
  "[$(Get-Date -Format o)] UPGRADE HEALTH START $FilePath $argumentLine" | Tee-Object -FilePath $logFile -Append
  $child = Start-Process -FilePath $FilePath -ArgumentList $argumentLine -WorkingDirectory $WorkingDirectory `
    -PassThru -NoNewWindow `
    -RedirectStandardOutput "$logFile.health.out" -RedirectStandardError "$logFile.health.err"
  Complete-PixelBrightnessLauncherBarrier
  $exitCode = 1
  try {
    while (-not $child.HasExited) {
      Start-Sleep -Milliseconds 500
      $child.Refresh()
      if ($child.HasExited) { break }
      try {
        $liveGate = Read-PixelBrightnessUpgradeGate $DataRoot
        if ($null -eq $liveGate -or [string]$liveGate.transactionId -cne $UpgradeHealthTransactionId -or
            [string]$liveGate.phase -cne 'health-running') {
          throw 'transaction gate was cleared or left health-running phase'
        }
        $null = Assert-PixelBrightnessUpgradeHealthOwner $liveGate
      } catch {
        throw "Upgrade health owner/gate watchdog failed: $($_.Exception.Message)"
      }
    }
    $child.Refresh()
    $exitCode = if ($child.HasExited) { $child.ExitCode } else { 1 }
  } catch {
    "[$(Get-Date -Format o)] $($_.Exception.Message); terminating candidate service." | Tee-Object -FilePath $logFile -Append
    $exitCode = 1
  } finally {
    $ownedProcessIds = @(Stop-UpgradeHealthProcessTree $child.Id)
    $candidatePort = if ($Role -eq 'Server') { 4100 } else { 3000 }
    try { Wait-UpgradeHealthPortClosed $candidatePort $ownedProcessIds }
    catch {
      "[$(Get-Date -Format o)] $($_.Exception.Message)" | Tee-Object -FilePath $logFile -Append
      $exitCode = 1
    }
  }
  "[$(Get-Date -Format o)] UPGRADE HEALTH EXIT $exitCode" | Tee-Object -FilePath $logFile -Append
  exit $exitCode
}

switch ($Role) {
  'Server' {
    $env:PB_SERVER_HOST = '0.0.0.0'
    $env:PB_SERVER_PORT = '4100'
    $env:PB_SERVER_DATA_DIR = Join-Path $DataRoot 'state\server'
    $env:PIXEL_CONTROL_TOKEN = Read-ControlToken $DataRoot
    $env:PIXEL_NODE_SIGNING_KEY = Read-NodeSigningKey $DataRoot
    $env:PB_PROJECTOR_CONTROL_USERNAME = 'dispadmin'
    $projectorPasswordPath = Join-Path $DataRoot 'secrets\panasonic-projector-password.txt'
    if (Test-Path -LiteralPath $projectorPasswordPath -PathType Leaf) {
      $null = Assert-AdminProtectedItem (Get-Item -LiteralPath $projectorPasswordPath -Force -ErrorAction Stop) 'Panasonic projector password'
      $env:PB_PROJECTOR_CONTROL_PASSWORD_FILE = $projectorPasswordPath
    } else {
      Remove-Item Env:PB_PROJECTOR_CONTROL_PASSWORD_FILE -ErrorAction SilentlyContinue
      Remove-Item Env:PB_PROJECTOR_CONTROL_PASSWORD -ErrorAction SilentlyContinue
    }
    $env:PB_PROJECTOR_COMMAND_TIMEOUT_MS = '3000'
    $env:PB_PROJECTOR_COMMAND_GAP_MS = '500'
    Remove-Item Env:PIXEL_AUTH_TOKEN -ErrorAction SilentlyContinue
    $env:PB_TRUST_LOCAL_WEB = '0'
    $env:PB_TRUSTED_WEB_CLIENTS = ''
    $env:PB_TRUSTED_WEB_HOSTS = ''
    $trustedWebPath = Join-Path $DataRoot 'secrets\trusted-web.json'
    if (Test-Path -LiteralPath $trustedWebPath) {
      $trustedWeb = Get-Content -LiteralPath $trustedWebPath -Raw | ConvertFrom-Json
      if ($trustedWeb.enabled -and @($trustedWeb.clients).Count -gt 0 -and @($trustedWeb.hosts).Count -gt 0) {
        $env:PB_TRUST_LOCAL_WEB = '1'
        $env:PB_TRUSTED_WEB_CLIENTS = (@($trustedWeb.clients) -join ',')
        $env:PB_TRUSTED_WEB_HOSTS = (@($trustedWeb.hosts) -join ',')
      }
    }
    $env:PB_ALLOW_POWER_ACTIONS = '0'
    if ($null -ne $upgradeGate) { Invoke-UpgradeHealthLogged $node @('runtime/server/index.mjs') $releaseRoot $upgradeGate }
    Invoke-Logged $node @('runtime/server/index.mjs') $releaseRoot
  }
  'Web' {
    $env:PORT = '3000'
    # Do not pin a public browser endpoint to loopback. Remote Web Control
    # clients derive port 4100 from the same host name/IP used for port 3000.
    Remove-Item Env:NEXT_PUBLIC_PIXEL_SERVER_URL -ErrorAction SilentlyContinue
    # SYSTEM executes the release-protected Node entrypoint directly. npm.cmd
    # remains pinned/audited for installation, but is not a service bootstrap.
    if ($null -ne $upgradeGate) { Invoke-UpgradeHealthLogged $node @('scripts/run-vinext.mjs', 'start') $releaseRoot $upgradeGate }
    Invoke-Logged $node @('scripts/run-vinext.mjs', 'start') $releaseRoot
  }
  'Show' {
    if ($env:SESSIONNAME -like 'RDP-*') {
      throw 'The projector renderer refuses to start in an RDP session.'
    }
    $launcherProcess = Get-Process -Id $PID
    if (-not [Environment]::UserInteractive -or $launcherProcess.SessionId -eq 0) {
      throw 'The projector renderer requires a signed-in interactive Windows user session, never Session 0.'
    }
    $renderer = Assert-NativeBundle $releaseRoot
    $show = Assert-ShowBinding $DataRoot $releaseRoot $renderer
    Clear-PixelBrightnessCameraEnvironment
    $installRoot = Split-Path (Split-Path $releaseRoot -Parent) -Parent
    $cameraAuthority = Read-PixelBrightnessCameraRuntimeAuthority -DataRoot $DataRoot `
      -InstallRoot $installRoot -AllowMissing
    if ($null -ne $cameraAuthority) {
      Set-PixelBrightnessCameraEnvironment $cameraAuthority
    }
    $activeRenderers = @(Get-Process 'pixel-brightness-renderer' -ErrorAction SilentlyContinue)
    if ($activeRenderers.Count -gt 0) {
      throw "Refusing to open projector swapchains while $($activeRenderers.Count) native renderer process(es) already exist."
    }
    # The release launch barrier is still owned here. Recheck the dedicated
    # binder gate at the final check-to-spawn boundary, so a binder cannot
    # publish its gate between this decision and native child creation.
    $null = Assert-PixelBrightnessDisplayBindingLauncherGate $DataRoot
    $null = Assert-PixelBrightnessCameraLauncherGate $DataRoot
    # Re-open the protected parent/commit/generation and rehash both immutable
    # authority and the current renderer cache inside the same barrier. The
    # mutable cache is never authority and native still boots black, but this
    # prevents a stale pre-barrier validation result from reaching child spawn.
    $show = Assert-ShowBinding $DataRoot $releaseRoot $renderer
    $cameraAuthority = Read-PixelBrightnessCameraRuntimeAuthority -DataRoot $DataRoot `
      -InstallRoot $installRoot -AllowMissing
    Clear-PixelBrightnessCameraEnvironment
    if ($null -ne $cameraAuthority) {
      Set-PixelBrightnessCameraEnvironment $cameraAuthority
    }
    $nodeConfig = $show.NodePath
    $rendererConfig = $show.RendererPath
    $nodeId = $show.NodeId
    $pipe = $show.PipeName
    # This one-process authorization is deliberately separate from both the
    # long-lived Server credential and persistent renderer config. Renderer
    # starts black, retains only its digest, and Node can consume it only after
    # strict state hydration proves that no safety lock is retained.
    $env:PIXEL_BRIGHTNESS_RENDERER_BOOT_TOKEN = New-RendererBootToken
    $rendererArgs = "--config `"$rendererConfig`" --pipe `"$pipe`" --node-id `"$nodeId`""
    $rendererProcess = Start-Process -FilePath $renderer -ArgumentList $rendererArgs -WorkingDirectory $releaseRoot -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $logRoot "renderer-$stamp.out.log") -RedirectStandardError (Join-Path $logRoot "renderer-$stamp.err.log")
    Start-Sleep -Milliseconds 300
    if ($rendererProcess.HasExited) {
      Remove-Item Env:PIXEL_BRIGHTNESS_RENDERER_BOOT_TOKEN -ErrorAction SilentlyContinue
      throw "Native renderer exited during startup with code $($rendererProcess.ExitCode). Check renderer-$stamp.err.log."
    }
    $nodeProcess = $null
    $supervisorExitCode = 1
    try {
      $env:PIXEL_BRIGHTNESS_RENDERER_PIPE = $pipe
      $env:PIXEL_BRIGHTNESS_CONFIG = $nodeConfig
      $env:PIXEL_BRIGHTNESS_NODE_TOKEN = Read-NodeToken $DataRoot
      Remove-Item Env:PIXEL_BRIGHTNESS_AUTH_TOKEN -ErrorAction SilentlyContinue
      Remove-Item Env:PIXEL_AUTH_TOKEN -ErrorAction SilentlyContinue
      $nodeArgs = "runtime/node/index.mjs --config `"$nodeConfig`""
      $nodeProcess = Start-Process -FilePath $node -ArgumentList $nodeArgs -WorkingDirectory $releaseRoot -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $logRoot "node-$stamp.out.log") -RedirectStandardError (Join-Path $logRoot "node-$stamp.err.log")
      Complete-PixelBrightnessLauncherBarrier
      Remove-Item Env:PIXEL_BRIGHTNESS_RENDERER_BOOT_TOKEN -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 300
      $rendererProcess.Refresh()
      $nodeProcess.Refresh()
      while (-not $rendererProcess.HasExited -and -not $nodeProcess.HasExited) {
        Start-Sleep -Milliseconds 500
        $rendererProcess.Refresh()
        $nodeProcess.Refresh()
      }

      if ($rendererProcess.HasExited) {
        $rendererExitCode = $rendererProcess.ExitCode
        "[$(Get-Date -Format o)] Native renderer exited with code $rendererExitCode; stopping Node so Task Scheduler can restart the complete Show stack." | Tee-Object -FilePath $logFile -Append
        if (-not $nodeProcess.HasExited) { Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue }
        $supervisorExitCode = if ($rendererExitCode -eq 0) { 1 } else { $rendererExitCode }
      } else {
        $nodeExitCode = $nodeProcess.ExitCode
        "[$(Get-Date -Format o)] Node agent exited with code $nodeExitCode; stopping the native renderer so no stale projector swapchains survive." | Tee-Object -FilePath $logFile -Append
        if (-not $rendererProcess.HasExited) { Stop-Process -Id $rendererProcess.Id -Force -ErrorAction SilentlyContinue }
        $supervisorExitCode = if ($nodeExitCode -eq 0) { 1 } else { $nodeExitCode }
      }
    } finally {
      Remove-Item Env:PIXEL_BRIGHTNESS_RENDERER_BOOT_TOKEN -ErrorAction SilentlyContinue
      Clear-PixelBrightnessCameraEnvironment
      if ($null -ne $nodeProcess) {
        $nodeProcess.Refresh()
        if (-not $nodeProcess.HasExited) { Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue }
      }
      $rendererProcess.Refresh()
      if (-not $rendererProcess.HasExited) { Stop-Process -Id $rendererProcess.Id -Force -ErrorAction SilentlyContinue }
    }
    exit $supervisorExitCode
  }
}
} finally {
  Complete-PixelBrightnessLauncherBarrier
}
