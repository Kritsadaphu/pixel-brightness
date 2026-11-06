[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [string]$DataRoot = (Join-Path $env:ProgramData 'Pixel Brightness'),
  [string]$JournalPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-RecoveryAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run Recover-PixelBrightnessUpgrade.ps1 locally as Administrator.'
  }
}

function Wait-RecoveredPixelBrightnessListener([int]$Port, [string]$CommandPattern, [int]$TimeoutSeconds = 60) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 1) {
      try {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listeners[0].OwningProcess)" -ErrorAction Stop
        if ([string]$process.CommandLine -match $CommandPattern) { return }
      } catch {}
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Recovered task did not restore its exact owned listener on port $Port."
}

function Assert-RecoveredPixelBrightnessServices([object]$Snapshot, [string]$Root) {
  $priorServer = @($Snapshot.Tasks | Where-Object { $_.Name -ceq 'PixelBrightness-Server' -and $_.Running -eq $true })
  $priorWeb = @($Snapshot.Tasks | Where-Object { $_.Name -ceq 'PixelBrightness-Web' -and $_.Running -eq $true })
  if ($priorServer.Count -eq 1) {
    Wait-RecoveredPixelBrightnessListener 4100 'runtime[\\/]server[\\/]index\.mjs'
    $controlPath = Join-Path $Root 'secrets\control-token.txt'
    if (-not (Test-Path -LiteralPath $controlPath -PathType Leaf)) {
      # An explicit rollback may restore the exact legacy generation. This is
      # only a recovery health probe; the next guarded upgrade rotates it.
      $controlPath = Join-Path $Root 'secrets\cluster-token.txt'
    }
    $token = (Get-Content -LiteralPath $controlPath -Raw).Trim()
    if ($token -notmatch '^[A-Za-z0-9_-]{43,128}$') { throw 'Restored control credential is invalid.' }
    $state = Invoke-RestMethod -Uri 'http://127.0.0.1:4100/v1/state?includeProject=0' `
      -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 10 -ErrorAction Stop
    if ([int]$state.protocolVersion -ne 1 -or $state.server.ok -ne $true -or
        [string]$state.server.service -cne 'pixel-brightness-server') {
      throw 'Restored Server authenticated health contract failed.'
    }
  }
  if ($priorWeb.Count -eq 1) {
    Wait-RecoveredPixelBrightnessListener 3000 'vinext[\\/].*cli\.js.*start'
    $web = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/' -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
    if ($web.StatusCode -ne 200 -or [string]$web.Content -notmatch 'PIXEL') { throw 'Restored Web health contract failed.' }
  }
}

$runtimeSecurityPath = Join-Path $PSScriptRoot 'RuntimeSecurity.ps1'
$transactionPolicyPath = Join-Path $PSScriptRoot 'UpgradeTransaction.ps1'
foreach ($policy in @($runtimeSecurityPath, $transactionPolicyPath)) {
  if (-not (Test-Path -LiteralPath $policy -PathType Leaf)) { throw "Required recovery policy is missing: $policy" }
}
. $runtimeSecurityPath
. $transactionPolicyPath

Assert-RecoveryAdministrator
$null = Get-PathWithinAdminRoot $DataRoot $env:ProgramData 'Pixel Brightness recovery data root'
$recoveryMutex = [Threading.Mutex]::new($false, 'Global\PixelBrightnessInstaller')
$mutexHeld = $false
try {
  try { $mutexHeld = $recoveryMutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $mutexHeld = $true }
  if (-not $mutexHeld) { throw 'Installer or another recovery process is already active.' }

  # Fail closed before trusting or parsing any gate/journal bytes. A corrupt
  # journal therefore cannot leave a managed task, renderer, or listener live.
  Set-PixelBrightnessUpgradeFailClosed

  $gate = $null
  $gateError = $null
  try { $gate = Read-PixelBrightnessUpgradeGate $DataRoot }
  catch { $gateError = $_.Exception }

  $resolvedJournal = ''
  if (-not [string]::IsNullOrWhiteSpace($JournalPath)) {
    $resolvedJournal = Assert-PixelBrightnessUpgradeJournalLocation $JournalPath
  } elseif ($null -ne $gate) {
    $resolvedJournal = [string]$gate.journalPath
  } else {
    $stagingParent = Join-Path $env:ProgramData 'Pixel Brightness Build'
    $candidates = @()
    if (Test-Path -LiteralPath $stagingParent -PathType Container) {
      $null = Assert-AdminProtectedDirectoryChain $stagingParent $env:ProgramData 'Pixel Brightness build staging parent'
      $candidates = @(Get-ChildItem -LiteralPath $stagingParent -Directory -Force -ErrorAction Stop |
        ForEach-Object { Join-Path $_.FullName 'transaction-snapshot\snapshot.json' } |
        Where-Object {
          (Test-Path -LiteralPath $_ -PathType Leaf) -and
            -not (Test-PixelBrightnessUpgradeCommitRecord $_) -and
            -not (Test-PixelBrightnessUpgradeRecoveryRecord $_)
        })
    }
    if ($candidates.Count -ne 1) {
      $detail = if ($null -ne $gateError) { " Gate error: $($gateError.Message)" } else { '' }
      throw "Recovery requires one exact protected journal; found $($candidates.Count). Supply -JournalPath only after local inspection.$detail"
    }
    $resolvedJournal = Assert-PixelBrightnessUpgradeJournalLocation $candidates[0]
  }

  $expectedId = if ($null -ne $gate) { [string]$gate.transactionId } else { '' }
  $snapshot = Read-PixelBrightnessUpgradeSnapshot -JournalPath $resolvedJournal `
    -ExpectedTransactionId $expectedId -DataRoot $DataRoot
  $transactionId = [string]$snapshot.TransactionId
  $showUser = [string]$snapshot.ShowUser
  $snapshotRoot = Split-Path $resolvedJournal -Parent
  $null = Write-PixelBrightnessUpgradeGate -DataRoot $DataRoot -ShowUser $showUser `
    -TransactionId $transactionId -JournalPath $resolvedJournal -Phase rollback

  if (-not $PSCmdlet.ShouldProcess($DataRoot, "Restore and verify protected Pixel Brightness transaction $transactionId")) {
    throw 'Recovery was not authorized. The upgrade gate and fail-closed task state were retained.'
  }

  Remove-PixelBrightnessUpgradeHealthTasks
  Restore-PixelBrightnessUpgradeSnapshot -Snapshot $snapshot -DataRoot $DataRoot `
    -IncludeTasks:($snapshot.Tasks.Count -gt 0) -DeferTaskActivation
  $null = Assert-PixelBrightnessUpgradeSnapshotRestored -Snapshot $snapshot -DataRoot $DataRoot `
    -IncludeTasks:($snapshot.Tasks.Count -gt 0) -TaskDefinitionsOnly

  $priorPointer = @($snapshot.Files | Where-Object { $_.Relative -ceq 'current-release.txt' -and $_.Existed -eq $true })
  if ($priorPointer.Count -eq 1) {
    $null = Assert-PixelBrightnessControlPlane -DataRoot $DataRoot -IncludeSystemDirectories
    $restoredRelease = (Get-Content -LiteralPath (Join-Path $DataRoot 'current-release.txt') -Raw).Trim()
    $null = Assert-AdminProtectedReleaseLocation $restoredRelease
  }

  if ($snapshot.Tasks.Count -gt 0) {
    Set-PixelBrightnessUpgradeTaskEnablement -Snapshot $snapshot
    $null = Assert-PixelBrightnessUpgradeSnapshotRestored -Snapshot $snapshot -DataRoot $DataRoot `
      -IncludeTasks -TaskEnablementOnly
  }

  # Static bytes, ACLs, task XML, firewall, power and intended task enablement
  # are now exact, with no task running. Only this proof authorizes deleting
  # the gate; previously-running instances are started immediately afterward.
  Remove-PixelBrightnessUpgradeGate $DataRoot $transactionId
  try {
    if ($snapshot.Tasks.Count -gt 0) { Start-PixelBrightnessUpgradePreviouslyRunningTasks -Snapshot $snapshot }
    $null = Assert-PixelBrightnessUpgradeSnapshotRestored -Snapshot $snapshot -DataRoot $DataRoot `
      -IncludeTasks:($snapshot.Tasks.Count -gt 0)
    if ($snapshot.Tasks.Count -gt 0) { Assert-RecoveredPixelBrightnessServices -Snapshot $snapshot -Root $DataRoot }
  } catch {
    $activationError = $_.Exception
    $null = Write-PixelBrightnessUpgradeGate -DataRoot $DataRoot -ShowUser $showUser `
      -TransactionId $transactionId -JournalPath $resolvedJournal -Phase rollback
    try { Set-PixelBrightnessUpgradeFailClosed } catch {}
    throw [InvalidOperationException]::new("Prior snapshot bytes were restored, but intended task-state restoration failed. The boot gate was reinstated and the host remains fail-closed: $($activationError.Message)", $activationError)
  }

  $completePath = Join-Path $snapshotRoot 'recovery-complete.json'
  $complete = [ordered]@{
    schemaVersion = 1
    transactionId = $transactionId
    journalSha256 = Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes($resolvedJournal))
    restoredAndVerified = $true
    completedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
  $completeBytes = [Text.UTF8Encoding]::new($false).GetBytes(($complete | ConvertTo-Json -Depth 4) + "`n")
  Write-PixelBrightnessAtomicBytes $completePath $completeBytes
  $null = Protect-AdminControlPath -Path $completePath -ShowUser $showUser -ShowAccess None -Label 'Pixel Brightness recovery completion record'
  $null = Assert-AdminProtectedControlTree $snapshotRoot 'Pixel Brightness recovered upgrade journal tree'
  Write-Host "Recovered Pixel Brightness transaction $transactionId and verified the exact prior snapshot." -ForegroundColor Green
} catch {
  $failure = $_.Exception
  try { Set-PixelBrightnessUpgradeFailClosed }
  catch { throw [InvalidOperationException]::new("Recovery failed: $($failure.Message). Fail-closed enforcement also failed: $($_.Exception.Message). Disconnect projector/network output and service locally.", $failure) }
  throw [InvalidOperationException]::new("Recovery did not prove the prior snapshot. The gate remains, every managed task is disabled, and owned listeners/processes are closed. Cause: $($failure.Message)", $failure)
} finally {
  if ($mutexHeld) { $recoveryMutex.ReleaseMutex() }
  $recoveryMutex.Dispose()
}
