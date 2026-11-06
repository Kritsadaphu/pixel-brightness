[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$SourceRoot = '',
  [string]$InstallRoot = (Join-Path $env:ProgramFiles 'Pixel Brightness'),
  [string]$DataRoot = (Join-Path $env:ProgramData 'Pixel Brightness'),
  [string]$ShowUser = $env:USERNAME,
  [string]$NodeId = 'render-01',
  [string]$NodeName = 'Windows Final Processor 01',
  [ValidateSet('All', 'Server', 'Node')]
  [string]$Role = 'All',
  [ValidateSet('CanonR50RfS1018', 'SonyA7IV', 'Disabled')]
  [string]$CameraProfile = 'CanonR50RfS1018',
  [string]$ServerUrl = 'http://127.0.0.1:4100',
  [string]$NodeTokenFile = '',
  # Removed shared-secret input. Retained only so old unattended commands fail
  # with an explicit migration error instead of being silently reinterpreted.
  [string]$ClusterTokenFile = '',
  [string[]]$TrustedWebClient = @(),
  [string[]]$TrustedWebHost = @(),
  [string]$ExpectedSourceManifestSha256 = '',
  [switch]$AllowUnverifiedDeveloperSource,
  [switch]$Appliance,
  [switch]$SkipNativeBuild,
  [switch]$SkipTasks
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Script-relative defaults must be resolved after parameter binding on Windows PowerShell.
if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
  $SourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..') -ErrorAction Stop).Path
}
. (Join-Path $PSScriptRoot 'RuntimeSecurity.ps1')
$upgradeTransactionPath = Join-Path $PSScriptRoot 'UpgradeTransaction.ps1'
if (-not (Test-Path -LiteralPath $upgradeTransactionPath -PathType Leaf)) {
  throw "Upgrade-transaction policy is missing beside installer: $upgradeTransactionPath"
}
. $upgradeTransactionPath
$cameraRuntimePath = Join-Path $PSScriptRoot 'CameraRuntime.ps1'
if (-not (Test-Path -LiteralPath $cameraRuntimePath -PathType Leaf)) {
  throw "Camera-runtime authority policy is missing beside installer: $cameraRuntimePath"
}
. $cameraRuntimePath
$sourceIntegrityPath = Join-Path $PSScriptRoot 'SourceIntegrity.ps1'
if (-not (Test-Path -LiteralPath $sourceIntegrityPath -PathType Leaf)) {
  throw "Source-integrity policy is missing beside installer: $sourceIntegrityPath"
}
. $sourceIntegrityPath

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run Install-PixelBrightness.ps1 from Windows Terminal as Administrator.'
  }
}

function Invoke-Checked([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory) {
  Push-Location $WorkingDirectory
  try {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$FilePath exited with $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

function New-RandomToken {
  $bytes = [byte[]]::new(32)
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function ConvertTo-Base64Url([byte[]]$Value) {
  return [Convert]::ToBase64String($Value).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function ConvertFrom-Base64Url([string]$Value, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z0-9_-]+$') {
    throw "$Label is not canonical base64url."
  }
  $base64 = $Value.Replace('-', '+').Replace('_', '/')
  switch ($base64.Length % 4) {
    0 { }
    2 { $base64 += '==' }
    3 { $base64 += '=' }
    default { throw "$Label has invalid base64url length." }
  }
  try { $bytes = [Convert]::FromBase64String($base64) }
  catch { throw "$Label is not valid base64url: $($_.Exception.Message)" }
  if ((ConvertTo-Base64Url $bytes) -cne $Value) { throw "$Label is not canonical base64url." }
  return $bytes
}

function Get-NodeIdFromCredential([string]$Token) {
  if ($Token -notmatch '^pbnode\.v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$') {
    throw 'Render Node credential is not in the canonical pbnode.v1 format.'
  }
  $encodedNodeId = $Matches[1]
  $encodedSignature = $Matches[2]
  $nodeBytes = ConvertFrom-Base64Url $encodedNodeId 'Render Node credential identity'
  $signatureBytes = ConvertFrom-Base64Url $encodedSignature 'Render Node credential signature'
  if ($signatureBytes.Length -ne 32) { throw 'Render Node credential signature must contain 32 bytes.' }
  $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
  try { $credentialNodeId = $strictUtf8.GetString($nodeBytes) }
  catch { throw "Render Node credential identity is not UTF-8: $($_.Exception.Message)" }
  if ($credentialNodeId -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' -or
      (ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($credentialNodeId))) -cne $encodedNodeId) {
    throw 'Render Node credential contains an invalid or non-canonical node id.'
  }
  return $credentialNodeId
}

function Assert-NodeCredentialIdentity([string]$Token, [string]$ExpectedNodeId) {
  $credentialNodeId = Get-NodeIdFromCredential $Token
  if ($credentialNodeId -cne $ExpectedNodeId) {
    throw "Render Node credential is bound to $credentialNodeId, not configured node $ExpectedNodeId."
  }
  return $Token
}

function New-NodeCredential([string]$CredentialNodeId, [string]$SigningKey) {
  if ($SigningKey -notmatch '^[A-Za-z0-9_-]{43,128}$') {
    throw 'Render Node signing key is empty or invalid.'
  }
  $keyBytes = [Text.Encoding]::UTF8.GetBytes($SigningKey)
  $payload = [Text.Encoding]::UTF8.GetBytes("pixel-brightness/render-node/v1$([char]0)$CredentialNodeId")
  $algorithm = [Security.Cryptography.HMACSHA256]::new($keyBytes)
  try { $signature = $algorithm.ComputeHash($payload) }
  finally { $algorithm.Dispose() }
  $encodedNodeId = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($CredentialNodeId))
  return "pbnode.v1.$encodedNodeId.$(ConvertTo-Base64Url $signature)"
}

function Assert-GateAwareInstalledLauncherForUpgrade([string]$Root) {
  $pointer = Join-Path $Root 'current-release.txt'
  if (-not (Test-Path -LiteralPath $pointer -PathType Leaf)) { return }
  $launcher = Join-Path $Root 'Start-PixelBrightness.ps1'
  if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw 'legacy_upgrade_bootstrap_required: installed launcher is missing. Stop and disable every Pixel Brightness task, install the gate-aware bootstrap offline, then retry.'
  }
  $helper = Join-Path $Root 'UpgradeTransaction.ps1'
  if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    throw 'legacy_upgrade_bootstrap_required: installed upgrade-gate helper is missing. Stop and disable every Pixel Brightness task, install the gate-aware bootstrap offline, then retry.'
  }
  $null = Assert-AdminProtectedItem (Get-Item -LiteralPath $launcher -Force -ErrorAction Stop) 'Installed gate-aware launcher'
  $null = Assert-AdminProtectedItem (Get-Item -LiteralPath $helper -Force -ErrorAction Stop) 'Installed upgrade-gate helper'
  $launcherText = Get-Content -LiteralPath $launcher -Raw
  $helperText = Get-Content -LiteralPath $helper -Raw
  $launcherMarker = $launcherText.IndexOf('# PixelBrightnessUpgradeGateContract:v1', [StringComparison]::Ordinal)
  $helperMarker = $helperText.IndexOf('# PixelBrightnessUpgradeGateHelperContract:v1', [StringComparison]::Ordinal)
  $launchBarrierMarker = $launcherText.IndexOf('# PixelBrightnessReleaseLaunchBarrierContract:v1', [StringComparison]::Ordinal)
  $launchBarrierHelperMarker = $helperText.IndexOf('# PixelBrightnessReleaseLaunchBarrierHelperContract:v1', [StringComparison]::Ordinal)
  $launchBarrierMatch = [regex]::Match(
    $launcherText,
    '(?m)^\s*\$script:PixelBrightnessLauncherBarrier\s*=\s*Enter-PixelBrightnessReleaseLaunchBarrier\b'
  )
  $launchBarrierHelperMatch = [regex]::Match(
    $helperText,
    '(?m)^\s*function\s+Enter-PixelBrightnessReleaseLaunchBarrier\s*\('
  )
  $gateMatch = [regex]::Match(
    $launcherText,
    '(?m)^\s*\$upgradeGate\s*=\s*Assert-PixelBrightnessUpgradeLauncherGate\s+-DataRoot\s+\$DataRoot\s+-Role\s+\$Role\b'
  )
  $helperMatch = [regex]::Match(
    $helperText,
    '(?m)^\s*function\s+Assert-PixelBrightnessUpgradeLauncherGate\s*\{'
  )
  $pointerMatch = [regex]::Match(
    $launcherText,
    '(?m)^\s*\$currentFile\s*=\s*Join-Path\s+\$DataRoot\s+''current-release\.txt''\s*$'
  )
  if ($launcherMarker -lt 0 -or $helperMarker -lt 0 -or
      $launchBarrierMarker -lt 0 -or $launchBarrierHelperMarker -lt 0 -or
      -not $launchBarrierMatch.Success -or -not $launchBarrierHelperMatch.Success -or
      -not $gateMatch.Success -or
      -not $helperMatch.Success -or -not $pointerMatch.Success -or $gateMatch.Index -gt $pointerMatch.Index) {
    throw 'legacy_upgrade_bootstrap_required: the installed launcher lacks the durable launch/publication barrier or can read the release pointer before enforcing the upgrade gate. Stop and disable every Pixel Brightness task, install the gate-aware barrier bootstrap offline, then retry.'
  }
  if ($launchBarrierMatch.Index -gt $gateMatch.Index) {
    throw 'legacy_upgrade_bootstrap_required: the installed launcher checks the upgrade gate before entering the cross-session launch/publication barrier. Stop and disable every Pixel Brightness task, install the gate-aware barrier bootstrap offline, then retry.'
  }
  foreach ($taskName in @('PixelBrightness-Server', 'PixelBrightness-Web', 'PixelBrightness-Show')) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -eq $task) { continue }
    [xml]$taskXml = Export-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $actions = @($taskXml.Task.Actions.Exec)
    $expectedRole = $taskName.Substring('PixelBrightness-'.Length)
    $expectedFileArgument = "-File `"$launcher`""
    $expectedRoleArgument = "-Role $expectedRole"
    if ($actions.Count -ne 1 -or
        [IO.Path]::GetFileName([string]$actions[0].Command) -ine 'powershell.exe' -or
        ([string]$actions[0].Arguments).IndexOf($expectedFileArgument, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
        ([string]$actions[0].Arguments).IndexOf($expectedRoleArgument, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
      throw "legacy_upgrade_bootstrap_required: scheduled task $taskName does not launch the audited gate-aware bootstrap. Stop and disable every Pixel Brightness task, repair its launcher offline, then retry."
    }
  }
  $scheduleTaskNames = @('PixelBrightness-Schedule', 'PixelBrightness-Schedule-Interactive')
  $existingScheduleTasks = @($scheduleTaskNames | Where-Object {
    $null -ne (Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue)
  })
  if ($existingScheduleTasks.Count -gt 0) {
    if ($existingScheduleTasks.Count -ne 2) {
      throw 'legacy_upgrade_bootstrap_required: weekly scheduler tasks are only partially installed. Disable all Pixel Brightness tasks and repair the scheduler offline.'
    }
    $scheduler = Join-Path $Root 'ShowSchedule.ps1'
    if (-not (Test-Path -LiteralPath $scheduler -PathType Leaf)) {
      throw 'legacy_upgrade_bootstrap_required: installed weekly scheduler is missing.'
    }
    $null = Assert-AdminProtectedItem (Get-Item -LiteralPath $scheduler -Force -ErrorAction Stop) 'Installed weekly scheduler'
    $schedulerText = Get-Content -LiteralPath $scheduler -Raw
    if ($schedulerText.IndexOf('# PixelBrightnessShowScheduleContract:v1', [StringComparison]::Ordinal) -lt 0 -or
        $schedulerText -notmatch 'Enter-PixelBrightnessReleaseLaunchBarrier' -or
        $schedulerText -notmatch 'Assert-PixelBrightnessUpgradeLauncherGate\s+-DataRoot\s+\$DataRoot\s+-Role\s+Schedule') {
      throw 'legacy_upgrade_bootstrap_required: installed weekly scheduler lacks the protected upgrade barrier contract.'
    }
    foreach ($taskName in $scheduleTaskNames) {
      [xml]$taskXml = Export-ScheduledTask -TaskName $taskName -ErrorAction Stop
      $actions = @($taskXml.Task.Actions.Exec)
      $expectedMode = if ($taskName -ceq 'PixelBrightness-Schedule') { 'Worker' } else { 'Interactive' }
      $expectedFileArgument = "-File `"$scheduler`""
      if ($actions.Count -ne 1 -or
          [IO.Path]::GetFileName([string]$actions[0].Command) -ine 'powershell.exe' -or
          ([string]$actions[0].Arguments).IndexOf($expectedFileArgument, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
          ([string]$actions[0].Arguments).IndexOf("-Mode $expectedMode", [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
          [string]$actions[0].Arguments -match 'UpgradeHealth(?:TransactionId|TokenPath)') {
        throw "legacy_upgrade_bootstrap_required: scheduled task $taskName does not launch the audited weekly scheduler mode."
      }
    }
  }
}

function Assert-RealFileDestination([string]$Path) {
  $directory = Split-Path $Path -Parent
  if (-not $directory -or -not (Test-Path -LiteralPath $directory -PathType Container)) {
    throw "Protected destination directory is missing: $directory"
  }
  $directoryItem = Get-Item -LiteralPath $directory -Force -ErrorAction Stop
  if (($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Protected destination directory is a reparse point: $directory"
  }
  $existing = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($null -ne $existing) {
    if ($existing.PSIsContainer -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Protected destination must be a real file, never a directory or reparse point: $Path"
    }
  }
}

function Write-Utf8Text([string]$Path, [string]$Value) {
  Assert-RealFileDestination $Path
  $encoding = [Text.UTF8Encoding]::new($false)
  Write-PixelBrightnessAtomicBytes $Path ($encoding.GetBytes($Value))
}

function Write-Utf8Json([string]$Path, [object]$Value, [int]$Depth = 20) {
  $json = $Value | ConvertTo-Json -Depth $Depth
  Write-Utf8Text $Path ($json + "`n")
}

function Protect-ReadOnlyForShow([string]$Path, [string]$User) {
  $null = Protect-AdminControlPath -Path $Path -ShowUser $User -ShowAccess Read -Label 'Pixel Brightness read-only Show data'
}

function Stop-ScheduledTaskAndWait([string]$TaskName) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task -or [string]$task.State -notin @('Running', 'Queued')) { return }
  Stop-ScheduledTask -TaskName $TaskName
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  } while ([string]$task.State -in @('Running', 'Queued') -and [DateTimeOffset]::UtcNow -lt $deadline)
  if ([string]$task.State -in @('Running', 'Queued')) {
    throw "Scheduled task $TaskName did not stop within 15 seconds; nothing was published."
  }
}

function Unregister-PixelBrightnessTask([string]$TaskName) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) { return }
  Stop-ScheduledTaskAndWait $TaskName
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
  if ($null -ne (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    throw "Scheduled task still exists after unregister: $TaskName"
  }
}

function Wait-NoPixelBrightnessServiceListeners([int]$TimeoutSeconds = 15) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Where-Object { [int]$_.LocalPort -in @(3000, 4100) })
    if ($listeners.Count -eq 0) { return }
    Start-Sleep -Milliseconds 500
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  $owners = @($listeners | ForEach-Object { "$($_.LocalPort)/PID$($_.OwningProcess)" } | Sort-Object -Unique)
  throw "Managed HTTP port remained occupied after tasks stopped: $($owners -join ', ')"
}

function Assert-FreshPixelBrightnessListener([int]$Port, [string]$CommandPattern, [DateTimeOffset]$StartedAfter) {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)
  $owners = @($listeners | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
  if ($owners.Count -ne 1) { throw "Port $Port is not owned by exactly one fresh service process" }
  $process = Get-Process -Id $owners[0] -ErrorAction Stop
  if ([DateTimeOffset]$process.StartTime -lt $StartedAfter.AddSeconds(-2)) {
    throw "Port $Port is served by a process older than this upgrade transaction (PID $($process.Id))"
  }
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)" -ErrorAction Stop
  if ([string]$cim.CommandLine -notmatch $CommandPattern) {
    throw "Port $Port is served by an unexpected process command (PID $($process.Id))"
  }
}

function Invoke-InstallFaultInjection([string]$Point) {
  # Test-only failure hooks let a physical Windows acceptance VM prove every
  # rollback boundary. They are inert unless an Administrator deliberately
  # sets the exact environment variable for that process.
  if ([string]$env:PIXEL_BRIGHTNESS_INSTALL_FAULT_INJECTION -ceq $Point) {
    throw "Injected Pixel Brightness installer failure at $Point"
  }
}

function Wait-PixelBrightnessTaskState([string]$TaskName, [string]$ExpectedState, [int]$TimeoutSeconds = 45) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    if ([string]$task.State -ceq $ExpectedState) { return $task }
    Start-Sleep -Milliseconds 500
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Scheduled task $TaskName did not reach $ExpectedState within $TimeoutSeconds seconds (last state: $($task.State))"
}

function Register-PixelBrightnessUpgradeHealthTask {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('Server', 'Web')][string]$Role,
    [Parameter(Mandatory = $true)][string]$TaskName,
    [Parameter(Mandatory = $true)][string]$Launcher,
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$TransactionId,
    [Parameter(Mandatory = $true)][string]$TokenPath,
    [Parameter(Mandatory = $true)][string]$PowerShell,
    [Parameter(Mandatory = $true)][object]$Settings
  )
  if ($TaskName -notmatch '^PixelBrightness-UpgradeHealth-(?:Server|Web)-[0-9a-f]{12}$') {
    throw "Transient health task name is invalid: $TaskName"
  }
  $argument = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$Launcher`" -Role $Role -DataRoot `"$DataRoot`" -UpgradeHealthTransactionId `"$TransactionId`" -UpgradeHealthTokenPath `"$TokenPath`""
  $action = New-ScheduledTaskAction -Execute $PowerShell -Argument $argument
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  # Deliberately no trigger: this process exists only for one installer-owned
  # precommit probe. Its protected token is atomically consumed by the launcher
  # and cannot be replayed after a crash or reboot.
  Register-ScheduledTask -TaskName $TaskName -Action $action -Settings $Settings -Principal $principal -Force | Out-Null
}

function Assert-PixelBrightnessFinalTasksBehindGate {
  param(
    [Parameter(Mandatory = $true)][bool]$InstallServer,
    [Parameter(Mandatory = $true)][bool]$InstallNode,
    [Parameter(Mandatory = $true)][bool]$InstallSchedule,
    [Parameter(Mandatory = $true)][string]$Launcher,
    [Parameter(Mandatory = $true)][string]$Scheduler
  )
  foreach ($entry in @(
    @{ Name = 'PixelBrightness-Server'; Expected = $InstallServer; Script = $Launcher; Mode = $null },
    @{ Name = 'PixelBrightness-Web'; Expected = $InstallServer; Script = $Launcher; Mode = $null },
    @{ Name = 'PixelBrightness-Show'; Expected = $InstallNode; Script = $Launcher; Mode = $null },
    @{ Name = 'PixelBrightness-Schedule'; Expected = $InstallSchedule; Script = $Scheduler; Mode = 'Worker' },
    @{ Name = 'PixelBrightness-Schedule-Interactive'; Expected = $InstallSchedule; Script = $Scheduler; Mode = 'Interactive' }
  )) {
    $task = Get-ScheduledTask -TaskName $entry.Name -ErrorAction SilentlyContinue
    if ($entry.Expected -ne $true) {
      if ($null -ne $task) { throw "Unexpected final task exists behind the upgrade gate: $($entry.Name)" }
      continue
    }
    if ($null -eq $task -or [string]$task.State -cne 'Disabled') {
      throw "Final task is not durably disabled behind the upgrade gate: $($entry.Name)"
    }
    $xml = [string](Export-ScheduledTask -TaskName $entry.Name -ErrorAction Stop)
    if ($xml -notmatch [regex]::Escape([string]$entry.Script) -or
        ($null -ne $entry.Mode -and $xml -notmatch ("-Mode\s+{0}" -f [regex]::Escape([string]$entry.Mode))) -or
        $xml -match 'UpgradeHealth(?:TransactionId|TokenPath)|PixelBrightness-UpgradeHealth-') {
      throw "Final task contains a missing, transient, or replayable launcher action: $($entry.Name)"
    }
    if ($entry.Name -ceq 'PixelBrightness-Show') {
      if ($InstallSchedule -and $xml -match '<LogonTrigger(?:\s|>)') {
        throw 'Role All requires scheduler-owned PixelBrightness-Show with no automatic logon trigger.'
      }
      if (-not $InstallSchedule -and $xml -notmatch '<LogonTrigger(?:\s|>)') {
        throw 'A standalone Role Node requires PixelBrightness-Show to start at local Show-user logon.'
      }
    }
  }
}

function Wait-PixelBrightnessJsonHealth([string]$Uri, [int]$TimeoutSeconds = 60) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastFailure = 'no response'
  do {
    try {
      $health = Invoke-RestMethod -Uri $Uri -TimeoutSec 5 -ErrorAction Stop
      if ([string]$health.service -cne 'pixel-brightness-server') {
        throw "unexpected service identity: $($health.service)"
      }
      if ($health.ok -ne $true -or [int]$health.protocolVersion -ne 1 -or
          [string]::IsNullOrWhiteSpace([string]$health.version)) {
        throw 'control API health contract is incomplete or unhealthy'
      }
      if ([string]$health.accessMode -notin @('token', 'trusted-local')) {
        throw "control API has an unexpected authentication mode: $($health.accessMode)"
      }
      return $health
    } catch {
      $lastFailure = $_.Exception.Message
      Start-Sleep -Milliseconds 500
    }
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Pixel Server health did not pass at $Uri within $TimeoutSeconds seconds: $lastFailure"
}

function Wait-PixelBrightnessAuthenticatedState([string]$Uri, [string]$Token, [int]$TimeoutSeconds = 60) {
  if ($Token -notmatch '^[A-Za-z0-9_-]{43,128}$') { throw 'Installed control token is invalid during health verification' }
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastFailure = 'no response'
  do {
    try {
      $state = Invoke-RestMethod -Uri $Uri -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5 -ErrorAction Stop
      if ([int]$state.protocolVersion -ne 1 -or $state.server.ok -ne $true -or
          [string]$state.server.service -cne 'pixel-brightness-server' -or
          [string]$state.server.accessMode -notin @('token', 'trusted-local')) {
        throw 'authenticated control state has an unexpected identity, protocol, or access mode'
      }
      return $state
    } catch {
      $lastFailure = $_.Exception.Message
      Start-Sleep -Milliseconds 500
    }
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Authenticated Pixel Server state did not pass at $Uri within $TimeoutSeconds seconds: $lastFailure"
}

function Wait-PixelBrightnessWebHealth([int]$TimeoutSeconds = 60) {
  $uri = 'http://127.0.0.1:3000/'
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastFailure = 'no response'
  do {
    try {
      $response = Invoke-WebRequest -Uri $uri -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
      if ($response.StatusCode -ne 200 -or [string]$response.Content -notmatch 'PIXEL') {
        throw "unexpected Web response: HTTP $($response.StatusCode)"
      }
      return $response
    } catch {
      $lastFailure = $_.Exception.Message
      Start-Sleep -Milliseconds 500
    }
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Pixel Web health did not pass at $uri within $TimeoutSeconds seconds: $lastFailure"
}

function Assert-PostInstallHealth {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$ReleaseRoot,
    [Parameter(Mandatory = $true)][string]$ServerUrl,
    [Parameter(Mandatory = $true)][bool]$InstallServer,
    [Parameter(Mandatory = $true)][bool]$InstallNode,
    [Parameter(Mandatory = $true)][bool]$TasksSkipped,
    [string]$ServerTaskName = 'PixelBrightness-Server',
    [string]$WebTaskName = 'PixelBrightness-Web',
    [DateTimeOffset]$ServicesStartedAfter = [DateTimeOffset]::MinValue
  )
  $null = Assert-PixelBrightnessControlPlane -DataRoot $DataRoot -IncludeSystemDirectories
  foreach ($relative in @(
    'UpgradeTransaction.ps1', 'Recover-PixelBrightnessUpgrade.ps1',
    'CameraRuntime.ps1', 'Provision-PixelBrightnessCanonCamera.ps1',
    'ShowSchedule.ps1', 'ArenaSaveEvidence.ps1'
  )) {
    $helper = Assert-PixelBrightnessPlainFile (Join-Path $DataRoot $relative) "Published upgrade helper $relative"
    if ($null -eq $helper) { throw "Published upgrade helper is missing: $relative" }
    $null = Assert-AdminProtectedItem $helper "Published upgrade helper $relative"
  }
  $null = Assert-AdminProtectedReleaseLocation $ReleaseRoot
  $null = Assert-PixelBrightnessReleaseManifest $ReleaseRoot
  $pointer = (Get-Content -LiteralPath (Join-Path $DataRoot 'current-release.txt') -Raw).Trim()
  if (-not [string]::Equals($pointer, $ReleaseRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Published release pointer does not select the new release: $pointer"
  }
  foreach ($relative in @('secrets\runtime.json', 'secrets\installation.json', 'secrets\trusted-web.json')) {
    try { Get-Content -LiteralPath (Join-Path $DataRoot $relative) -Raw | ConvertFrom-Json | Out-Null }
    catch { throw "Published control JSON is invalid ($relative): $($_.Exception.Message)" }
  }
  if ($InstallNode) {
    foreach ($relative in @('config\node.json', 'config\renderer.json', 'config\display-binding.json')) {
      try { Get-Content -LiteralPath (Join-Path $DataRoot $relative) -Raw | ConvertFrom-Json | Out-Null }
      catch { throw "Published Node JSON is invalid ($relative): $($_.Exception.Message)" }
    }
    $null = Read-PixelBrightnessCameraRuntimeAuthority -DataRoot $DataRoot -InstallRoot (Split-Path (Split-Path $ReleaseRoot -Parent) -Parent)
  }
  if (-not $TasksSkipped) {
    if ($InstallServer) {
      $null = Wait-PixelBrightnessTaskState $ServerTaskName 'Running'
      $null = Wait-PixelBrightnessTaskState $WebTaskName 'Running'
      foreach ($taskName in @($ServerTaskName, $WebTaskName)) {
        $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop
        $lastRun = [DateTimeOffset]$taskInfo.LastRunTime
        if ($lastRun.ToUniversalTime() -lt $ServicesStartedAfter.ToUniversalTime().AddSeconds(-2)) {
          throw "Scheduled task $taskName did not start in this upgrade transaction (LastRunTime: $lastRun)"
        }
      }
    }
    if ($InstallNode) {
      $show = Get-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop
      if ([string]$show.State -cne 'Disabled') {
        throw "PixelBrightness-Show must remain fail-closed until display binding (state: $($show.State))"
      }
    }
    if ($InstallServer -and $InstallNode) {
      foreach ($taskName in @('PixelBrightness-Schedule', 'PixelBrightness-Schedule-Interactive')) {
        if ($null -eq (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
          throw "Weekly show scheduler task is missing: $taskName"
        }
      }
    }
    foreach ($unexpected in @(
      @{ Name = 'PixelBrightness-Server'; Expected = $InstallServer },
      @{ Name = 'PixelBrightness-Web'; Expected = $InstallServer },
      @{ Name = 'PixelBrightness-Show'; Expected = $InstallNode },
      @{ Name = 'PixelBrightness-Schedule'; Expected = ($InstallServer -and $InstallNode) },
      @{ Name = 'PixelBrightness-Schedule-Interactive'; Expected = ($InstallServer -and $InstallNode) }
    ) | Where-Object { $_.Expected -ne $true }) {
      if ($null -ne (Get-ScheduledTask -TaskName $unexpected.Name -ErrorAction SilentlyContinue)) {
        throw "Unexpected scheduled task remains after role publication: $($unexpected.Name)"
      }
    }
  }
  if ($TasksSkipped) {
    Write-Warning 'Runtime health probes were skipped because -SkipTasks explicitly suppresses task registration/startup; only protected publication and JSON integrity were verified.'
    return $true
  }
  $healthOrigin = if ($InstallServer) { 'http://127.0.0.1:4100' } else { $ServerUrl.TrimEnd('/') }
  # Server and Web verify the full release behind a serialized launch barrier.
  # A cold Windows host can spend several minutes auditing a 20k-file payload.
  # Keep startup bounded without confusing that work with a failed service.
  $null = Wait-PixelBrightnessJsonHealth "$healthOrigin/v1/health" 900
  if ($InstallServer) {
    $installedControlToken = (Get-Content -LiteralPath (Join-Path $DataRoot 'secrets\control-token.txt') -Raw).Trim()
    $null = Wait-PixelBrightnessAuthenticatedState "$healthOrigin/v1/state?includeProject=0" $installedControlToken
    $null = Wait-PixelBrightnessWebHealth 900
    Assert-FreshPixelBrightnessListener 4100 'runtime[\\/]server[\\/]index\.mjs' $ServicesStartedAfter
    Assert-FreshPixelBrightnessListener 3000 'vinext[\\/].*cli\.js.*start' $ServicesStartedAfter
    # A second live sample rejects a task that only stayed Running long enough
    # for one stale/orphan endpoint response during restart churn.
    Start-Sleep -Seconds 2
    $null = Wait-PixelBrightnessTaskState $ServerTaskName 'Running' 5
    $null = Wait-PixelBrightnessTaskState $WebTaskName 'Running' 5
    $null = Wait-PixelBrightnessJsonHealth "$healthOrigin/v1/health" 10
    $null = Wait-PixelBrightnessAuthenticatedState "$healthOrigin/v1/state?includeProject=0" $installedControlToken 10
    $null = Wait-PixelBrightnessWebHealth 10
    Assert-FreshPixelBrightnessListener 4100 'runtime[\\/]server[\\/]index\.mjs' $ServicesStartedAfter
    Assert-FreshPixelBrightnessListener 3000 'vinext[\\/].*cli\.js.*start' $ServicesStartedAfter
  }
  return $true
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
  foreach ($relative in @(
    'native\windows\config\renderer.example.json',
    'native\windows\config\renderer.schema.json'
  )) {
    $path = Join-Path $ReleasePath $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -le 0) {
      throw "Native renderer contract is missing or empty: $path"
    }
    try { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json | Out-Null }
    catch { throw "Native renderer contract is invalid JSON ($path): $($_.Exception.Message)" }
  }
  return $rendererPath
}

function Normalize-TrustedClients([string[]]$Values) {
  $result = [System.Collections.Generic.List[string]]::new()
  foreach ($value in $Values) {
    $candidate = ([string]$value).Trim()
    if (-not $candidate) { continue }
    $parsed = $null
    if (-not [Net.IPAddress]::TryParse($candidate, [ref]$parsed)) {
      throw "TrustedWebClient must be an exact IPv4 or IPv6 address, not a subnet or wildcard: $candidate"
    }
    $result.Add($parsed.ToString().ToLowerInvariant())
  }
  return @($result | Select-Object -Unique)
}

function Normalize-TrustedHosts([string[]]$Values) {
  $result = [System.Collections.Generic.List[string]]::new()
  foreach ($value in $Values) {
    $candidate = ([string]$value).Trim().Trim([char[]]'[]').ToLowerInvariant()
    if (-not $candidate) { continue }
    $parsed = $null
    $isAddress = [Net.IPAddress]::TryParse($candidate, [ref]$parsed)
    $isDnsName = $candidate -match '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
    if (-not $isAddress -and -not $isDnsName) {
      throw "TrustedWebHost must be an exact host name or IP address without a scheme, port, subnet, or wildcard: $candidate"
    }
    $result.Add($(if ($isAddress) { $parsed.ToString().ToLowerInvariant() } else { $candidate }))
  }
  return @($result | Select-Object -Unique)
}

Assert-Administrator
$sourceIntegrity = Assert-PixelBrightnessSourceManifest -SourceRoot $SourceRoot `
  -ExpectedManifestSha256 $ExpectedSourceManifestSha256 `
  -AllowMissing:$AllowUnverifiedDeveloperSource
$ExpectedSourceManifestSha256 = [string]$sourceIntegrity.ManifestSha256
$installServer = $Role -in @('All', 'Server')
$installNode = $Role -in @('All', 'Node')
$installSchedule = $Role -eq 'All'
# Probe effective power settings before creating any durable upgrade gate.
if ($Appliance) { $null = Get-PixelBrightnessPowerSnapshot }
if ($installNode) {
  $cameraPreflight = New-PixelBrightnessUnconfiguredCameraAuthority -DataRoot $DataRoot -Profile $CameraProfile
  $null = Assert-PixelBrightnessCameraAuthorityObject -Authority $cameraPreflight -DataRoot $DataRoot -InstallRoot $InstallRoot
}
& (Join-Path $PSScriptRoot 'Preflight-PixelBrightness.ps1') `
  -RequireRenderHost:$installNode -RequireArena:$installNode `
  -RequireNativeToolchain:($installNode -and -not $SkipNativeBuild)

$nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
$protectedRuntime = Assert-ProtectedNodeRuntime $nodeCommand $npmCommand
$nodeCommand = [string]$protectedRuntime.node
$npmCommand = [string]$protectedRuntime.npm
$TrustedWebClient = @(Normalize-TrustedClients $TrustedWebClient)
$TrustedWebHost = @(Normalize-TrustedHosts $TrustedWebHost)
if (($TrustedWebClient.Count -gt 0) -xor ($TrustedWebHost.Count -gt 0)) {
  throw 'Trusted local Web Control requires both -TrustedWebClient and -TrustedWebHost; otherwise use neither.'
}
if (-not $installServer -and ($TrustedWebClient.Count -gt 0 -or $TrustedWebHost.Count -gt 0)) {
  throw 'TrustedWebClient/TrustedWebHost apply only to a Server or All installation.'
}
$serverUri = $null
$ServerUrl = $ServerUrl.Trim().TrimEnd('/')
if (-not [Uri]::TryCreate($ServerUrl, [UriKind]::Absolute, [ref]$serverUri) -or
    $serverUri.Scheme -notin @('http', 'https') -or -not [string]::IsNullOrEmpty($serverUri.UserInfo) -or
    -not [string]::IsNullOrEmpty($serverUri.Query) -or -not [string]::IsNullOrEmpty($serverUri.Fragment) -or
    $serverUri.AbsolutePath -ne '/') {
  throw 'ServerUrl must be an absolute HTTP(S) origin without credentials, path, query, or fragment.'
}
if ($Role -eq 'All' -and $serverUri.Host -notin @('127.0.0.1', 'localhost', '::1')) {
  throw 'Role All owns the local Server; use the default loopback ServerUrl. Use Role Node for a central remote Server.'
}
if ($NodeId -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$') {
  throw 'NodeId must be 1-64 characters using letters, numbers, dot, underscore, or hyphen.'
}
if (-not [string]::IsNullOrWhiteSpace($ClusterTokenFile)) {
  throw 'ClusterTokenFile is a retired shared credential and is rejected. Rotate the Server control token and import a per-node -NodeTokenFile instead.'
}
$importedNodeToken = $null
if (-not [string]::IsNullOrWhiteSpace($NodeTokenFile)) {
  if ($Role -ne 'Node') {
    throw 'NodeTokenFile is accepted only for a render-only Role Node installation; Role All derives its local credential from the Server-only signing key.'
  }
  $resolvedNodeTokenFile = (Resolve-Path -LiteralPath $NodeTokenFile -ErrorAction Stop).Path
  $importedNodeToken = (Get-Content -LiteralPath $resolvedNodeTokenFile -Raw).Trim()
  $null = Assert-NodeCredentialIdentity $importedNodeToken $NodeId
}
$existingNodeTokenPath = Join-Path $DataRoot 'secrets\node-token.txt'
if ($Role -eq 'Node' -and $null -eq $importedNodeToken) {
  if (-not (Test-Path -LiteralPath $existingNodeTokenPath -PathType Leaf)) {
    throw 'A new Node installation requires -NodeTokenFile containing the per-node credential generated on the central Server. Shared cluster tokens are never accepted.'
  }
  $existingNodeToken = (Get-Content -LiteralPath $existingNodeTokenPath -Raw).Trim()
  $null = Assert-NodeCredentialIdentity $existingNodeToken $NodeId
}
if ([string]::IsNullOrWhiteSpace($ShowUser) -or $ShowUser -match '["\x00-\x1f\x7f]') {
  throw 'ShowUser cannot be empty or contain quotes/control characters.'
}
$null = Resolve-PixelBrightnessAccountSid $ShowUser 'Show user'

foreach ($path in @($InstallRoot, $DataRoot)) {
  if ([string]::IsNullOrWhiteSpace($path) -or $path -match '^[A-Za-z]:\\?$') { throw "Unsafe install path: $path" }
}
$null = Get-PathWithinAdminRoot $InstallRoot $env:ProgramFiles 'Pixel Brightness install root'
$null = Get-PathWithinAdminRoot $DataRoot $env:ProgramData 'Pixel Brightness data root'
if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot 'runtime\server\index.mjs'))) {
  throw "SourceRoot is not a Pixel Brightness repository: $SourceRoot"
}

$version = "0.3.0-win-$(Get-Date -Format 'yyyyMMddHHmmss')"
$stagingParent = Join-Path $env:ProgramData 'Pixel Brightness Build'
$stageRoot = Join-Path $stagingParent "b-$([guid]::NewGuid().ToString('N'))"
# MSBuild/FetchContent still contain MAX_PATH-limited tools on Windows.
# Keep transient paths short; the published release retains its full version.
$stageRelease = Join-Path $stageRoot 'src'
$releaseRoot = Join-Path (Join-Path $InstallRoot 'releases') $version
$snapshotRoot = Join-Path $stageRoot 'transaction-snapshot'
$journalPath = Join-Path $snapshotRoot 'snapshot.json'
$transactionId = [guid]::NewGuid().ToString('D')
$upgradeSnapshot = $null
$transactionDirty = $false
$transactionCommitted = $false
$preserveRecoverySnapshot = $false
$releasePublishStaging = $null
$installMutex = [Threading.Mutex]::new($false, 'Global\PixelBrightnessInstaller')
$installMutexHeld = $false
try {
  $installMutexHeld = $installMutex.WaitOne(0)
} catch [Threading.AbandonedMutexException] {
  $installMutexHeld = $true
}
if (-not $installMutexHeld) {
  $installMutex.Dispose()
  throw 'Another Pixel Brightness installer is already running. No state was changed.'
}

try {
  # An abandoned binder mutex is not recovery evidence. Refuse to supersede a
  # durable display-binding intent (or a corrupt protected gate) before staging
  # or publishing any release mutation; the binder must reconcile Server A/B
  # and clear its own exact gate first.
  $null = Assert-PixelBrightnessDisplayBindingInstallerReady $DataRoot
  if (Test-Path -LiteralPath (Get-PixelBrightnessCameraTransactionGatePath $DataRoot)) {
    throw 'A Canon camera-runtime provision transaction is unresolved. Re-run Provision-PixelBrightnessCanonCamera.ps1 locally as Administrator before installing.'
  }
  $null = Initialize-AdminProtectedDirectory $stagingParent $env:ProgramData $ShowUser 'Pixel Brightness build staging parent'
  $gatePathAtStartup = Get-PixelBrightnessUpgradeGatePath $DataRoot
  if (Test-Path -LiteralPath $gatePathAtStartup) {
    try { Set-PixelBrightnessUpgradeFailClosed }
    catch { throw "An upgrade boot gate is active and fail-closed enforcement was incomplete: $($_.Exception.Message). Disconnect this host and service locally." }
    throw "An upgrade boot gate is active; run Recover-PixelBrightnessUpgrade.ps1 locally as Administrator before another install: $gatePathAtStartup"
  }
  try {
    $unresolvedTransactions = @(Get-ChildItem -LiteralPath $stagingParent -Directory -Force -ErrorAction Stop |
      Where-Object {
        $candidateJournal = Join-Path $_.FullName 'transaction-snapshot\snapshot.json'
        (Test-Path -LiteralPath $candidateJournal -PathType Leaf) -and
          -not (Test-PixelBrightnessUpgradeCommitRecord $candidateJournal) -and
          -not (Test-PixelBrightnessUpgradeRecoveryRecord $candidateJournal)
      })
  } catch {
    $journalAuditError = $_.Exception
    try { Set-PixelBrightnessUpgradeFailClosed }
    catch { throw "Protected upgrade journal inventory is corrupt and fail-closed enforcement was incomplete: $($_.Exception.Message). Disconnect this host and service locally." }
    throw [InvalidOperationException]::new("Protected upgrade journal inventory is corrupt or untrusted; all managed runtime was forced closed. Recover locally before another install: $($journalAuditError.Message)", $journalAuditError)
  }
  if ($unresolvedTransactions.Count -gt 0) {
    try { Set-PixelBrightnessUpgradeFailClosed }
    catch { throw "An unresolved journal exists and fail-closed enforcement was incomplete: $($_.Exception.Message). Disconnect this host and service locally." }
    throw "Unresolved protected upgrade journal exists; local recovery is required before another install: $($unresolvedTransactions[0].FullName)"
  }
  $null = Initialize-AdminProtectedDirectory $stageRoot $env:ProgramData $ShowUser 'Pixel Brightness build staging root'
  $null = Protect-AdminControlPath -Path $stageRoot -ShowUser $ShowUser -ShowAccess None -Label 'Pixel Brightness build staging root'
  New-Item -ItemType Directory -Force -Path $stageRelease | Out-Null
  $robocopyArgs = @(
    $SourceRoot, $stageRelease, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:2', '/W:1',
    # Root build/ contains the checked-in Sites/Vite source plugin used by
    # vite.config.ts. It is source code, not generated output, and must reach
    # staging before npm run build.
    '/XD', '.git', '.next', 'dist', 'node_modules', 'outputs', 'work', 'cache',
    '/XF', '*.iso', '*.img', '*.key', '*.pfx', '*.pem'
  )
  $robocopyCommand = Join-Path $env:SystemRoot 'System32\robocopy.exe'
  if (-not (Test-Path -LiteralPath $robocopyCommand -PathType Leaf)) { throw "Trusted robocopy.exe is missing: $robocopyCommand" }
  & $robocopyCommand @robocopyArgs | Out-Host
  if ($LASTEXITCODE -gt 7) { throw "robocopy exited with $LASTEXITCODE" }

  $null = Assert-PixelBrightnessSourceManifest -SourceRoot $stageRelease `
    -ExpectedManifestSha256 $ExpectedSourceManifestSha256 `
    -AllowMissing:$AllowUnverifiedDeveloperSource

  # ZIP timestamps have no time-zone offset. A handoff extracted in another
  # zone can place CMakeLists.txt in the future, causing parallel MSBuild
  # targets to regenerate the same dependency files concurrently. Only clamp
  # future metadata on this verified private copy; file contents are unchanged.
  $sourceTimestampCeiling = [DateTime]::UtcNow
  foreach ($sourceFile in @(Get-ChildItem -LiteralPath $stageRelease -File -Recurse -Force)) {
    if ($sourceFile.LastWriteTimeUtc -gt $sourceTimestampCeiling) {
      $sourceFile.LastWriteTimeUtc = $sourceTimestampCeiling
    }
  }

  Invoke-Checked $npmCommand @('ci', '--ignore-scripts=false') $stageRelease
  if ($installServer) {
    # Public endpoint selection is always browser-host derived. Explicitly
    # remove stale inherited values as defense in depth before the Web build.
    Remove-Item Env:NEXT_PUBLIC_PIXEL_SERVER_URL -ErrorAction SilentlyContinue
    Invoke-Checked $npmCommand @('run', 'build') $stageRelease
  }

  if ($installNode -and -not $SkipNativeBuild) {
    $nativeSource = Join-Path $stageRelease 'native\windows'
    if (-not (Test-Path -LiteralPath (Join-Path $nativeSource 'CMakeLists.txt'))) {
      throw 'native/windows/CMakeLists.txt is missing'
    }
    # Build outside the release payload: shorter MSBuild paths, and no SDK
    # clones/intermediates in the immutable installed application.
    $nativeBuild = Join-Path $stageRoot 'nb'
    Invoke-Checked (Get-Command cmake.exe).Source @('-S', $nativeSource, '-B', $nativeBuild, '-A', 'x64') $stageRelease
    Invoke-Checked (Get-Command cmake.exe).Source @('--build', $nativeBuild, '--config', 'Release', '--parallel') $stageRelease
    Invoke-Checked (Get-Command ctest.exe).Source @('--test-dir', $nativeBuild, '-C', 'Release', '--output-on-failure') $stageRelease
    $nativeExe = Join-Path $nativeBuild 'Release\pixel-brightness-renderer.exe'
    if (-not (Test-Path -LiteralPath $nativeExe -PathType Leaf) -or (Get-Item -LiteralPath $nativeExe).Length -le 0) {
      throw "Native build completed without the exact Release x64 renderer: $nativeExe"
    }
    $nativeBin = Join-Path $nativeSource 'bin'
    New-Item -ItemType Directory -Force -Path $nativeBin | Out-Null
    Copy-Item -LiteralPath $nativeExe -Destination (Join-Path $nativeBin 'pixel-brightness-renderer.exe') -Force
    $shaderSource = Join-Path $nativeSource 'shaders'
    $shaderDestination = Join-Path $nativeBin 'shaders'
    New-Item -ItemType Directory -Force -Path $shaderDestination | Out-Null
    foreach ($shaderName in @('fullscreen_vs.hlsl', 'final_ps.hlsl')) {
      $shader = Join-Path $shaderSource $shaderName
      if (-not (Test-Path -LiteralPath $shader -PathType Leaf) -or (Get-Item -LiteralPath $shader).Length -le 0) {
        throw "Native renderer shader is missing or empty: $shader"
      }
      Copy-Item -LiteralPath $shader -Destination (Join-Path $shaderDestination $shaderName) -Force
    }
  }
  if ($installNode) { $null = Assert-NativeBundle $stageRelease }

  # The build tree becomes immutable only after npm/native build and tests have
  # completed. Bind every regular, non-reparse payload file into one exact
  # manifest, then force both payload and manifest bytes through the Windows
  # storage cache before any release directory or pointer can be published.
  Write-Host 'Build complete. Creating the complete release inventory...'
  $releaseManifestPath = Write-PixelBrightnessReleaseManifest $stageRelease
  Invoke-InstallFaultInjection 'after-release-manifest'
  Write-Host 'Release inventory complete. Flushing payload files to disk...'
  Sync-PixelBrightnessReleaseTree $stageRelease
  Write-Host 'Payload flush complete. Verifying staged release...'
  $stagedReleaseManifest = Assert-PixelBrightnessReleaseManifest $stageRelease
  if (-not [string]::Equals(
    [IO.Path]::GetFullPath($releaseManifestPath),
    [IO.Path]::GetFullPath([string]$stagedReleaseManifest.ManifestPath),
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw 'Final staged release manifest resolved to an unexpected path.'
  }
  Invoke-InstallFaultInjection 'after-release-payload-flush'

  $persistentTargets = "$releaseRoot; $DataRoot; PixelBrightness $Role scheduled tasks$(if ($installServer) { '; Private firewall ports 3000/4100' } else { '' })"
  if (-not $PSCmdlet.ShouldProcess($persistentTargets, "Install Pixel Brightness $version")) {
    Write-Warning 'Installation was not committed; staging will be removed and no persistent configuration will be changed.'
    return
  }
  $activeRenderers = @(Get-Process 'pixel-brightness-renderer' -ErrorAction SilentlyContinue)
  if ($activeRenderers.Count -gt 0) {
    throw "Found $($activeRenderers.Count) active native renderer process(es). Close the live/orphan renderer before installing; nothing was published."
  }
  if ($SkipTasks) {
    $managedTasks = @(Get-PixelBrightnessManagedTaskNames) |
      ForEach-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue } |
      Where-Object { $null -ne $_ }
    if (@($managedTasks).Count -gt 0) {
      throw '-SkipTasks is allowed only when no Pixel Brightness scheduled task exists; an in-place upgrade must stop and transactionally restore managed tasks.'
    }
  }
  $existingPointer = Join-Path $DataRoot 'current-release.txt'
  if (Test-Path -LiteralPath $existingPointer -PathType Leaf) {
    # A pre-gate launcher could start the old generation after a power loss in
    # the interval between publishing the first gate and disabling its tasks.
    # Refuse that upgrade before any persistent application state changes.
    Assert-GateAwareInstalledLauncherForUpgrade $DataRoot
    $null = Assert-PixelBrightnessControlPlane -DataRoot $DataRoot -IncludeSystemDirectories -AllowLegacyCredentials
    $priorRelease = (Get-Content -LiteralPath $existingPointer -Raw).Trim()
    $null = Assert-AdminProtectedReleaseLocation $priorRelease
  }
  # Publish the durable boot gate before touching any task or generation file.
  # Gate-aware installed launchers fail before reading current-release.txt.
  # The gate is safety metadata; all managed tasks are then durably disabled
  # before the first mutable application control is published.
  $null = Initialize-AdminProtectedDirectory $DataRoot $env:ProgramData $ShowUser 'Pixel Brightness data root'
  $releaseLaunchBarrier = $null
  try {
    # Lock ordering is global installer mutex -> release launch barrier. A
    # launcher never acquires the installer mutex, so there is no reverse-order
    # cycle. Its fresh gate decision and child creation are one serialized side;
    # gate publication plus complete process/listener drain are the other.
    $releaseLaunchBarrier = Enter-PixelBrightnessReleaseLaunchBarrier
    $transactionDirty = $true
    $null = Write-PixelBrightnessUpgradeGate -DataRoot $DataRoot -ShowUser $ShowUser `
      -TransactionId $transactionId -JournalPath $journalPath -Phase snapshot-pending
    Invoke-InstallFaultInjection 'after-boot-gate'
    # Snapshot every file that this installer may publish plus every managed task
    # definitions/states before the first stop, disable, write, or registration.
    $upgradeSnapshot = New-PixelBrightnessUpgradeSnapshot -SnapshotRoot $snapshotRoot `
      -DataRoot $DataRoot -ShowUser $ShowUser -TransactionId $transactionId `
      -IncludeTasks:(-not $SkipTasks) -IncludeAppliancePower:$Appliance
    $null = Write-PixelBrightnessUpgradeGate -DataRoot $DataRoot -ShowUser $ShowUser `
      -TransactionId $transactionId -JournalPath $journalPath -Phase snapshot-ready
    if (-not $SkipTasks) {
      $snapshotShow = @($upgradeSnapshot.Tasks | Where-Object { $_.Name -ceq 'PixelBrightness-Show' })
      if ($snapshotShow.Count -eq 1 -and $snapshotShow[0].Running -eq $true) {
        throw 'PixelBrightness-Show is running. Stop the live Show task before installing or upgrading; nothing was published.'
      }
    }
    if (-not $SkipTasks) { Disable-PixelBrightnessManagedTasksForUpgrade }
    # A launcher that won the barrier before the installer may have created a
    # child just before gate publication. Drain the exact installed launcher,
    # its descendants, orphaned fixed entrypoints and native renderer while no
    # new launcher can pass the barrier. Listener closure then proves that no
    # pre-listen child appeared between the old listener check and mutation.
    Stop-PixelBrightnessRacedLaunchProcessTrees -DataRoot $DataRoot
    Wait-NoPixelBrightnessServiceListeners
    $racedRenderers = @(Get-Process 'pixel-brightness-renderer' -ErrorAction SilentlyContinue)
    if ($racedRenderers.Count -gt 0) {
      throw "Show startup raced the upgrade and left $($racedRenderers.Count) renderer process(es); rollback will fail closed."
    }
    $null = Write-PixelBrightnessUpgradeGate -DataRoot $DataRoot -ShowUser $ShowUser `
      -TransactionId $transactionId -JournalPath $journalPath -Phase mutating
    Invoke-InstallFaultInjection 'after-task-disable'
  } finally {
    if ($null -ne $releaseLaunchBarrier) {
      Exit-PixelBrightnessReleaseLaunchBarrier $releaseLaunchBarrier
    }
  }
  $null = Initialize-AdminProtectedDirectory $InstallRoot $env:ProgramFiles $ShowUser 'Pixel Brightness install root'
  $releasesDirectory = Join-Path $InstallRoot 'releases'
  $null = Initialize-AdminProtectedDirectory $releasesDirectory $env:ProgramFiles $ShowUser 'Pixel Brightness releases parent'
  if (Test-Path -LiteralPath $releaseRoot) { throw "Release already exists: $releaseRoot" }
  $releasePublishSource = $stageRelease
  if (-not [string]::Equals(
    [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($stageRelease)),
    [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($releaseRoot)),
    [StringComparison]::OrdinalIgnoreCase
  )) {
    # MoveFileEx cannot atomically rename a directory across volumes. Copy the
    # already-manifested payload into an administrator-only sibling first,
    # flush and re-verify it there, then publish only that same-volume tree.
    $releasePublishStaging = Join-Path $releasesDirectory ".$version.$($transactionId.Replace('-', '')).incoming"
    $releasePublishSource = Copy-PixelBrightnessReleaseToProtectedStaging `
      -SourceRoot $stageRelease -DestinationRoot $releasePublishStaging -ShowUser $ShowUser
    Sync-PixelBrightnessReleaseTree $releasePublishSource
    $copiedReleaseManifest = Assert-PixelBrightnessReleaseManifest $releasePublishSource
    if ([string]$copiedReleaseManifest.ManifestSha256 -cne [string]$stagedReleaseManifest.ManifestSha256) {
      throw 'Destination-volume release staging changed the protected manifest.'
    }
  }
  Write-Host 'Publishing verified release and applying installed file permissions...'
  $releaseRoot = Publish-PixelBrightnessWriteThroughDirectory $releasePublishSource $releaseRoot
  Invoke-InstallFaultInjection 'after-release-write-through-move'
  $null = Protect-AdminReadOnlyReleaseTree $releaseRoot $ShowUser
  Write-Host 'Installed file permissions complete. Verifying published release...'
  $publishedReleaseManifest = Assert-PixelBrightnessReleaseManifest $releaseRoot
  if ([string]$publishedReleaseManifest.ManifestSha256 -cne [string]$stagedReleaseManifest.ManifestSha256) {
    throw 'Published release manifest does not match the flushed build candidate.'
  }
  Invoke-InstallFaultInjection 'after-release-manifest-verify'
  $rendererCommand = if ($installNode) { Assert-NativeBundle $releaseRoot } else { $null }
  Invoke-InstallFaultInjection 'after-release-publish'

  $null = Initialize-AdminProtectedDirectory $DataRoot $env:ProgramData $ShowUser 'Pixel Brightness data root'
  foreach ($profile in @(
    @{ Relative = 'config'; Access = 'Modify'; Label = 'Show-writable configuration directory' },
    @{ Relative = 'logs'; Access = 'Read'; Label = 'Pixel Brightness logs parent' },
    @{ Relative = 'logs\system'; Access = 'None'; Label = 'SYSTEM-only Server/Web logs' },
    @{ Relative = 'logs\show'; Access = 'Modify'; Label = 'interactive Show logs' },
    # Child files opt into Show read one by one. Keeping the directory itself
    # administrator-only also keeps atomic temporary credential files secret.
    @{ Relative = 'secrets'; Access = 'None'; Label = 'runtime secrets directory' },
    @{ Relative = 'state'; Access = 'Read'; Label = 'Pixel Brightness state parent' },
    @{ Relative = 'state\server'; Access = 'None'; Label = 'SYSTEM-only Server state' },
    @{ Relative = 'state\node'; Access = 'Modify'; Label = 'Show-writable Node state' },
    @{ Relative = 'state\schedule'; Access = 'Modify'; Label = 'Show scheduler interactive handoff state' }
  )) {
    $profilePath = Join-Path $DataRoot $profile.Relative
    $null = Initialize-AdminProtectedDirectory $profilePath $env:ProgramData $ShowUser $profile.Label
    $null = Protect-AdminControlPath -Path $profilePath -ShowUser $ShowUser -ShowAccess $profile.Access -Label $profile.Label
  }
  # Upgrades may contain pre-existing Server state/log descendants. Protecting
  # only the directory root would retain a hostile child ACL or reparse point
  # that the SYSTEM Server/Web tasks later follow.
  foreach ($systemTree in @(
    @{ Relative = 'logs\system'; Label = 'SYSTEM-only Server/Web logs tree' },
    @{ Relative = 'state\server'; Label = 'SYSTEM-only Server state tree' }
  )) {
    $null = Protect-AdminSystemTree -Path (Join-Path $DataRoot $systemTree.Relative) -ShowUser $ShowUser -Label $systemTree.Label
  }
  $systemLogDirectory = Join-Path $DataRoot 'logs\system'
  $showLogDirectory = Join-Path $DataRoot 'logs\show'
  $secretsDirectory = Join-Path $DataRoot 'secrets'

  $controlTokenFile = Join-Path $secretsDirectory 'control-token.txt'
  $nodeSigningKeyFile = Join-Path $secretsDirectory 'node-signing-key.txt'
  $installedNodeTokenFile = Join-Path $secretsDirectory 'node-token.txt'
  $legacyClusterTokenFile = Join-Path $secretsDirectory 'cluster-token.txt'
  foreach ($credentialPath in @($controlTokenFile, $nodeSigningKeyFile, $installedNodeTokenFile, $legacyClusterTokenFile)) {
    Assert-RealFileDestination $credentialPath
  }
  # Presence of the retired bearer means the split was never durably
  # completed. Even canonical-looking files left by an interrupted or
  # pre-release migration must not silently preserve shared authority.
  $legacySharedCredentialPresent = Test-Path -LiteralPath $legacyClusterTokenFile -PathType Leaf

  if ($installServer) {
    if ($legacySharedCredentialPresent -or -not (Test-Path -LiteralPath $controlTokenFile -PathType Leaf)) {
      # Never promote the legacy shared token: every old Render Node may know it.
      Write-Utf8Text $controlTokenFile (New-RandomToken)
    }
    if ($legacySharedCredentialPresent -or -not (Test-Path -LiteralPath $nodeSigningKeyFile -PathType Leaf)) {
      Write-Utf8Text $nodeSigningKeyFile (New-RandomToken)
    }
    $installedControlToken = (Get-Content -LiteralPath $controlTokenFile -Raw).Trim()
    $installedNodeSigningKey = (Get-Content -LiteralPath $nodeSigningKeyFile -Raw).Trim()
    if ($installedControlToken -notmatch '^[A-Za-z0-9_-]{43,128}$') {
      throw 'The Server control token is empty or invalid. Refusing to start the operator API.'
    }
    if ($installedNodeSigningKey -notmatch '^[A-Za-z0-9_-]{43,128}$') {
      throw 'The Render Node signing key is empty or invalid. Refusing to authenticate workers.'
    }
    if ($installedControlToken -ceq $installedNodeSigningKey) {
      throw 'The control token and Render Node signing key must be different secrets.'
    }
    $null = Protect-AdminControlPath -Path $controlTokenFile -ShowUser $ShowUser -ShowAccess None -Label 'Pixel Brightness control token'
    $null = Protect-AdminControlPath -Path $nodeSigningKeyFile -ShowUser $ShowUser -ShowAccess None -Label 'Pixel Brightness Render Node signing key'
  } else {
    # A render-only host must never retain operator authority or the key that
    # can mint credentials for a different node after a role transition.
    foreach ($serverSecret in @($controlTokenFile, $nodeSigningKeyFile)) {
      if (Test-Path -LiteralPath $serverSecret) { Remove-Item -LiteralPath $serverSecret -Force }
    }
  }

  if ($installNode) {
    $installedNodeToken = if ($Role -eq 'All') {
      New-NodeCredential $NodeId $installedNodeSigningKey
    } elseif ($null -ne $importedNodeToken) {
      $importedNodeToken
    } else {
      (Get-Content -LiteralPath $installedNodeTokenFile -Raw).Trim()
    }
    $null = Assert-NodeCredentialIdentity $installedNodeToken $NodeId
    Write-Utf8Text $installedNodeTokenFile $installedNodeToken
    Protect-ReadOnlyForShow $installedNodeTokenFile $ShowUser
  } elseif (Test-Path -LiteralPath $installedNodeTokenFile) {
    Remove-Item -LiteralPath $installedNodeTokenFile -Force
  }

  # This shared bearer must not survive a successful split. The transaction
  # snapshot still restores it if any later publication or health step fails.
  if (Test-Path -LiteralPath $legacyClusterTokenFile) {
    Remove-Item -LiteralPath $legacyClusterTokenFile -Force
  }
  Invoke-InstallFaultInjection 'after-token-control-file'
  $rendererPipe = "\\.\pipe\pixel-brightness-renderer-$($NodeId -replace '[^A-Za-z0-9_.-]', '-')"
  $rendererConfig = Join-Path $DataRoot 'config\renderer.json'
  if ($installNode) {
    $projectExample = Join-Path $releaseRoot 'config\windows-arena-final-processor.example.json'
    if (-not (Test-Path -LiteralPath $projectExample)) {
      throw "Windows Arena project example is missing: $projectExample"
    }
    $projectDefaults = Get-Content -LiteralPath $projectExample -Raw | ConvertFrom-Json

    $cameraProfileValue = New-PixelBrightnessCameraProfile $CameraProfile
    $cameraBackend = switch ($CameraProfile) {
      'CanonR50RfS1018' { 'canon-edsdk' }
      'SonyA7IV' { 'sony-sdk' }
      default { 'disabled' }
    }
    $nodeConfig = [ordered]@{
    nodeId = $NodeId
    name = $NodeName
    platform = 'win32'
    serverUrl = $ServerUrl
    dataDir = (Join-Path $DataRoot 'state\node')
    displayBackend = 'dxgi'
    rendererBackend = 'dxgi'
    rendererCommand = $rendererCommand
    rendererConfigPath = $rendererConfig
    rendererPipe = $rendererPipe
    rendererIpcTimeoutMs = 30000
    cameraBackend = $cameraBackend
    cameraExpectedModel = [string]$cameraProfileValue.camera.model
    cameraExpectedSerial = $null
    cameraExpectedLensModel = [string]$cameraProfileValue.lens.model
    cameraExpectedLensSerial = $null
    cameraHelperCommand = $null
    cameraRuntimeManifestPath = $null
    cameraHelperTimeoutMs = 30000
    cameraCaptureDir = (Join-Path $DataRoot 'state\node\camera-captures')
    canvas = $projectDefaults.canvas
    compositionSource = $projectDefaults.compositionSource
    outputs = @($projectDefaults.outputs)
    renderer = [ordered]@{
      backend = 'dxgi'
      command = $rendererCommand
      configPath = $rendererConfig
      pipe = $rendererPipe
      ipcTimeoutMs = 30000
    }
    }
    Write-Utf8Json (Join-Path $DataRoot 'config\node.json') $nodeConfig 30
    Invoke-InstallFaultInjection 'after-node-control-file'

    # Camera runtime is independent of the immutable display-binding
    # generation. A fresh node starts with one honest, protected, unconfigured
    # profile. Upgrades preserve any previously provisioned camera authority
    # byte-for-byte; only the dedicated transaction may replace it.
    $cameraAuthorityPath = Get-PixelBrightnessCameraAuthorityPath $DataRoot
    if (-not (Test-Path -LiteralPath $cameraAuthorityPath)) {
      $cameraAuthority = New-PixelBrightnessUnconfiguredCameraAuthority -DataRoot $DataRoot -Profile $CameraProfile
      $null = Write-PixelBrightnessCameraAuthority -DataRoot $DataRoot -ShowUser $ShowUser `
        -Authority $cameraAuthority -InstallRoot $InstallRoot
      Invoke-InstallFaultInjection 'after-camera-authority-control-file'
    } else {
      $null = Read-PixelBrightnessCameraRuntimeAuthority -DataRoot $DataRoot -InstallRoot $InstallRoot
    }
  }

  $runtimeConfig = [ordered]@{
    schemaVersion = 1
    node = $nodeCommand
    npm = $npmCommand
  }
  $runtimeFile = Join-Path $DataRoot 'secrets\runtime.json'
  Write-Utf8Json $runtimeFile $runtimeConfig 4
  Protect-ReadOnlyForShow $runtimeFile $ShowUser
  Invoke-InstallFaultInjection 'after-runtime-control-file'
  $installationFile = Join-Path $DataRoot 'secrets\installation.json'
  Write-Utf8Json $installationFile ([ordered]@{
    schemaVersion = 1
    role = $Role
    serverUrl = $ServerUrl
    nodeId = $(if ($installNode) { $NodeId } else { $null })
    installedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }) 4
  Protect-ReadOnlyForShow $installationFile $ShowUser
  Invoke-InstallFaultInjection 'after-installation-control-file'

  $rendererExample = Join-Path $releaseRoot 'native\windows\config\renderer.example.json'
  if ($installNode -and -not (Test-Path -LiteralPath $rendererConfig)) {
    if (-not (Test-Path -LiteralPath $rendererExample)) {
      throw "Native renderer example is missing: $rendererExample"
    }
    $nativeDefaults = Get-Content -LiteralPath $rendererExample -Raw | ConvertFrom-Json
    $nativeDefaults.nodeId = $NodeId
    $nativeDefaults.pipeName = $rendererPipe
    $nativeDefaults.telemetry.path = (Join-Path $DataRoot 'config\renderer-status.json')
    Write-Utf8Json $rendererConfig $nativeDefaults 30
    Invoke-InstallFaultInjection 'after-renderer-control-file'
  }

  $bindingGate = Join-Path $DataRoot 'config\display-binding.json'
  if ($installNode) {
    Write-Utf8Json $bindingGate ([ordered]@{
      schemaVersion = 1
      valid = $false
      reason = 'Run Bind-PixelBrightnessDisplays.ps1 after installation or upgrade.'
      releaseRoot = $releaseRoot
      invalidatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    }) 6
    Protect-ReadOnlyForShow $bindingGate $ShowUser
    Invoke-InstallFaultInjection 'after-binding-control-file'
  }
  $releasePointer = Join-Path $DataRoot 'current-release.txt'
  $installedLauncher = Join-Path $DataRoot 'Start-PixelBrightness.ps1'
  $installedShowSchedule = Join-Path $DataRoot 'ShowSchedule.ps1'
  $installedBinder = Join-Path $DataRoot 'Bind-PixelBrightnessDisplays.ps1'
  $installedAcceptance = Join-Path $DataRoot 'Test-PixelBrightness.ps1'
  $installedCameraRuntime = Join-Path $DataRoot 'CameraRuntime.ps1'
  $installedCameraProvisioner = Join-Path $DataRoot 'Provision-PixelBrightnessCanonCamera.ps1'
  $installedRuntimeSecurity = Join-Path $DataRoot 'RuntimeSecurity.ps1'
  $installedUpgradeTransaction = Join-Path $DataRoot 'UpgradeTransaction.ps1'
  $installedRecovery = Join-Path $DataRoot 'Recover-PixelBrightnessUpgrade.ps1'
  foreach ($copy in @(
    @{ Source = 'RuntimeSecurity.ps1'; Destination = $installedRuntimeSecurity },
    @{ Source = 'UpgradeTransaction.ps1'; Destination = $installedUpgradeTransaction },
    @{ Source = 'Recover-PixelBrightnessUpgrade.ps1'; Destination = $installedRecovery },
    @{ Source = 'CameraRuntime.ps1'; Destination = $installedCameraRuntime },
    @{ Source = 'Provision-PixelBrightnessCanonCamera.ps1'; Destination = $installedCameraProvisioner },
    @{ Source = 'Start-PixelBrightness.ps1'; Destination = $installedLauncher },
    @{ Source = 'ShowSchedule.ps1'; Destination = $installedShowSchedule },
    @{ Source = 'ArenaSaveEvidence.ps1'; Destination = (Join-Path $DataRoot 'ArenaSaveEvidence.ps1') },
    @{ Source = 'Bind-PixelBrightnessDisplays.ps1'; Destination = $installedBinder },
    @{ Source = 'Test-PixelBrightness.ps1'; Destination = $installedAcceptance }
  )) {
    Assert-RealFileDestination $copy.Destination
    $copySource = Join-Path $PSScriptRoot $copy.Source
    $copySourceItem = Assert-PixelBrightnessPlainFile $copySource "Installed control source $($copy.Source)"
    if ($null -eq $copySourceItem) { throw "Installed control source is missing: $copySource" }
    Write-PixelBrightnessAtomicBytes $copy.Destination ([IO.File]::ReadAllBytes($copySourceItem.FullName))
    Invoke-InstallFaultInjection ("after-stable-control-file-{0}" -f $copy.Source)
  }
  foreach ($controlFile in @(
    $installedRuntimeSecurity, $installedUpgradeTransaction, $installedRecovery,
    $installedCameraRuntime, $installedCameraProvisioner,
    $installedLauncher, $installedShowSchedule, $installedBinder, $installedAcceptance
  )) {
    Protect-ReadOnlyForShow $controlFile $ShowUser
  }

  $trustedWebFile = Join-Path $DataRoot 'secrets\trusted-web.json'
  $trustedWebConfig = [ordered]@{
    enabled = $TrustedWebClient.Count -gt 0 -and $TrustedWebHost.Count -gt 0
    clients = @($TrustedWebClient)
    hosts = @($TrustedWebHost)
  }
  Write-Utf8Json $trustedWebFile $trustedWebConfig 4
  Protect-ReadOnlyForShow $trustedWebFile $ShowUser
  Invoke-InstallFaultInjection 'after-trusted-web-control-file'

  # The pointer is the generation commit record. Services are stopped while
  # configs/launchers are replaced atomically, and the pointer is itself
  # atomically replaced only after every other control file is complete.
  Write-Utf8Text $releasePointer $releaseRoot
  Protect-ReadOnlyForShow $releasePointer $ShowUser
  Invoke-InstallFaultInjection 'after-release-pointer'
  Invoke-InstallFaultInjection 'after-control-publication'

  # Fail before registering or starting SYSTEM tasks unless every stable
  # launcher/control file and both immutable parent chains are still trusted.
  $null = Assert-PixelBrightnessControlPlane -DataRoot $DataRoot -IncludeSystemDirectories
  $null = Assert-AdminProtectedReleaseLocation $releaseRoot
  $null = Assert-PixelBrightnessReleaseManifest $releaseRoot

  if (-not $SkipTasks) {
    $launcher = Join-Path $DataRoot 'Start-PixelBrightness.ps1'
    $scheduler = Join-Path $DataRoot 'ShowSchedule.ps1'
    $powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    # Task Scheduler's schema bounds RestartCount to an unsigned byte and
    # RestartInterval to at least PT1M. Values outside those bounds can make
    # Register-ScheduledTask reject an otherwise valid first installation.
    $settings = New-ScheduledTaskSettingsSet -RestartCount 255 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew

    if ($installServer) {
      foreach ($taskRole in @('Server', 'Web')) {
        $action = New-ScheduledTaskAction -Execute $powerShell -Argument "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -Role $taskRole -DataRoot `"$DataRoot`""
        $trigger = New-ScheduledTaskTrigger -AtStartup
        $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        $taskName = "PixelBrightness-$taskRole"
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
        Disable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
      }
    } else {
      foreach ($taskName in @('PixelBrightness-Server', 'PixelBrightness-Web')) {
        Unregister-PixelBrightnessTask $taskName
      }
    }

    if ($installNode) {
      $showAction = New-ScheduledTaskAction -Execute $powerShell -Argument "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -Role Show -DataRoot `"$DataRoot`""
      $showPrincipal = New-ScheduledTaskPrincipal -UserId $ShowUser -LogonType Interactive -RunLevel Limited
      $showTaskParameters = @{
        TaskName = 'PixelBrightness-Show'; Action = $showAction; Settings = $settings
        Principal = $showPrincipal; Force = $true
      }
      if (-not $installSchedule) {
        # Standalone render Nodes retain automatic start at local Show-user logon.
        # Role All omits the trigger so the weekly worker is the sole automatic owner.
        $showTaskParameters.Trigger = New-ScheduledTaskTrigger -AtLogOn -User $ShowUser
      }
      Register-ScheduledTask @showTaskParameters | Out-Null
      Disable-ScheduledTask -TaskName 'PixelBrightness-Show' | Out-Null
    } else {
      Unregister-PixelBrightnessTask 'PixelBrightness-Show'
    }

    if ($installSchedule) {
      $scheduleAction = New-ScheduledTaskAction -Execute $powerShell -Argument "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$scheduler`" -Mode Worker -DataRoot `"$DataRoot`" -ShowUser `"$ShowUser`""
      $scheduleTrigger = New-ScheduledTaskTrigger -AtStartup
      $schedulePrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
      Register-ScheduledTask -TaskName 'PixelBrightness-Schedule' -Action $scheduleAction -Trigger $scheduleTrigger -Settings $settings -Principal $schedulePrincipal -Force | Out-Null
      Disable-ScheduledTask -TaskName 'PixelBrightness-Schedule' -ErrorAction Stop | Out-Null

      $interactiveAction = New-ScheduledTaskAction -Execute $powerShell -Argument "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$scheduler`" -Mode Interactive -DataRoot `"$DataRoot`""
      $interactiveSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable -MultipleInstances IgnoreNew
      $interactivePrincipal = New-ScheduledTaskPrincipal -UserId $ShowUser -LogonType Interactive -RunLevel Limited
      Register-ScheduledTask -TaskName 'PixelBrightness-Schedule-Interactive' -Action $interactiveAction -Settings $interactiveSettings -Principal $interactivePrincipal -Force | Out-Null
      Disable-ScheduledTask -TaskName 'PixelBrightness-Schedule-Interactive' -ErrorAction Stop | Out-Null
    } else {
      Unregister-PixelBrightnessTask 'PixelBrightness-Schedule-Interactive'
      Unregister-PixelBrightnessTask 'PixelBrightness-Schedule'
    }
    Invoke-InstallFaultInjection 'after-task-change'
    Assert-PixelBrightnessFinalTasksBehindGate -InstallServer $installServer -InstallNode $installNode `
      -InstallSchedule $installSchedule -Launcher $launcher -Scheduler $scheduler
  }

  foreach ($rule in @(
    @{ Name = 'Pixel Brightness Web Control'; Port = 3000 },
    @{ Name = 'Pixel Brightness Control API'; Port = 4100 }
  )) {
    $oldRules = @(Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue)
    foreach ($oldRule in $oldRules) { Remove-NetFirewallRule -InputObject $oldRule -ErrorAction Stop }
    if ($installServer) {
      New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $rule.Port -Profile Private -ErrorAction Stop | Out-Null
    }
  }
  Invoke-InstallFaultInjection 'after-firewall-change'

  if ($Appliance) {
    $powerCfg = Join-Path $env:SystemRoot 'System32\powercfg.exe'
    if (-not (Test-Path -LiteralPath $powerCfg -PathType Leaf)) { throw "Trusted powercfg.exe is missing: $powerCfg" }
    foreach ($setting in @('standby-timeout-ac', 'monitor-timeout-ac', 'hibernate-timeout-ac', 'disk-timeout-ac')) {
      & $powerCfg /change $setting 0 | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "powercfg failed while setting $setting to never on AC power" }
    }
  }
  Invoke-InstallFaultInjection 'after-power-change'

  $healthBypass = $null
  $healthServerTask = ''
  $healthWebTask = ''
  $candidateStartedAfter = [DateTimeOffset]::UtcNow
  if (-not $SkipTasks -and $installServer) {
    $healthBypass = New-PixelBrightnessUpgradeHealthBypass -SnapshotRoot $snapshotRoot `
      -ShowUser $ShowUser -TransactionId $transactionId -InstallerProcessId $PID -Roles @('Server', 'Web')
  }
  $null = Write-PixelBrightnessUpgradeGate -DataRoot $DataRoot -ShowUser $ShowUser `
    -TransactionId $transactionId -JournalPath $journalPath -Phase health-running -HealthBypass $healthBypass

  if (-not $SkipTasks -and $installServer) {
    $healthSuffix = $transactionId.Replace('-', '').Substring(0, 12)
    $healthServerTask = "PixelBrightness-UpgradeHealth-Server-$healthSuffix"
    $healthWebTask = "PixelBrightness-UpgradeHealth-Web-$healthSuffix"
    Register-PixelBrightnessUpgradeHealthTask -Role Server -TaskName $healthServerTask `
      -Launcher $launcher -DataRoot $DataRoot -TransactionId $transactionId `
      -TokenPath ([string]$healthBypass['Server'].path) -PowerShell $powerShell -Settings $settings
    Register-PixelBrightnessUpgradeHealthTask -Role Web -TaskName $healthWebTask `
      -Launcher $launcher -DataRoot $DataRoot -TransactionId $transactionId `
      -TokenPath ([string]$healthBypass['Web'].path) -PowerShell $powerShell -Settings $settings
    $candidateStartedAfter = [DateTimeOffset]::UtcNow
    Start-ScheduledTask -TaskName $healthServerTask
    Start-ScheduledTask -TaskName $healthWebTask
  }
  Invoke-InstallFaultInjection 'after-service-start'

  Invoke-InstallFaultInjection 'before-post-install-health'
  $candidateHealthParameters = @{
    DataRoot = $DataRoot
    ReleaseRoot = $releaseRoot
    ServerUrl = $ServerUrl
    InstallServer = $installServer
    InstallNode = $installNode
    TasksSkipped = [bool]$SkipTasks
    ServicesStartedAfter = $candidateStartedAfter
  }
  if ($installServer -and -not $SkipTasks) {
    $candidateHealthParameters.ServerTaskName = $healthServerTask
    $candidateHealthParameters.WebTaskName = $healthWebTask
  }
  Write-Host 'Starting candidate Server/Web and checking live health...'
  $null = Assert-PostInstallHealth @candidateHealthParameters
  $null = Write-PixelBrightnessUpgradeGate -DataRoot $DataRoot -ShowUser $ShowUser `
    -TransactionId $transactionId -JournalPath $journalPath -Phase health-verified
  Invoke-InstallFaultInjection 'after-post-install-health'

  if (-not $SkipTasks -and $installServer) {
    Remove-PixelBrightnessUpgradeHealthTasks
    Wait-NoPixelBrightnessServiceListeners
  }
  Invoke-InstallFaultInjection 'after-health-service-stop'
  if (-not $SkipTasks) {
    Assert-PixelBrightnessFinalTasksBehindGate -InstallServer $installServer -InstallNode $installNode `
      -InstallSchedule $installSchedule -Launcher $launcher -Scheduler $scheduler
  }

  $null = Write-PixelBrightnessUpgradeCommit -SnapshotRoot $snapshotRoot -ShowUser $ShowUser `
    -TransactionId $transactionId -ReleaseRoot $releaseRoot
  Invoke-InstallFaultInjection 'after-commit-record'

  # The normal startup tasks contain no bypass. Their desired enabled state is
  # restored only after the durable post-health commit, while the gate still
  # makes every accidental/reboot launch fail before reading the release pointer.
  if (-not $SkipTasks -and $installServer) {
    Enable-ScheduledTask -TaskName 'PixelBrightness-Server' -ErrorAction Stop | Out-Null
    Enable-ScheduledTask -TaskName 'PixelBrightness-Web' -ErrorAction Stop | Out-Null
    foreach ($taskName in @('PixelBrightness-Server', 'PixelBrightness-Web')) {
      $committedTask = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
      if ([string]$committedTask.State -ceq 'Disabled') {
        throw "Committed final task did not retain its intended enabled state: $taskName"
      }
    }
  }
  if (-not $SkipTasks -and $installNode) {
    Disable-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop | Out-Null
    Write-Warning 'PixelBrightness-Show remains disabled until Bind-PixelBrightnessDisplays.ps1 validates and saves the physical projector targets.'
  }
  if (-not $SkipTasks -and $installSchedule) {
    Enable-ScheduledTask -TaskName 'PixelBrightness-Schedule' -ErrorAction Stop | Out-Null
    Enable-ScheduledTask -TaskName 'PixelBrightness-Schedule-Interactive' -ErrorAction Stop | Out-Null
    foreach ($taskName in @('PixelBrightness-Schedule', 'PixelBrightness-Schedule-Interactive')) {
      if ([string](Get-ScheduledTask -TaskName $taskName -ErrorAction Stop).State -ceq 'Disabled') {
        throw "Committed weekly scheduler task did not retain its intended enabled state: $taskName"
      }
    }
  }
  Invoke-InstallFaultInjection 'after-final-task-enable'
  # Keep the boot gate if payload bytes disappeared or changed after candidate
  # health/commit but before normal startup authority would be restored.
  $null = Assert-AdminProtectedReleaseLocation $releaseRoot
  $null = Assert-PixelBrightnessReleaseManifest $releaseRoot
  Remove-PixelBrightnessUpgradeGate $DataRoot $transactionId
  Invoke-InstallFaultInjection 'after-gate-clear'

  if (-not $SkipTasks -and $installServer) {
    $finalStartedAfter = [DateTimeOffset]::UtcNow
    Start-ScheduledTask -TaskName 'PixelBrightness-Server'
    Start-ScheduledTask -TaskName 'PixelBrightness-Web'
    $null = Assert-PostInstallHealth -DataRoot $DataRoot -ReleaseRoot $releaseRoot `
      -ServerUrl $ServerUrl -InstallServer $installServer -InstallNode $installNode `
      -TasksSkipped $false -ServicesStartedAfter $finalStartedAfter
  }
  if (-not $SkipTasks -and $installSchedule) {
    Start-ScheduledTask -TaskName 'PixelBrightness-Schedule' -ErrorAction Stop
    $scheduleDeadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
    do {
      $scheduleTask = Get-ScheduledTask -TaskName 'PixelBrightness-Schedule' -ErrorAction Stop
      if ([string]$scheduleTask.State -ceq 'Running') { break }
      Start-Sleep -Milliseconds 250
    } while ([DateTimeOffset]::UtcNow -lt $scheduleDeadline)
    if ([string]$scheduleTask.State -cne 'Running') {
      throw 'PixelBrightness-Schedule did not remain running after installation.'
    }
  }
  $transactionCommitted = $true

  Write-Host "Installed Pixel Brightness $version" -ForegroundColor Green
  Write-Host "Release: $releaseRoot"
  Write-Host "Data:    $DataRoot"
  if ($installNode) {
    Write-Host "Node control plane: $ServerUrl"
    Write-Host 'Next: run Bind-PixelBrightnessDisplays.ps1 to bind stable projector targets, then publish PB-COMPOSITION from Arena on this render PC.'
  } else {
    Write-Host 'Central Server/Web installation is ready. Generate one nodeId-bound credential per render PC; never copy either Server secret to a node.'
  }
} catch {
  $installError = $_.Exception
  if ($transactionDirty -and -not $transactionCommitted -and $null -ne $upgradeSnapshot) {
    $rollbackError = $null
    try {
      if (-not (Test-Path -LiteralPath (Get-PixelBrightnessUpgradeGatePath $DataRoot))) {
        $null = Write-PixelBrightnessUpgradeGate -DataRoot $DataRoot -ShowUser $ShowUser `
          -TransactionId $transactionId -JournalPath $journalPath -Phase rollback
      } else {
        $null = Write-PixelBrightnessUpgradeGate -DataRoot $DataRoot -ShowUser $ShowUser `
          -TransactionId $transactionId -JournalPath $journalPath -Phase rollback
      }
      Set-PixelBrightnessUpgradeFailClosed
      Remove-PixelBrightnessUpgradeHealthTasks
      Restore-PixelBrightnessUpgradeSnapshot -Snapshot $upgradeSnapshot -DataRoot $DataRoot `
        -IncludeTasks:(-not $SkipTasks) -DeferTaskActivation
      $null = Assert-PixelBrightnessUpgradeSnapshotRestored -Snapshot $upgradeSnapshot -DataRoot $DataRoot `
        -IncludeTasks:(-not $SkipTasks) -TaskDefinitionsOnly
      $priorPointer = @($upgradeSnapshot.Files | Where-Object { $_.Relative -ceq 'current-release.txt' -and $_.Existed -eq $true })
      if ($priorPointer.Count -eq 1) {
        $null = Assert-PixelBrightnessControlPlane -DataRoot $DataRoot -IncludeSystemDirectories
        $restoredRelease = (Get-Content -LiteralPath (Join-Path $DataRoot 'current-release.txt') -Raw).Trim()
        $null = Assert-AdminProtectedReleaseLocation $restoredRelease
      }
      if (@(Get-Process 'pixel-brightness-renderer' -ErrorAction SilentlyContinue).Count -ne 0) {
        throw 'Rollback left a native renderer process that did not exist at the snapshot boundary'
      }
      if (-not $SkipTasks) {
        Set-PixelBrightnessUpgradeTaskEnablement -Snapshot $upgradeSnapshot
        $null = Assert-PixelBrightnessUpgradeSnapshotRestored -Snapshot $upgradeSnapshot -DataRoot $DataRoot `
          -IncludeTasks -TaskEnablementOnly
      }
      Remove-PixelBrightnessUpgradeGate $DataRoot $transactionId
      if (-not $SkipTasks) { Start-PixelBrightnessUpgradePreviouslyRunningTasks -Snapshot $upgradeSnapshot }
      $null = Assert-PixelBrightnessUpgradeSnapshotRestored -Snapshot $upgradeSnapshot -DataRoot $DataRoot -IncludeTasks:(-not $SkipTasks)
      if (-not $SkipTasks) {
        $priorServer = @($upgradeSnapshot.Tasks | Where-Object { $_.Name -ceq 'PixelBrightness-Server' -and $_.Running -eq $true })
        $priorWeb = @($upgradeSnapshot.Tasks | Where-Object { $_.Name -ceq 'PixelBrightness-Web' -and $_.Running -eq $true })
        if ($priorServer.Count -eq 1) { $null = Wait-PixelBrightnessJsonHealth 'http://127.0.0.1:4100/v1/health' }
        if ($priorWeb.Count -eq 1) { $null = Wait-PixelBrightnessWebHealth }
      }
    } catch {
      $rollbackError = $_.Exception
    }
    if ($null -ne $rollbackError) {
      $preserveRecoverySnapshot = $true
      $failClosedError = $null
      try {
        if (-not (Test-Path -LiteralPath (Get-PixelBrightnessUpgradeGatePath $DataRoot))) {
          $null = Write-PixelBrightnessUpgradeGate -DataRoot $DataRoot -ShowUser $ShowUser `
            -TransactionId $transactionId -JournalPath $journalPath -Phase rollback
        }
        Set-PixelBrightnessUpgradeFailClosed
      }
      catch { $failClosedError = $_.Exception }
      $details = "Install failed: $($installError.Message). Exact rollback could not be proven: $($rollbackError.Message). Protected recovery evidence was preserved at $snapshotRoot."
      if ($null -ne $failClosedError) {
        $details += " Automatic task shutdown also failed: $($failClosedError.Message). Disconnect projector output and service this host locally before reuse."
      } else {
        $details += ' All Pixel Brightness scheduled tasks were stopped and disabled; the host is fail-closed until local recovery.'
      }
      throw [InvalidOperationException]::new($details, $installError)
    }
    throw [InvalidOperationException]::new("Install failed, and the exact prior control files, firewall/power state, task definitions, and enabled/running state were restored and verified. New immutable release was retained for diagnosis. Cause: $($installError.Message)", $installError)
  }
  if ($transactionDirty -and -not $transactionCommitted -and $null -eq $upgradeSnapshot) {
    $preserveRecoverySnapshot = $true
    try { Set-PixelBrightnessUpgradeFailClosed }
    catch {
      throw [InvalidOperationException]::new("Install failed before the protected recovery snapshot completed, and fail-closed enforcement also failed: $($_.Exception.Message). Disconnect the host and service locally. Original cause: $($installError.Message)", $installError)
    }
    throw [InvalidOperationException]::new("Install failed before the protected recovery snapshot completed. The durable gate remains and all managed tasks/listeners are fail-closed; local inspection is required because exact rollback cannot be proven. Cause: $($installError.Message)", $installError)
  }
  throw
} finally {
  foreach ($cleanupPath in @($releasePublishStaging, $(if (-not $preserveRecoverySnapshot) { $stageRoot }))) {
    if ([string]::IsNullOrWhiteSpace($cleanupPath)) { continue }
    try {
      if (Test-Path -LiteralPath $cleanupPath -PathType Container) {
        Remove-Item -LiteralPath $cleanupPath -Recurse -Force -ErrorAction Stop
      }
    } catch {
      # A cleanup error must not hide the original build/install error or
      # prevent the installer mutex from being released.
      Write-Warning "Temporary installer directory retained at ${cleanupPath}: $($_.Exception.Message)"
    }
  }
  if ($installMutexHeld) { $installMutex.ReleaseMutex() }
  $installMutex.Dispose()
}
