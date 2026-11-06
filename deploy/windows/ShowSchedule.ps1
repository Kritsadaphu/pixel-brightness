[CmdletBinding()]
param(
  [ValidateSet('Worker', 'Interactive')]
  [string]$Mode = 'Worker',
  [string]$DataRoot = (Join-Path $env:ProgramData 'Pixel Brightness'),
  [string]$ShowUser = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# PixelBrightnessShowScheduleContract:v1
# BIOS/UEFI owns physical wake. This worker owns only the post-boot show
# sequence and the fail-closed Arena-save-before-shutdown sequence.

$runtimeSecurityPath = Join-Path $PSScriptRoot 'RuntimeSecurity.ps1'
$upgradeTransactionPath = Join-Path $PSScriptRoot 'UpgradeTransaction.ps1'
foreach ($policy in @($runtimeSecurityPath, $upgradeTransactionPath)) {
  if (-not (Test-Path -LiteralPath $policy -PathType Leaf)) {
    throw "Show scheduler policy is missing beside the worker: $policy"
  }
}
. $runtimeSecurityPath
. $upgradeTransactionPath
$saveEvidencePath = Join-Path $PSScriptRoot 'ArenaSaveEvidence.ps1'
if (-not (Test-Path -LiteralPath $saveEvidencePath -PathType Leaf)) { throw 'Arena save verification helper is missing.' }
. $saveEvidencePath

$script:ScheduleStateRoot = Join-Path $DataRoot 'state\schedule'
$script:ScheduleConfigPath = Join-Path $DataRoot 'state\server\show-schedule.json'
$script:ScheduleRuntimePath = Join-Path $DataRoot 'state\server\show-schedule-runtime.json'
$script:ScheduleRequestPath = Join-Path $script:ScheduleStateRoot 'interactive-request.json'
$script:ScheduleResponsePath = Join-Path $script:ScheduleStateRoot 'interactive-response.json'
$script:ServerOrigin = 'http://127.0.0.1:4100'
$script:WorkerBootId = $null
$script:DayNames = @('sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday')
$script:CanonicalDays = @('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')

function Get-ExactPropertyNames([object]$Value) {
  return @($Value.PSObject.Properties | ForEach-Object { [string]$_.Name })
}

function Assert-ExactProperties([object]$Value, [string[]]$Allowed, [string]$Label) {
  if ($null -eq $Value) { throw "$Label is missing." }
  $unknown = @(Get-ExactPropertyNames $Value | Where-Object { $_ -notin $Allowed })
  if ($unknown.Count -gt 0) { throw "$Label contains unsupported fields: $($unknown -join ', ')" }
}

function Read-BoundedJson([string]$Path, [int]$MaximumBytes, [string]$Label) {
  $item = Assert-PixelBrightnessPlainFile $Path $Label
  if ($null -eq $item) { throw "$Label is missing: $Path" }
  if ([int64]$item.Length -lt 2 -or [int64]$item.Length -gt $MaximumBytes) {
    throw "$Label has an invalid size."
  }
  try {
    $encoding = [Text.UTF8Encoding]::new($false, $true)
    $json = [IO.File]::ReadAllText($item.FullName, $encoding)
    return ($json | ConvertFrom-Json -ErrorAction Stop)
  }
  catch { throw "$Label is not valid JSON: $($_.Exception.Message)" }
}

function Write-ScheduleJson([string]$Path, [object]$Value) {
  $json = ($Value | ConvertTo-Json -Depth 12 -Compress) + "`n"
  Write-PixelBrightnessAtomicBytes -Path $Path -Bytes ([Text.UTF8Encoding]::new($false).GetBytes($json))
}

function Test-ControlCharacters([string]$Value) {
  if ($null -eq $Value) { return $false }
  return $Value -match '[\x00-\x1f\x7f]'
}

function Get-RuntimeMessage([string]$Value) {
  $clean = ([string]$Value) -replace '[\x00-\x1f\x7f]', ' '
  if ($clean.Length -gt 500) { return $clean.Substring(0, 500) }
  return $clean
}

function Convert-IsoTimestamp([string]$Value, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 64 -or
      $Value -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$') {
    throw "$Label is invalid."
  }
  try {
    return [DateTimeOffset]::Parse(
      $Value,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::None
    )
  } catch { throw "$Label is invalid." }
}

function Assert-RealLocalDate([string]$Value, [string]$Label) {
  try {
    $parsed = [DateTime]::ParseExact(
      $Value,
      'yyyy-MM-dd',
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::None
    )
  } catch { throw "$Label is invalid." }
  if ($parsed.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) -cne $Value) {
    throw "$Label is invalid."
  }
  return $Value
}

function Assert-WindowsFilePath([string]$Value, [string]$Extension, [string]$Label, [bool]$RequireFile = $true) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 2048 -or
      $Value.Trim() -cne $Value -or (Test-ControlCharacters $Value) -or
      $Value -match '["<>|?*]' -or $Value.StartsWith('\\?\') -or $Value.StartsWith('\\.\')) {
    throw "$Label is invalid."
  }
  if ($Value -notmatch '^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))') {
    throw "$Label must be an absolute Windows drive or UNC path."
  }
  $full = [IO.Path]::GetFullPath($Value)
  if ([IO.Path]::GetExtension($full) -ine $Extension) { throw "$Label must end with $Extension." }
  $root = [IO.Path]::GetPathRoot($full)
  $relative = $full.Substring($root.Length)
  foreach ($segment in @($relative -split '\\')) {
    if ([string]::IsNullOrWhiteSpace($segment) -or $segment -in @('.', '..') -or
        $segment.Contains(':') -or $segment -match '[ .]$') {
      throw "$Label contains an invalid Windows path segment."
    }
  }
  if (-not $RequireFile) { return $full }
  $item = Assert-PixelBrightnessPlainFile $full $Label
  if ($null -eq $item -or $item.Length -le 0) { throw "$Label is missing or empty: $full" }
  return $item.FullName
}

function Convert-TimeOfDay([string]$Value, [string]$Label) {
  try {
    return [DateTime]::ParseExact(
      $Value,
      'HH:mm',
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::None
    )
  } catch { throw "$Label must use zero-padded 24-hour HH:mm time." }
}

function Read-ShowSchedule {
  $schedule = Read-BoundedJson $script:ScheduleConfigPath 65536 'Weekly show schedule'
  Assert-ExactProperties $schedule @(
    'schemaVersion', 'revision', 'updatedAt', 'enabled', 'nodeId', 'arenaExecutablePath',
    'arenaCompositionPath', 'projectorStartupEnabled', 'projectorStandbyEnabled',
    'projectorStaggerMs', 'projectorWarmupSeconds', 'days'
  ) 'Weekly show schedule'
  if ([int]$schedule.schemaVersion -ne 1) { throw 'Weekly show schedule schemaVersion must be 1.' }
  if ($null -eq $schedule.PSObject.Properties['revision']) {
    Add-Member -InputObject $schedule -NotePropertyName revision -NotePropertyValue 1
  }
  if ([double]$schedule.revision -ne [int]$schedule.revision -or [int]$schedule.revision -lt 1) {
    throw 'Weekly show schedule revision is invalid.'
  }
  if (-not ($schedule.enabled -is [bool]) -or
      -not ($schedule.projectorStartupEnabled -is [bool]) -or
      -not ($schedule.projectorStandbyEnabled -is [bool])) {
    throw 'Weekly show schedule switches must be booleans.'
  }
  if ([string]$schedule.nodeId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') {
    if ($schedule.enabled -eq $true -or -not [string]::IsNullOrEmpty([string]$schedule.nodeId)) {
      throw 'Weekly show schedule nodeId is invalid.'
    }
  }
  if ([int]$schedule.projectorStaggerMs -lt 0 -or [int]$schedule.projectorStaggerMs -gt 2000 -or
      [double]$schedule.projectorStaggerMs -ne [int]$schedule.projectorStaggerMs) {
    throw 'Weekly show schedule projectorStaggerMs is invalid.'
  }
  if ([int]$schedule.projectorWarmupSeconds -lt 0 -or [int]$schedule.projectorWarmupSeconds -gt 600 -or
      [double]$schedule.projectorWarmupSeconds -ne [int]$schedule.projectorWarmupSeconds) {
    throw 'Weekly show schedule projectorWarmupSeconds is invalid.'
  }
  $null = Convert-IsoTimestamp ([string]$schedule.updatedAt) 'Weekly show schedule updatedAt'
  $days = @($schedule.days)
  if ($days.Count -ne 7) { throw 'Weekly show schedule must contain exactly seven days.' }
  for ($index = 0; $index -lt 7; $index += 1) {
    $day = $days[$index]
    Assert-ExactProperties $day @('day', 'enabled', 'startTime', 'shutdownTime') "Weekly show schedule day $index"
    if ([string]$day.day -cne $script:CanonicalDays[$index] -or -not ($day.enabled -is [bool])) {
      throw 'Weekly show schedule days must be ordered Monday through Sunday.'
    }
    $start = Convert-TimeOfDay ([string]$day.startTime) "Start time for $($day.day)"
    $shutdown = Convert-TimeOfDay ([string]$day.shutdownTime) "Shutdown time for $($day.day)"
    if ($start.TimeOfDay -ge $shutdown.TimeOfDay) {
      throw "Start time must precede shutdown on $($day.day)."
    }
  }
  if ($schedule.enabled -eq $true) {
    $schedule.arenaExecutablePath = Assert-WindowsFilePath ([string]$schedule.arenaExecutablePath) '.exe' 'Resolume Arena executable'
    $schedule.arenaCompositionPath = Assert-WindowsFilePath ([string]$schedule.arenaCompositionPath) '.avc' 'Resolume Arena composition'
    if (@($days | Where-Object { $_.enabled -eq $true }).Count -lt 1) {
      throw 'An enabled weekly show schedule requires at least one active day.'
    }
  }
  return $schedule
}

function Set-ObjectProperty([object]$Value, [string]$Name, [object]$PropertyValue) {
  if ($Value -is [Collections.IDictionary]) { $Value[$Name] = $PropertyValue; return }
  if ($null -eq $Value.PSObject.Properties[$Name]) {
    Add-Member -InputObject $Value -NotePropertyName $Name -NotePropertyValue $PropertyValue
  } else {
    $Value.$Name = $PropertyValue
  }
}

function New-DailyLedger([string]$ScheduleDate) {
  return [ordered]@{
    scheduleDate = $ScheduleDate
    startStatus = 'not-attempted'
    shutdownStatus = 'not-attempted'
  }
}

function Ensure-DailyLedger([object]$Runtime, [string]$ScheduleDate) {
  $ledger = $(if ($Runtime -is [Collections.IDictionary]) { $Runtime['dailyLedger'] } else { $Runtime.dailyLedger })
  if ($null -eq $ledger -or [string]$ledger.scheduleDate -cne $ScheduleDate) {
    Set-ObjectProperty $Runtime 'dailyLedger' (New-DailyLedger $ScheduleDate)
  }
}

function New-EmptyRuntime([object]$Schedule, [string]$State = 'idle', [string]$Phase = 'before-start') {
  $today = [DateTime]::Now.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
  return [ordered]@{
    schemaVersion = 1
    state = $State
    phase = $Phase
    localDate = $today
    lastAction = $null
    dailyLedger = (New-DailyLedger $today)
    activeRun = $null
    arenaProcessId = $null
    workerMessage = $null
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    scheduleUpdatedAt = $(if ($null -eq $Schedule) { $null } else { [string]$Schedule.updatedAt })
  }
}

function Read-ShowScheduleRuntime([object]$Schedule) {
  if (-not (Test-Path -LiteralPath $script:ScheduleRuntimePath -PathType Leaf)) {
    return (New-EmptyRuntime $Schedule)
  }
  $runtime = Read-BoundedJson $script:ScheduleRuntimePath 32768 'Show schedule runtime state'
  Assert-ExactProperties $runtime @(
    'schemaVersion', 'state', 'phase', 'localDate', 'lastAction', 'dailyLedger',
    'activeRun', 'arenaProcessId', 'workerMessage', 'updatedAt', 'scheduleUpdatedAt'
  ) 'Show schedule runtime state'
  if ([int]$runtime.schemaVersion -ne 1) { throw 'Show schedule runtime state has an invalid contract.' }
  $null = Assert-RealLocalDate ([string]$runtime.localDate) 'Show schedule runtime localDate'
  $null = Convert-IsoTimestamp ([string]$runtime.updatedAt) 'Show schedule runtime updatedAt'
  if ($null -ne $runtime.scheduleUpdatedAt) {
    $null = Convert-IsoTimestamp ([string]$runtime.scheduleUpdatedAt) 'Show schedule runtime scheduleUpdatedAt'
  }
  if ([string]$runtime.state -notin @('disabled', 'idle', 'waiting-for-login', 'starting', 'running', 'stopping', 'shutdown-blocked', 'error') -or
      [string]$runtime.phase -notin @('disabled', 'off-day', 'before-start', 'deferred', 'awaiting-login', 'starting-show', 'starting-arena', 'waiting-source', 'powering-projectors', 'warming-projectors', 'ready', 'saving-arena', 'closing-arena', 'projector-standby', 'stopping-show', 'requesting-windows-shutdown', 'failed')) {
    throw 'Show schedule runtime state or phase is invalid.'
  }
  if ($null -ne $runtime.arenaProcessId -and ([int]$runtime.arenaProcessId -lt 1 -or [double]$runtime.arenaProcessId -ne [int]$runtime.arenaProcessId)) {
    throw 'Show schedule runtime Arena process id is invalid.'
  }
  if ($null -ne $runtime.lastAction) {
    Assert-ExactProperties $runtime.lastAction @('type', 'scheduleDate', 'status', 'startedAt', 'completedAt', 'message') 'Show schedule runtime last action'
    $null = Assert-RealLocalDate ([string]$runtime.lastAction.scheduleDate) 'Show schedule runtime action date'
    if ([string]$runtime.lastAction.type -notin @('start', 'shutdown') -or
        [string]$runtime.lastAction.status -notin @('running', 'succeeded', 'failed')) {
      throw 'Show schedule runtime last action is invalid.'
    }
    $null = Convert-IsoTimestamp ([string]$runtime.lastAction.startedAt) 'Show schedule runtime action startedAt'
    if ($null -ne $runtime.lastAction.completedAt) {
      $null = Convert-IsoTimestamp ([string]$runtime.lastAction.completedAt) 'Show schedule runtime action completedAt'
    }
  }
  if ($null -eq $runtime.PSObject.Properties['dailyLedger']) {
    $ledger = New-DailyLedger ([string]$runtime.localDate)
    if ($null -ne $runtime.lastAction -and [string]$runtime.lastAction.scheduleDate -ceq [string]$runtime.localDate) {
      if ([string]$runtime.lastAction.type -ceq 'start') { $ledger.startStatus = [string]$runtime.lastAction.status }
      else { $ledger.shutdownStatus = [string]$runtime.lastAction.status }
    }
    Add-Member -InputObject $runtime -NotePropertyName dailyLedger -NotePropertyValue $ledger
  }
  Assert-ExactProperties $runtime.dailyLedger @('scheduleDate', 'startStatus', 'shutdownStatus') 'Show schedule runtime daily ledger'
  $null = Assert-RealLocalDate ([string]$runtime.dailyLedger.scheduleDate) 'Show schedule runtime ledger date'
  foreach ($status in @([string]$runtime.dailyLedger.startStatus, [string]$runtime.dailyLedger.shutdownStatus)) {
    if ($status -notin @('not-attempted', 'running', 'succeeded', 'failed')) {
      throw 'Show schedule runtime daily ledger status is invalid.'
    }
  }
  if ($null -eq $runtime.PSObject.Properties['activeRun']) { Add-Member -InputObject $runtime -NotePropertyName activeRun -NotePropertyValue $null }
  if ($null -eq $runtime.PSObject.Properties['workerMessage']) { Add-Member -InputObject $runtime -NotePropertyName workerMessage -NotePropertyValue $null }
  if ($null -ne $runtime.workerMessage -and (([string]$runtime.workerMessage).Length -gt 500 -or (Test-ControlCharacters ([string]$runtime.workerMessage)))) {
    throw 'Show schedule runtime workerMessage is invalid.'
  }
  if ($null -ne $runtime.activeRun) {
    $run = $runtime.activeRun
    Assert-ExactProperties $run @(
      'scheduleDate', 'scheduleRevision', 'scheduleUpdatedAt', 'shutdownTime', 'nodeId',
      'arenaExecutablePath', 'arenaCompositionPath', 'projectorStartupEnabled',
      'projectorStandbyEnabled', 'projectorStaggerMs', 'projectorWarmupSeconds',
      'projectorIds', 'projectorConfigurationRevision', 'startupStage', 'shutdownStage',
      'runBootId', 'shutdownRequestBootId',
      'arenaProcessId', 'arenaProcessStartTimeUtc'
    ) 'Show schedule active run'
    if ($null -eq $run.PSObject.Properties['runBootId']) {
      Add-Member -InputObject $run -NotePropertyName runBootId -NotePropertyValue $null
    }
    if ($null -eq $run.PSObject.Properties['projectorConfigurationRevision']) {
      Add-Member -InputObject $run -NotePropertyName projectorConfigurationRevision -NotePropertyValue 0
    }
    if ($null -eq $run.PSObject.Properties['shutdownRequestBootId']) {
      Add-Member -InputObject $run -NotePropertyName shutdownRequestBootId -NotePropertyValue $null
    }
    $null = Assert-RealLocalDate ([string]$run.scheduleDate) 'Show schedule active-run date'
    $null = Convert-IsoTimestamp ([string]$run.scheduleUpdatedAt) 'Show schedule active-run generation'
    $null = Convert-TimeOfDay ([string]$run.shutdownTime) 'Show schedule active-run shutdown time'
    if ([double]$run.scheduleRevision -ne [int]$run.scheduleRevision -or [int]$run.scheduleRevision -lt 1 -or
        [string]$run.nodeId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -or
        -not ($run.projectorStartupEnabled -is [bool]) -or -not ($run.projectorStandbyEnabled -is [bool]) -or
        [double]$run.projectorConfigurationRevision -ne [int]$run.projectorConfigurationRevision -or
        [double]$run.projectorStaggerMs -ne [int]$run.projectorStaggerMs -or [int]$run.projectorStaggerMs -lt 0 -or [int]$run.projectorStaggerMs -gt 2000 -or
        [double]$run.projectorWarmupSeconds -ne [int]$run.projectorWarmupSeconds -or [int]$run.projectorWarmupSeconds -lt 0 -or [int]$run.projectorWarmupSeconds -gt 600) {
      throw 'Show schedule active run contains invalid values.'
    }
    $run.arenaExecutablePath = Assert-WindowsFilePath ([string]$run.arenaExecutablePath) '.exe' 'Active-run Arena executable' $false
    $run.arenaCompositionPath = Assert-WindowsFilePath ([string]$run.arenaCompositionPath) '.avc' 'Active-run Arena composition' $false
    $projectorIds = @($run.projectorIds)
    if ($projectorIds.Count -notin @(0, 5) -or @($projectorIds | Select-Object -Unique).Count -ne $projectorIds.Count -or
        @($projectorIds | Where-Object { [string]$_ -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' }).Count -gt 0) {
      throw 'Show schedule active-run projector ids are invalid.'
    }
    if (($run.projectorStartupEnabled -eq $true -or $run.projectorStandbyEnabled -eq $true) -and $projectorIds.Count -ne 5) {
      throw 'Show schedule active-run projector controls require exactly five pinned ids.'
    }
    if (($run.projectorStartupEnabled -eq $true -or $run.projectorStandbyEnabled -eq $true) -and [int]$run.projectorConfigurationRevision -lt 1) {
      throw 'Show schedule active-run projector controls require a pinned configuration revision.'
    }
    if ($run.projectorStartupEnabled -ne $true -and $run.projectorStandbyEnabled -ne $true -and $projectorIds.Count -ne 0) {
      throw 'Show schedule active-run has projector ids while both projector controls are disabled.'
    }
    if ($run.projectorStartupEnabled -ne $true -and $run.projectorStandbyEnabled -ne $true -and [int]$run.projectorConfigurationRevision -ne 0) {
      throw 'Show schedule active-run has a projector configuration revision while both projector controls are disabled.'
    }
    if ([string]$run.startupStage -notin @('created', 'show-start-requested', 'show-running', 'arena-start-requested', 'arena-running', 'source-ready', 'projectors-power-requested', 'ready') -or
        [string]$run.shutdownStage -notin @('pending', 'arena-save-requested', 'arena-closed', 'projectors-standby-requested', 'projectors-standby-confirmed', 'show-stop-requested', 'show-stopped', 'shutdown-requested')) {
      throw 'Show schedule active-run checkpoint is invalid.'
    }
    if ($null -ne $run.arenaProcessId) {
      if ([double]$run.arenaProcessId -ne [int]$run.arenaProcessId -or [int]$run.arenaProcessId -lt 1 -or $null -eq $run.arenaProcessStartTimeUtc) {
        throw 'Show schedule active-run Arena identity is invalid.'
      }
      $null = Convert-IsoTimestamp ([string]$run.arenaProcessStartTimeUtc) 'Show schedule active-run Arena start time'
    } elseif ($null -ne $run.arenaProcessStartTimeUtc) {
      throw 'Show schedule active-run Arena start time has no process id.'
    }
    $runBootTime = $null
    if ($null -ne $run.runBootId) {
      $runBootTime = Convert-IsoTimestamp ([string]$run.runBootId) 'Show schedule active-run boot identity'
    }
    if ($null -ne $run.shutdownRequestBootId) {
      $shutdownBootTime = Convert-IsoTimestamp ([string]$run.shutdownRequestBootId) 'Show schedule active-run shutdown boot identity'
      if ([string]$run.shutdownStage -cne 'shutdown-requested') {
        throw 'Show schedule active-run shutdown boot identity has no shutdown-requested checkpoint.'
      }
      if ($null -ne $runBootTime -and $shutdownBootTime.UtcDateTime.Ticks -ne $runBootTime.UtcDateTime.Ticks) {
        throw 'Show schedule active-run shutdown boot identity differs from its originating run.'
      }
    }
    $startupStages = @('created', 'show-start-requested', 'show-running', 'arena-start-requested', 'arena-running', 'source-ready', 'projectors-power-requested', 'ready')
    $shutdownStages = @('pending', 'arena-save-requested', 'arena-closed', 'projectors-standby-requested', 'projectors-standby-confirmed', 'show-stop-requested', 'show-stopped', 'shutdown-requested')
    $startupIndex = [Array]::IndexOf($startupStages, [string]$run.startupStage)
    $shutdownIndex = [Array]::IndexOf($shutdownStages, [string]$run.shutdownStage)
    $arenaRunningIndex = [Array]::IndexOf($startupStages, 'arena-running')
    $arenaClosedIndex = [Array]::IndexOf($shutdownStages, 'arena-closed')
    if (($startupIndex -lt $arenaRunningIndex -and $null -ne $run.arenaProcessId) -or
        ($startupIndex -ge $arenaRunningIndex -and $shutdownIndex -lt $arenaClosedIndex -and $null -eq $run.arenaProcessId) -or
        ($shutdownIndex -ge $arenaClosedIndex -and $null -ne $run.arenaProcessId)) {
      throw 'Show schedule active-run Arena identity contradicts its durable checkpoints.'
    }
    if ($runtime.arenaProcessId -ne $run.arenaProcessId) { throw 'Show schedule runtime Arena process identity is inconsistent.' }
  } elseif ($null -ne $runtime.arenaProcessId) {
    throw 'Show schedule runtime has an Arena process without an active run.'
  }
  return $runtime
}

function Write-ShowScheduleRuntime([object]$Runtime, [object]$Schedule) {
  $Runtime.localDate = [DateTime]::Now.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
  $Runtime.updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  $Runtime.scheduleUpdatedAt = $(if ($null -eq $Schedule) { $null } else { [string]$Schedule.updatedAt })
  Write-ScheduleJson $script:ScheduleRuntimePath $Runtime
}

function Set-RuntimePhase([object]$Runtime, [object]$Schedule, [string]$State, [string]$Phase, [string]$Message = '') {
  $Runtime.state = $State
  $Runtime.phase = $Phase
  $Runtime.workerMessage = $(if ([string]::IsNullOrWhiteSpace($Message)) { $null } else { Get-RuntimeMessage $Message })
  Write-ShowScheduleRuntime $Runtime $Schedule
}

function Start-RuntimeAction([object]$Runtime, [object]$Schedule, [string]$Type, [string]$ScheduleDate) {
  Ensure-DailyLedger $Runtime $ScheduleDate
  if ($Type -ceq 'start') { $Runtime.dailyLedger.startStatus = 'running' }
  else { $Runtime.dailyLedger.shutdownStatus = 'running' }
  $Runtime.lastAction = [ordered]@{
    type = $Type
    scheduleDate = $ScheduleDate
    status = 'running'
    startedAt = [DateTimeOffset]::UtcNow.ToString('o')
    completedAt = $null
    message = $null
  }
  $Runtime.workerMessage = $null
  Write-ShowScheduleRuntime $Runtime $Schedule
}

function Complete-RuntimeAction([object]$Runtime, [object]$Schedule, [bool]$Succeeded, [string]$Message) {
  if ($null -eq $Runtime.lastAction) { throw 'Cannot complete a missing weekly scheduler action.' }
  $status = $(if ($Succeeded) { 'succeeded' } else { 'failed' })
  Ensure-DailyLedger $Runtime ([string]$Runtime.lastAction.scheduleDate)
  if ([string]$Runtime.lastAction.type -ceq 'start') { $Runtime.dailyLedger.startStatus = $status }
  else { $Runtime.dailyLedger.shutdownStatus = $status }
  $Runtime.lastAction.status = $status
  $Runtime.lastAction.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
  $Runtime.lastAction.message = Get-RuntimeMessage $Message
  $Runtime.workerMessage = Get-RuntimeMessage $Message
  Write-ShowScheduleRuntime $Runtime $Schedule
}

function New-ActiveRun(
  [object]$Schedule,
  [object]$Day,
  [string]$ScheduleDate,
  [string[]]$ProjectorIds,
  [int]$ProjectorConfigurationRevision
) {
  return [ordered]@{
    scheduleDate = $ScheduleDate
    scheduleRevision = [int]$Schedule.revision
    scheduleUpdatedAt = [string]$Schedule.updatedAt
    shutdownTime = [string]$Day.shutdownTime
    nodeId = [string]$Schedule.nodeId
    arenaExecutablePath = [string]$Schedule.arenaExecutablePath
    arenaCompositionPath = [string]$Schedule.arenaCompositionPath
    projectorStartupEnabled = [bool]$Schedule.projectorStartupEnabled
    projectorStandbyEnabled = [bool]$Schedule.projectorStandbyEnabled
    projectorStaggerMs = [int]$Schedule.projectorStaggerMs
    projectorWarmupSeconds = [int]$Schedule.projectorWarmupSeconds
    projectorIds = @($ProjectorIds)
    projectorConfigurationRevision = $ProjectorConfigurationRevision
    startupStage = 'created'
    shutdownStage = 'pending'
    runBootId = Get-WorkerBootId
    shutdownRequestBootId = $null
    arenaProcessId = $null
    arenaProcessStartTimeUtc = $null
  }
}

function Set-ActiveRunStartupStage([object]$Runtime, [object]$Schedule, [string]$Stage, [string]$State, [string]$Phase) {
  if ($null -eq $Runtime.activeRun) { throw 'The active show run is missing.' }
  $Runtime.activeRun.startupStage = $Stage
  Set-RuntimePhase $Runtime $Schedule $State $Phase
}

function Set-ActiveRunShutdownStage([object]$Runtime, [object]$Schedule, [string]$Stage, [string]$Phase) {
  if ($null -eq $Runtime.activeRun) { throw 'The active show run is missing.' }
  $Runtime.activeRun.shutdownStage = $Stage
  Set-RuntimePhase $Runtime $Schedule 'stopping' $Phase
}

function Get-ControlHeaders {
  $tokenPath = Join-Path $DataRoot 'secrets\control-token.txt'
  $tokenItem = Assert-PixelBrightnessPlainFile $tokenPath 'Pixel Server control token'
  if ($null -eq $tokenItem) { return @{} }
  $null = Assert-AdminOnlyPixelBrightnessSecret $tokenItem.FullName 'Pixel Server control token'
  $token = (Get-Content -LiteralPath $tokenItem.FullName -Raw -ErrorAction Stop).Trim()
  if ($token -notmatch '^[A-Za-z0-9_-]{43,128}$') { throw 'Pixel Server control token is invalid.' }
  return @{ Authorization = "Bearer $token" }
}

function Invoke-PixelApi([string]$Method, [string]$Path, [object]$Body = $null, [int]$TimeoutSeconds = 10) {
  $parameters = @{
    Uri = "$script:ServerOrigin$Path"
    Method = $Method
    Headers = (Get-ControlHeaders)
    TimeoutSec = $TimeoutSeconds
    ErrorAction = 'Stop'
  }
  if ($null -ne $Body) {
    $parameters.ContentType = 'application/json'
    $parameters.Body = ($Body | ConvertTo-Json -Depth 8 -Compress)
  }
  return (Invoke-RestMethod @parameters)
}

function Wait-PixelServer([int]$TimeoutSeconds = 180) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastFailure = 'no response'
  do {
    try {
      $health = Invoke-RestMethod -Uri "$script:ServerOrigin/v1/health" -Method Get -TimeoutSec 5 -ErrorAction Stop
      if ($health.ok -eq $true -and [string]$health.service -ceq 'pixel-brightness-server') { return }
      $lastFailure = 'unexpected health response'
    } catch { $lastFailure = $_.Exception.Message }
    Start-Sleep -Seconds 2
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Pixel Server was not ready within $TimeoutSeconds seconds: $lastFailure"
}

function Test-ShowUserConsoleSession {
  if ([string]::IsNullOrWhiteSpace($ShowUser)) { return $false }
  try {
    $expected = ([Security.Principal.NTAccount]::new($ShowUser)).Translate([Security.Principal.SecurityIdentifier]).Value
    $consoleUser = [string](Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).UserName
    if ([string]::IsNullOrWhiteSpace($consoleUser)) { return $false }
    $actual = ([Security.Principal.NTAccount]::new($consoleUser)).Translate([Security.Principal.SecurityIdentifier]).Value
    if ($actual -cne $expected) { return $false }
    return @((Get-Process explorer -ErrorAction SilentlyContinue) | Where-Object { $_.SessionId -gt 0 }).Count -gt 0
  } catch { return $false }
}

function Get-EnabledProjectorBinding {
  $snapshot = Invoke-PixelApi 'Get' '/v1/projectors'
  $ids = @($snapshot.projectors | Where-Object { $_.enabled -eq $true -and -not [string]::IsNullOrWhiteSpace([string]$_.host) } | ForEach-Object { [string]$_.id })
  if ($ids.Count -ne 5 -or @($ids | Select-Object -Unique).Count -ne 5) {
    throw 'Weekly show automation requires exactly five enabled, uniquely identified projector rows.'
  }
  if ([double]$snapshot.revision -ne [int]$snapshot.revision -or [int]$snapshot.revision -lt 1) {
    throw 'Projector Control did not report a valid configuration revision.'
  }
  return [ordered]@{ projectorIds = $ids; revision = [int]$snapshot.revision }
}

function Assert-ProjectorBatch([object]$Response, [string[]]$ProjectorIds, [string]$Label) {
  $results = @($Response.results)
  if ($results.Count -ne $ProjectorIds.Count -or @($results | Where-Object { $_.ok -ne $true }).Count -gt 0) {
    throw "$Label was not accepted by every selected projector."
  }
  foreach ($id in $ProjectorIds) {
    if (@($results | Where-Object { [string]$_.projectorId -ceq $id -and $_.ok -eq $true }).Count -ne 1) {
      throw "$Label omitted or duplicated projector $id."
    }
  }
}

function Wait-ShowTaskRunning([int]$TimeoutSeconds = 45) {
  $task = Get-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop
  if ([string]$task.State -ceq 'Disabled') { return $false }
  if ([string]$task.State -notin @('Running', 'Queued')) { Start-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop | Out-Null }
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $task = Get-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop
    if ([string]$task.State -ceq 'Running') { return $true }
    Start-Sleep -Milliseconds 500
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw 'PixelBrightness-Show did not reach Running state.'
}

function Stop-ShowTask([int]$TimeoutSeconds = 45) {
  $task = Get-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop
  if ([string]$task.State -in @('Running', 'Queued')) { Stop-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop }
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $task = Get-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop
    if ([string]$task.State -notin @('Running', 'Queued')) { return }
    Start-Sleep -Milliseconds 500
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw 'PixelBrightness-Show did not stop before Windows shutdown.'
}

function Invoke-InteractiveArena(
  [string]$Action,
  [object]$Schedule,
  [Nullable[int]]$ArenaProcessId,
  [string]$ArenaProcessStartTimeUtc,
  [int]$TimeoutSeconds
) {
  $requestId = [guid]::NewGuid().ToString('D')
  $request = [ordered]@{
    schemaVersion = 1
    requestId = $requestId
    action = $Action
    executablePath = [string]$Schedule.arenaExecutablePath
    compositionPath = [string]$Schedule.arenaCompositionPath
    arenaProcessId = $(if ($null -eq $ArenaProcessId) { $null } else { [int]$ArenaProcessId })
    arenaProcessStartTimeUtc = $(if ([string]::IsNullOrWhiteSpace($ArenaProcessStartTimeUtc)) { $null } else { $ArenaProcessStartTimeUtc })
    createdAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
  Remove-Item -LiteralPath $script:ScheduleResponsePath -Force -ErrorAction SilentlyContinue
  Write-ScheduleJson $script:ScheduleRequestPath $request
  Start-ScheduledTask -TaskName 'PixelBrightness-Schedule-Interactive' -ErrorAction Stop | Out-Null
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (Test-Path -LiteralPath $script:ScheduleResponsePath -PathType Leaf) {
      try {
        $response = Read-BoundedJson $script:ScheduleResponsePath 8192 'Arena interactive response'
        Assert-ExactProperties $response @('schemaVersion', 'requestId', 'ok', 'processId', 'processStartTimeUtc', 'message', 'completedAt') 'Arena interactive response'
        if ([string]$response.requestId -ceq $requestId) {
          if ([int]$response.schemaVersion -ne 1 -or -not ($response.ok -is [bool])) {
            throw 'Arena interactive response contract is invalid.'
          }
          $null = Convert-IsoTimestamp ([string]$response.completedAt) 'Arena interactive response timestamp'
          if ($null -ne $response.message -and (([string]$response.message).Length -gt 500 -or (Test-ControlCharacters ([string]$response.message)))) {
            throw 'Arena interactive response message is invalid.'
          }
          if ($Action -ceq 'start') {
            if (($null -eq $response.processId) -ne ($null -eq $response.processStartTimeUtc)) {
              throw 'Arena interactive startup response contains a partial process identity.'
            }
            if ($response.ok -eq $true -and ($null -eq $response.processId -or [int]$response.processId -lt 1)) {
              throw 'Arena interactive startup response omitted its exact process identity.'
            }
            if ($null -ne $response.processId) {
              if ([int]$response.processId -lt 1) { throw 'Arena interactive process id is invalid.' }
              $null = Convert-IsoTimestamp ([string]$response.processStartTimeUtc) 'Arena interactive process start time'
            }
            return $response
          } elseif ($null -ne $response.processId -or $null -ne $response.processStartTimeUtc) {
            throw 'Arena interactive close response retained a process identity.'
          }
          if ($response.ok -ne $true) { throw "Arena interactive action failed: $([string]$response.message)" }
          return $response
        }
      } catch {
        throw
      }
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Arena interactive action $Action did not complete within $TimeoutSeconds seconds. Confirm Windows auto-logon for the Show account."
}

function Wait-NodeAndSource([string]$NodeId, [int]$TimeoutSeconds = 150) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  $last = 'node not reported'
  do {
    try {
      $state = Invoke-PixelApi 'Get' '/v1/state?includeProject=0'
      $matches = @($state.nodes | Where-Object { [string]$_.nodeId -ceq $NodeId })
      if ($matches.Count -eq 1) {
        $node = $matches[0]
        $sourceState = [string]$node.telemetry.renderer.compositionSource.state
        if ($node.readiness.ready -eq $true -and $node.telemetry.renderer.ready -eq $true -and
            $node.telemetry.renderer.connected -eq $true -and $sourceState -ceq 'connected') {
          return
        }
        $last = "node=$([string]$node.status), source=$sourceState"
      }
    } catch { $last = $_.Exception.Message }
    Start-Sleep -Seconds 2
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Windows renderer and PB-COMPOSITION did not become ready: $last"
}

function Assert-ScheduleControlPlane {
  $barrier = Enter-PixelBrightnessReleaseLaunchBarrier
  try {
    $null = Assert-PixelBrightnessUpgradeLauncherGate -DataRoot $DataRoot -Role Schedule
    $null = Assert-PixelBrightnessControlPlane -DataRoot $DataRoot -IncludeSystemDirectories
  } finally {
    Exit-PixelBrightnessReleaseLaunchBarrier $barrier
  }
}

function Get-WindowsBootId {
  $operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem -Property LastBootUpTime -ErrorAction Stop
  if ($null -eq $operatingSystem -or $null -eq $operatingSystem.LastBootUpTime) {
    throw 'Windows did not report a stable boot identity; automatic shutdown is blocked.'
  }
  try {
    $bootTime = ([DateTime]$operatingSystem.LastBootUpTime).ToUniversalTime()
    if ($bootTime.Year -lt 2000) { throw 'Boot time is outside the supported range.' }
    return ([DateTimeOffset]::new($bootTime)).ToString('o')
  } catch {
    throw "Windows boot identity is invalid; automatic shutdown is blocked: $($_.Exception.Message)"
  }
}

function Test-SameWindowsBootId([string]$Left, [string]$Right) {
  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
  $leftTime = Convert-IsoTimestamp $Left 'Stored Windows boot identity'
  $rightTime = Convert-IsoTimestamp $Right 'Current Windows boot identity'
  return $leftTime.UtcDateTime.Ticks -eq $rightTime.UtcDateTime.Ticks
}

function Get-WorkerBootId {
  if ([string]::IsNullOrWhiteSpace([string]$script:WorkerBootId)) {
    throw 'The weekly worker has no verified Windows boot identity.'
  }
  return [string]$script:WorkerBootId
}

function Invoke-ScheduledStart([object]$Schedule, [object]$Day, [object]$Runtime, [string]$ScheduleDate) {
  $actionStarted = $false
  try {
    # Hold the global release barrier only for this preflight. PixelBrightness-Show
    # acquires the same barrier in its own launcher, so retaining it while starting
    # the task would deadlock the renderer startup.
    Assert-ScheduleControlPlane
    Wait-PixelServer
    if (-not (Test-ShowUserConsoleSession)) {
      Set-RuntimePhase $Runtime $Schedule 'waiting-for-login' 'awaiting-login'
      return $false
    }
    $showTask = Get-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop
    if ([string]$showTask.State -ceq 'Disabled') {
      Set-RuntimePhase $Runtime $Schedule 'idle' 'starting-show'
      return $false
    }
    $projectorIds = @()
    $projectorConfigurationRevision = 0
    if ($Schedule.projectorStartupEnabled -eq $true -or $Schedule.projectorStandbyEnabled -eq $true) {
      $projectorBinding = Get-EnabledProjectorBinding
      $projectorIds = @($projectorBinding.projectorIds)
      $projectorConfigurationRevision = [int]$projectorBinding.revision
    }

    $Runtime.state = 'starting'
    $Runtime.phase = 'starting-show'
    $Runtime.activeRun = New-ActiveRun $Schedule $Day $ScheduleDate $projectorIds $projectorConfigurationRevision
    Start-RuntimeAction $Runtime $Schedule 'start' $ScheduleDate
    $actionStarted = $true
    Set-ActiveRunStartupStage $Runtime $Schedule 'show-start-requested' 'starting' 'starting-show'
    if (-not (Wait-ShowTaskRunning)) { throw 'PixelBrightness-Show remains disabled until display binding is complete.' }
    Set-ActiveRunStartupStage $Runtime $Schedule 'show-running' 'starting' 'starting-arena'

    Set-ActiveRunStartupStage $Runtime $Schedule 'arena-start-requested' 'starting' 'starting-arena'
    $arena = Invoke-InteractiveArena 'start' $Runtime.activeRun $null $null 120
    if ($null -ne $arena.processId) {
      $Runtime.arenaProcessId = [int]$arena.processId
      $Runtime.activeRun.arenaProcessId = [int]$arena.processId
      $Runtime.activeRun.arenaProcessStartTimeUtc = [string]$arena.processStartTimeUtc
      Set-ActiveRunStartupStage $Runtime $Schedule 'arena-running' 'starting' 'waiting-source'
    }
    if ($arena.ok -ne $true) { throw "Arena interactive action failed: $([string]$arena.message)" }
    Wait-NodeAndSource ([string]$Runtime.activeRun.nodeId)
    Set-ActiveRunStartupStage $Runtime $Schedule 'source-ready' 'starting' 'powering-projectors'

    if ($Runtime.activeRun.projectorStartupEnabled -eq $true) {
      Set-ActiveRunStartupStage $Runtime $Schedule 'projectors-power-requested' 'starting' 'powering-projectors'
      $powered = Invoke-PixelApi 'Post' '/v1/projectors/actions' ([ordered]@{
        action = 'power-on'; projectorIds = @($Runtime.activeRun.projectorIds)
        staggerMs = [int]$Runtime.activeRun.projectorStaggerMs
        expectedRevision = [int]$Runtime.activeRun.projectorConfigurationRevision
      }) 30
      Assert-ProjectorBatch $powered @($Runtime.activeRun.projectorIds) 'Projector power-on'
      Set-RuntimePhase $Runtime $Schedule 'starting' 'warming-projectors'
      if ([int]$Runtime.activeRun.projectorWarmupSeconds -gt 0) { Start-Sleep -Seconds ([int]$Runtime.activeRun.projectorWarmupSeconds) }
      $refreshed = Invoke-PixelApi 'Post' '/v1/projectors/refresh' ([ordered]@{
        projectorIds = @($Runtime.activeRun.projectorIds)
        expectedRevision = [int]$Runtime.activeRun.projectorConfigurationRevision
      }) 60
      Assert-ProjectorBatch $refreshed @($Runtime.activeRun.projectorIds) 'Projector readiness refresh'
      foreach ($id in @($Runtime.activeRun.projectorIds)) {
        $projector = @($refreshed.projectors | Where-Object { [string]$_.id -ceq $id })
        if ($projector.Count -ne 1 -or $projector[0].status.online -ne $true -or
            [string]$projector[0].status.power -cne 'on' -or [string]$projector[0].status.light -cne 'on') {
          throw "Projector $id did not reach powered-on, light-on state after warmup."
        }
      }
    }

    $Runtime.state = 'running'
    $Runtime.phase = 'ready'
    $Runtime.activeRun.startupStage = 'ready'
    Complete-RuntimeAction $Runtime $Schedule $true 'Arena, Pixel Brightness and all scheduled projectors are ready.'
    return $true
  } catch {
    if ($actionStarted -and $null -ne $Runtime.lastAction -and [string]$Runtime.lastAction.type -ceq 'start' -and
        [string]$Runtime.lastAction.status -ceq 'running') {
      $Runtime.state = 'error'
      $Runtime.phase = 'failed'
      Complete-RuntimeAction $Runtime $Schedule $false $_.Exception.Message
    } else {
      $Runtime.state = 'error'
      $Runtime.phase = 'failed'
      if ($null -ne $Runtime.lastAction) { $Runtime.lastAction.message = Get-RuntimeMessage $_.Exception.Message }
      Write-ShowScheduleRuntime $Runtime $Schedule
    }
    return $false
  }
}

function Get-StageIndex([string[]]$Stages, [string]$Stage) {
  $index = [Array]::IndexOf($Stages, $Stage)
  if ($index -lt 0) { throw "Unknown durable show checkpoint: $Stage" }
  return $index
}

function Resolve-ShutdownRequestCheckpoint([object]$Schedule, [object]$Runtime) {
  if ($null -eq $Runtime.activeRun -or [string]$Runtime.activeRun.shutdownStage -cne 'shutdown-requested') {
    return $false
  }
  if ([string]::IsNullOrWhiteSpace([string]$Runtime.activeRun.shutdownRequestBootId)) {
    $message = 'A shutdown-requested checkpoint has no boot identity; automatic shutdown replay is blocked for local inspection.'
    if ($null -ne $Runtime.lastAction -and [string]$Runtime.lastAction.type -ceq 'shutdown' -and
        [string]$Runtime.lastAction.status -ceq 'running') {
      $Runtime.state = 'shutdown-blocked'
      $Runtime.phase = 'failed'
      Complete-RuntimeAction $Runtime $Schedule $false $message
    } else {
      Set-RuntimePhase $Runtime $Schedule 'shutdown-blocked' 'failed' $message
    }
    return $true
  }
  $currentBootId = Get-WorkerBootId
  if (Test-SameWindowsBootId ([string]$Runtime.activeRun.shutdownRequestBootId) $currentBootId) {
    # The request belongs to this boot and may already be accepted by Windows.
    # Never reissue it in the same boot session.
    if ($null -ne $Runtime.lastAction -and [string]$Runtime.lastAction.status -ceq 'failed') {
      Set-RuntimePhase $Runtime $Schedule 'shutdown-blocked' 'failed' 'Windows rejected or could not complete shutdown in this boot session; automatic replay is blocked for local inspection.'
    } else {
      Set-RuntimePhase $Runtime $Schedule 'stopping' 'requesting-windows-shutdown' 'Windows shutdown was requested in this boot session; waiting for the power transition.'
    }
    return $true
  }
  if ($null -eq $Runtime.lastAction -or [string]$Runtime.lastAction.type -cne 'shutdown' -or
      [string]$Runtime.lastAction.scheduleDate -cne [string]$Runtime.activeRun.scheduleDate) {
    throw 'A prior-boot shutdown checkpoint has no matching shutdown action; automatic recovery is blocked.'
  }

  # shutdown.exe may terminate the worker before it can write its success. A
  # different Windows boot identity proves that the requested power transition
  # completed, so clear the pinned run instead of issuing shutdown again.
  $Runtime.activeRun = $null
  $Runtime.arenaProcessId = $null
  $Runtime.state = 'idle'
  $Runtime.phase = 'before-start'
  Complete-RuntimeAction $Runtime $Schedule $true 'The prior Windows shutdown completed; the new boot session reconciled its durable checkpoint.'
  return $true
}

function Wait-ProjectorsStandby(
  [string[]]$ProjectorIds,
  [int]$ExpectedRevision,
  [int]$TimeoutSeconds = 180
) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  $last = 'no status response'
  do {
    try {
      $refreshed = Invoke-PixelApi 'Post' '/v1/projectors/refresh' ([ordered]@{
        projectorIds = @($ProjectorIds)
        expectedRevision = $ExpectedRevision
      }) 60
      Assert-ProjectorBatch $refreshed $ProjectorIds 'Projector standby verification'
      $pending = [System.Collections.Generic.List[string]]::new()
      foreach ($id in $ProjectorIds) {
        $projector = @($refreshed.projectors | Where-Object { [string]$_.id -ceq $id })
        if ($projector.Count -ne 1 -or $projector[0].status.online -ne $true -or
            [string]$projector[0].status.power -cne 'standby' -or
            [string]$projector[0].status.light -cne 'standby') {
          $pending.Add($id)
        }
      }
      if ($pending.Count -eq 0) { return }
      $last = "still active: $($pending -join ', ')"
    } catch { $last = $_.Exception.Message }
    Start-Sleep -Seconds 5
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "All five projectors did not confirm standby before Windows shutdown: $last"
}

function Invoke-ScheduledShutdown([object]$Schedule, [object]$Runtime) {
  $actionStarted = $false
  try {
    Assert-ScheduleControlPlane
    if ($null -eq $Runtime.activeRun) { throw 'The active show run is missing; automatic shutdown is blocked.' }
    $run = $Runtime.activeRun
    $scheduleDate = [string]$run.scheduleDate

    $Runtime.state = 'stopping'
    $Runtime.phase = 'saving-arena'
    Start-RuntimeAction $Runtime $Schedule 'shutdown' $scheduleDate
    $actionStarted = $true
    $shutdownStages = @('pending', 'arena-save-requested', 'arena-closed', 'projectors-standby-requested', 'projectors-standby-confirmed', 'show-stop-requested', 'show-stopped', 'shutdown-requested')
    $startupStages = @('created', 'show-start-requested', 'show-running', 'arena-start-requested', 'arena-running', 'source-ready', 'projectors-power-requested', 'ready')

    if ((Get-StageIndex $shutdownStages ([string]$run.shutdownStage)) -lt (Get-StageIndex $shutdownStages 'arena-closed')) {
      $startupIndex = Get-StageIndex $startupStages ([string]$run.startupStage)
      if ($startupIndex -lt (Get-StageIndex $startupStages 'arena-start-requested')) {
        Set-ActiveRunShutdownStage $Runtime $Schedule 'arena-closed' 'closing-arena'
      } else {
        if ($null -eq $run.arenaProcessId -or [string]::IsNullOrWhiteSpace([string]$run.arenaProcessStartTimeUtc)) {
          throw 'Arena launch was requested but its exact process identity is unknown; automatic shutdown is blocked for local inspection.'
        }
        if (-not (Test-ShowUserConsoleSession)) {
          throw 'The local Show account is not signed in; Arena cannot be saved and automatic shutdown is blocked.'
        }
        Set-ActiveRunShutdownStage $Runtime $Schedule 'arena-save-requested' 'saving-arena'
        $closed = Invoke-InteractiveArena 'save-close' $run ([int]$run.arenaProcessId) ([string]$run.arenaProcessStartTimeUtc) 90
        if ($closed.ok -ne $true) { throw 'Arena did not confirm its save-and-close operation.' }
        $Runtime.arenaProcessId = $null
        $run.arenaProcessId = $null
        $run.arenaProcessStartTimeUtc = $null
        Set-ActiveRunShutdownStage $Runtime $Schedule 'arena-closed' 'closing-arena'
      }
    }

    if ((Get-StageIndex $shutdownStages ([string]$run.shutdownStage)) -lt (Get-StageIndex $shutdownStages 'projectors-standby-confirmed')) {
      if ($run.projectorStandbyEnabled -eq $true) {
        if (@($run.projectorIds).Count -ne 5) { throw 'The active run does not contain the exact five projector ids required for standby.' }
        Wait-PixelServer 60
        Set-ActiveRunShutdownStage $Runtime $Schedule 'projectors-standby-requested' 'projector-standby'
        $standby = Invoke-PixelApi 'Post' '/v1/projectors/actions' ([ordered]@{
          action = 'standby'; projectorIds = @($run.projectorIds)
          staggerMs = [int]$run.projectorStaggerMs
          expectedRevision = [int]$run.projectorConfigurationRevision
        }) 30
        Assert-ProjectorBatch $standby @($run.projectorIds) 'Projector standby'
        Wait-ProjectorsStandby -ProjectorIds @($run.projectorIds) -ExpectedRevision ([int]$run.projectorConfigurationRevision)
      }
      Set-ActiveRunShutdownStage $Runtime $Schedule 'projectors-standby-confirmed' 'projector-standby'
    }

    if ((Get-StageIndex $shutdownStages ([string]$run.shutdownStage)) -lt (Get-StageIndex $shutdownStages 'show-stopped')) {
      Set-ActiveRunShutdownStage $Runtime $Schedule 'show-stop-requested' 'stopping-show'
      Stop-ShowTask
      Set-ActiveRunShutdownStage $Runtime $Schedule 'show-stopped' 'stopping-show'
    }
    $shutdown = Join-Path $env:SystemRoot 'System32\shutdown.exe'
    if (-not (Test-Path -LiteralPath $shutdown -PathType Leaf)) { throw "Trusted Windows shutdown executable is missing: $shutdown" }
    $run.shutdownRequestBootId = Get-WorkerBootId
    Set-ActiveRunShutdownStage $Runtime $Schedule 'shutdown-requested' 'requesting-windows-shutdown'
    # Windows documents that /t values greater than zero imply /f. /t 0 keeps
    # normal non-forced application shutdown semantics after Arena is proven closed.
    & $shutdown /s /t 0 /d 'p:0:0' /c 'Pixel Brightness weekly show schedule completed safely.'
    if ($LASTEXITCODE -ne 0) { throw "Windows shutdown.exe exited with $LASTEXITCODE." }
    # Exit 0 means Windows accepted the request, not that power-off completed.
    # Keep the tombstone until a later boot proves the transition occurred.
    $Runtime.workerMessage = 'Windows accepted the shutdown request; waiting for the power transition.'
    Write-ShowScheduleRuntime $Runtime $Schedule
    return $true
  } catch {
    $Runtime.state = 'shutdown-blocked'
    $Runtime.phase = 'failed'
    if ($actionStarted -and $null -ne $Runtime.lastAction -and [string]$Runtime.lastAction.type -ceq 'shutdown' -and
        [string]$Runtime.lastAction.status -ceq 'running') {
      Complete-RuntimeAction $Runtime $Schedule $false $_.Exception.Message
    } else {
      if ($null -ne $Runtime.lastAction) { $Runtime.lastAction.message = Get-RuntimeMessage $_.Exception.Message }
      Write-ShowScheduleRuntime $Runtime $Schedule
    }
    return $false
  }
}

function Get-ExactArenaProcesses([string]$ExecutablePath) {
  $result = [System.Collections.Generic.List[object]]::new()
  foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
    try {
      if ([string]::Equals([IO.Path]::GetFullPath([string]$process.Path), $ExecutablePath, [StringComparison]::OrdinalIgnoreCase)) {
        $result.Add($process)
      }
    } catch { }
  }
  return @($result)
}

function Resolve-PriorBootActiveRun([object]$Schedule, [object]$Runtime) {
  if ($null -eq $Runtime.activeRun) { return $false }
  $run = $Runtime.activeRun
  if ([string]::IsNullOrWhiteSpace([string]$run.runBootId)) {
    $message = 'The active run predates boot-session tracking; automatic resume and shutdown are blocked for local inspection.'
    if ($null -ne $Runtime.lastAction -and [string]$Runtime.lastAction.status -ceq 'running') {
      $Runtime.state = 'shutdown-blocked'
      $Runtime.phase = 'failed'
      Complete-RuntimeAction $Runtime $Schedule $false $message
    } else {
      Set-RuntimePhase $Runtime $Schedule 'shutdown-blocked' 'failed' $message
    }
    return $true
  }
  $currentBootId = Get-WorkerBootId
  if (Test-SameWindowsBootId ([string]$run.runBootId) $currentBootId) { return $false }

  $actionStarted = $false
  try {
    # The old interactive session no longer exists. Do not reuse its PID and do
    # not shut down this new boot; only place any pinned projectors in standby,
    # stop the renderer task and retire the stale active run.
    Assert-ScheduleControlPlane
    if (@(Get-ExactArenaProcesses ([string]$run.arenaExecutablePath)).Count -ne 0) {
      throw 'A new-boot Arena process exists while an older active run needs recovery; automatic cleanup is blocked.'
    }
    $Runtime.state = 'stopping'
    $Runtime.phase = 'closing-arena'
    Start-RuntimeAction $Runtime $Schedule 'shutdown' ([string]$run.scheduleDate)
    $actionStarted = $true
    $Runtime.arenaProcessId = $null
    $run.arenaProcessId = $null
    $run.arenaProcessStartTimeUtc = $null
    Set-ActiveRunShutdownStage $Runtime $Schedule 'arena-closed' 'closing-arena'

    if ($run.projectorStandbyEnabled -eq $true) {
      if (@($run.projectorIds).Count -ne 5) { throw 'The prior-boot active run does not contain the exact five projector ids required for standby.' }
      Wait-PixelServer 60
      Set-ActiveRunShutdownStage $Runtime $Schedule 'projectors-standby-requested' 'projector-standby'
      $standby = Invoke-PixelApi 'Post' '/v1/projectors/actions' ([ordered]@{
        action = 'standby'; projectorIds = @($run.projectorIds)
        staggerMs = [int]$run.projectorStaggerMs
        expectedRevision = [int]$run.projectorConfigurationRevision
      }) 30
      Assert-ProjectorBatch $standby @($run.projectorIds) 'Prior-boot projector standby'
      Wait-ProjectorsStandby -ProjectorIds @($run.projectorIds) -ExpectedRevision ([int]$run.projectorConfigurationRevision)
    }
    Set-ActiveRunShutdownStage $Runtime $Schedule 'projectors-standby-confirmed' 'projector-standby'
    Set-ActiveRunShutdownStage $Runtime $Schedule 'show-stop-requested' 'stopping-show'
    Stop-ShowTask
    Set-ActiveRunShutdownStage $Runtime $Schedule 'show-stopped' 'stopping-show'
    $Runtime.activeRun = $null
    $Runtime.arenaProcessId = $null
    $Runtime.state = 'error'
    $Runtime.phase = 'failed'
    Complete-RuntimeAction $Runtime $Schedule $false 'The prior Windows session ended before final shutdown completion. Projectors and Show were retired, but the operator must inspect the Arena composition.'
  } catch {
    $Runtime.state = 'shutdown-blocked'
    $Runtime.phase = 'failed'
    if ($actionStarted -and $null -ne $Runtime.lastAction -and [string]$Runtime.lastAction.status -ceq 'running') {
      Complete-RuntimeAction $Runtime $Schedule $false $_.Exception.Message
    } else {
      Set-RuntimePhase $Runtime $Schedule 'shutdown-blocked' 'failed' $_.Exception.Message
    }
  }
  return $true
}

function Invoke-InteractiveRequest {
  if (-not [Environment]::UserInteractive -or (Get-Process -Id $PID).SessionId -eq 0 -or $env:SESSIONNAME -like 'RDP-*') {
    throw 'Arena automation requires the local interactive Show session, never Session 0 or RDP.'
  }
  $barrier = Enter-PixelBrightnessReleaseLaunchBarrier
  try {
    $null = Assert-PixelBrightnessUpgradeLauncherGate -DataRoot $DataRoot -Role Schedule
    $null = Assert-PixelBrightnessControlPlane -DataRoot $DataRoot -IncludeSystemDirectories
    $request = Read-BoundedJson $script:ScheduleRequestPath 8192 'Arena interactive request'
    Assert-ExactProperties $request @(
      'schemaVersion', 'requestId', 'action', 'executablePath', 'compositionPath',
      'arenaProcessId', 'arenaProcessStartTimeUtc', 'createdAt'
    ) 'Arena interactive request'
    $requestId = [guid]::Empty
    if ([int]$request.schemaVersion -ne 1 -or
        -not [guid]::TryParseExact([string]$request.requestId, 'D', [ref]$requestId) -or
        [string]$request.action -notin @('start', 'save-close')) {
      throw 'Arena interactive request contract is invalid.'
    }
    $createdAt = Convert-IsoTimestamp ([string]$request.createdAt) 'Arena interactive request timestamp'
    if ($createdAt -lt [DateTimeOffset]::UtcNow.AddMinutes(-5) -or $createdAt -gt [DateTimeOffset]::UtcNow.AddMinutes(1)) {
      throw 'Arena interactive request is stale or from the future.'
    }
    $executable = Assert-WindowsFilePath ([string]$request.executablePath) '.exe' 'Resolume Arena executable'
    $composition = Assert-WindowsFilePath ([string]$request.compositionPath) '.avc' 'Resolume Arena composition'
    $response = [ordered]@{
      schemaVersion = 1
      requestId = [string]$request.requestId
      ok = $false
      processId = $null
      processStartTimeUtc = $null
      message = $null
      completedAt = $null
    }
    try {
      if ([string]$request.action -ceq 'start') {
        if ($null -ne $request.arenaProcessId -or $null -ne $request.arenaProcessStartTimeUtc) {
          throw 'Arena startup request must not contain an existing process identity.'
        }
        if (@(Get-ExactArenaProcesses $executable).Count -gt 0) {
          throw 'An Arena process already exists; refusing to assume it opened the scheduled composition.'
        }
        $argument = '"' + $composition + '"'
        $process = Start-Process -FilePath $executable -ArgumentList $argument -PassThru -ErrorAction Stop
        $response.processId = [int]$process.Id
        $response.processStartTimeUtc = ([DateTimeOffset]$process.StartTime.ToUniversalTime()).ToString('o')
        $deadline = [DateTimeOffset]::UtcNow.AddSeconds(90)
        do {
          Start-Sleep -Milliseconds 500
          $process.Refresh()
          if ($process.HasExited) { throw "Arena exited during startup with code $($process.ExitCode)." }
          if ($process.MainWindowHandle -ne [IntPtr]::Zero -and $process.Responding) { break }
        } while ([DateTimeOffset]::UtcNow -lt $deadline)
        $process.Refresh()
        if ($process.MainWindowHandle -eq [IntPtr]::Zero -or -not $process.Responding) {
          throw 'Arena did not expose a responsive main window within 90 seconds.'
        }
        $response.ok = $true
        $response.message = 'The exact Arena composition opened in the local Show session.'
      } else {
        if ($null -eq $request.arenaProcessId -or [int]$request.arenaProcessId -lt 1 -or
            [string]::IsNullOrWhiteSpace([string]$request.arenaProcessStartTimeUtc)) {
          throw 'Arena save-and-close requires the exact recorded process id and start time.'
        }
        $expectedStart = Convert-IsoTimestamp ([string]$request.arenaProcessStartTimeUtc) 'Recorded Arena process start time'
        $process = Get-Process -Id ([int]$request.arenaProcessId) -ErrorAction SilentlyContinue
        if ($null -eq $process) {
          $response.message = 'The recorded Arena process is already closed; no process remains to force or save.'
        } else {
          $process.Refresh()
          if (-not [string]::Equals([IO.Path]::GetFullPath([string]$process.Path), $executable, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The recorded Arena process id now belongs to a different executable.'
          }
          $actualStart = [DateTimeOffset]$process.StartTime.ToUniversalTime()
          if ([Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -gt 0.001) {
            throw 'The recorded Arena process id was reused by a different process instance.'
          }
          if ($process.MainWindowHandle -eq [IntPtr]::Zero -or -not $process.Responding) {
            throw 'Arena is not responsive; Windows shutdown is blocked without force-closing it.'
          }
          $shell = New-Object -ComObject WScript.Shell
          $beforeSave = Get-ArenaCompositionSaveEvidence $composition
          if (-not $shell.AppActivate([int]$process.Id)) { throw 'Arena could not receive focus for the Save command.' }
          Start-Sleep -Milliseconds 300
          $saveRequestedAt = [DateTime]::UtcNow
          $shell.SendKeys('^s')
          Start-Sleep -Seconds 3
          $null = Wait-ArenaCompositionSaved -Path $composition -Before $beforeSave -RequestedAtUtc $saveRequestedAt
          $process.Refresh()
          if ($process.HasExited -or -not $process.Responding) { throw 'Arena stopped responding after Save; Windows shutdown is blocked.' }
          if (-not $process.CloseMainWindow()) { throw 'Arena rejected graceful window close; Windows shutdown is blocked.' }
          if (-not $process.WaitForExit(30000)) { throw 'Arena did not close within 30 seconds; it was left running and Windows shutdown is blocked.' }
          $response.message = 'A stable new composition save was observed after Ctrl+S, then Arena closed gracefully without force termination.'
        }
        if (@(Get-ExactArenaProcesses $executable).Count -ne 0) {
          throw 'An exact Arena executable process remains after graceful close; Windows shutdown is blocked.'
        }
        $response.ok = $true
      }
    } catch {
      $response.ok = $false
      $response.message = Get-RuntimeMessage $_.Exception.Message
    }
    $response.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    Write-ScheduleJson $script:ScheduleResponsePath $response
    if ($response.ok -ne $true) { throw "Arena interactive request failed: $([string]$response.message)" }
  } finally {
    Exit-PixelBrightnessReleaseLaunchBarrier $barrier
  }
}

function Invoke-ScheduleWorker {
  $createdNew = $false
  $mutex = [Threading.Mutex]::new($false, 'Global\PixelBrightnessShowScheduleWorker', [ref]$createdNew)
  if (-not $createdNew) { $mutex.Dispose(); return }
  $runtimeCorrupt = $false
  try {
    $script:WorkerBootId = Get-WindowsBootId
    while ($true) {
      $schedule = $null
      $runtime = $null
      $scheduleError = $null
      try {
        if (Test-Path -LiteralPath $script:ScheduleConfigPath -PathType Leaf) {
          try { $schedule = Read-ShowSchedule }
          catch { $scheduleError = $_.Exception.Message }
        }
        try { $runtime = Read-ShowScheduleRuntime $schedule }
        catch {
          $runtimeCorrupt = $true
          # Never overwrite corrupt authoritative state: it may contain the only
          # Arena process identity and cleanup checkpoint. Leaving it intact keeps
          # every worker restart fail-closed for local inspection and recovery.
          $runtime = $null
        }
        if ($runtimeCorrupt) { Start-Sleep -Seconds 10; continue }

        $now = [DateTime]::Now
        $today = $now.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
        if (Resolve-ShutdownRequestCheckpoint $schedule $runtime) {
          Start-Sleep -Seconds 10
          continue
        }
        if (Resolve-PriorBootActiveRun $schedule $runtime) {
          Start-Sleep -Seconds 10
          continue
        }
        if ($null -ne $runtime.lastAction -and [string]$runtime.lastAction.status -ceq 'running') {
          $runtime.state = $(if ([string]$runtime.lastAction.type -ceq 'shutdown') { 'shutdown-blocked' } else { 'error' })
          $runtime.phase = 'failed'
          Complete-RuntimeAction $runtime $schedule $false 'The previous scheduler action was interrupted; durable checkpoints will be used for safe cleanup.'
        }

        # An active run is authoritative until its pinned shutdown finishes.
        # New Web revisions, disabled weekdays and master-disable cannot strand it.
        if ($null -ne $runtime.activeRun) {
          $runDate = [DateTime]::ParseExact(
            [string]$runtime.activeRun.scheduleDate,
            'yyyy-MM-dd',
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::None
          )
          $runShutdownClock = Convert-TimeOfDay ([string]$runtime.activeRun.shutdownTime) 'Active-run shutdown time'
          $activeShutdownAt = $runDate.Date.Add($runShutdownClock.TimeOfDay)
          if ($now -ge $activeShutdownAt) {
            $null = Invoke-ScheduledShutdown $schedule $runtime
          } elseif ([string]$runtime.activeRun.startupStage -ceq 'ready') {
            Set-RuntimePhase $runtime $schedule 'running' 'ready'
          } else {
            Set-RuntimePhase $runtime $schedule 'error' 'failed' 'A partial startup remains tracked and will receive safe cleanup at its pinned shutdown time.'
          }
          Start-Sleep -Seconds 10
          continue
        }

        Ensure-DailyLedger $runtime $today
        if ($null -eq $schedule) {
          if ($null -eq $scheduleError) {
            Set-RuntimePhase $runtime $null 'disabled' 'disabled' 'Save a weekly schedule in Web Control to arm automation.'
          } else {
            Set-RuntimePhase $runtime $null 'error' 'failed' $scheduleError
          }
          Start-Sleep -Seconds 10
          continue
        }
        if ($schedule.enabled -ne $true) {
          Set-RuntimePhase $runtime $schedule 'disabled' 'disabled'
          Start-Sleep -Seconds 10; continue
        }
        $dayName = $script:DayNames[[int]$now.DayOfWeek]
        $day = @($schedule.days | Where-Object { [string]$_.day -ceq $dayName })
        if ($day.Count -ne 1 -or $day[0].enabled -ne $true) {
          Set-RuntimePhase $runtime $schedule 'idle' 'off-day'
          Start-Sleep -Seconds 10; continue
        }
        $startClock = Convert-TimeOfDay ([string]$day[0].startTime) 'Scheduled start time'
        $shutdownClock = Convert-TimeOfDay ([string]$day[0].shutdownTime) 'Scheduled shutdown time'
        $startAt = $now.Date.Add($startClock.TimeOfDay)
        $shutdownAt = $now.Date.Add($shutdownClock.TimeOfDay)
        $scheduleSavedAt = Convert-IsoTimestamp ([string]$schedule.updatedAt) 'Weekly show schedule updatedAt'
        $armedBeforeStart = $scheduleSavedAt.ToLocalTime().DateTime -le $startAt
        $startAttemptedToday = [string]$runtime.dailyLedger.startStatus -cne 'not-attempted'
        $shutdownAttemptedToday = [string]$runtime.dailyLedger.shutdownStatus -cne 'not-attempted'
        if ($now -lt $startAt) {
          Set-RuntimePhase $runtime $schedule 'idle' 'before-start'
        } elseif ($now -lt $shutdownAt) {
          if ($shutdownAttemptedToday) {
            Set-RuntimePhase $runtime $schedule 'idle' 'off-day' 'Today already completed its safe shutdown; automatic restart is blocked until another date.'
          } elseif ($startAttemptedToday) {
            Set-RuntimePhase $runtime $schedule 'error' 'failed' 'Today already attempted startup and has no active run; automatic replay is blocked for local inspection.'
          } elseif (-not $armedBeforeStart) {
            Set-RuntimePhase $runtime $schedule 'idle' 'deferred' 'This revision was saved after today''s Start boundary and will apply on the next enabled day.'
          } else {
            $null = Invoke-ScheduledStart $schedule $day[0] $runtime $today
          }
        } else {
          Set-RuntimePhase $runtime $schedule 'idle' 'off-day' 'Today''s operating window has ended; the next enabled day will be used.'
        }
      } catch {
        if ($null -eq $runtime) { $runtime = New-EmptyRuntime $schedule 'error' 'failed' }
        $runtime.state = 'error'
        $runtime.phase = 'failed'
        $runtime.workerMessage = Get-RuntimeMessage $_.Exception.Message
        try { Write-ShowScheduleRuntime $runtime $schedule } catch { }
      }
      Start-Sleep -Seconds 10
    }
  } finally {
    $mutex.Dispose()
  }
}

if ($Mode -ceq 'Interactive') {
  try { Invoke-InteractiveRequest }
  catch {
    try {
      $request = Read-BoundedJson $script:ScheduleRequestPath 8192 'Arena interactive request'
      Write-ScheduleJson $script:ScheduleResponsePath ([ordered]@{
        schemaVersion = 1; requestId = [string]$request.requestId; ok = $false; processId = $null
        processStartTimeUtc = $null; message = (Get-RuntimeMessage $_.Exception.Message)
        completedAt = [DateTimeOffset]::UtcNow.ToString('o')
      })
    } catch { }
    exit 1
  }
  exit 0
}

Invoke-ScheduleWorker
