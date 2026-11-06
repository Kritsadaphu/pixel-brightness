[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)][string]$RuntimeSource,
  [Parameter(Mandatory = $true)][string]$ExpectedRuntimeManifestSha256,
  [Parameter(Mandatory = $true)][string]$ExpectedCameraSerial,
  [string]$ExpectedLensSerial = '',
  [string]$InstallRoot = (Join-Path $env:ProgramFiles 'Pixel Brightness'),
  [string]$DataRoot = (Join-Path $env:ProgramData 'Pixel Brightness'),
  [string]$ShowUser = $env:USERNAME,
  [switch]$StartShow
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'RuntimeSecurity.ps1')
. (Join-Path $PSScriptRoot 'UpgradeTransaction.ps1')
. (Join-Path $PSScriptRoot 'CameraRuntime.ps1')

# PixelBrightnessCanonCameraProvisionTransactionContract:v1

function Assert-CameraProvisionAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run Provision-PixelBrightnessCanonCamera.ps1 from Windows Terminal as Administrator.'
  }
}

function Write-CameraProvisionJson([string]$Path, [object]$Value, [string]$User, [string]$Label) {
  $bytes = ConvertTo-PixelBrightnessUtf8JsonBytes -Value $Value -Depth 30
  Write-PixelBrightnessAtomicBytes $Path $bytes
  $null = Protect-AdminControlPath -Path $Path -ShowUser $User -ShowAccess None -Label $Label
  return $Path
}

function Read-CameraProvisionJournal([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  $null = Assert-AdminProtectedItem $item 'Canon camera provision journal'
  return (Read-PixelBrightnessCameraJson $Path 'Canon camera provision journal')
}

function Set-CameraProvisionJournalPhase([string]$Path, [string]$Phase, [string]$User) {
  $journal = Read-CameraProvisionJournal $Path
  $journal.phase = $Phase
  $journal.updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  $null = Write-CameraProvisionJson $Path $journal $User 'Canon camera provision journal'
  return $journal
}

function Write-CameraProvisionGate(
  [string]$Root,
  [string]$TransactionId,
  [string]$JournalPath,
  [string]$Phase,
  [string]$User
) {
  $gatePath = Get-PixelBrightnessCameraTransactionGatePath $Root
  $gate = [ordered]@{
    schemaVersion = 1
    transactionId = $TransactionId
    journalPath = $JournalPath
    phase = $Phase
    createdAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
  $null = Write-CameraProvisionJson $gatePath $gate $User 'Canon camera provision gate'
  return $gatePath
}

function Remove-CameraProvisionGate([string]$Root, [string]$ExpectedTransactionId) {
  $gatePath = Get-PixelBrightnessCameraTransactionGatePath $Root
  $gate = Read-PixelBrightnessCameraJson $gatePath 'Canon camera provision gate'
  if ([string]$gate.transactionId -cne $ExpectedTransactionId) {
    throw 'Canon camera provision gate belongs to another transaction.'
  }
  Remove-Item -LiteralPath $gatePath -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $gatePath) { throw 'Canon camera provision gate could not be cleared.' }
}

function Get-ShowTaskSnapshot {
  $task = Get-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    return [ordered]@{ existed = $false; enabled = $false; running = $false }
  }
  return [ordered]@{
    existed = $true
    enabled = [string]$task.State -cne 'Disabled'
    running = [string]$task.State -in @('Running', 'Queued')
  }
}

function Stop-ShowForCameraProvision([string]$Root) {
  $task = Get-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction SilentlyContinue
  if ($null -ne $task) {
    Disable-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop | Out-Null
    if ([string]$task.State -in @('Running', 'Queued')) {
      Stop-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop
    }
  }
  Stop-PixelBrightnessRacedShowLaunchProcessTrees -DataRoot $Root
}

function Restore-ShowAfterCameraProvision([object]$Snapshot, [switch]$ForceStart) {
  if ($Snapshot.existed -ne $true) { return }
  if ($Snapshot.enabled -eq $true -or $ForceStart) {
    Enable-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop | Out-Null
  } else {
    Disable-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop | Out-Null
  }
  if ($Snapshot.running -eq $true -or $ForceStart) {
    Start-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop
  }
}

function Restore-CameraAuthorityFromJournal([object]$Journal, [string]$Root, [string]$User) {
  $activePath = Get-PixelBrightnessCameraAuthorityPath $Root
  if ($Journal.priorAuthorityExisted -eq $true) {
    $bytes = [Convert]::FromBase64String([string]$Journal.priorAuthorityBase64)
    if ((Get-PixelBrightnessSha256 $bytes) -cne [string]$Journal.priorAuthoritySha256) {
      throw 'Prior camera authority backup failed its journal digest.'
    }
    Write-PixelBrightnessAtomicBytes $activePath $bytes
    $null = Protect-AdminControlPath -Path $activePath -ShowUser $User -ShowAccess Read -Label 'Restored camera runtime authority'
  } elseif (Test-Path -LiteralPath $activePath) {
    Remove-Item -LiteralPath $activePath -Force -ErrorAction Stop
  }
  if ($Journal.priorAuthorityExisted -eq $true) {
    $restored = [IO.File]::ReadAllBytes($activePath)
    if ((Get-PixelBrightnessSha256 $restored) -cne [string]$Journal.priorAuthoritySha256) {
      throw 'Prior camera authority was not restored byte-for-byte.'
    }
  } elseif (Test-Path -LiteralPath $activePath) {
    throw 'Rollback left a camera authority that did not exist before provisioning.'
  }
}

function Recover-InterruptedCameraProvision([string]$Root, [string]$User) {
  $gatePath = Get-PixelBrightnessCameraTransactionGatePath $Root
  if (-not (Test-Path -LiteralPath $gatePath)) { return }
  $gateItem = Get-Item -LiteralPath $gatePath -Force -ErrorAction Stop
  $null = Assert-AdminProtectedItem $gateItem 'Interrupted camera provision gate'
  $gate = Read-PixelBrightnessCameraJson $gatePath 'Interrupted camera provision gate'
  $transactionId = Assert-PixelBrightnessCameraTransactionId ([string]$gate.transactionId)
  $expectedTransactionRoot = [IO.Path]::GetFullPath((Get-PixelBrightnessCameraTransactionRoot $Root $transactionId)).TrimEnd('\')
  $journalPath = [IO.Path]::GetFullPath([string]$gate.journalPath)
  if (-not $journalPath.StartsWith(($expectedTransactionRoot + '\'), [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($journalPath) -cne 'journal.json') {
    throw 'Interrupted camera provision journal escaped its exact transaction root.'
  }
  $null = Assert-AdminProtectedControlTree $expectedTransactionRoot 'Interrupted camera provision transaction'
  $journal = Read-CameraProvisionJournal $journalPath
  if ([string]$journal.transactionId -cne $transactionId) { throw 'Interrupted camera provision journal identity mismatch.' }
  Stop-ShowForCameraProvision $Root
  Restore-CameraAuthorityFromJournal $journal $Root $User
  $null = Set-CameraProvisionJournalPhase $journalPath 'rolled-back-after-interruption' $User
  Remove-CameraProvisionGate $Root $transactionId
  Restore-ShowAfterCameraProvision $journal.showTask
}

function Copy-CameraRuntimeCandidate([string]$Source, [string]$Destination, [string]$User) {
  if (Test-Path -LiteralPath $Destination) { throw "Camera runtime staging already exists: $Destination" }
  New-Item -ItemType Directory -Path $Destination -ErrorAction Stop | Out-Null
  $null = Protect-AdminControlPath -Path $Destination -ShowUser $User -ShowAccess None -Label 'Canon camera incoming runtime'
  $sourceRoot = [IO.Path]::GetFullPath($Source).TrimEnd('\')
  $sourcePrefix = $sourceRoot + '\'
  $destinationRoot = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
  $destinationPrefix = $destinationRoot + '\'
  foreach ($item in @(Get-NonReparseTree $sourceRoot 'Canon camera source runtime' | Where-Object { -not $_.PSIsContainer })) {
    if (-not $item.FullName.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Camera runtime source escaped its root: $($item.FullName)"
    }
    $relative = $item.FullName.Substring($sourcePrefix.Length)
    $target = [IO.Path]::GetFullPath((Join-Path $destinationRoot $relative))
    if (-not $target.StartsWith($destinationPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Camera runtime destination escaped its root: $target"
    }
    $targetDirectory = Split-Path $target -Parent
    if (-not (Test-Path -LiteralPath $targetDirectory)) {
      New-Item -ItemType Directory -Path $targetDirectory -Force -ErrorAction Stop | Out-Null
    }
    Copy-Item -LiteralPath $item.FullName -Destination $target -ErrorAction Stop
    $stream = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
    try { $stream.Flush($true) } finally { $stream.Dispose() }
  }
  return $destinationRoot
}

Assert-CameraProvisionAdministrator
if ([string]::IsNullOrWhiteSpace($ShowUser)) { throw 'ShowUser cannot be empty.' }
$cameraSerial = Assert-PixelBrightnessCameraCanonicalText $ExpectedCameraSerial 'Expected EOS R50 serial number' 128
$lensSerial = if ([string]::IsNullOrWhiteSpace($ExpectedLensSerial)) {
  $null
} else {
  Assert-PixelBrightnessCameraCanonicalText $ExpectedLensSerial 'Expected RF-S10-18 serial number' 128
}
if ($ExpectedRuntimeManifestSha256 -notmatch '^[a-fA-F0-9]{64}$') {
  throw 'ExpectedRuntimeManifestSha256 must be a pinned 64-character SHA-256 supplied independently of the runtime tree.'
}
$null = Get-PathWithinAdminRoot $InstallRoot $env:ProgramFiles 'Pixel Brightness install root'
$null = Get-PathWithinAdminRoot $DataRoot $env:ProgramData 'Pixel Brightness data root'
$sourceRuntime = Assert-PixelBrightnessCameraRuntimeManifest -RuntimeRoot $RuntimeSource `
  -ExpectedManifestSha256 $ExpectedRuntimeManifestSha256

$installMutex = [Threading.Mutex]::new($false, 'Global\PixelBrightnessInstaller')
$installMutexHeld = $false
$releaseBarrier = $null
$incomingRoot = $null
$transactionId = [guid]::NewGuid().ToString('D')
$transactionCommitted = $false
$gatePublished = $false
$journalPath = $null
$journal = $null
try {
  try { $installMutexHeld = $installMutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $installMutexHeld = $true }
  if (-not $installMutexHeld) { throw 'Another Pixel Brightness installer or camera provisioner is already running.' }
  $releaseBarrier = Enter-PixelBrightnessReleaseLaunchBarrier
  $null = Assert-PixelBrightnessDisplayBindingInstallerReady $DataRoot
  if (Test-Path -LiteralPath (Get-PixelBrightnessUpgradeGatePath $DataRoot)) {
    throw 'An upgrade gate is active; recover the upgrade before provisioning Canon camera runtime.'
  }
  Recover-InterruptedCameraProvision $DataRoot $ShowUser
  $null = Assert-PixelBrightnessControlPlane -DataRoot $DataRoot -IncludeSystemDirectories

  $authorityRoot = Get-PixelBrightnessCameraAuthorityRoot $DataRoot
  $null = Initialize-AdminProtectedDirectory $authorityRoot $env:ProgramData $ShowUser 'Pixel Brightness camera authority root'
  $transactionsRoot = Join-Path $authorityRoot 'transactions'
  $null = Initialize-AdminProtectedDirectory $transactionsRoot $env:ProgramData $ShowUser 'Pixel Brightness camera transactions root'
  $transactionRoot = Get-PixelBrightnessCameraTransactionRoot $DataRoot $transactionId
  $null = Initialize-AdminProtectedDirectory $transactionRoot $env:ProgramData $ShowUser 'Pixel Brightness camera transaction'
  $null = Protect-AdminControlPath -Path $transactionRoot -ShowUser $ShowUser -ShowAccess None -Label 'Pixel Brightness camera transaction'
  $activePath = Get-PixelBrightnessCameraAuthorityPath $DataRoot
  $priorAuthorityExisted = Test-Path -LiteralPath $activePath -PathType Leaf
  $priorBytes = if ($priorAuthorityExisted) { [IO.File]::ReadAllBytes($activePath) } else { [byte[]]::new(0) }
  if ($priorAuthorityExisted) { $null = Read-PixelBrightnessCameraRuntimeAuthority -DataRoot $DataRoot -InstallRoot $InstallRoot }
  $showTask = Get-ShowTaskSnapshot
  $journalPath = Join-Path $transactionRoot 'journal.json'
  $journal = [ordered]@{
    schemaVersion = 1
    transactionId = $transactionId
    phase = 'prepared'
    runtimeSourceManifestSha256 = [string]$sourceRuntime.ManifestSha256
    targetRuntimeId = [string]$sourceRuntime.RuntimeId
    priorAuthorityExisted = [bool]$priorAuthorityExisted
    priorAuthorityBase64 = $(if ($priorAuthorityExisted) { [Convert]::ToBase64String($priorBytes) } else { $null })
    priorAuthoritySha256 = $(if ($priorAuthorityExisted) { Get-PixelBrightnessSha256 $priorBytes } else { $null })
    showTask = $showTask
    createdAt = [DateTimeOffset]::UtcNow.ToString('o')
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
  $null = Write-CameraProvisionJson $journalPath $journal $ShowUser 'Canon camera provision journal'

  $targetDescription = "Canon EOS R50 $cameraSerial camera runtime $($sourceRuntime.RuntimeId)"
  if (-not $PSCmdlet.ShouldProcess($targetDescription, 'Provision protected Canon EDSDK runtime')) { return }
  $null = Write-CameraProvisionGate $DataRoot $transactionId $journalPath 'mutating' $ShowUser
  $gatePublished = $true
  $null = Set-CameraProvisionJournalPhase $journalPath 'gate-published' $ShowUser
  Stop-ShowForCameraProvision $DataRoot
  $null = Set-CameraProvisionJournalPhase $journalPath 'show-drained' $ShowUser

  $null = Initialize-AdminProtectedDirectory $InstallRoot $env:ProgramFiles $ShowUser 'Pixel Brightness install root'
  $cameraRuntimesRoot = Join-Path $InstallRoot 'camera-runtimes'
  $null = Initialize-AdminProtectedDirectory $cameraRuntimesRoot $env:ProgramFiles $ShowUser 'Pixel Brightness camera runtimes root'
  $generationsRoot = Get-PixelBrightnessCameraGenerationsRoot $InstallRoot
  $null = Initialize-AdminProtectedDirectory $generationsRoot $env:ProgramFiles $ShowUser 'Pixel Brightness Canon runtime generations'
  $destinationRoot = Join-Path $generationsRoot ([string]$sourceRuntime.RuntimeId)
  if (Test-Path -LiteralPath $destinationRoot) {
    $existingRuntime = Assert-PixelBrightnessCameraRuntimeManifest -RuntimeRoot $destinationRoot `
      -ExpectedManifestSha256 ([string]$sourceRuntime.ManifestSha256) -RequireProtected
  } else {
    $incomingRoot = Join-Path $generationsRoot (".{0}.{1}.incoming" -f $sourceRuntime.RuntimeId, $transactionId.Replace('-', ''))
    $null = Copy-CameraRuntimeCandidate $sourceRuntime.RuntimeRoot $incomingRoot $ShowUser
    $null = Assert-PixelBrightnessCameraRuntimeManifest -RuntimeRoot $incomingRoot `
      -ExpectedManifestSha256 ([string]$sourceRuntime.ManifestSha256)
    $null = Protect-AdminControlTree -Path $incomingRoot -ShowUser $ShowUser -ShowAccess Read -Label 'Pixel Brightness Canon camera runtime'
    $null = Assert-PixelBrightnessCameraRuntimeManifest -RuntimeRoot $incomingRoot `
      -ExpectedManifestSha256 ([string]$sourceRuntime.ManifestSha256) -RequireProtected
    $destinationRoot = Publish-PixelBrightnessWriteThroughDirectory $incomingRoot $destinationRoot
    $incomingRoot = $null
    $existingRuntime = Assert-PixelBrightnessCameraRuntimeManifest -RuntimeRoot $destinationRoot `
      -ExpectedManifestSha256 ([string]$sourceRuntime.ManifestSha256) -RequireProtected
  }
  $null = Set-CameraProvisionJournalPhase $journalPath 'generation-published' $ShowUser

  $profile = New-PixelBrightnessCameraProfile 'CanonR50RfS1018'
  $profile.camera.serialNumber = $cameraSerial
  $profile.lens.serialNumber = $lensSerial
  $authority = [ordered]@{
    schemaVersion = 1
    state = 'configured'
    backend = 'canon-edsdk'
    profile = $profile
    generationRoot = [string]$existingRuntime.RuntimeRoot
    manifestPath = [string]$existingRuntime.ManifestPath
    manifestSha256 = [string]$existingRuntime.ManifestSha256
    helperPath = [string]$existingRuntime.HelperPath
    helperSha256 = [string]$existingRuntime.HelperSha256
    sdkEntryDllPath = [string]$existingRuntime.SdkEntryDllPath
    sdkEntryDllSha256 = [string]$existingRuntime.SdkEntryDllSha256
    cameraCaptureDir = (Join-Path $DataRoot 'state\node\camera-captures')
    helperTimeoutMs = 30000
    configuredAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
  $null = Write-PixelBrightnessCameraAuthority -DataRoot $DataRoot -ShowUser $ShowUser `
    -Authority $authority -InstallRoot $InstallRoot
  $null = Set-CameraProvisionJournalPhase $journalPath 'authority-published' $ShowUser
  $null = Read-PixelBrightnessCameraRuntimeAuthority -DataRoot $DataRoot -InstallRoot $InstallRoot -RequireConfigured
  $null = Set-CameraProvisionJournalPhase $journalPath 'committed' $ShowUser
  Remove-CameraProvisionGate $DataRoot $transactionId
  $gatePublished = $false
  Restore-ShowAfterCameraProvision $showTask -ForceStart:$StartShow
  $transactionCommitted = $true
  Write-Host 'Canon camera runtime configured and statically verified.' -ForegroundColor Green
  Write-Host "Camera: EOS R50 / serial $cameraSerial"
  Write-Host 'Lens:   RF-S10-18mm F4.5-6.3 IS STM / calibration focal length 10 mm'
  Write-Host 'Next: run Test-PixelBrightness.ps1 -Full for live USB/RAW physical acceptance.'
} catch {
  $provisionError = $_.Exception
  if ($gatePublished -and $null -ne $journalPath -and (Test-Path -LiteralPath $journalPath -PathType Leaf)) {
    try {
      Stop-ShowForCameraProvision $DataRoot
      $rollbackJournal = Read-CameraProvisionJournal $journalPath
      Restore-CameraAuthorityFromJournal $rollbackJournal $DataRoot $ShowUser
      $null = Set-CameraProvisionJournalPhase $journalPath 'rolled-back' $ShowUser
      Remove-CameraProvisionGate $DataRoot $transactionId
      $gatePublished = $false
      Restore-ShowAfterCameraProvision $rollbackJournal.showTask
    } catch {
      throw [InvalidOperationException]::new(
        "Canon camera provisioning failed and exact rollback could not be proven. The camera transaction gate remains and Show stays fail-closed. Provision error: $($provisionError.Message). Rollback error: $($_.Exception.Message)",
        $provisionError
      )
    }
    throw [InvalidOperationException]::new(
      "Canon camera provisioning failed; the exact prior camera authority and Show task state were restored. Cause: $($provisionError.Message)",
      $provisionError
    )
  }
  throw
} finally {
  if ($null -ne $incomingRoot -and (Test-Path -LiteralPath $incomingRoot -PathType Container)) {
    Remove-Item -LiteralPath $incomingRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($null -ne $releaseBarrier) { Exit-PixelBrightnessReleaseLaunchBarrier $releaseBarrier }
  if ($installMutexHeld) { $installMutex.ReleaseMutex() }
  $installMutex.Dispose()
}
