[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$DataRoot = (Join-Path $env:ProgramData 'Pixel Brightness'),
  [string]$ControlTokenFile = '',
  [string[]]$GdiName = @(),
  [ValidateRange(1, 16)]
  [int]$OutputCount = 2,
  [ValidateRange(0, 4096)]
  [int]$Overlap = 240,
  [ValidateRange(0, 16384)]
  [int]$CanvasWidth = 0,
  [ValidateRange(0, 16384)]
  [int]$CanvasHeight = 0,
  [ValidateRange(0, 16383)]
  [int]$SourceOffsetX = 0,
  [ValidateRange(0, 16383)]
  [int]$SourceOffsetY = 0,
  [string]$SenderName = 'PB-COMPOSITION',
  [switch]$AutoSelect,
  [switch]$ResetSpatialConfig,
  [switch]$StartShow
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$runtimeSecurityPath = Join-Path $PSScriptRoot 'RuntimeSecurity.ps1'
if (-not (Test-Path -LiteralPath $runtimeSecurityPath -PathType Leaf)) {
  throw "Runtime security policy is missing beside the binder: $runtimeSecurityPath"
}
. $runtimeSecurityPath
$upgradeTransactionPath = Join-Path $PSScriptRoot 'UpgradeTransaction.ps1'
if (-not (Test-Path -LiteralPath $upgradeTransactionPath -PathType Leaf)) {
  throw "Upgrade transaction policy is missing beside the binder: $upgradeTransactionPath"
}
$null = Assert-AdminProtectedItem (Get-Item -LiteralPath $upgradeTransactionPath -Force -ErrorAction Stop) 'Display binding durability policy'
. $upgradeTransactionPath

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

function Write-Utf8Json([string]$Path, [object]$Value, [int]$Depth = 30) {
  Assert-RealFileDestination $Path
  Write-PixelBrightnessAtomicBytes $Path (ConvertTo-PixelBrightnessUtf8JsonBytes $Value $Depth)
}

function Invoke-DisplayBindingFaultInjection([string]$Stage) {
  if ([string]$env:PIXEL_BRIGHTNESS_BIND_FAULT_INJECTION -cne $Stage) { return }
  Stop-Process -Id $PID -Force
  throw "Display binding fault injection did not terminate the binder at $Stage"
}

function Protect-BindingGate([string]$Path, [string]$User) {
  $null = Protect-AdminControlPath -Path $Path -ShowUser $User -ShowAccess Read -Label 'Pixel Brightness display binding gate'
}

function Protect-BackupDirectory([string]$Path, [string]$User, [switch]$IncludeShowRead) {
  $showAccess = if ($IncludeShowRead) { 'Read' } else { 'None' }
  $null = Protect-AdminControlTree -Path $Path -ShowUser $User -ShowAccess $showAccess -Label 'Pixel Brightness display-binding backup'
}

function Get-PropertyValue([object]$Value, [string]$Name) {
  if ($null -eq $Value) { return $null }
  $property = $Value.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Get-DisplayProperty([object]$Output, [string]$Name) {
  return Get-PropertyValue (Get-PropertyValue $Output 'display') $Name
}

function Assert-ExactResolution([object]$ExistingOutput, [object]$Display) {
  $resolution = Get-PropertyValue $ExistingOutput 'resolution'
  if ($null -eq $resolution) {
    throw "Authoritative output $($ExistingOutput.id) has no resolution. Use -ResetSpatialConfig only if an intentional calibration reset is acceptable."
  }
  foreach ($property in @('width', 'height', 'refreshNum', 'refreshDen')) {
    if ([int64](Get-PropertyValue $resolution $property) -ne [int64](Get-PropertyValue $Display $property)) {
      throw "Authoritative output $($ExistingOutput.id) $property does not match the selected Windows target. Spatial calibration was not changed; restore the prior display mode or use -ResetSpatialConfig intentionally."
    }
  }
}

function Assert-PreservedSpatialConfig([object]$Output, [object]$Canvas) {
  foreach ($property in @('sourceViewport', 'overlap', 'warp', 'blend', 'blackUniformity', 'color', 'mask', 'processing')) {
    if ($null -eq (Get-PropertyValue $Output $property)) {
      throw "Authoritative output $($Output.id) has no $property calibration. Use -ResetSpatialConfig only if an intentional calibration reset is acceptable."
    }
  }
  $viewport = Get-PropertyValue $Output 'sourceViewport'
  foreach ($property in @('x', 'y', 'width', 'height')) {
    if ($null -eq (Get-PropertyValue $viewport $property)) {
      throw "Authoritative output $($Output.id) sourceViewport has no $property value. Spatial calibration was not changed."
    }
  }
  $x = [double](Get-PropertyValue $viewport 'x')
  $y = [double](Get-PropertyValue $viewport 'y')
  $width = [double](Get-PropertyValue $viewport 'width')
  $height = [double](Get-PropertyValue $viewport 'height')
  if ($x -lt 0 -or $y -lt 0 -or $width -le 0 -or $height -le 0 -or
      $x + $width -gt [double]$Canvas.width -or $y + $height -gt [double]$Canvas.height) {
    throw "Authoritative output $($Output.id) sourceViewport is incompatible with the selected master canvas. Spatial calibration was not changed."
  }
}

function Assert-SpatialConfigEqual([object]$Expected, [object]$Actual) {
  foreach ($property in @('sourceViewport', 'overlap', 'warp', 'blend', 'blackUniformity', 'color', 'mask', 'processing')) {
    $expectedJson = (Get-PropertyValue $Expected $property) | ConvertTo-Json -Depth 50 -Compress
    $actualJson = (Get-PropertyValue $Actual $property) | ConvertTo-Json -Depth 50 -Compress
    if ($expectedJson -cne $actualJson) {
      throw "Pixel Server changed preserved $property data for output $($Expected.id); the binding remains invalid."
    }
  }
}

function Export-RebindBackup(
  [string]$Root,
  [string]$NodeId,
  [string]$ShowUser,
  [object]$ServerProject,
  [object[]]$SelectedDisplays,
  [bool]$ResetRequested,
  [string[]]$LocalPaths,
  [string]$InventoryPath
) {
  $backupsParent = Join-Path $Root 'backups'
  $backupRoot = Join-Path $Root 'backups\display-bindings'
  $null = Initialize-AdminProtectedDirectory $backupsParent $env:ProgramData $ShowUser 'Pixel Brightness backups parent'
  $null = Initialize-AdminProtectedDirectory $backupRoot $env:ProgramData $ShowUser 'Pixel Brightness display-binding backups parent'
  $stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
  $backupPath = Join-Path $backupRoot ("$stamp-$NodeId-$([guid]::NewGuid().ToString('N').Substring(0, 8))")
  New-Item -ItemType Directory -Path $backupPath | Out-Null
  Protect-BackupDirectory $backupPath $ShowUser
  try {
    Write-Utf8Json (Join-Path $backupPath 'server-project-before.json') $ServerProject 50
    Write-Utf8Json (Join-Path $backupPath 'selected-displays.json') @($SelectedDisplays) 20
    $manifest = [ordered]@{
      schemaVersion = 1
      createdAt = [DateTimeOffset]::UtcNow.ToString('o')
      nodeId = $NodeId
      resetSpatialConfig = $ResetRequested
      serverProjectRevision = [int64]$ServerProject.revision
    }
    Write-Utf8Json (Join-Path $backupPath 'manifest.json') $manifest 10
    foreach ($path in $LocalPaths) {
      if (Test-Path -LiteralPath $path -PathType Leaf) {
        Copy-Item -LiteralPath $path -Destination (Join-Path $backupPath ((Split-Path $path -Leaf) + '.before')) -Force
      }
    }
    if (Test-Path -LiteralPath $InventoryPath -PathType Leaf) {
      Copy-Item -LiteralPath $InventoryPath -Destination (Join-Path $backupPath 'windows-display-inventory.json') -Force
    }
    Protect-BackupDirectory $backupPath $ShowUser -IncludeShowRead
    return $backupPath
  } catch {
    throw "Could not export a protected pre-bind backup; no display config was changed: $($_.Exception.Message)"
  }
}

function Read-OperatorControlToken([string]$Root, [string]$TransportFile) {
  $tokenPath = if ([string]::IsNullOrWhiteSpace($TransportFile)) {
    Join-Path $Root 'secrets\control-token.txt'
  } else {
    (Resolve-Path -LiteralPath $TransportFile -ErrorAction Stop).Path
  }
  if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
    throw "Control token is missing: $tokenPath. A render-only host requires the temporary administrator-readable -ControlTokenFile exported from its central Server."
  }
  $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
  if ($token -notmatch '^[A-Za-z0-9_-]{43,128}$') {
    throw 'Control token is empty or invalid; operator actions cannot continue.'
  }
  return $token
}

function Get-PixelServerBindingReconcileState {
  param(
    [Parameter(Mandatory = $true)][object]$Project,
    [Parameter(Mandatory = $true)][string]$ProjectId,
    [Parameter(Mandatory = $true)][int64]$BaseRevision,
    [Parameter(Mandatory = $true)][int64]$TargetRevision,
    [Parameter(Mandatory = $true)][string]$BaseProjectSha256,
    [Parameter(Mandatory = $true)][string]$TargetProjectSha256
  )
  $actualSha256 = Get-PixelBrightnessServerProjectAuthoritySha256 $Project
  if ([string]$Project.id -ceq $ProjectId -and [int64]$Project.revision -eq $BaseRevision -and
      $actualSha256 -ceq $BaseProjectSha256) {
    return 'base'
  }
  if ([string]$Project.id -ceq $ProjectId -and [int64]$Project.revision -eq $TargetRevision -and
      $actualSha256 -ceq $TargetProjectSha256) {
    return 'target'
  }
  throw "Authoritative Server is neither the exact pre-bind project A nor intended project B (id=$([string]$Project.id), revision=$([int64]$Project.revision), sha256=$actualSha256). The durable gate remains and no project will be overwritten."
}

function Sync-PixelServerProject {
  param(
    [Parameter(Mandatory = $true)][byte[]]$TargetProjectBytes,
    [Parameter(Mandatory = $true)][string]$ControlToken,
    [Parameter(Mandatory = $true)][string]$ServerBaseUrl,
    [Parameter(Mandatory = $true)][string]$ProjectId,
    [Parameter(Mandatory = $true)][int64]$BaseRevision,
    [Parameter(Mandatory = $true)][int64]$TargetRevision,
    [Parameter(Mandatory = $true)][string]$BaseProjectSha256,
    [Parameter(Mandatory = $true)][string]$TargetProjectSha256
  )
  $headers = @{
    Authorization = "Bearer $ControlToken"
    'If-Match' = '"' + $BaseRevision.ToString([Globalization.CultureInfo]::InvariantCulture) + '"'
  }
  $lastFailure = $null
  foreach ($attempt in 1..20) {
    try {
      $before = Get-PixelServerProject $ControlToken $ServerBaseUrl
      $beforeState = Get-PixelServerBindingReconcileState -Project $before -ProjectId $ProjectId `
        -BaseRevision $BaseRevision -TargetRevision $TargetRevision `
        -BaseProjectSha256 $BaseProjectSha256 -TargetProjectSha256 $TargetProjectSha256
      if ($beforeState -ceq 'target') {
        return [pscustomobject]@{ project = $before; reconciled = $true }
      }
      $response = Invoke-RestMethod -Method Post -Uri "$ServerBaseUrl/v1/projects/default" `
        -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $TargetProjectBytes -TimeoutSec 10
      $responseState = Get-PixelServerBindingReconcileState -Project $response.project -ProjectId $ProjectId `
        -BaseRevision $BaseRevision -TargetRevision $TargetRevision `
        -BaseProjectSha256 $BaseProjectSha256 -TargetProjectSha256 $TargetProjectSha256
      if ($responseState -cne 'target') { throw 'Server POST did not commit the intended project B.' }
      return $response
    } catch {
      $postFailure = $_.Exception.Message
      try {
        # A timeout, reset connection, or lost HTTP response is ambiguous. GET
        # after every failure: exact A is the only state that permits retry;
        # exact intended B is success; every other state is a hard fail-close.
        $after = Get-PixelServerProject $ControlToken $ServerBaseUrl
        $afterState = Get-PixelServerBindingReconcileState -Project $after -ProjectId $ProjectId `
          -BaseRevision $BaseRevision -TargetRevision $TargetRevision `
          -BaseProjectSha256 $BaseProjectSha256 -TargetProjectSha256 $TargetProjectSha256
        if ($afterState -ceq 'target') {
          return [pscustomobject]@{ project = $after; reconciled = $true }
        }
        $lastFailure = $postFailure
      } catch {
        if ($_.Exception.Message -like 'Authoritative Server is neither*') { throw }
        $lastFailure = "$postFailure; reconciliation GET failed: $($_.Exception.Message)"
      }
      if ($attempt -lt 20) { Start-Sleep -Milliseconds 500 }
    }
  }
  throw "Pixel Server did not commit or reconcile the exact intended project B; Show remains gated: $lastFailure"
}

function Get-PixelServerProject([string]$ControlToken, [string]$ServerBaseUrl) {
  $headers = @{ Authorization = "Bearer $ControlToken" }
  $lastFailure = $null
  foreach ($attempt in 1..20) {
    try {
      $response = Invoke-RestMethod -Method Get -Uri "$ServerBaseUrl/v1/projects/default" `
        -Headers $headers -TimeoutSec 10
      return $response.project
    } catch {
      $lastFailure = $_.Exception.Message
      if ($attempt -lt 20) { Start-Sleep -Milliseconds 500 }
    }
  }
  throw "Pixel Server topology is unavailable; Show remains disabled: $lastFailure"
}

function Assert-PixelServerBindingCommit {
  param(
    [Parameter(Mandatory = $true)][object]$Project,
    [Parameter(Mandatory = $true)][string]$ExpectedProjectId,
    [Parameter(Mandatory = $true)][int64]$ExpectedRevision,
    [Parameter(Mandatory = $true)][object[]]$ExpectedOutputs,
    [Parameter(Mandatory = $true)][string]$NodeId,
    [Parameter(Mandatory = $true)][bool]$PreserveSpatial
  )
  if ([string]$Project.id -cne $ExpectedProjectId -or
      [int64]$Project.revision -ne $ExpectedRevision) {
    throw 'Pixel Server returned a different project identity or committed revision.'
  }
  $serverOutputs = @($Project.outputs)
  $expectedIds = @($ExpectedOutputs | ForEach-Object { [string]$_.id } | Sort-Object)
  $actualIds = @($serverOutputs | ForEach-Object { [string]$_.id } | Sort-Object)
  $localServerOutputs = @($serverOutputs | Where-Object { [string]$_.nodeId -eq $NodeId })
  $expectedLocalOutputs = @($ExpectedOutputs | Where-Object { [string]$_.nodeId -eq $NodeId })
  if ($serverOutputs.Count -ne $ExpectedOutputs.Count -or
      @(Compare-Object $expectedIds $actualIds).Count -gt 0 -or
      $localServerOutputs.Count -ne $expectedLocalOutputs.Count) {
    throw 'Pixel Server returned a project that does not match the bound physical outputs.'
  }
  foreach ($expectedOutput in $expectedLocalOutputs) {
    $actualOutput = @($localServerOutputs | Where-Object { [string]$_.id -ceq [string]$expectedOutput.id })
    if ($actualOutput.Count -ne 1) {
      throw "Pixel Server returned a missing or duplicate local output $($expectedOutput.id)."
    }
    foreach ($property in @('devicePath', 'gdiName', 'adapterLuid', 'targetId')) {
      if ([string](Get-DisplayProperty $actualOutput[0] $property) -cne
          [string](Get-DisplayProperty $expectedOutput $property)) {
        throw "Pixel Server returned a different $property for local output $($expectedOutput.id)."
      }
    }
    if ($PreserveSpatial) { Assert-SpatialConfigEqual $expectedOutput $actualOutput[0] }
  }
  return $Project
}

function Stop-PixelBrightnessShowBehindBindingGate {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$TransactionId
  )
  $activeGate = Read-PixelBrightnessDisplayBindingTransactionGate $DataRoot
  if ($null -eq $activeGate -or [string]$activeGate.transactionId -cne $TransactionId) {
    throw 'The exact display binding transaction gate is not active before Show quiescence.'
  }
  Disable-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop | Out-Null
  Stop-PixelBrightnessTaskForRollback 'PixelBrightness-Show'
  Stop-PixelBrightnessRacedShowLaunchProcessTrees -DataRoot $DataRoot
  $showTask = Get-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop
  $activeRenderers = @(Get-Process 'pixel-brightness-renderer' -ErrorAction SilentlyContinue)
  if ([string]$showTask.State -cne 'Disabled' -or $activeRenderers.Count -gt 0) {
    throw 'Show could not be proven disabled and black behind the durable display binding gate.'
  }
}

function Assert-NoPixelBrightnessShowProcessTrees {
  param([Parameter(Mandatory = $true)][string]$DataRoot)

  # This proof runs while the release-launch barrier is held and before the
  # first durable A-to-B gate is published. A launcher that won the barrier
  # must have finished spawning its child before we can get here; refusing
  # that pre-existing child keeps a process or machine stop in the small
  # gate-to-disable interval black without making any pre-gate mutation.
  $showTask = Get-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop
  if ([string]$showTask.State -ceq 'Running') {
    throw 'PixelBrightness-Show won the release-launch barrier; no binding gate was published. Stop it and retry.'
  }

  $launcherPath = [IO.Path]::GetFullPath((Join-Path $DataRoot 'Start-PixelBrightness.ps1'))
  $matches = @((Get-CimInstance Win32_Process -ErrorAction Stop) | Where-Object {
    $commandLine = [string]$_.CommandLine
    $isShowLauncher = -not [string]::IsNullOrWhiteSpace($commandLine) -and
      $commandLine.IndexOf($launcherPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $commandLine -match '(?i)(?:^|\s)-Role\s+"?Show(?:"|\s|$)'
    $isOrphanNode = $commandLine -match '(?:^|[\s"])(?:[^\s"]*[\\/])?runtime[\\/]node[\\/]index\.mjs(?:[\s"]|$)'
    $isRenderer = [string]$_.Name -ieq 'pixel-brightness-renderer.exe'
    $isShowLauncher -or $isOrphanNode -or $isRenderer
  })
  if ($matches.Count -gt 0) {
    throw 'A live Pixel Brightness Show launcher, Node, or renderer won the release-launch barrier; no binding gate was published. Stop it and retry.'
  }
}

function Read-TrustedPixelBrightnessBindingInstallation([string]$DataRoot) {
  # config\node.json lives below the intentionally Show-Modify config parent,
  # so it can never select the URL that receives the administrator control
  # bearer. installation.json lives below the already-audited administrator-
  # only secrets tree and is the bootstrap identity for both first bind and
  # post-upgrade bind generations.
  $path = Join-Path $DataRoot 'secrets\installation.json'
  $item = Assert-PixelBrightnessPlainFile $path 'Pixel Brightness binding installation authority'
  if ($null -eq $item) { throw "Pixel Brightness binding installation authority is missing: $path" }
  $null = Assert-AdminProtectedItem $item 'Pixel Brightness binding installation authority'
  try {
    $text = [Text.UTF8Encoding]::new($false, $true).GetString([IO.File]::ReadAllBytes($item.FullName))
    $installation = $text | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "Pixel Brightness binding installation authority is invalid: $($_.Exception.Message)"
  }
  if ([int]$installation.schemaVersion -ne 1 -or [string]$installation.role -notin @('All', 'Node')) {
    throw 'Display binding requires a trusted All or Node installation authority.'
  }
  $nodeId = [string]$installation.nodeId
  if ($nodeId -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$') {
    throw 'Trusted installation nodeId is invalid.'
  }
  $serverBaseUrl = ([string]$installation.serverUrl).Trim().TrimEnd('/')
  $serverUri = $null
  if (-not [Uri]::TryCreate($serverBaseUrl, [UriKind]::Absolute, [ref]$serverUri) -or
      $serverUri.Scheme -notin @('http', 'https') -or
      -not [string]::IsNullOrEmpty($serverUri.UserInfo) -or
      -not [string]::IsNullOrEmpty($serverUri.Query) -or
      -not [string]::IsNullOrEmpty($serverUri.Fragment)) {
    throw 'Trusted installation serverUrl must be an absolute HTTP(S) control-plane URL without credentials, query, or fragment.'
  }
  return [pscustomobject]@{ NodeId = $nodeId; ServerBaseUrl = $serverBaseUrl }
}

function Complete-PixelBrightnessDisplayBindingTransaction {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$ShowUser,
    [Parameter(Mandatory = $true)][object]$Gate,
    [Parameter(Mandatory = $true)][string]$ControlToken,
    [Parameter(Mandatory = $true)][string]$ServerBaseUrl,
    [Parameter(Mandatory = $true)][bool]$PreserveSpatial
  )
  $transactionId = [string]$Gate.transactionId
  $nodePath = Join-Path $DataRoot 'config\node.json'
  $rendererPath = Join-Path $DataRoot 'config\renderer.json'
  $informationalBindingPath = Join-Path $DataRoot 'config\display-binding.json'
  $generation = $Gate.generation
  $nodeBytes = [IO.File]::ReadAllBytes([string]$generation.NodePath)
  $rendererBytes = [IO.File]::ReadAllBytes([string]$generation.RendererPath)
  $targetProjectBytes = [IO.File]::ReadAllBytes([string]$generation.TargetProjectPath)
  $bindingBytes = [IO.File]::ReadAllBytes([string]$generation.BindingPath)
  $gateCleared = $false
  try {
    # The live config directory is writable by the interactive Show principal
    # because Node persists a later renderer cache there. These copies are not
    # boot authority: the immutable generation node/commit below is. Exact
    # write-through publication still makes every crash cut deterministic.
    Write-PixelBrightnessAtomicBytes $rendererPath $rendererBytes
    if ((Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes($rendererPath))) -cne [string]$Gate.rendererConfigSha256) {
      throw 'Published native renderer cache differs from the exact bind candidate bytes.'
    }
    Invoke-DisplayBindingFaultInjection 'after-renderer-config'

    Write-PixelBrightnessAtomicBytes $nodePath $nodeBytes
    if ((Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes($nodePath))) -cne [string]$Gate.nodeConfigSha256) {
      throw 'Published informational Node config differs from the exact bind candidate bytes.'
    }
    Invoke-DisplayBindingFaultInjection 'after-node-config'

    $serverResult = Sync-PixelServerProject -TargetProjectBytes $targetProjectBytes `
      -ControlToken $ControlToken -ServerBaseUrl $ServerBaseUrl `
      -ProjectId ([string]$Gate.projectId) -BaseRevision ([int64]$Gate.baseRevision) `
      -TargetRevision ([int64]$Gate.targetRevision) `
      -BaseProjectSha256 ([string]$Gate.baseProjectSha256) `
      -TargetProjectSha256 ([string]$Gate.targetProjectSha256)
    $null = Assert-PixelServerBindingCommit -Project $serverResult.project `
      -ExpectedProjectId ([string]$Gate.projectId) -ExpectedRevision ([int64]$Gate.targetRevision) `
      -ExpectedOutputs @($Gate.targetProject.outputs) -NodeId ([string]$Gate.nodeId) `
      -PreserveSpatial $PreserveSpatial
    Invoke-DisplayBindingFaultInjection 'after-server-commit'

    $commitPath = Write-PixelBrightnessDisplayBindingCommit -DataRoot $DataRoot `
      -ShowUser $ShowUser -Gate $Gate
    # Keep the historical config path only as operator/acceptance-test
    # information. Start never authorizes Show from this replaceable parent.
    Write-PixelBrightnessAtomicBytes $informationalBindingPath $bindingBytes
    Protect-BindingGate $informationalBindingPath $ShowUser
    $publishedCommit = Read-PixelBrightnessDisplayBindingCommit $DataRoot
    if ($null -eq $publishedCommit -or
        [string]$publishedCommit.transactionId -cne $transactionId -or
        (Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes($commitPath))) -cne [string]$Gate.bindingSha256 -or
        (Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes([string]$generation.NodePath))) -cne [string]$Gate.nodeConfigSha256 -or
        (Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes([string]$generation.RendererPath))) -cne [string]$Gate.rendererConfigSha256) {
      throw 'Protected display binding commit or immutable generation changed before gate removal.'
    }
    Invoke-DisplayBindingFaultInjection 'after-final-binding'

    $authoritativeProject = Get-PixelServerProject $ControlToken $ServerBaseUrl
    $authoritativeState = Get-PixelServerBindingReconcileState -Project $authoritativeProject `
      -ProjectId ([string]$Gate.projectId) -BaseRevision ([int64]$Gate.baseRevision) `
      -TargetRevision ([int64]$Gate.targetRevision) `
      -BaseProjectSha256 ([string]$Gate.baseProjectSha256) `
      -TargetProjectSha256 ([string]$Gate.targetProjectSha256)
    if ($authoritativeState -cne 'target') {
      throw 'Server returned to the pre-bind project before final gate removal.'
    }
    $null = Assert-PixelServerBindingCommit -Project $authoritativeProject `
      -ExpectedProjectId ([string]$Gate.projectId) -ExpectedRevision ([int64]$Gate.targetRevision) `
      -ExpectedOutputs @($Gate.targetProject.outputs) -NodeId ([string]$Gate.nodeId) `
      -PreserveSpatial $PreserveSpatial
    if ((Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes([string]$generation.NodePath))) -cne [string]$Gate.nodeConfigSha256 -or
        (Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes([string]$generation.RendererPath))) -cne [string]$Gate.rendererConfigSha256 -or
        (Get-PixelBrightnessDisplayOutputSelectorsSha256 @($Gate.binding.outputs)) -cne [string]$Gate.outputSelectorsSha256) {
      throw 'Immutable local display authority changed at the Server proof boundary.'
    }

    Remove-PixelBrightnessDisplayBindingTransactionGate $DataRoot $transactionId
    $gateCleared = $true
    Invoke-DisplayBindingFaultInjection 'after-binding-gate-clear'

    Enable-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop | Out-Null
    $showTask = Get-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop
    if ([string]$showTask.State -ceq 'Disabled') {
      throw 'The exact display binding committed, but PixelBrightness-Show could not be enabled.'
    }
    Invoke-DisplayBindingFaultInjection 'after-show-enable'
    return $publishedCommit
  } catch {
    $bindingError = $_.Exception.Message
    try {
      Disable-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop | Out-Null
      Stop-PixelBrightnessTaskForRollback 'PixelBrightness-Show'
    } catch {
      Write-Warning "Show could not be re-disabled after the binding failure: $($_.Exception.Message)"
    }
    if (-not $gateCleared) {
      throw "Display binding failed; the durable transaction gate remains and Show must stay black until exact recovery succeeds: $bindingError"
    }
    throw "Display binding committed exactly, but Show remains disabled because final task activation failed: $bindingError"
  }
}

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run Bind-PixelBrightnessDisplays.ps1 from Windows Terminal as Administrator.'
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

function Assert-DisplayDescriptor([object]$Display) {
  foreach ($property in @('devicePath', 'gdiName', 'adapterLuid')) {
    if ([string]::IsNullOrWhiteSpace([string]$Display.$property)) {
      throw "Windows returned a display without stable $property identity. No config was changed."
    }
  }
  if ([int64]$Display.targetId -lt 0 -or [int]$Display.width -lt 64 -or [int]$Display.width -gt 16384 -or
      [int]$Display.height -lt 64 -or [int]$Display.height -gt 16384) {
    throw 'Windows returned an invalid display target id or resolution. No config was changed.'
  }
  if ([int64]$Display.refreshNum -lt 1 -or [int64]$Display.refreshNum -gt 240000 -or
      [int64]$Display.refreshDen -lt 1 -or [int64]$Display.refreshDen -gt 100000) {
    throw 'Windows returned an invalid rational refresh rate. No config was changed.'
  }
}

function New-IdentityMesh {
  $points = [System.Collections.Generic.List[object]]::new()
  foreach ($row in 0..2) {
    foreach ($column in 0..2) {
      $u = $column / 2.0
      $v = $row / 2.0
      $points.Add([ordered]@{ u = $u; v = $v; x = $u; y = $v })
    }
  }
  return [ordered]@{
    enabled = $false
    columns = 2
    rows = 2
    interpolation = 'bilinear'
    points = @($points)
  }
}

function DisplayLabel([object]$Display) {
  return ("{0} | {1} | {2}x{3} @{4}/{5} | target {6} | {7}" -f $Display.gdiName, $Display.friendlyName, $Display.width, $Display.height, $Display.refreshNum, $Display.refreshDen, $Display.targetId, $Display.devicePath)
}

Assert-Administrator
$bindingInstallMutex = [Threading.Mutex]::new($false, 'Global\PixelBrightnessInstaller')
$bindingInstallMutexHeld = $false
try {
  $bindingInstallMutexHeld = $bindingInstallMutex.WaitOne(0)
} catch [Threading.AbandonedMutexException] {
  $bindingInstallMutexHeld = $true
}
if (-not $bindingInstallMutexHeld) {
  $bindingInstallMutex.Dispose()
  throw 'A Pixel Brightness install or display binding transaction is already running; no binding state was changed.'
}
try {
if ([string]::IsNullOrWhiteSpace($SenderName) -or $SenderName.Length -gt 255) {
  throw 'SenderName must contain 1-255 characters.'
}

$null = Assert-PixelBrightnessUpgradeLauncherGate -DataRoot $DataRoot -Role Show
$priorBindingTransaction = Read-PixelBrightnessDisplayBindingTransactionGate $DataRoot
if ($null -ne $priorBindingTransaction) {
  Write-Warning "An interrupted display binding transaction remains active ($($priorBindingTransaction.transactionId)); this run will resume only its exact protected A-to-B intent."
}
$currentFile = Join-Path $DataRoot 'current-release.txt'
if (-not (Test-Path -LiteralPath $currentFile)) { throw "Current release pointer is missing: $currentFile" }
$null = Assert-PixelBrightnessControlPlane -DataRoot $DataRoot -IncludeSystemDirectories
$trustedInstallation = Read-TrustedPixelBrightnessBindingInstallation $DataRoot
$releaseRoot = (Get-Content -LiteralPath $currentFile -Raw).Trim()
$releaseRoot = Assert-AdminProtectedReleaseLocation $releaseRoot
$null = Assert-PixelBrightnessReleaseManifest $releaseRoot
$renderer = Assert-NativeBundle $releaseRoot
$showTask = Get-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction SilentlyContinue
if (-not $showTask) {
  throw 'PixelBrightness-Show scheduled task is missing. Re-run the installer; no config was changed.'
}
if ($showTask.State -eq 'Running' -and $null -eq $priorBindingTransaction) {
  throw 'PixelBrightness-Show is running. Stop that task before rebinding physical projector targets; no config was changed.'
}
$showUser = [string]$showTask.Principal.UserId
if ([string]::IsNullOrWhiteSpace($showUser)) {
  throw 'PixelBrightness-Show has no interactive principal. Re-run the installer; no config was changed.'
}
$activeRenderers = @(Get-Process 'pixel-brightness-renderer' -ErrorAction SilentlyContinue)
if ($null -ne $priorBindingTransaction) {
  if (-not [string]::Equals(
    [IO.Path]::GetFullPath([string]$priorBindingTransaction.releaseRoot).TrimEnd('\'),
    [IO.Path]::GetFullPath($releaseRoot).TrimEnd('\'),
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw 'Interrupted binding transaction names a different release. Show remains gated; do not upgrade or clear the gate manually.'
  }
  $recoveryNode = Get-Content -LiteralPath ([string]$priorBindingTransaction.generation.NodePath) -Raw -ErrorAction Stop |
    ConvertFrom-Json -ErrorAction Stop
  if ([string]$recoveryNode.nodeId -cne [string]$priorBindingTransaction.nodeId -or
      [string]$priorBindingTransaction.binding.nodeId -cne [string]$priorBindingTransaction.nodeId -or
      $null -eq $priorBindingTransaction.binding.PSObject.Properties['preserveSpatial']) {
    throw 'Interrupted binding transaction Node/binding identity is inconsistent; Show remains gated.'
  }
  $recoveryServerBaseUrl = ([string]$recoveryNode.serverUrl).Trim().TrimEnd('/')
  if ([string]$recoveryNode.nodeId -cne [string]$trustedInstallation.NodeId -or
      $recoveryServerBaseUrl -cne [string]$trustedInstallation.ServerBaseUrl) {
    throw 'Interrupted binding transaction differs from the trusted installation identity; Show remains gated and no control bearer was sent.'
  }
  $recoveryServerBaseUrl = [string]$trustedInstallation.ServerBaseUrl
  $recoveryControlToken = Read-OperatorControlToken $DataRoot $ControlTokenFile
  $recoveryBarrier = $null
  try {
    $recoveryBarrier = Enter-PixelBrightnessReleaseLaunchBarrier
    Stop-PixelBrightnessShowBehindBindingGate -DataRoot $DataRoot `
      -TransactionId ([string]$priorBindingTransaction.transactionId)
    Invoke-DisplayBindingFaultInjection 'after-show-disable'
  } finally {
    if ($null -ne $recoveryBarrier) { Exit-PixelBrightnessReleaseLaunchBarrier $recoveryBarrier }
  }
  $recoveredCommit = Complete-PixelBrightnessDisplayBindingTransaction -DataRoot $DataRoot `
    -ShowUser $showUser -Gate $priorBindingTransaction -ControlToken $recoveryControlToken `
    -ServerBaseUrl $recoveryServerBaseUrl `
    -PreserveSpatial ([bool]$priorBindingTransaction.binding.preserveSpatial)
  Write-Host "Recovered exact display binding transaction $($priorBindingTransaction.transactionId)." -ForegroundColor Green
  if ($StartShow) {
    Start-ScheduledTask -TaskName 'PixelBrightness-Show'
    Write-Host 'PixelBrightness-Show started after exact transaction recovery.' -ForegroundColor Yellow
  }
  return
}
if ($activeRenderers.Count -gt 0) {
  throw "Found $($activeRenderers.Count) active live/orphan renderer process(es). Close them before binding; no config was changed."
}

$inventoryPath = Join-Path $DataRoot 'state\windows-display-inventory.json'
Assert-RealFileDestination $inventoryPath
$inventoryTemporary = "$inventoryPath.$([guid]::NewGuid().ToString('N')).tmp"
$inventoryBytes = $null
try {
  $enumerationArgs = "--list-displays-file `"$inventoryTemporary`""
  $enumeration = Start-Process -FilePath $renderer -ArgumentList $enumerationArgs -Wait -PassThru
  if ($enumeration.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $inventoryTemporary -PathType Leaf)) {
    throw 'The native renderer could not enumerate Windows display targets.'
  }
  $inventory = Get-Content -LiteralPath $inventoryTemporary -Raw | ConvertFrom-Json
  $displays = @($inventory | Where-Object { $_.active -eq $true })
  foreach ($display in $displays) { Assert-DisplayDescriptor $display }
  $inventoryItem = Assert-PixelBrightnessPlainFile $inventoryTemporary 'Windows display inventory candidate'
  if ($null -eq $inventoryItem) { throw 'Windows display inventory candidate disappeared before publication.' }
  # Keep enumeration private until the durable transaction gate is active.
  # The inventory is diagnostic rather than boot authority, but publishing it
  # after the gate keeps every persistent A-to-B boundary unambiguous.
  $inventoryBytes = [IO.File]::ReadAllBytes($inventoryItem.FullName)
} finally {
  if (Test-Path -LiteralPath $inventoryTemporary) { Remove-Item -LiteralPath $inventoryTemporary -Force }
}
if ($displays.Count -eq 0) { throw 'Windows reports no active physical display targets.' }

Write-Host 'Active Windows display targets:' -ForegroundColor Cyan
foreach ($display in $displays) { Write-Host ("  " + (DisplayLabel $display)) }

$selected = @()
if ($GdiName.Count -gt 0) {
  foreach ($name in $GdiName) {
    $match = @($displays | Where-Object { $_.gdiName -ieq $name })
    if ($match.Count -ne 1) { throw "Display selector is missing or ambiguous: $name" }
    $selected += $match[0]
  }
} elseif ($AutoSelect) {
  $nonPrimary = @($displays | Where-Object {
    -not ($_.desktopRect.left -eq 0 -and $_.desktopRect.top -eq 0)
  })
  $groups = @($nonPrimary | Group-Object adapterLuid | Where-Object { $_.Count -ge $OutputCount })
  if ($groups.Count -ne 1) {
    throw 'AutoSelect is ambiguous. Pass the exact projector -GdiName values shown above; no config was changed.'
  }
  $selected = @($groups[0].Group | Sort-Object { $_.desktopRect.left }, { $_.desktopRect.top } | Select-Object -First $OutputCount)
} else {
  Write-PixelBrightnessAtomicBytes $inventoryPath $inventoryBytes
  $exampleNames = @($displays | ForEach-Object {
    $escapedName = ([string]$_.gdiName).Replace("'", "''")
    "'{0}'" -f $escapedName
  }) -join ','
  Write-Host "Display inventory saved successfully to $inventoryPath." -ForegroundColor Green
  Write-Host 'Inventory-only mode made no configuration changes. Remove the monitor name, order the projector names left-to-right, then run:' -ForegroundColor Yellow
  Write-Host ("  & `"{0}`" -GdiName {1}" -f $PSCommandPath, $exampleNames) -ForegroundColor Cyan
  return
}

if ($selected.Count -lt 1 -or $selected.Count -gt 16) { throw 'Select between 1 and 16 projector displays.' }
if (@($selected | Group-Object gdiName | Where-Object Count -gt 1).Count -gt 0) { throw 'The same display was selected more than once.' }
if (@($selected | Group-Object adapterLuid).Count -ne 1) { throw 'Every overlapping projector must be on the same GPU adapter.' }
if (@($selected | Group-Object width,height,refreshNum,refreshDen).Count -ne 1) {
  throw 'Every selected projector must use the same exact resolution and rational refresh rate.'
}

$width = [int]$selected[0].width
$height = [int]$selected[0].height
if ($Overlap -ge $width) { throw "Overlap must be smaller than projector width $width." }
$localSpanWidth = $width + (($selected.Count - 1) * ($width - $Overlap))
if (($SourceOffsetX -gt 0 -and $CanvasWidth -eq 0) -or ($SourceOffsetY -gt 0 -and $CanvasHeight -eq 0)) {
  throw 'Source offsets require an explicit shared -CanvasWidth and -CanvasHeight so every node addresses the same master composition.'
}
$canvasWidth = $(if ($CanvasWidth -gt 0) { $CanvasWidth } else { $localSpanWidth })
$canvasHeight = $(if ($CanvasHeight -gt 0) { $CanvasHeight } else { $height })
if ($canvasWidth -gt 16384 -or $canvasHeight -gt 16384) {
  throw "Master canvas ${canvasWidth}x${canvasHeight} exceeds the D3D11/Spout 16384-pixel texture limit; no config was changed."
}
if ($SourceOffsetX + $localSpanWidth -gt $canvasWidth -or $SourceOffsetY + $height -gt $canvasHeight) {
  throw "This node's ${localSpanWidth}x${height} projector area at ${SourceOffsetX},${SourceOffsetY} falls outside the shared ${canvasWidth}x${canvasHeight} master canvas."
}
$canvas = [ordered]@{ width = $canvasWidth; height = $canvasHeight; frameRateNum = [int]$selected[0].refreshNum; frameRateDen = [int]$selected[0].refreshDen }
$source = [ordered]@{
  type = 'spout'; senderName = $SenderName; width = $canvasWidth; height = $canvasHeight
  frameRateNum = $canvas.frameRateNum; frameRateDen = $canvas.frameRateDen
  acceptedFormats = @('DXGI_FORMAT_R16G16B16A16_FLOAT', 'DXGI_FORMAT_R8G8B8A8_UNORM', 'DXGI_FORMAT_B8G8R8A8_UNORM')
  colorEncoding = 'srgb'; alphaMode = 'ignore'; timeoutMs = 500; startupGraceMs = 10000
  onMissing = 'black'; onMismatch = 'black'; allowAutoSelect = $false
}

$nodePath = Join-Path $DataRoot 'config\node.json'
$rendererPath = Join-Path $DataRoot 'config\renderer.json'
$bindingPath = Join-Path $DataRoot 'config\display-binding.json'
foreach ($configPath in @($nodePath, $rendererPath, $bindingPath)) {
  Assert-RealFileDestination $configPath
}
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw "Node config is missing: $nodePath" }
$authorityNodePath = $nodePath
$priorBindingCommit = Read-PixelBrightnessDisplayBindingCommit $DataRoot
if ($null -ne $priorBindingCommit -and [string]::Equals(
  [IO.Path]::GetFullPath([string]$priorBindingCommit.releaseRoot).TrimEnd('\'),
  [IO.Path]::GetFullPath($releaseRoot).TrimEnd('\'),
  [StringComparison]::OrdinalIgnoreCase
)) {
  $authorityNodePath = [string]$priorBindingCommit.generation.NodePath
}
$node = Get-Content -LiteralPath $authorityNodePath -Raw | ConvertFrom-Json
$nodeId = [string]$trustedInstallation.NodeId
$serverBaseUrl = [string]$trustedInstallation.ServerBaseUrl
$candidateServerBaseUrl = ([string]$node.serverUrl).Trim().TrimEnd('/')
if ([string]$node.nodeId -cne $nodeId -or $candidateServerBaseUrl -cne $serverBaseUrl) {
  throw 'Candidate Node config differs from the protected installation identity; no control bearer was sent. Re-run the installer or restore the committed binding generation.'
}
$operatorControlToken = Read-OperatorControlToken $DataRoot $ControlTokenFile
$existingServerProject = Get-PixelServerProject $operatorControlToken $serverBaseUrl
$existingLocalOutputs = @($existingServerProject.outputs | Where-Object {
  [string]$_.nodeId -eq $nodeId
})
$otherServerOutputs = @($existingServerProject.outputs | Where-Object {
  -not [string]::IsNullOrWhiteSpace([string]$_.nodeId) -and [string]$_.nodeId -ne $nodeId
})
$preserveSpatial = -not $ResetSpatialConfig -and $existingLocalOutputs.Count -gt 0
if ($preserveSpatial -and $existingLocalOutputs.Count -ne $selected.Count) {
  throw "Authoritative Server has $($existingLocalOutputs.Count) output(s) for $nodeId but $($selected.Count) target(s) were selected. Topology was not changed. Rebind the same targets or use -ResetSpatialConfig intentionally."
}
if ($otherServerOutputs.Count -gt 0 -or $preserveSpatial) {
  foreach ($property in @('width', 'height', 'frameRateNum', 'frameRateDen')) {
    if ([int64]$existingServerProject.canvas.$property -ne [int64]$canvas.$property) {
      throw "Every Windows node in one project must publish the same master canvas; authoritative canvas $property differs from this bind request. Spatial calibration was not changed; use the exact existing canvas or -ResetSpatialConfig only when no other node depends on it."
    }
  }
  if ([string]$existingServerProject.compositionSource.senderName -ne $SenderName) {
    throw 'Every Windows node in one project must publish the same exact Spout sender name. No config was changed.'
  }
}
if ($preserveSpatial) {
  foreach ($property in @('width', 'height')) {
    if ([int64]$existingServerProject.compositionSource.$property -ne [int64]$source.$property) {
      throw "The authoritative composition source $property is incompatible with this bind request. Spatial calibration was not changed."
    }
  }
}
if ($ResetSpatialConfig -and $existingLocalOutputs.Count -gt 0) {
  Write-Warning "-ResetSpatialConfig will replace the $($existingLocalOutputs.Count) authoritative spatial/optical output calibration(s) for node $nodeId with identity/default values."
}

$outputs = [System.Collections.Generic.List[object]]::new()
$matchedOutputIds = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
for ($index = 0; $index -lt $selected.Count; $index += 1) {
  $display = $selected[$index]
  $label = [char]([int][char]'A' + $index)
  $existingOutput = $null
  if ($preserveSpatial) {
    # A stable Windows device path is the primary calibration identity.
    $pathMatches = @($existingLocalOutputs | Where-Object {
      -not $matchedOutputIds.Contains([string]$_.id) -and
      -not [string]::IsNullOrWhiteSpace([string](Get-DisplayProperty $_ 'devicePath')) -and
      [string](Get-DisplayProperty $_ 'devicePath') -ieq [string]$display.devicePath
    })
    if ($pathMatches.Count -gt 1) { throw "Authoritative Server has duplicate devicePath matches for $($display.devicePath). No config was changed." }
    if ($pathMatches.Count -eq 1) { $existingOutput = $pathMatches[0] }

    # Windows can rebuild a device interface path after a driver update. The
    # adapter LUID + target id pair is the next stable, unique physical match.
    if ($null -eq $existingOutput) {
      $targetMatches = @($existingLocalOutputs | Where-Object {
        -not $matchedOutputIds.Contains([string]$_.id) -and
        -not [string]::IsNullOrWhiteSpace([string](Get-DisplayProperty $_ 'adapterLuid')) -and
        $null -ne (Get-DisplayProperty $_ 'targetId') -and
        [string](Get-DisplayProperty $_ 'adapterLuid') -ieq [string]$display.adapterLuid -and
        [int64](Get-DisplayProperty $_ 'targetId') -eq [int64]$display.targetId
      })
      if ($targetMatches.Count -gt 1) { throw "Authoritative Server has duplicate adapter/target matches for $($display.gdiName). No config was changed." }
      if ($targetMatches.Count -eq 1) { $existingOutput = $targetMatches[0] }
    }

    # The final fallback is deterministic only when the operator supplied the
    # exact GDI list in logical A/B/... order. AutoSelect is never allowed to
    # guess which calibrated surface an unmatched projector should inherit.
    if ($null -eq $existingOutput -and $GdiName.Count -gt 0 -and -not $AutoSelect) {
      $expectedId = "$nodeId-$label"
      $idMatches = @($existingLocalOutputs | Where-Object {
        -not $matchedOutputIds.Contains([string]$_.id) -and [string]$_.id -ceq $expectedId
      })
      if ($idMatches.Count -eq 1) { $existingOutput = $idMatches[0] }
    }
    if ($null -eq $existingOutput) {
      throw "Selected target $($display.gdiName) cannot be matched safely to one authoritative calibrated output. Pass the exact -GdiName list in logical order, restore the prior Windows target identity, or use -ResetSpatialConfig intentionally."
    }
    Assert-ExactResolution $existingOutput $display
    Assert-PreservedSpatialConfig $existingOutput $canvas
    if (-not $matchedOutputIds.Add([string]$existingOutput.id)) {
      throw "Authoritative output $($existingOutput.id) would be assigned to more than one Windows target. No config was changed."
    }
    $preservedName = [string](Get-PropertyValue $existingOutput 'name')
    if ([string]::IsNullOrWhiteSpace($preservedName)) { $preservedName = "Projector $label" }
    $preservedWallId = [string](Get-PropertyValue $existingOutput 'wallId')
    if ([string]::IsNullOrWhiteSpace($preservedWallId)) { $preservedWallId = "$nodeId-wall" }
    $outputs.Add([ordered]@{
      id = [string]$existingOutput.id
      name = $preservedName
      connector = [string]$display.devicePath
      nodeId = $nodeId
      enabled = $true
      wallId = $preservedWallId
      display = [ordered]@{
        devicePath = [string]$display.devicePath
        gdiName = [string]$display.gdiName
        adapterLuid = [string]$display.adapterLuid
        targetId = [int64]$display.targetId
      }
      resolution = [ordered]@{ width = $width; height = $height; refreshNum = [int]$display.refreshNum; refreshDen = [int]$display.refreshDen }
      sourceViewport = $existingOutput.sourceViewport
      overlap = $existingOutput.overlap
      warp = $existingOutput.warp
      blend = $existingOutput.blend
      blackUniformity = $existingOutput.blackUniformity
      color = $existingOutput.color
      mask = $existingOutput.mask
      processing = $existingOutput.processing
    })
  } else {
    $id = "$nodeId-$label"
    $outputs.Add([ordered]@{
      id = [string]$id
      name = "Projector $label"
      connector = [string]$display.devicePath
      nodeId = $nodeId
      enabled = $true
      wallId = "$nodeId-wall"
      display = [ordered]@{
        devicePath = [string]$display.devicePath
        gdiName = [string]$display.gdiName
        adapterLuid = [string]$display.adapterLuid
        targetId = [int64]$display.targetId
      }
      resolution = [ordered]@{ width = $width; height = $height; refreshNum = [int]$display.refreshNum; refreshDen = [int]$display.refreshDen }
      sourceViewport = [ordered]@{ x = $SourceOffsetX + ($index * ($width - $Overlap)); y = $SourceOffsetY; width = $width; height = $height }
      overlap = [ordered]@{ left = $(if ($index -gt 0) { $Overlap } else { 0 }); right = $(if ($index -lt $selected.Count - 1) { $Overlap } else { 0 }); top = 0; bottom = 0 }
      warp = New-IdentityMesh
      blend = [ordered]@{ enabled = $true; feather = 0.78; gamma = 2.2; map = $null }
      blackUniformity = [ordered]@{ enabled = $false; lift = 0.0; map = $null }
      color = [ordered]@{ gain = @(1.0, 1.0, 1.0); offset = @(0.0, 0.0, 0.0); gamma = @(1.0, 1.0, 1.0); lut = $null }
      mask = [ordered]@{ enabled = $false; map = $null; path = $null; softness = 0.0 }
      processing = [ordered]@{ bypass = $false; order = @('sourceViewport', 'warp', 'blend', 'blackUniformity', 'color', 'mask') }
    })
  }
}
if ($preserveSpatial -and $matchedOutputIds.Count -ne $existingLocalOutputs.Count) {
  throw 'Not every authoritative calibrated output was matched to one selected Windows target. Topology was not changed.'
}

$node.canvas = $canvas
$node.compositionSource = $source
$node.outputs = @($outputs)
$node | Add-Member -NotePropertyName adapterLuid -NotePropertyValue ([string]$selected[0].adapterLuid) -Force

$existingRevision = [int64]0
if (Test-Path -LiteralPath $rendererPath -PathType Leaf) {
  $existingRenderer = Get-Content -LiteralPath $rendererPath -Raw | ConvertFrom-Json
  if ($null -ne $existingRenderer.revision) { $existingRevision = [int64]$existingRenderer.revision }
}
$clockRevision = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$revision = [int64][Math]::Max($clockRevision, $existingRevision + 1)
$pipeProperty = $node.PSObject.Properties['rendererPipe']
$pipeName = if ($pipeProperty) { [string]$pipeProperty.Value } else { '' }
if ([string]::IsNullOrWhiteSpace($pipeName)) {
  $pipeName = "\\.\pipe\pixel-brightness-renderer-$nodeId"
}
if ($pipeName -notmatch '^\\\\\.\\pipe\\pixel-brightness-renderer-[A-Za-z0-9_.-]+$') {
  throw 'Installed rendererPipe is outside the Pixel Brightness named-pipe namespace.'
}
$nativeOutputs = @($outputs | ForEach-Object {
  [ordered]@{
    id = $_.id; enabled = $_.enabled; display = $_.display
    resolution = $_.resolution; sourceViewport = $_.sourceViewport; processing = $_.processing; overlap = $_.overlap
    warp = $_.warp; blend = $_.blend; blackUniformity = $_.blackUniformity
    color = $_.color; mask = $_.mask
  }
})
$rendererConfig = [ordered]@{
  schemaVersion = 1; revision = $revision; nodeId = $nodeId
  adapterLuid = [string]$selected[0].adapterLuid; pipeName = $pipeName; vsync = $true; topmost = $true
  telemetry = [ordered]@{ path = (Join-Path $DataRoot 'config\renderer-status.json'); intervalMs = 1000 }
  canvas = $canvas; compositionSource = $source; outputs = $nativeOutputs
}
$bindingOutputs = @($outputs | ForEach-Object {
  [ordered]@{
    id = $_.id
    devicePath = $_.display.devicePath
    gdiName = $_.display.gdiName
    adapterLuid = $_.display.adapterLuid
    targetId = $_.display.targetId
  }
})
$nodeConfigBytes = ConvertTo-PixelBrightnessUtf8JsonBytes $node 40
$rendererConfigBytes = ConvertTo-PixelBrightnessUtf8JsonBytes $rendererConfig 40
$nodeConfigSha256 = Get-PixelBrightnessSha256 $nodeConfigBytes
$rendererConfigSha256 = Get-PixelBrightnessSha256 $rendererConfigBytes
$outputSelectorsSha256 = Get-PixelBrightnessDisplayOutputSelectorsSha256 $bindingOutputs
$serverProjectId = [string]$existingServerProject.id
$serverProjectBaseRevision = [int64]$existingServerProject.revision
if ([string]::IsNullOrWhiteSpace($serverProjectId) -or $serverProjectId.Length -gt 128 -or
    $serverProjectBaseRevision -lt 1 -or $serverProjectBaseRevision -ge 9007199254740991) {
  throw 'The authoritative Server project identity or revision cannot be committed safely.'
}
$serverProjectRevision = $serverProjectBaseRevision + 1
$bindingTransactionId = [guid]::NewGuid().ToString('D')
$bindingGenerationRoot = Get-PixelBrightnessDisplayBindingGenerationRoot $DataRoot $bindingTransactionId
$bindingAuthorityNodePath = Join-Path $bindingGenerationRoot 'node.json'
$bindingRendererSnapshotPath = Join-Path $bindingGenerationRoot 'renderer.json'
$bindingTargetProjectPath = Join-Path $bindingGenerationRoot 'target-project.json'
$sourceLeft = [double](($outputs | ForEach-Object { [double]$_.sourceViewport.x } | Measure-Object -Minimum).Minimum)
$sourceTop = [double](($outputs | ForEach-Object { [double]$_.sourceViewport.y } | Measure-Object -Minimum).Minimum)
$sourceRight = [double](($outputs | ForEach-Object { [double]$_.sourceViewport.x + [double]$_.sourceViewport.width } | Measure-Object -Maximum).Maximum)
$sourceBottom = [double](($outputs | ForEach-Object { [double]$_.sourceViewport.y + [double]$_.sourceViewport.height } | Measure-Object -Maximum).Maximum)
$binding = [ordered]@{
  schemaVersion = 2
  valid = $true
  transactionId = $bindingTransactionId
  releaseRoot = $releaseRoot
  generationRoot = $bindingGenerationRoot
  nodeConfigPath = $bindingAuthorityNodePath
  rendererBindSnapshotPath = $bindingRendererSnapshotPath
  rendererCachePath = $rendererPath
  targetProjectPath = $bindingTargetProjectPath
  boundAt = [DateTimeOffset]::UtcNow.ToString('o')
  nodeId = $nodeId
  pipeName = $pipeName
  adapterLuid = [string]$selected[0].adapterLuid
  rendererRevision = $revision
  serverProjectId = $serverProjectId
  serverProjectBaseRevision = $serverProjectBaseRevision
  serverProjectRevision = $serverProjectRevision
  serverProjectSha256 = $null
  nodeConfigSha256 = $nodeConfigSha256
  rendererConfigSha256 = $rendererConfigSha256
  outputSelectorsSha256 = $outputSelectorsSha256
  preserveSpatial = [bool]$preserveSpatial
  canvas = $canvas
  compositionSource = [ordered]@{ senderName = $SenderName; width = $canvasWidth; height = $canvasHeight }
  sourceArea = [ordered]@{ x = $sourceLeft; y = $sourceTop; width = $sourceRight - $sourceLeft; height = $sourceBottom - $sourceTop }
  outputs = $bindingOutputs
  backupPath = $null
}
$mergedWalls = @($existingServerProject.walls)
$requiredWallIds = @($outputs | ForEach-Object { [string]$_.wallId } | Where-Object { $_ } | Select-Object -Unique)
$freshSurfaceLayout = $(if ($selected.Count -ge 2 -and $Overlap -gt 0) { 'horizontal' } else { 'independent' })
foreach ($requiredWallId in $requiredWallIds) {
  if (@($mergedWalls | Where-Object { [string]$_.id -ceq $requiredWallId }).Count -eq 0) {
    $newWall = [ordered]@{ id = $requiredWallId; name = $(if ($requiredWallId -ceq "$nodeId-wall") { "$nodeId wall" } else { $requiredWallId }) }
    # Only fresh/reset outputs have spatial defaults authored by this binder.
    # A preserved surface record (including a legacy record without layout) is
    # authoritative and is never migrated or rewritten here.
    if (-not $preserveSpatial) { $newWall['layout'] = $freshSurfaceLayout }
    $mergedWalls += $newWall
  }
}
if ($mergedWalls.Count -gt 128) {
  throw 'The bound project would exceed the Server wall limit; no transaction was started.'
}
$mergedOutputs = @($otherServerOutputs) + @($outputs)
if ($mergedOutputs.Count -gt 256 -or
    @($mergedOutputs | Group-Object id | Where-Object Count -gt 1).Count -gt 0) {
  throw 'The bound project would exceed the Server output limit or contain duplicate output ids; no transaction was started.'
}
$mergedOutputIds = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($mergedOutput in $mergedOutputs) { $null = $mergedOutputIds.Add([string]$mergedOutput.id) }
$normalizedTimelineCues = @($existingServerProject.timeline.cues | ForEach-Object {
  [ordered]@{
    id = [string]$_.id
    assetSha256 = $(if ($null -eq $_.assetSha256) { $null } else { [string]$_.assetSha256 })
    startFrame = [int64]$_.startFrame
    durationFrames = [int64]$_.durationFrames
    loop = [bool]$_.loop
    # Match normalizeProject before hashing intended B: removed output ids are
    # not retained by the Server when an explicit reset changes topology.
    outputIds = @($_.outputIds | ForEach-Object { [string]$_ } | Where-Object { $mergedOutputIds.Contains($_) })
  }
})
$serverProject = [ordered]@{
  protocolVersion = 1
  id = $serverProjectId
  revision = $serverProjectRevision
  name = [string]$existingServerProject.name
  canvas = $canvas
  compositionSource = $source
  walls = $mergedWalls
  outputs = $mergedOutputs
  timeline = [ordered]@{ cues = $normalizedTimelineCues }
  updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
}
$baseProjectBytes = ConvertTo-PixelBrightnessUtf8JsonBytes -Value $existingServerProject -Depth 50 -Compress
$targetProjectBytes = ConvertTo-PixelBrightnessUtf8JsonBytes -Value $serverProject -Depth 50 -Compress
$baseProjectSha256 = Get-PixelBrightnessServerProjectAuthoritySha256 $existingServerProject
$targetProjectSha256 = Get-PixelBrightnessServerProjectAuthoritySha256 $serverProject
$binding['serverProjectSha256'] = $targetProjectSha256
$bindingBytes = ConvertTo-PixelBrightnessUtf8JsonBytes -Value $binding -Depth 30
$bindingSha256 = Get-PixelBrightnessSha256 $bindingBytes

if (-not $PSCmdlet.ShouldProcess("$nodePath, $rendererPath, $bindingPath and Pixel Server project", "Bind $($selected.Count) stable projector targets")) {
  Write-Warning 'Display binding was not committed; no Show task was enabled.'
  return
}
$backupPath = $null
$candidateGeneration = Write-PixelBrightnessDisplayBindingCandidate -DataRoot $DataRoot `
  -ShowUser $showUser -TransactionId $bindingTransactionId `
  -NodeBytes $nodeConfigBytes -RendererBytes $rendererConfigBytes `
  -BaseProjectBytes $baseProjectBytes -TargetProjectBytes $targetProjectBytes `
  -BindingBytes $bindingBytes
$releaseLaunchBarrier = $null
$bindingGate = $null
try {
  # Global ordering is installer/display-binder mutex -> release launch
  # barrier. Candidate bytes are inert under a protected generation; this
  # write-through gate is the first live A-to-B authority mutation.
  $releaseLaunchBarrier = Enter-PixelBrightnessReleaseLaunchBarrier
  Assert-NoPixelBrightnessShowProcessTrees -DataRoot $DataRoot
  $bindingGate = Write-PixelBrightnessDisplayBindingTransactionGate `
    -DataRoot $DataRoot -ShowUser $showUser -TransactionId $bindingTransactionId `
    -NodeId $nodeId -ProjectId $serverProjectId `
    -BaseRevision $serverProjectBaseRevision -TargetRevision $serverProjectRevision `
    -ReleaseRoot $releaseRoot -GenerationRoot $candidateGeneration.Root `
    -BaseProjectSha256 $baseProjectSha256 -TargetProjectSha256 $targetProjectSha256 `
    -NodeConfigSha256 $nodeConfigSha256 -RendererConfigSha256 $rendererConfigSha256 `
    -OutputSelectorsSha256 $outputSelectorsSha256 -BindingSha256 $bindingSha256
  Invoke-DisplayBindingFaultInjection 'after-in-progress-gate'
  Stop-PixelBrightnessShowBehindBindingGate -DataRoot $DataRoot -TransactionId $bindingTransactionId
  Invoke-DisplayBindingFaultInjection 'after-show-disable'
} catch {
  $gateFailure = $_.Exception.Message
  $gatePathExists = Test-Path -LiteralPath (Get-PixelBrightnessDisplayBindingTransactionGatePath $DataRoot)
  if ($gatePathExists -and $null -ne $releaseLaunchBarrier) {
    # Assignment can fail after the atomic gate name is already durable (for
    # example during its read-back audit). While the barrier is still held,
    # quiesce so an unreadable but durably published gate cannot leave a
    # process alive. Pre-gate proof failures perform no local mutation.
    try {
      Disable-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop | Out-Null
      Stop-PixelBrightnessTaskForRollback 'PixelBrightness-Show'
      Stop-PixelBrightnessRacedShowLaunchProcessTrees -DataRoot $DataRoot
    } catch {
      throw "Display binding gate publication failed and Show quiescence could not be proven: $gateFailure; $($_.Exception.Message)"
    }
  }
  if ($gatePathExists) {
    throw "Display binding gate/quiescence failed; its durable gate remains and Show must stay black: $gateFailure"
  }
  throw
} finally {
  if ($null -ne $releaseLaunchBarrier) {
    Exit-PixelBrightnessReleaseLaunchBarrier $releaseLaunchBarrier
  }
}

# From this point onward every failure is behind the exact durable gate. The
# diagnostic inventory and backup can therefore never create a runnable mixed
# generation at a power boundary.
Write-PixelBrightnessAtomicBytes $inventoryPath $inventoryBytes
$backupPath = Export-RebindBackup $DataRoot $nodeId $showUser $existingServerProject `
  @($selected) ([bool]$ResetSpatialConfig) @($nodePath, $rendererPath, $bindingPath) $inventoryPath
$bindingCommit = Complete-PixelBrightnessDisplayBindingTransaction -DataRoot $DataRoot `
  -ShowUser $showUser -Gate $bindingGate -ControlToken $operatorControlToken `
  -ServerBaseUrl $serverBaseUrl -PreserveSpatial ([bool]$preserveSpatial)

Write-Host "Bound $($selected.Count) projectors on adapter $($selected[0].adapterLuid)." -ForegroundColor Green
Write-Host "Pre-bind backup: $backupPath"
Write-Host "Arena composition: $SenderName · $canvasWidth x $canvasHeight @ $($canvas.frameRateNum)/$($canvas.frameRateDen)"
for ($index = 0; $index -lt $selected.Count; $index += 1) {
  Write-Host ("  {0}-{1}: {2}" -f $nodeId, [char]([int][char]'A' + $index), (DisplayLabel $selected[$index]))
}
if ($StartShow) {
  $showTask = Get-ScheduledTask -TaskName 'PixelBrightness-Show' -ErrorAction Stop
  if ($showTask.State -eq 'Disabled') {
    throw 'PixelBrightness-Show is still disabled because the display binding was not committed.'
  }
  Start-ScheduledTask -TaskName 'PixelBrightness-Show'
  Write-Host 'PixelBrightness-Show started. Use Identify grid to verify A/B before calibration.' -ForegroundColor Yellow
}
} finally {
  if ($bindingInstallMutexHeld) { $bindingInstallMutex.ReleaseMutex() }
  $bindingInstallMutex.Dispose()
}
