[CmdletBinding()]
param()

Set-StrictMode -Version Latest

# PixelBrightnessUpgradeGateHelperContract:v1
# This stable helper contract is audited before an existing installation may
# cross its first power boundary under the durable upgrade gate.
# PixelBrightnessReleaseLaunchBarrierHelperContract:v1

if ($null -eq ('PixelBrightness.NativeFileDurability' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace PixelBrightness {
  public static class NativeFileDurability {
    public const UInt32 MOVEFILE_REPLACE_EXISTING = 0x00000001;
    public const UInt32 MOVEFILE_WRITE_THROUGH = 0x00000008;
    public const UInt32 GENERIC_READ_WRITE = 0xC0000000;
    public const UInt32 FILE_SHARE_READ_WRITE_DELETE = 0x00000007;
    public const UInt32 OPEN_EXISTING = 3;
    public const UInt32 FILE_FLAG_WRITE_THROUGH = 0x80000000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool MoveFileExW(string existingFileName, string newFileName, UInt32 flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern SafeFileHandle CreateFileW(
      string fileName,
      UInt32 desiredAccess,
      UInt32 shareMode,
      IntPtr securityAttributes,
      UInt32 creationDisposition,
      UInt32 flagsAndAttributes,
      IntPtr templateFile
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FlushFileBuffers(SafeFileHandle fileHandle);
  }
}
'@
}

function Get-PixelBrightnessSha256([byte[]]$Bytes) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
  }
}

function Assert-PixelBrightnessPlainFile([string]$Path, [string]$Label) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($null -eq $item) { return $null }
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label must be a real file, never a directory or reparse point: $Path"
  }
  return $item
}

function Publish-PixelBrightnessWriteThroughFile([string]$Temporary, [string]$Destination) {
  $temporaryFull = [IO.Path]::GetFullPath($Temporary)
  $destinationFull = [IO.Path]::GetFullPath($Destination)
  if (-not [string]::Equals(
    [IO.Path]::GetPathRoot($temporaryFull),
    [IO.Path]::GetPathRoot($destinationFull),
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw 'Atomic publication requires a temporary file on the destination volume.'
  }
  $moveFlags = [PixelBrightness.NativeFileDurability]::MOVEFILE_REPLACE_EXISTING -bor
    [PixelBrightness.NativeFileDurability]::MOVEFILE_WRITE_THROUGH
  if (-not [PixelBrightness.NativeFileDurability]::MoveFileExW($temporaryFull, $destinationFull, $moveFlags)) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw [ComponentModel.Win32Exception]::new($errorCode, "Write-through atomic publication failed: $destinationFull")
  }
  $published = [PixelBrightness.NativeFileDurability]::CreateFileW(
    $destinationFull,
    [PixelBrightness.NativeFileDurability]::GENERIC_READ_WRITE,
    [PixelBrightness.NativeFileDurability]::FILE_SHARE_READ_WRITE_DELETE,
    [IntPtr]::Zero,
    [PixelBrightness.NativeFileDurability]::OPEN_EXISTING,
    [PixelBrightness.NativeFileDurability]::FILE_FLAG_WRITE_THROUGH,
    [IntPtr]::Zero
  )
  if ($null -eq $published -or $published.IsInvalid) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($null -ne $published) { $published.Dispose() }
    throw [ComponentModel.Win32Exception]::new($errorCode, "Published file could not be reopened for durability verification: $destinationFull")
  }
  try {
    if (-not [PixelBrightness.NativeFileDurability]::FlushFileBuffers($published)) {
      $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw [ComponentModel.Win32Exception]::new($errorCode, "FlushFileBuffers failed after atomic publication: $destinationFull")
    }
  } finally {
    $published.Dispose()
  }
  $null = Assert-PixelBrightnessPlainFile $destinationFull 'Published atomic destination'
}

function Write-PixelBrightnessAtomicBytes([string]$Path, [byte[]]$Bytes) {
  $directory = Split-Path $Path -Parent
  if (-not $directory -or -not (Test-Path -LiteralPath $directory -PathType Container)) {
    throw "Atomic destination directory is missing: $directory"
  }
  $directoryItem = Get-Item -LiteralPath $directory -Force -ErrorAction Stop
  if (($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Atomic destination directory is a reparse point: $directory"
  }
  $existing = Assert-PixelBrightnessPlainFile $Path 'Atomic destination'
  $temporary = Join-Path $directory ".$([IO.Path]::GetFileName($Path)).$([guid]::NewGuid().ToString('N')).tmp"
  try {
    $stream = [IO.FileStream]::new(
      $temporary,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None,
      4096,
      [IO.FileOptions]::WriteThrough
    )
    try {
      $stream.Write($Bytes, 0, $Bytes.Length)
      $stream.Flush($true)
    } finally {
      $stream.Dispose()
    }
    # MOVEFILE_WRITE_THROUGH closes the rename/link durability gap left by
    # File.Move/File.Replace. Reopening and calling FlushFileBuffers then
    # proves the published file itself is flushable before a later gate phase,
    # pointer publication, commit record, or gate removal can proceed.
    Publish-PixelBrightnessWriteThroughFile $temporary $Path
  } finally {
    if (Test-Path -LiteralPath $temporary -PathType Leaf) {
      Remove-Item -LiteralPath $temporary -Force
    }
  }
}

function ConvertTo-PixelBrightnessUtf8JsonBytes(
  [object]$Value,
  [int]$Depth = 30,
  [switch]$Compress
) {
  if ($Depth -lt 2 -or $Depth -gt 100) {
    throw 'Pixel Brightness JSON serialization depth is outside its bounded contract.'
  }
  $json = if ($Compress) {
    $Value | ConvertTo-Json -Depth $Depth -Compress
  } else {
    $Value | ConvertTo-Json -Depth $Depth
  }
  return [Text.UTF8Encoding]::new($false).GetBytes($json + "`n")
}

function ConvertTo-PixelBrightnessCanonicalJsonValue([object]$Value) {
  # Every JSON kind receives an outer type tag. Tagging only arrays/numbers
  # would let an ordinary object such as {"$number":"1"} collide with the
  # number 1; tagging objects too makes the representation injective across
  # JSON structure while still normalizing equivalent numeric CLR types.
  if ($null -eq $Value) { return [ordered]@{ '$type' = 'null' } }
  if ($Value -is [string] -or $Value -is [char]) {
    return [ordered]@{ '$type' = 'string'; '$value' = [string]$Value }
  }
  if ($Value -is [bool]) {
    return [ordered]@{ '$type' = 'boolean'; '$value' = [bool]$Value }
  }
  if ($Value -is [byte] -or $Value -is [sbyte] -or $Value -is [int16] -or
      $Value -is [uint16] -or $Value -is [int32] -or $Value -is [uint32] -or
      $Value -is [int64] -or $Value -is [uint64] -or $Value -is [single] -or
      $Value -is [double] -or $Value -is [decimal]) {
    # Pixel Server's JSON Number domain is IEEE-754 double. Decimal conversion
    # loses values beyond 15 significant digits (for example 1 and
    # 1.0000000000000002 can collide), so normalize through double and retain
    # its exact round-trip representation. Validated integer fields remain
    # below Number.MAX_SAFE_INTEGER.
    try { $number = [Convert]::ToDouble($Value, [Globalization.CultureInfo]::InvariantCulture) }
    catch { throw "Number cannot be normalized in canonical Pixel Brightness JSON: $Value" }
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) {
      throw 'Non-finite number cannot enter canonical Pixel Brightness JSON.'
    }
    $numberText = $number.ToString('R', [Globalization.CultureInfo]::InvariantCulture)
    if ($numberText -ceq '-0') { $numberText = '0' }
    # 1, 1.0, Int64(1), and a JSON response parsed as Int32(1) have one
    # semantic digest without colliding with the literal string "1".
    return [ordered]@{ '$type' = 'number'; '$value' = $numberText }
  }
  if ($Value -is [Collections.IDictionary]) {
    $result = [ordered]@{}
    foreach ($key in @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object)) {
      $result[$key] = ConvertTo-PixelBrightnessCanonicalJsonValue $Value[$key]
    }
    return [ordered]@{ '$type' = 'object'; '$value' = $result }
  }
  if ($Value -is [Collections.IEnumerable]) {
    $items = [System.Collections.Generic.List[object]]::new()
    foreach ($item in $Value) {
      $items.Add((ConvertTo-PixelBrightnessCanonicalJsonValue $item))
    }
    # PowerShell functions enumerate returned arrays: [] can collapse to no
    # value and [x] to x. Return the tagged array in a non-enumerated dictionary
    # so empty, singleton, null and scalar structures cannot share a project
    # fingerprint.
    return [ordered]@{ '$type' = 'array'; '$value' = $items.ToArray() }
  }
  $properties = @($Value.PSObject.Properties | Where-Object {
    $_.MemberType -in @('NoteProperty', 'Property', 'AliasProperty', 'ScriptProperty')
  })
  if ($properties.Count -eq 0) {
    throw "Unsupported value in canonical Pixel Brightness JSON: $($Value.GetType().FullName)"
  }
  $object = [ordered]@{}
  foreach ($property in @($properties | Sort-Object Name)) {
    $object[[string]$property.Name] = ConvertTo-PixelBrightnessCanonicalJsonValue $property.Value
  }
  return [ordered]@{ '$type' = 'object'; '$value' = $object }
}

function Get-PixelBrightnessCanonicalJsonSha256([object]$Value) {
  $canonical = ConvertTo-PixelBrightnessCanonicalJsonValue $Value
  $bytes = ConvertTo-PixelBrightnessUtf8JsonBytes -Value $canonical -Depth 100 -Compress
  return Get-PixelBrightnessSha256 $bytes
}

function Get-PixelBrightnessRequiredJsonProperty(
  [object]$Value,
  [string]$Name,
  [string]$Label
) {
  if ($null -eq $Value) { throw "$Label is empty." }
  if ($Value -is [Collections.IDictionary]) {
    if (-not $Value.Contains($Name)) { throw "$Label is missing $Name." }
    return $Value[$Name]
  }
  $property = $Value.PSObject.Properties[$Name]
  if ($null -eq $property) { throw "$Label is missing $Name." }
  return $property.Value
}

function Get-PixelBrightnessServerProjectAuthoritySha256([object]$Project) {
  if ($null -eq $Project) { throw 'Server project authority cannot be empty.' }
  $required = @(
    'protocolVersion', 'id', 'revision', 'name', 'canvas',
    'compositionSource', 'walls', 'outputs', 'timeline'
  )
  $values = [ordered]@{}
  foreach ($name in $required) {
    $values[$name] = Get-PixelBrightnessRequiredJsonProperty $Project $name 'Server project authority'
  }
  # updatedAt is stamped by the Server after the If-Match transaction. Every
  # stable authority field is included, recursively key-sorted, so an ambiguous
  # response can be reconciled without treating selectors or revision alone as
  # proof of the intended project.
  $authority = [ordered]@{
    protocolVersion = $values['protocolVersion']
    id = $values['id']
    revision = $values['revision']
    name = $values['name']
    canvas = $values['canvas']
    compositionSource = $values['compositionSource']
    walls = @($values['walls'])
    outputs = @($values['outputs'])
    timeline = $values['timeline']
  }
  return Get-PixelBrightnessCanonicalJsonSha256 $authority
}

function Get-PixelBrightnessDisplayOutputSelectorsSha256([object[]]$Outputs) {
  $values = @($Outputs)
  if ($values.Count -lt 1 -or $values.Count -gt 16) {
    throw 'Display binding selector set must contain between 1 and 16 outputs.'
  }
  $ids = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $selectors = [System.Collections.Generic.List[object]]::new()
  foreach ($output in $values) {
    foreach ($requiredProperty in @('id', 'devicePath', 'gdiName', 'adapterLuid', 'targetId')) {
      $null = Get-PixelBrightnessRequiredJsonProperty $output $requiredProperty 'Display binding selector'
    }
    $id = [string](Get-PixelBrightnessRequiredJsonProperty $output 'id' 'Display binding selector')
    $devicePath = [string](Get-PixelBrightnessRequiredJsonProperty $output 'devicePath' 'Display binding selector')
    $gdiName = [string](Get-PixelBrightnessRequiredJsonProperty $output 'gdiName' 'Display binding selector')
    $adapterLuid = [string](Get-PixelBrightnessRequiredJsonProperty $output 'adapterLuid' 'Display binding selector')
    $targetId = [int64](Get-PixelBrightnessRequiredJsonProperty $output 'targetId' 'Display binding selector')
    if ([string]::IsNullOrWhiteSpace($id) -or -not $ids.Add($id) -or
        [string]::IsNullOrWhiteSpace($devicePath) -or
        [string]::IsNullOrWhiteSpace($gdiName) -or
        [string]::IsNullOrWhiteSpace($adapterLuid) -or
        $targetId -lt 0 -or $targetId -gt [uint32]::MaxValue) {
      throw 'Display binding contains an invalid or duplicate authoritative output selector.'
    }
    $selectors.Add([ordered]@{
      id = $id
      devicePath = $devicePath
      gdiName = $gdiName
      adapterLuid = $adapterLuid
      targetId = $targetId
    })
  }
  $selectorArray = @($selectors)
  $selectorBytes = ConvertTo-PixelBrightnessUtf8JsonBytes -Value $selectorArray -Depth 8 -Compress
  return Get-PixelBrightnessSha256 $selectorBytes
}

function Get-PixelBrightnessDisplayBindingTransactionRoot([string]$DataRoot) {
  return (Join-Path $DataRoot 'binding-transaction')
}

function Get-PixelBrightnessDisplayBindingTransactionGatePath([string]$DataRoot) {
  return (Join-Path (Get-PixelBrightnessDisplayBindingTransactionRoot $DataRoot) 'in-progress.json')
}

function Get-PixelBrightnessDisplayBindingCommitPath([string]$DataRoot) {
  return (Join-Path (Get-PixelBrightnessDisplayBindingTransactionRoot $DataRoot) 'commit.json')
}

function Get-PixelBrightnessDisplayBindingGenerationRoot(
  [string]$DataRoot,
  [string]$TransactionId
) {
  $TransactionId = Assert-PixelBrightnessUpgradeTransactionId $TransactionId
  return (Join-Path (Join-Path (Get-PixelBrightnessDisplayBindingTransactionRoot $DataRoot) 'generations') $TransactionId)
}

function Assert-PixelBrightnessDisplayBindingGeneration {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][object]$Contract,
    [switch]$RequireCommit
  )
  $transactionId = Assert-PixelBrightnessUpgradeTransactionId ([string]$Contract.transactionId)
  $expectedRoot = [IO.Path]::GetFullPath((Get-PixelBrightnessDisplayBindingGenerationRoot $DataRoot $transactionId)).TrimEnd('\')
  $actualRoot = [IO.Path]::GetFullPath([string]$Contract.generationRoot).TrimEnd('\')
  if (-not [string]::Equals($expectedRoot, $actualRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Display binding generation escaped its protected transaction root.'
  }
  $null = Assert-AdminProtectedDirectoryChain $actualRoot $DataRoot 'Pixel Brightness display binding generation'
  $null = Assert-AdminProtectedControlTree $actualRoot 'Pixel Brightness display binding generation'
  $files = [ordered]@{
    node = 'node.json'
    renderer = 'renderer.json'
    baseProject = 'base-project.json'
    targetProject = 'target-project.json'
    binding = 'binding.json'
  }
  if ($RequireCommit) { $files['commit'] = 'commit.json' }
  $resolved = [ordered]@{}
  foreach ($entry in $files.GetEnumerator()) {
    $path = Join-Path $actualRoot $entry.Value
    $item = Assert-PixelBrightnessPlainFile $path "Display binding generation $($entry.Key)"
    if ($null -eq $item) { throw "Display binding generation file is missing: $path" }
    $resolved[$entry.Key] = $item.FullName
  }
  $commitPath = if ($RequireCommit) { [string]$resolved['commit'] } else { $null }
  return [pscustomobject]@{
    Root = $actualRoot
    NodePath = $resolved.node
    RendererPath = $resolved.renderer
    BaseProjectPath = $resolved.baseProject
    TargetProjectPath = $resolved.targetProject
    BindingPath = $resolved.binding
    CommitPath = $commitPath
  }
}

function Write-PixelBrightnessDisplayBindingCandidate {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$ShowUser,
    [Parameter(Mandatory = $true)][string]$TransactionId,
    [Parameter(Mandatory = $true)][byte[]]$NodeBytes,
    [Parameter(Mandatory = $true)][byte[]]$RendererBytes,
    [Parameter(Mandatory = $true)][byte[]]$BaseProjectBytes,
    [Parameter(Mandatory = $true)][byte[]]$TargetProjectBytes,
    [Parameter(Mandatory = $true)][byte[]]$BindingBytes
  )
  $TransactionId = Assert-PixelBrightnessUpgradeTransactionId $TransactionId
  $root = Get-PixelBrightnessDisplayBindingTransactionRoot $DataRoot
  $generations = Join-Path $root 'generations'
  $generationRoot = Get-PixelBrightnessDisplayBindingGenerationRoot $DataRoot $TransactionId
  $null = Initialize-AdminProtectedDirectory $root $DataRoot $ShowUser 'Pixel Brightness display binding transaction root'
  $null = Initialize-AdminProtectedDirectory $generations $DataRoot $ShowUser 'Pixel Brightness display binding generations root'
  if (Test-Path -LiteralPath $generationRoot) {
    throw "Display binding generation already exists: $generationRoot"
  }
  New-Item -ItemType Directory -Path $generationRoot -ErrorAction Stop | Out-Null
  $null = Protect-AdminControlPath -Path $generationRoot -ShowUser $ShowUser -ShowAccess Read -Label 'Pixel Brightness display binding generation'
  foreach ($file in @(
    @{ Name = 'node.json'; Bytes = $NodeBytes },
    @{ Name = 'renderer.json'; Bytes = $RendererBytes },
    @{ Name = 'base-project.json'; Bytes = $BaseProjectBytes },
    @{ Name = 'target-project.json'; Bytes = $TargetProjectBytes },
    @{ Name = 'binding.json'; Bytes = $BindingBytes }
  )) {
    Write-PixelBrightnessAtomicBytes (Join-Path $generationRoot $file.Name) $file.Bytes
  }
  $null = Protect-AdminControlTree -Path $generationRoot -ShowUser $ShowUser -ShowAccess Read -Label 'Pixel Brightness display binding generation'
  $contract = [pscustomobject]@{ transactionId = $TransactionId; generationRoot = $generationRoot }
  return Assert-PixelBrightnessDisplayBindingGeneration -DataRoot $DataRoot -Contract $contract
}

function Read-PixelBrightnessDisplayBindingTransactionGate([string]$DataRoot) {
  $root = Get-PixelBrightnessDisplayBindingTransactionRoot $DataRoot
  $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction SilentlyContinue
  if ($null -eq $rootItem) { return $null }
  if (-not $rootItem.PSIsContainer -or
      ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Display binding transaction root is not a real directory: $root"
  }
  $null = Assert-AdminProtectedControlTree $root 'Pixel Brightness display binding transaction tree'
  $path = Get-PixelBrightnessDisplayBindingTransactionGatePath $DataRoot
  $item = Assert-PixelBrightnessPlainFile $path 'Pixel Brightness display binding transaction gate'
  if ($null -eq $item) { return $null }
  try {
    $gate = Get-Content -LiteralPath $item.FullName -Raw -ErrorAction Stop |
      ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "Display binding transaction gate is corrupt: $($_.Exception.Message)"
  }
  $properties = @($gate.PSObject.Properties.Name | Sort-Object)
  $expected = @(
    'baseProjectSha256', 'baseRevision', 'bindingSha256', 'generationRoot',
    'nodeConfigSha256', 'nodeId', 'outputSelectorsSha256', 'projectId',
    'releaseRoot', 'rendererConfigSha256', 'schemaVersion', 'startedAt',
    'targetProjectSha256', 'targetRevision', 'transactionId'
  )
  if (Compare-Object $properties $expected) {
    throw 'Display binding transaction gate has unsupported or missing fields.'
  }
  $transactionId = Assert-PixelBrightnessUpgradeTransactionId ([string]$gate.transactionId)
  if ([int]$gate.schemaVersion -ne 2 -or
      [string]$gate.nodeId -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' -or
      [string]::IsNullOrWhiteSpace([string]$gate.projectId) -or
      ([string]$gate.projectId).Length -gt 128 -or
      [int64]$gate.baseRevision -lt 1 -or
      [int64]$gate.targetRevision -ne ([int64]$gate.baseRevision + 1) -or
      [string]::IsNullOrWhiteSpace([string]$gate.releaseRoot) -or
      [string]::IsNullOrWhiteSpace([string]$gate.startedAt)) {
    throw 'Display binding transaction gate contract is invalid.'
  }
  foreach ($digestName in @(
    'baseProjectSha256', 'bindingSha256', 'nodeConfigSha256',
    'outputSelectorsSha256', 'rendererConfigSha256', 'targetProjectSha256'
  )) {
    if ([string]$gate.$digestName -notmatch '^[0-9a-f]{64}$') {
      throw "Display binding transaction gate contains an invalid $digestName digest."
    }
  }
  $gate.transactionId = $transactionId
  $generation = Assert-PixelBrightnessDisplayBindingGeneration -DataRoot $DataRoot -Contract $gate
  $checks = @(
    @{ Path = $generation.NodePath; Digest = [string]$gate.nodeConfigSha256; Label = 'Node candidate' },
    @{ Path = $generation.RendererPath; Digest = [string]$gate.rendererConfigSha256; Label = 'renderer candidate' },
    @{ Path = $generation.BindingPath; Digest = [string]$gate.bindingSha256; Label = 'binding candidate' }
  )
  foreach ($check in $checks) {
    if ((Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes($check.Path))) -cne $check.Digest) {
      throw "$($check.Label) bytes differ from the durable binding transaction gate."
    }
  }
  try {
    $baseProject = Get-Content -LiteralPath $generation.BaseProjectPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $targetProject = Get-Content -LiteralPath $generation.TargetProjectPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $binding = Get-Content -LiteralPath $generation.BindingPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "Display binding transaction generation is corrupt: $($_.Exception.Message)"
  }
  if ((Get-PixelBrightnessServerProjectAuthoritySha256 $baseProject) -cne [string]$gate.baseProjectSha256 -or
      (Get-PixelBrightnessServerProjectAuthoritySha256 $targetProject) -cne [string]$gate.targetProjectSha256 -or
      (Get-PixelBrightnessDisplayOutputSelectorsSha256 @($binding.outputs)) -cne [string]$gate.outputSelectorsSha256) {
    throw 'Display binding transaction semantic authority differs from its durable gate.'
  }
  if ([string]$baseProject.id -cne [string]$gate.projectId -or
      [int64]$baseProject.revision -ne [int64]$gate.baseRevision -or
      [string]$targetProject.id -cne [string]$gate.projectId -or
      [int64]$targetProject.revision -ne [int64]$gate.targetRevision) {
    throw 'Display binding base/target projects do not prove the gated A-to-B revision transition.'
  }
  if ([int]$binding.schemaVersion -ne 2 -or $binding.valid -ne $true -or
      [string]$binding.transactionId -cne $transactionId -or
      [string]$binding.nodeId -cne [string]$gate.nodeId -or
      [string]$binding.serverProjectId -cne [string]$gate.projectId -or
      [int64]$binding.serverProjectBaseRevision -ne [int64]$gate.baseRevision -or
      [int64]$binding.serverProjectRevision -ne [int64]$gate.targetRevision -or
      [string]$binding.serverProjectSha256 -cne [string]$gate.targetProjectSha256 -or
      [string]$binding.nodeConfigSha256 -cne [string]$gate.nodeConfigSha256 -or
      [string]$binding.rendererConfigSha256 -cne [string]$gate.rendererConfigSha256 -or
      [string]$binding.outputSelectorsSha256 -cne [string]$gate.outputSelectorsSha256) {
    throw 'Display binding candidate does not match its exact durable gate contract.'
  }
  $gate | Add-Member -NotePropertyName generation -NotePropertyValue $generation -Force
  $gate | Add-Member -NotePropertyName baseProject -NotePropertyValue $baseProject -Force
  $gate | Add-Member -NotePropertyName targetProject -NotePropertyValue $targetProject -Force
  $gate | Add-Member -NotePropertyName binding -NotePropertyValue $binding -Force
  return $gate
}

function Write-PixelBrightnessDisplayBindingTransactionGate {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$ShowUser,
    [Parameter(Mandatory = $true)][string]$TransactionId,
    [Parameter(Mandatory = $true)][string]$NodeId,
    [Parameter(Mandatory = $true)][string]$ProjectId,
    [Parameter(Mandatory = $true)][int64]$BaseRevision,
    [Parameter(Mandatory = $true)][int64]$TargetRevision,
    [Parameter(Mandatory = $true)][string]$ReleaseRoot,
    [Parameter(Mandatory = $true)][string]$GenerationRoot,
    [Parameter(Mandatory = $true)][string]$BaseProjectSha256,
    [Parameter(Mandatory = $true)][string]$TargetProjectSha256,
    [Parameter(Mandatory = $true)][string]$NodeConfigSha256,
    [Parameter(Mandatory = $true)][string]$RendererConfigSha256,
    [Parameter(Mandatory = $true)][string]$OutputSelectorsSha256,
    [Parameter(Mandatory = $true)][string]$BindingSha256
  )
  $TransactionId = Assert-PixelBrightnessUpgradeTransactionId $TransactionId
  if ($NodeId -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' -or
      [string]::IsNullOrWhiteSpace($ProjectId) -or $ProjectId.Length -gt 128 -or
      $BaseRevision -lt 1 -or $TargetRevision -ne ($BaseRevision + 1) -or
      [string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    throw 'Cannot publish an invalid display binding transaction gate.'
  }
  foreach ($digest in @(
    $BaseProjectSha256, $TargetProjectSha256, $NodeConfigSha256,
    $RendererConfigSha256, $OutputSelectorsSha256, $BindingSha256
  )) {
    if ($digest -notmatch '^[0-9a-f]{64}$') {
      throw 'Cannot publish a display binding gate with an invalid digest.'
    }
  }
  $expectedGenerationRoot = Get-PixelBrightnessDisplayBindingGenerationRoot $DataRoot $TransactionId
  if (-not [string]::Equals(
    [IO.Path]::GetFullPath($GenerationRoot).TrimEnd('\'),
    [IO.Path]::GetFullPath($expectedGenerationRoot).TrimEnd('\'),
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw 'Cannot publish a display binding gate for an unexpected generation root.'
  }
  $root = Get-PixelBrightnessDisplayBindingTransactionRoot $DataRoot
  $null = Initialize-AdminProtectedDirectory $root $DataRoot $ShowUser 'Pixel Brightness display binding transaction root'
  # Protect the parent before creating the atomic temporary. The temporary and
  # its published name therefore inherit a fail-closed ACL even if the process
  # or machine stops before the redundant per-file ACL verification below.
  $null = Protect-AdminControlPath -Path $root -ShowUser $ShowUser -ShowAccess Read -Label 'Pixel Brightness display binding transaction root'
  $path = Get-PixelBrightnessDisplayBindingTransactionGatePath $DataRoot
  $gate = [ordered]@{
    schemaVersion = 2
    transactionId = $TransactionId
    nodeId = $NodeId
    projectId = $ProjectId
    baseRevision = $BaseRevision
    targetRevision = $TargetRevision
    releaseRoot = $ReleaseRoot
    generationRoot = $expectedGenerationRoot
    baseProjectSha256 = $BaseProjectSha256
    targetProjectSha256 = $TargetProjectSha256
    nodeConfigSha256 = $NodeConfigSha256
    rendererConfigSha256 = $RendererConfigSha256
    outputSelectorsSha256 = $OutputSelectorsSha256
    bindingSha256 = $BindingSha256
    startedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
  Write-PixelBrightnessAtomicBytes $path (ConvertTo-PixelBrightnessUtf8JsonBytes $gate 8)
  $null = Protect-AdminControlPath -Path $path -ShowUser $ShowUser -ShowAccess Read -Label 'Pixel Brightness display binding transaction gate'
  $published = Read-PixelBrightnessDisplayBindingTransactionGate $DataRoot
  if ($null -eq $published -or [string]$published.transactionId -cne $TransactionId) {
    throw 'Display binding transaction gate did not persist its exact transaction identity.'
  }
  return $published
}

function Write-PixelBrightnessDisplayBindingCommit {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$ShowUser,
    [Parameter(Mandatory = $true)][object]$Gate
  )
  $transactionId = Assert-PixelBrightnessUpgradeTransactionId ([string]$Gate.transactionId)
  $generation = Assert-PixelBrightnessDisplayBindingGeneration -DataRoot $DataRoot -Contract $Gate
  if ((Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes($generation.BindingPath))) -cne [string]$Gate.bindingSha256) {
    throw 'Display binding candidate changed before commit publication.'
  }
  $generationCommitPath = Join-Path $generation.Root 'commit.json'
  Write-PixelBrightnessAtomicBytes $generationCommitPath ([IO.File]::ReadAllBytes($generation.BindingPath))
  $rootCommitPath = Get-PixelBrightnessDisplayBindingCommitPath $DataRoot
  Write-PixelBrightnessAtomicBytes $rootCommitPath ([IO.File]::ReadAllBytes($generationCommitPath))
  $root = Get-PixelBrightnessDisplayBindingTransactionRoot $DataRoot
  $null = Protect-AdminControlTree -Path $generation.Root -ShowUser $ShowUser -ShowAccess Read -Label 'Pixel Brightness committed display binding generation'
  $null = Protect-AdminControlPath -Path $rootCommitPath -ShowUser $ShowUser -ShowAccess Read -Label 'Pixel Brightness display binding commit'
  $null = Protect-AdminControlPath -Path $root -ShowUser $ShowUser -ShowAccess Read -Label 'Pixel Brightness display binding transaction root'
  $published = Assert-PixelBrightnessPlainFile $rootCommitPath 'Pixel Brightness display binding commit'
  if ($null -eq $published -or
      (Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes($published.FullName))) -cne [string]$Gate.bindingSha256) {
    throw 'Display binding commit did not publish the exact protected candidate bytes.'
  }
  $null = Assert-AdminProtectedControlTree $root 'Pixel Brightness display binding transaction tree'
  return $published.FullName
}

function Read-PixelBrightnessDisplayBindingCommit([string]$DataRoot) {
  $root = Get-PixelBrightnessDisplayBindingTransactionRoot $DataRoot
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { return $null }
  $null = Assert-AdminProtectedDirectoryChain $root $DataRoot 'Pixel Brightness display binding transaction root'
  $null = Assert-AdminProtectedControlTree $root 'Pixel Brightness display binding transaction tree'
  $path = Get-PixelBrightnessDisplayBindingCommitPath $DataRoot
  $item = Assert-PixelBrightnessPlainFile $path 'Pixel Brightness display binding commit'
  if ($null -eq $item) { return $null }
  try { $commit = Get-Content -LiteralPath $item.FullName -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "Pixel Brightness display binding commit is corrupt: $($_.Exception.Message)" }
  if ([int]$commit.schemaVersion -ne 2 -or $commit.valid -ne $true) {
    throw 'Pixel Brightness display binding commit has an unsupported contract.'
  }
  $generation = Assert-PixelBrightnessDisplayBindingGeneration -DataRoot $DataRoot -Contract $commit -RequireCommit
  try {
    $targetProject = Get-Content -LiteralPath $generation.TargetProjectPath -Raw -ErrorAction Stop |
      ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "Protected target Server project is corrupt: $($_.Exception.Message)"
  }
  if ([string]$commit.nodeConfigSha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$commit.rendererConfigSha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$commit.outputSelectorsSha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$commit.serverProjectSha256 -notmatch '^[0-9a-f]{64}$' -or
      (Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes($generation.CommitPath))) -cne
        (Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes($item.FullName))) -or
      (Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes($generation.NodePath))) -cne
        [string]$commit.nodeConfigSha256 -or
      (Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes($generation.RendererPath))) -cne
        [string]$commit.rendererConfigSha256 -or
      (Get-PixelBrightnessServerProjectAuthoritySha256 $targetProject) -cne
        [string]$commit.serverProjectSha256 -or
      (Get-PixelBrightnessDisplayOutputSelectorsSha256 @($commit.outputs)) -cne
        [string]$commit.outputSelectorsSha256) {
    throw 'Root display binding commit differs from its immutable generation commit.'
  }
  $commit | Add-Member -NotePropertyName generation -NotePropertyValue $generation -Force
  $commit | Add-Member -NotePropertyName commitPath -NotePropertyValue $item.FullName -Force
  return $commit
}

function Assert-PixelBrightnessDisplayBindingLauncherGate([string]$DataRoot) {
  try { $gate = Read-PixelBrightnessDisplayBindingTransactionGate $DataRoot }
  catch {
    throw "PixelBrightness-Show startup is blocked by an invalid display binding transaction gate: $($_.Exception.Message)"
  }
  if ($null -ne $gate) {
    throw "PixelBrightness-Show startup is blocked by display binding transaction $($gate.transactionId). Run the binder again as Administrator; never clear this gate manually."
  }
  return $null
}

function Assert-PixelBrightnessDisplayBindingInstallerReady([string]$DataRoot) {
  try { $gate = Read-PixelBrightnessDisplayBindingTransactionGate $DataRoot }
  catch {
    throw "Installer is blocked by an invalid display binding transaction: $($_.Exception.Message)"
  }
  if ($null -ne $gate) {
    throw "Installer is blocked by active display binding transaction $($gate.transactionId). Resume the binder first; upgrading cannot overwrite its durable recovery intent."
  }
  return $null
}

function Remove-PixelBrightnessDisplayBindingTransactionGate(
  [string]$DataRoot,
  [string]$TransactionId
) {
  $TransactionId = Assert-PixelBrightnessUpgradeTransactionId $TransactionId
  $gate = Read-PixelBrightnessDisplayBindingTransactionGate $DataRoot
  if ($null -eq $gate) { throw 'Display binding transaction gate disappeared before final commit.' }
  if ([string]$gate.transactionId -cne $TransactionId) {
    throw 'Display binding transaction gate belongs to a different transaction.'
  }
  $path = Get-PixelBrightnessDisplayBindingTransactionGatePath $DataRoot
  Remove-Item -LiteralPath $path -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $path) {
    throw 'Display binding transaction gate could not be cleared after exact commit.'
  }
}

$script:PixelBrightnessReleaseManifestName = '.pixel-brightness-release-manifest.json'
$script:PixelBrightnessReleaseManifestMaximumBytes = 67108864
$script:PixelBrightnessReleaseManifestMaximumFiles = 200000

function Get-PixelBrightnessFileSha256([string]$Path) {
  $item = Assert-PixelBrightnessPlainFile $Path 'Release payload file'
  if ($null -eq $item) { throw "Release payload file is missing: $Path" }
  $stream = [IO.FileStream]::new(
    $item.FullName,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
  )
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Get-PixelBrightnessReleaseRelativePath([string]$Root, [string]$Path) {
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $pathFull = [IO.Path]::GetFullPath($Path)
  $prefix = $rootFull + '\'
  if (-not $pathFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Release payload escaped its root: $pathFull"
  }
  $relative = $pathFull.Substring($prefix.Length).Replace('\', '/')
  if ([string]::IsNullOrWhiteSpace($relative) -or $relative.StartsWith('/') -or
      $relative.EndsWith('/') -or $relative.Contains('//') -or $relative.Contains('\') -or
      $relative.Contains(':') -or @($relative.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -ne 0) {
    throw "Release payload path is not canonical: $relative"
  }
  return $relative
}

function Get-PixelBrightnessReleaseFiles([string]$ReleaseRoot) {
  $rootItem = Get-Item -LiteralPath $ReleaseRoot -Force -ErrorAction Stop
  if (-not $rootItem.PSIsContainer -or
      ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Release payload root must be a real directory: $ReleaseRoot"
  }
  $files = [System.Collections.Generic.List[object]]::new()
  $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($item in @(Get-NonReparseTree $rootItem.FullName 'Pixel Brightness release payload')) {
    if ($item.PSIsContainer) { continue }
    if ($item -isnot [IO.FileInfo]) {
      throw "Release payload contains a non-regular file: $($item.FullName)"
    }
    $relative = Get-PixelBrightnessReleaseRelativePath $rootItem.FullName $item.FullName
    if (-not $seen.Add($relative)) {
      throw "Release payload contains a case-insensitive duplicate path: $relative"
    }
    $files.Add([pscustomobject]@{ Relative = $relative; Item = $item })
  }
  $payloadFileCount = @($files | Where-Object {
    $_.Relative -cne $script:PixelBrightnessReleaseManifestName
  }).Count
  if ($payloadFileCount -gt $script:PixelBrightnessReleaseManifestMaximumFiles) {
    throw "Release payload exceeds the bounded manifest file count ($payloadFileCount)."
  }
  return @($files | Sort-Object -Property Relative)
}

function Sync-PixelBrightnessPlainFile([string]$Path) {
  $item = Assert-PixelBrightnessPlainFile $Path 'Release durability file'
  if ($null -eq $item) { throw "Release durability file is missing: $Path" }
  if (($item.Attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) {
    $item.Attributes = $item.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
    $item.Refresh()
  }
  $handle = [PixelBrightness.NativeFileDurability]::CreateFileW(
    $item.FullName,
    [PixelBrightness.NativeFileDurability]::GENERIC_READ_WRITE,
    [PixelBrightness.NativeFileDurability]::FILE_SHARE_READ_WRITE_DELETE,
    [IntPtr]::Zero,
    [PixelBrightness.NativeFileDurability]::OPEN_EXISTING,
    [PixelBrightness.NativeFileDurability]::FILE_FLAG_WRITE_THROUGH,
    [IntPtr]::Zero
  )
  if ($null -eq $handle -or $handle.IsInvalid) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($null -ne $handle) { $handle.Dispose() }
    throw [ComponentModel.Win32Exception]::new($errorCode, "Release file could not be opened for durability: $($item.FullName)")
  }
  try {
    if (-not [PixelBrightness.NativeFileDurability]::FlushFileBuffers($handle)) {
      $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw [ComponentModel.Win32Exception]::new($errorCode, "FlushFileBuffers failed for release payload: $($item.FullName)")
    }
  } finally {
    $handle.Dispose()
  }
}

function Sync-PixelBrightnessReleaseTree([string]$ReleaseRoot) {
  foreach ($file in @(Get-PixelBrightnessReleaseFiles $ReleaseRoot)) {
    Sync-PixelBrightnessPlainFile $file.Item.FullName
  }
}

function Write-PixelBrightnessReleaseManifest([string]$ReleaseRoot) {
  $manifestPath = Join-Path $ReleaseRoot $script:PixelBrightnessReleaseManifestName
  if (Test-Path -LiteralPath $manifestPath) {
    throw "Reserved release manifest path already exists before final build inventory: $manifestPath"
  }
  $entries = [System.Collections.Generic.List[object]]::new()
  foreach ($file in @(Get-PixelBrightnessReleaseFiles $ReleaseRoot)) {
    $entries.Add([ordered]@{
      path = $file.Relative
      length = [int64]$file.Item.Length
      sha256 = Get-PixelBrightnessFileSha256 $file.Item.FullName
    })
  }
  $manifest = [ordered]@{
    schemaVersion = 1
    algorithm = 'sha256'
    manifestPath = $script:PixelBrightnessReleaseManifestName
    fileCount = $entries.Count
    files = @($entries)
  }
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($manifest | ConvertTo-Json -Depth 6 -Compress) + "`n")
  if ($bytes.Length -gt $script:PixelBrightnessReleaseManifestMaximumBytes) {
    throw "Release manifest exceeds its bounded maximum size ($($bytes.Length) bytes)."
  }
  Write-PixelBrightnessAtomicBytes $manifestPath $bytes
  return $manifestPath
}

function Assert-PixelBrightnessReleaseManifest([string]$ReleaseRoot) {
  $manifestPath = Join-Path $ReleaseRoot $script:PixelBrightnessReleaseManifestName
  $manifestItem = Assert-PixelBrightnessPlainFile $manifestPath 'Protected release manifest'
  if ($null -eq $manifestItem) { throw "Protected release manifest is missing: $manifestPath" }
  if ($manifestItem.Length -le 0 -or $manifestItem.Length -gt $script:PixelBrightnessReleaseManifestMaximumBytes) {
    throw "Protected release manifest size is invalid: $($manifestItem.Length)"
  }
  try {
    $manifest = Get-Content -LiteralPath $manifestItem.FullName -Raw -ErrorAction Stop |
      ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "Protected release manifest is corrupt: $($_.Exception.Message)"
  }
  $topProperties = @($manifest.PSObject.Properties.Name | Sort-Object)
  $expectedTopProperties = @('algorithm', 'fileCount', 'files', 'manifestPath', 'schemaVersion')
  if (Compare-Object $topProperties $expectedTopProperties) {
    throw 'Protected release manifest has unsupported or missing fields.'
  }
  if ([int]$manifest.schemaVersion -ne 1 -or [string]$manifest.algorithm -cne 'sha256' -or
      [string]$manifest.manifestPath -cne $script:PixelBrightnessReleaseManifestName) {
    throw 'Protected release manifest contract is invalid.'
  }
  $actualFiles = @(Get-PixelBrightnessReleaseFiles $ReleaseRoot |
    Where-Object { $_.Relative -cne $script:PixelBrightnessReleaseManifestName })
  $declaredFiles = @($manifest.files)
  if ([int64]$manifest.fileCount -ne $declaredFiles.Count -or
      $declaredFiles.Count -ne $actualFiles.Count -or
      $declaredFiles.Count -gt $script:PixelBrightnessReleaseManifestMaximumFiles) {
    throw 'Protected release manifest file count does not match the exact release inventory.'
  }
  $actualByPath = [System.Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($file in $actualFiles) {
    if ($actualByPath.ContainsKey($file.Relative)) {
      throw "Protected release contains a duplicate path: $($file.Relative)"
    }
    $actualByPath.Add($file.Relative, $file)
  }
  $declaredPaths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $declaredFiles) {
    $entryProperties = @($entry.PSObject.Properties.Name | Sort-Object)
    if (Compare-Object $entryProperties @('length', 'path', 'sha256')) {
      throw 'Protected release manifest file entry has unsupported or missing fields.'
    }
    $relative = [string]$entry.path
    if ([string]::IsNullOrWhiteSpace($relative) -or $relative.StartsWith('/') -or
        $relative.EndsWith('/') -or $relative.Contains('//') -or $relative.Contains('\') -or
        $relative.Contains(':') -or @($relative.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -ne 0 -or
        [string]::Equals($relative, $script:PixelBrightnessReleaseManifestName, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Protected release manifest path is not canonical: $relative"
    }
    if (-not $declaredPaths.Add($relative) -or -not $actualByPath.ContainsKey($relative)) {
      throw "Protected release manifest path is duplicated or missing: $relative"
    }
    $actual = $actualByPath[$relative]
    if ([string]$actual.Relative -cne $relative -or [int64]$entry.length -ne [int64]$actual.Item.Length -or
        [string]$entry.sha256 -notmatch '^[0-9a-f]{64}$' -or
        (Get-PixelBrightnessFileSha256 $actual.Item.FullName) -cne [string]$entry.sha256) {
      throw "Protected release manifest digest or length mismatch: $relative"
    }
  }
  return [pscustomobject]@{
    ManifestPath = $manifestItem.FullName
    ManifestSha256 = Get-PixelBrightnessFileSha256 $manifestItem.FullName
    FileCount = $actualFiles.Count
  }
}

function Copy-PixelBrightnessReleaseToProtectedStaging {
  param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$DestinationRoot,
    [Parameter(Mandatory = $true)][string]$ShowUser
  )
  if (Test-Path -LiteralPath $DestinationRoot) {
    throw "Destination-volume release staging already exists: $DestinationRoot"
  }
  $source = [IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
  $destination = [IO.Path]::GetFullPath($DestinationRoot).TrimEnd('\')
  $null = Assert-PixelBrightnessReleaseManifest $source
  $null = Initialize-AdminProtectedDirectory $destination $env:ProgramFiles $ShowUser 'Pixel Brightness destination-volume release staging'
  $null = Protect-AdminControlPath -Path $destination -ShowUser $ShowUser -ShowAccess None -Label 'Pixel Brightness destination-volume release staging'
  foreach ($item in @(Get-NonReparseTree $source 'Pixel Brightness source release payload') |
      Sort-Object { $_.FullName.Length }) {
    if ([string]::Equals($item.FullName, $source, [StringComparison]::OrdinalIgnoreCase)) { continue }
    $relative = Get-PixelBrightnessReleaseRelativePath $source $item.FullName
    $target = Join-Path $destination $relative.Replace('/', '\')
    if ($item.PSIsContainer) {
      New-Item -ItemType Directory -Path $target -ErrorAction Stop | Out-Null
    } else {
      [IO.File]::Copy($item.FullName, $target, $false)
    }
  }
  $null = Protect-AdminControlTree -Path $destination -ShowUser $ShowUser -ShowAccess None -Label 'Pixel Brightness destination-volume release staging'
  return $destination
}

function Publish-PixelBrightnessWriteThroughDirectory([string]$Temporary, [string]$Destination) {
  $temporaryFull = [IO.Path]::GetFullPath($Temporary).TrimEnd('\')
  $destinationFull = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
  if (-not [string]::Equals(
    [IO.Path]::GetPathRoot($temporaryFull),
    [IO.Path]::GetPathRoot($destinationFull),
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw 'Write-through release publication requires destination-volume staging.'
  }
  $sourceItem = Get-Item -LiteralPath $temporaryFull -Force -ErrorAction Stop
  if (-not $sourceItem.PSIsContainer -or
      ($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Write-through release publication source must be a real directory: $temporaryFull"
  }
  if (Test-Path -LiteralPath $destinationFull) {
    throw "Write-through release publication destination already exists: $destinationFull"
  }
  $destinationParent = Get-Item -LiteralPath (Split-Path $destinationFull -Parent) -Force -ErrorAction Stop
  if (-not $destinationParent.PSIsContainer -or
      ($destinationParent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Write-through release publication parent must be a real directory: $($destinationParent.FullName)"
  }
  if (-not [PixelBrightness.NativeFileDurability]::MoveFileExW(
    $temporaryFull,
    $destinationFull,
    [PixelBrightness.NativeFileDurability]::MOVEFILE_WRITE_THROUGH
  )) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw [ComponentModel.Win32Exception]::new($errorCode, "Write-through release directory publication failed: $destinationFull")
  }
  $published = Get-Item -LiteralPath $destinationFull -Force -ErrorAction Stop
  if (-not $published.PSIsContainer -or
      ($published.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Published release is not a real directory: $destinationFull"
  }
  return $published.FullName
}

function New-PixelBrightnessReleaseLaunchBarrierSecurity {
  $security = [Security.AccessControl.MutexSecurity]::new()
  # The Mutex constructor requests full access when it opens an already-created
  # named object. Grant that access only to the three principals that can run a
  # managed launcher/installer; mutex ownership still limits ReleaseMutex to
  # the acquiring thread.
  $rights = [Security.AccessControl.MutexRights]::FullControl
  foreach ($sidValue in @(
    'S-1-5-18',       # LocalSystem Server/Web task
    'S-1-5-32-544',   # elevated installer/Administrators
    'S-1-5-4'         # signed-in interactive Show session
  )) {
    $sid = [Security.Principal.SecurityIdentifier]::new($sidValue)
    $rule = [Security.AccessControl.MutexAccessRule]::new(
      $sid,
      $rights,
      [Security.AccessControl.AccessControlType]::Allow
    )
    $null = $security.AddAccessRule($rule)
  }
  return $security
}

function Enter-PixelBrightnessReleaseLaunchBarrier([int]$TimeoutMilliseconds = 900000) {
  if ($TimeoutMilliseconds -lt 1 -or $TimeoutMilliseconds -gt 900000) {
    throw 'Release launch barrier timeout is outside its bounded contract.'
  }
  $createdNew = $false
  $security = New-PixelBrightnessReleaseLaunchBarrierSecurity
  try {
    $barrier = [Threading.Mutex]::new(
      $false,
      'Global\PixelBrightnessReleaseLaunchBarrier',
      [ref]$createdNew,
      $security
    )
  } catch {
    throw "Release launch barrier could not be opened with its protected cross-session ACL: $($_.Exception.Message)"
  }
  $held = $false
  try {
    try { $held = $barrier.WaitOne($TimeoutMilliseconds) }
    catch [Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { throw 'Timed out waiting for the release launch/publication barrier.' }
    return $barrier
  } catch {
    $barrier.Dispose()
    throw
  }
}

function Exit-PixelBrightnessReleaseLaunchBarrier([Threading.Mutex]$Barrier) {
  if ($null -eq $Barrier) { return }
  try { $Barrier.ReleaseMutex() }
  finally { $Barrier.Dispose() }
}

function Stop-PixelBrightnessRacedLaunchProcessTrees {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [int]$TimeoutSeconds = 15
  )
  $launcherPath = [IO.Path]::GetFullPath((Join-Path $DataRoot 'Start-PixelBrightness.ps1'))
  $schedulePath = [IO.Path]::GetFullPath((Join-Path $DataRoot 'ShowSchedule.ps1'))
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $owned = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($process in $processes) {
      $commandLine = [string]$process.CommandLine
      $isLauncher = -not [string]::IsNullOrWhiteSpace($commandLine) -and
        $commandLine.IndexOf($launcherPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
      $isSchedule = -not [string]::IsNullOrWhiteSpace($commandLine) -and
        $commandLine.IndexOf($schedulePath, [StringComparison]::OrdinalIgnoreCase) -ge 0
      $isOrphanRuntime = $commandLine -match '(?:runtime[\\/]server[\\/]index\.mjs|runtime[\\/]node[\\/]index\.mjs|scripts[\\/]run-vinext\.mjs"?\s+"?start|vinext[\\/].*cli\.js.*(?:\s|")start(?:\s|"|$))'
      $isRenderer = [string]$process.Name -ieq 'pixel-brightness-renderer.exe'
      if ($isLauncher -or $isSchedule -or $isOrphanRuntime -or $isRenderer) {
        $null = $owned.Add([int]$process.ProcessId)
      }
    }
    $changed = $true
    while ($changed) {
      $changed = $false
      foreach ($process in $processes) {
        if ($owned.Contains([int]$process.ParentProcessId) -and
            $owned.Add([int]$process.ProcessId)) {
          $changed = $true
        }
      }
    }
    if ($owned.Count -eq 0) { return }
    foreach ($processId in @($owned | Sort-Object -Descending)) {
      Stop-Process -Id $processId -Force -ErrorAction Stop
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw 'A raced Pixel Brightness launcher or descendant survived the protected upgrade gate drain.'
}

function Stop-PixelBrightnessRacedShowLaunchProcessTrees {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [int]$TimeoutSeconds = 15
  )
  $launcherPath = [IO.Path]::GetFullPath((Join-Path $DataRoot 'Start-PixelBrightness.ps1'))
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $owned = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($process in $processes) {
      $commandLine = [string]$process.CommandLine
      $isShowLauncher = -not [string]::IsNullOrWhiteSpace($commandLine) -and
        $commandLine.IndexOf($launcherPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $commandLine -match '(?i)(?:^|\s)-Role\s+"?Show(?:"|\s|$)'
      $isOrphanNode = $commandLine -match '(?:^|[\s"])(?:[^\s"]*[\\/])?runtime[\\/]node[\\/]index\.mjs(?:[\s"]|$)'
      $isRenderer = [string]$process.Name -ieq 'pixel-brightness-renderer.exe'
      if ($isShowLauncher -or $isOrphanNode -or $isRenderer) {
        $null = $owned.Add([int]$process.ProcessId)
      }
    }
    $changed = $true
    while ($changed) {
      $changed = $false
      foreach ($process in $processes) {
        if ($owned.Contains([int]$process.ParentProcessId) -and
            $owned.Add([int]$process.ProcessId)) {
          $changed = $true
        }
      }
    }
    if ($owned.Count -eq 0) { return }
    foreach ($processId in @($owned | Sort-Object -Descending)) {
      Stop-Process -Id $processId -Force -ErrorAction Stop
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw 'A raced Pixel Brightness Show launcher or descendant survived the display binding gate drain.'
}

function Get-PixelBrightnessUpgradeGatePath([string]$DataRoot) {
  return (Join-Path (Join-Path $DataRoot 'upgrade') 'in-progress.json')
}

function Get-PixelBrightnessManagedTaskNames {
  return @(
    'PixelBrightness-Server',
    'PixelBrightness-Web',
    'PixelBrightness-Show',
    'PixelBrightness-Schedule',
    'PixelBrightness-Schedule-Interactive'
  )
}

function Get-PixelBrightnessUpgradeHealthTasks {
  return @(Get-ScheduledTask -TaskName 'PixelBrightness-UpgradeHealth-*' -ErrorAction SilentlyContinue)
}

function Assert-PixelBrightnessUpgradeTransactionId([string]$TransactionId) {
  $parsed = [guid]::Empty
  if (-not [guid]::TryParseExact($TransactionId, 'D', [ref]$parsed) -or $parsed -eq [guid]::Empty) {
    throw "Pixel Brightness upgrade transaction id is invalid: $TransactionId"
  }
  return $parsed.ToString('D')
}

function Assert-PixelBrightnessUpgradeJournalLocation([string]$JournalPath) {
  $stagingParent = Join-Path $env:ProgramData 'Pixel Brightness Build'
  $location = Get-PathWithinAdminRoot $JournalPath $stagingParent 'Pixel Brightness upgrade journal'
  if ([IO.Path]::GetFileName($location.Path) -cne 'snapshot.json' -or
      [IO.Path]::GetFileName((Split-Path $location.Path -Parent)) -cne 'transaction-snapshot') {
    throw "Upgrade journal must be the exact transaction-snapshot\snapshot.json file: $($location.Path)"
  }
  return $location.Path
}

function Write-PixelBrightnessUpgradeGate {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$ShowUser,
    [Parameter(Mandatory = $true)][string]$TransactionId,
    [Parameter(Mandatory = $true)][string]$JournalPath,
    [Parameter(Mandatory = $true)][ValidateSet('snapshot-pending', 'snapshot-ready', 'mutating', 'health-running', 'health-verified', 'rollback')][string]$Phase,
    [object]$HealthBypass = $null
  )
  $TransactionId = Assert-PixelBrightnessUpgradeTransactionId $TransactionId
  $JournalPath = Assert-PixelBrightnessUpgradeJournalLocation $JournalPath
  $upgradeRoot = Join-Path $DataRoot 'upgrade'
  $null = Initialize-AdminProtectedDirectory $upgradeRoot $env:ProgramData $ShowUser 'Pixel Brightness upgrade boot gate directory'
  $null = Protect-AdminControlPath -Path $upgradeRoot -ShowUser $ShowUser -ShowAccess Read -Label 'Pixel Brightness upgrade boot gate directory'
  $gatePath = Get-PixelBrightnessUpgradeGatePath $DataRoot
  $gate = [ordered]@{
    schemaVersion = 1
    transactionId = $TransactionId
    phase = $Phase
    dataRoot = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
    journalPath = $JournalPath
    healthBypass = $HealthBypass
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($gate | ConvertTo-Json -Depth 8) + "`n")
  Write-PixelBrightnessAtomicBytes $gatePath $bytes
  $null = Protect-AdminControlPath -Path $gatePath -ShowUser $ShowUser -ShowAccess Read -Label 'Pixel Brightness upgrade boot gate'
  $null = Assert-AdminProtectedControlTree $upgradeRoot 'Pixel Brightness upgrade boot gate tree'
  return [pscustomobject]$gate
}

function Read-PixelBrightnessUpgradeGate([string]$DataRoot) {
  $gatePath = Get-PixelBrightnessUpgradeGatePath $DataRoot
  if (-not (Test-Path -LiteralPath $gatePath)) { return $null }
  $upgradeRoot = Split-Path $gatePath -Parent
  $null = Assert-AdminProtectedDirectoryChain $upgradeRoot $env:ProgramData 'Pixel Brightness upgrade boot gate directory'
  $null = Assert-AdminProtectedControlTree $upgradeRoot 'Pixel Brightness upgrade boot gate tree'
  if ($null -eq (Assert-PixelBrightnessPlainFile $gatePath 'Pixel Brightness upgrade boot gate')) {
    throw 'Pixel Brightness upgrade boot gate is missing after its protected directory was inspected.'
  }
  try { $gate = Get-Content -LiteralPath $gatePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "Pixel Brightness upgrade boot gate is corrupt; startup remains blocked: $($_.Exception.Message)" }
  if ([int]$gate.schemaVersion -ne 1) { throw 'Unsupported Pixel Brightness upgrade boot gate schema; startup remains blocked.' }
  if ([string]$gate.phase -notin @('snapshot-pending', 'snapshot-ready', 'mutating', 'health-running', 'health-verified', 'rollback')) {
    throw 'Pixel Brightness upgrade boot gate phase is invalid; startup remains blocked.'
  }
  $transactionId = Assert-PixelBrightnessUpgradeTransactionId ([string]$gate.transactionId)
  $expectedRoot = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
  if (-not [string]::Equals([IO.Path]::GetFullPath([string]$gate.dataRoot).TrimEnd('\'), $expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Pixel Brightness upgrade boot gate names a different data root; startup remains blocked.'
  }
  $journalPath = Assert-PixelBrightnessUpgradeJournalLocation ([string]$gate.journalPath)
  $gate.transactionId = $transactionId
  $gate.journalPath = $journalPath
  return $gate
}

function Remove-PixelBrightnessUpgradeGate([string]$DataRoot, [string]$TransactionId) {
  $expectedId = Assert-PixelBrightnessUpgradeTransactionId $TransactionId
  $gate = Read-PixelBrightnessUpgradeGate $DataRoot
  if ($null -eq $gate) { throw 'Upgrade boot gate disappeared before the transaction could clear it.' }
  if ([string]$gate.transactionId -cne $expectedId) {
    throw 'Upgrade boot gate belongs to a different transaction and will not be cleared.'
  }
  Remove-Item -LiteralPath (Get-PixelBrightnessUpgradeGatePath $DataRoot) -Force -ErrorAction Stop
  if (Test-Path -LiteralPath (Get-PixelBrightnessUpgradeGatePath $DataRoot)) {
    throw 'Upgrade boot gate could not be cleared.'
  }
}

function New-PixelBrightnessUpgradeHealthBypass {
  param(
    [Parameter(Mandatory = $true)][string]$SnapshotRoot,
    [Parameter(Mandatory = $true)][string]$ShowUser,
    [Parameter(Mandatory = $true)][string]$TransactionId,
    [Parameter(Mandatory = $true)][int]$InstallerProcessId,
    [Parameter(Mandatory = $true)][string[]]$Roles
  )
  $TransactionId = Assert-PixelBrightnessUpgradeTransactionId $TransactionId
  $tokenRoot = Join-Path $SnapshotRoot 'health-bypass'
  New-Item -ItemType Directory -Path $tokenRoot -ErrorAction Stop | Out-Null
  $null = Protect-AdminControlPath -Path $tokenRoot -ShowUser $ShowUser -ShowAccess None -Label 'Pixel Brightness one-shot health bypass directory'
  $entries = [ordered]@{}
  $installerProcess = Get-Process -Id $InstallerProcessId -ErrorAction Stop
  $installerCim = Get-CimInstance Win32_Process -Filter "ProcessId = $InstallerProcessId" -ErrorAction Stop
  if ([string]::IsNullOrWhiteSpace([string]$installerCim.CommandLine)) { throw 'Upgrade health owner command line is unavailable.' }
  $entries['_installer'] = [ordered]@{
    pid = $InstallerProcessId
    startedAt = ([DateTimeOffset]$installerProcess.StartTime).ToUniversalTime().ToString('o')
    startedAtUtcTicks = $installerProcess.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
    expiresAt = [DateTimeOffset]::UtcNow.AddMinutes(10).ToString('o')
    commandLineSha256 = Get-PixelBrightnessSha256 ([Text.UTF8Encoding]::new($false).GetBytes([string]$installerCim.CommandLine))
  }
  foreach ($role in @($Roles)) {
    if ($role -notin @('Server', 'Web')) { throw "Upgrade health bypass cannot authorize role: $role" }
    $tokenPath = Join-Path $tokenRoot ("{0}.json" -f $role.ToLowerInvariant())
    $token = [ordered]@{
      schemaVersion = 1
      transactionId = $TransactionId
      role = $role
      nonce = [Convert]::ToBase64String(([guid]::NewGuid().ToByteArray())).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($token | ConvertTo-Json -Depth 4) + "`n")
    Write-PixelBrightnessAtomicBytes $tokenPath $bytes
    $null = Protect-AdminControlPath -Path $tokenPath -ShowUser $ShowUser -ShowAccess None -Label "Pixel Brightness $role one-shot health bypass"
    $entries[$role] = [ordered]@{ path = $tokenPath; sha256 = Get-PixelBrightnessSha256 $bytes }
  }
  $null = Assert-AdminProtectedControlTree $tokenRoot 'Pixel Brightness one-shot health bypass tree'
  return $entries
}

function Assert-PixelBrightnessUpgradeHealthOwner([object]$Gate) {
  if ($null -eq $Gate.healthBypass) { throw 'Upgrade health gate has no installer owner contract.' }
  $ownerProperty = $Gate.healthBypass.PSObject.Properties['_installer']
  if ($null -eq $ownerProperty) { throw 'Upgrade health gate is missing its installer owner contract.' }
  $owner = $ownerProperty.Value
  $pidValue = [int]$owner.pid
  if ($pidValue -le 4) { throw 'Upgrade health owner PID is invalid.' }
  try {
    $expectedStart = [DateTimeOffset]::ParseExact([string]$owner.startedAt, 'o', [Globalization.CultureInfo]::InvariantCulture)
    $expectedStartTicks = [int64]::Parse([string]$owner.startedAtUtcTicks, [Globalization.CultureInfo]::InvariantCulture)
    $expiresAt = [DateTimeOffset]::ParseExact([string]$owner.expiresAt, 'o', [Globalization.CultureInfo]::InvariantCulture)
  } catch { throw "Upgrade health owner time contract is invalid: $($_.Exception.Message)" }
  if ([DateTimeOffset]::UtcNow -ge $expiresAt) { throw 'Upgrade health owner lease expired.' }
  $process = Get-Process -Id $pidValue -ErrorAction Stop
  $actualStart = ([DateTimeOffset]$process.StartTime).ToUniversalTime()
  if ($actualStart.UtcDateTime.Ticks -ne $expectedStartTicks -or $actualStart.UtcDateTime.Ticks -ne $expectedStart.UtcDateTime.Ticks) {
    throw 'Upgrade health owner PID was reused by a different process.'
  }
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction Stop
  $commandDigest = Get-PixelBrightnessSha256 ([Text.UTF8Encoding]::new($false).GetBytes([string]$cim.CommandLine))
  if ([string]$owner.commandLineSha256 -notmatch '^[0-9a-f]{64}$' -or $commandDigest -cne [string]$owner.commandLineSha256) {
    throw 'Upgrade health owner command identity changed.'
  }
  return $owner
}

function Assert-PixelBrightnessUpgradeLauncherGate {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][ValidateSet('Server', 'Web', 'Show', 'Schedule')][string]$Role,
    [string]$HealthTransactionId = '',
    [string]$HealthTokenPath = ''
  )
  $gatePath = Get-PixelBrightnessUpgradeGatePath $DataRoot
  if (-not (Test-Path -LiteralPath $gatePath)) {
    if ($HealthTransactionId -or $HealthTokenPath) {
      throw 'Upgrade health bypass arguments cannot be used without an active protected boot gate.'
    }
    return $null
  }
  $gate = Read-PixelBrightnessUpgradeGate $DataRoot
  if (-not $HealthTransactionId -or -not $HealthTokenPath) {
    throw "Pixel Brightness $Role startup is blocked by an in-progress upgrade. Run Recover-PixelBrightnessUpgrade.ps1 locally as Administrator."
  }
  if ($Role -eq 'Show') { throw 'The projector Show role can never bypass an upgrade boot gate.' }
  if ($Role -eq 'Schedule') { throw 'The weekly Show scheduler can never bypass an upgrade boot gate.' }
  if ([string]$gate.phase -cne 'health-running') {
    throw "Upgrade health bypass is not valid in gate phase $($gate.phase)."
  }
  $transactionId = Assert-PixelBrightnessUpgradeTransactionId $HealthTransactionId
  if ($transactionId -cne [string]$gate.transactionId) { throw 'Upgrade health bypass transaction id does not match the boot gate.' }
  $null = Assert-PixelBrightnessUpgradeHealthOwner $gate
  if ($null -eq $gate.healthBypass) { throw 'Upgrade boot gate has no health-bypass contract.' }
  $property = $gate.healthBypass.PSObject.Properties[$Role]
  if ($null -eq $property) { throw "Upgrade boot gate does not authorize a $Role health process." }
  $expected = $property.Value
  $expectedPath = [IO.Path]::GetFullPath([string]$expected.path)
  $suppliedPath = [IO.Path]::GetFullPath($HealthTokenPath)
  if (-not [string]::Equals($expectedPath, $suppliedPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Upgrade health bypass token path does not match the protected boot gate.'
  }
  $tokenRoot = Split-Path $expectedPath -Parent
  if ([IO.Path]::GetFileName($tokenRoot) -cne 'health-bypass' -or
      -not $expectedPath.StartsWith(([IO.Path]::GetFullPath((Split-Path ([string]$gate.journalPath) -Parent)).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Upgrade health bypass escaped the protected transaction snapshot.'
  }
  $null = Assert-AdminProtectedControlTree $tokenRoot 'Pixel Brightness one-shot health bypass tree'
  $consumedPath = "$expectedPath.consumed"
  if (Test-Path -LiteralPath $consumedPath) { throw "Upgrade $Role health bypass was already consumed." }
  try { Publish-PixelBrightnessWriteThroughFile $expectedPath $consumedPath }
  catch { throw "Upgrade $Role health bypass could not be consumed exactly once: $($_.Exception.Message)" }
  $consumed = Assert-PixelBrightnessPlainFile $consumedPath "Consumed $Role health bypass"
  $null = Assert-AdminProtectedItem $consumed "Consumed $Role health bypass"
  $bytes = [IO.File]::ReadAllBytes($consumed.FullName)
  if ((Get-PixelBrightnessSha256 $bytes) -cne [string]$expected.sha256) {
    throw "Consumed $Role health bypass failed its protected digest."
  }
  try { $token = [Text.UTF8Encoding]::new($false).GetString($bytes) | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "Consumed $Role health bypass is corrupt: $($_.Exception.Message)" }
  if ([int]$token.schemaVersion -ne 1 -or [string]$token.transactionId -cne $transactionId -or
      [string]$token.role -cne $Role -or [string]$token.nonce -notmatch '^[A-Za-z0-9_-]{22}$') {
    throw "Consumed $Role health bypass contract is invalid."
  }
  return $gate
}

function Write-PixelBrightnessUpgradeCommit {
  param(
    [Parameter(Mandatory = $true)][string]$SnapshotRoot,
    [Parameter(Mandatory = $true)][string]$ShowUser,
    [Parameter(Mandatory = $true)][string]$TransactionId,
    [Parameter(Mandatory = $true)][string]$ReleaseRoot
  )
  $TransactionId = Assert-PixelBrightnessUpgradeTransactionId $TransactionId
  $journalPath = Join-Path $SnapshotRoot 'snapshot.json'
  $journal = Assert-PixelBrightnessPlainFile $journalPath 'Pixel Brightness upgrade journal'
  if ($null -eq $journal) { throw 'Upgrade journal disappeared before commit.' }
  $releaseManifest = Assert-PixelBrightnessReleaseManifest $ReleaseRoot
  $commit = [ordered]@{
    schemaVersion = 1
    transactionId = $TransactionId
    releaseRoot = $ReleaseRoot
    releaseManifestSha256 = $releaseManifest.ManifestSha256
    journalSha256 = Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes($journal.FullName))
    healthVerified = $true
    committedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
  $commitPath = Join-Path $SnapshotRoot 'commit.json'
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($commit | ConvertTo-Json -Depth 5) + "`n")
  Write-PixelBrightnessAtomicBytes $commitPath $bytes
  $null = Protect-AdminControlPath -Path $commitPath -ShowUser $ShowUser -ShowAccess None -Label 'Pixel Brightness upgrade commit record'
  $null = Assert-AdminProtectedControlTree $SnapshotRoot 'Pixel Brightness committed upgrade journal'
  return $commit
}

function Get-PixelBrightnessUpgradeControlFiles([string]$DataRoot) {
  return @(
    'config\node.json',
    'config\renderer.json',
    'config\display-binding.json',
    'current-release.txt',
    'Start-PixelBrightness.ps1',
    'ShowSchedule.ps1',
    'ArenaSaveEvidence.ps1',
    'Bind-PixelBrightnessDisplays.ps1',
    'Test-PixelBrightness.ps1',
    'CameraRuntime.ps1',
    'Provision-PixelBrightnessCanonCamera.ps1',
    'RuntimeSecurity.ps1',
    'UpgradeTransaction.ps1',
    'Recover-PixelBrightnessUpgrade.ps1',
    'secrets\control-token.txt',
    'secrets\node-signing-key.txt',
    'secrets\node-token.txt',
    # Retained in the snapshot only so a failed credential-split migration can
    # restore the legacy generation byte-for-byte. Successful installs delete it.
    'secrets\cluster-token.txt',
    'secrets\runtime.json',
    'secrets\installation.json',
    'secrets\trusted-web.json',
    'camera-runtime\active.json'
  ) | ForEach-Object {
    [pscustomobject]@{ Relative = $_; Path = (Join-Path $DataRoot $_) }
  }
}

function Get-PixelBrightnessFirewallSnapshot {
  $definitions = @(
    @{ DisplayName = 'Pixel Brightness Web Control'; Port = '3000' },
    @{ DisplayName = 'Pixel Brightness Control API'; Port = '4100' }
  )
  $result = [System.Collections.Generic.List[object]]::new()
  foreach ($definition in $definitions) {
    $rules = @(Get-NetFirewallRule -DisplayName $definition.DisplayName -ErrorAction SilentlyContinue)
    if ($rules.Count -gt 1) {
      throw "Firewall rule name is ambiguous and cannot be rolled back exactly: $($definition.DisplayName)"
    }
    if ($rules.Count -eq 0) {
      $result.Add([pscustomobject]@{
        DisplayName = $definition.DisplayName
        Port = $definition.Port
        Existed = $false
        Name = $null
        Enabled = $null
      })
      continue
    }
    $rule = $rules[0]
    $port = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop
    $application = Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop
    $address = Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop
    $service = Get-NetFirewallServiceFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop
    $interface = Get-NetFirewallInterfaceFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop
    $interfaceType = Get-NetFirewallInterfaceTypeFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop
    $security = Get-NetFirewallSecurityFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop
    $simpleOwnedRule = [string]$rule.Direction -eq 'Inbound' -and
      [string]$rule.Action -eq 'Allow' -and
      [string]$rule.Profile -eq 'Private' -and
      [string]$rule.EdgeTraversalPolicy -eq 'Block' -and
      [string]$rule.LooseSourceMapping -eq 'False' -and
      [string]$rule.LocalOnlyMapping -eq 'False' -and
      [string]$rule.Description -eq '' -and
      [string]$rule.Group -eq '' -and
      [string]$rule.Owner -eq '' -and
      @($rule.Platform).Count -eq 0 -and
      [string]$rule.PolicyStoreSourceType -eq 'Local' -and
      [string]$port.Protocol -eq 'TCP' -and
      [string]$port.LocalPort -eq $definition.Port -and
      [string]$port.RemotePort -eq 'Any' -and
      [string]$port.IcmpType -eq 'Any' -and
      [string]$port.DynamicTarget -eq 'Any' -and
      [string]$application.Program -eq 'Any' -and
      [string]$application.Package -in @('', 'Any') -and
      [string]$address.LocalAddress -eq 'Any' -and
      [string]$address.RemoteAddress -eq 'Any' -and
      @($address.RemoteDynamicKeywordAddresses).Count -eq 0 -and
      [string]$service.Service -eq 'Any' -and
      [string]$interface.InterfaceAlias -eq 'Any' -and
      [string]$interfaceType.InterfaceType -eq 'Any' -and
      [string]$security.Authentication -eq 'NotRequired' -and
      [string]$security.Encryption -eq 'NotRequired' -and
      [string]$security.OverrideBlockRules -eq 'False' -and
      [string]$security.LocalUser -in @('', 'Any') -and
      [string]$security.RemoteUser -in @('', 'Any') -and
      [string]$security.RemoteMachine -in @('', 'Any')
    if (-not $simpleOwnedRule) {
      throw "Existing firewall rule collides with Pixel Brightness but is not the exact installer-owned rule: $($definition.DisplayName)"
    }
    $result.Add([pscustomobject]@{
      DisplayName = $definition.DisplayName
      Port = $definition.Port
      Existed = $true
      Name = [string]$rule.Name
      Enabled = [string]$rule.Enabled
    })
  }
  return @($result)
}

function Get-PixelBrightnessPowerSnapshot {
  if ($null -eq ('PixelBrightness.NativePowerSnapshot' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace PixelBrightness {
  public static class NativePowerSnapshot {
    [DllImport("powrprof.dll")]
    public static extern UInt32 PowerReadACValueIndex(
      IntPtr root, ref Guid scheme, ref Guid subgroup, ref Guid setting,
      out UInt32 value);
  }
}
'@
  }
  $powerRoot = 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes'
  $scheme = ([string](Get-ItemProperty -LiteralPath $powerRoot -Name ActivePowerScheme -ErrorAction Stop).ActivePowerScheme).Trim([char[]]'{}')
  if ($scheme -notmatch '^[0-9a-fA-F-]{36}$') { throw "Active Windows power scheme is invalid: $scheme" }
  $settings = @(
    @{ Name = 'standby-timeout-ac'; Subgroup = '238C9FA8-0AAD-41ED-83F4-97BE242C8F20'; Setting = '29F6C1DB-86DA-48C5-9FDB-F2B67B1F44DA' },
    @{ Name = 'monitor-timeout-ac'; Subgroup = '7516B95F-F776-4464-8C53-06167F40CC99'; Setting = '3C0BC021-C8A8-4E07-A973-6B14CBCB2B7E' },
    @{ Name = 'hibernate-timeout-ac'; Subgroup = '238C9FA8-0AAD-41ED-83F4-97BE242C8F20'; Setting = '9D7815A6-7EE4-497E-8888-515A05F02364' },
    @{ Name = 'disk-timeout-ac'; Subgroup = '0012EE47-9041-4B5D-9B77-535FBA8B1442'; Setting = '6738E2C4-E8A5-4A42-B16A-E040E769756E' }
  )
  $values = foreach ($entry in $settings) {
    # Registry overrides need not exist on a clean Windows installation.
    # Read the effective value through the power API, including scheme defaults.
    $schemeGuid = [guid]$scheme
    $subgroupGuid = [guid]$entry.Subgroup
    $settingGuid = [guid]$entry.Setting
    [uint32]$acValue = 0
    $status = [PixelBrightness.NativePowerSnapshot]::PowerReadACValueIndex(
      [IntPtr]::Zero, [ref]$schemeGuid, [ref]$subgroupGuid, [ref]$settingGuid, [ref]$acValue)
    if ($status -ne 0) {
      throw [ComponentModel.Win32Exception]::new([int]$status, "Could not read effective AC power setting: $($entry.Name)")
    }
    [pscustomobject]@{
      Name = $entry.Name
      Subgroup = $entry.Subgroup
      Setting = $entry.Setting
      AcValue = $acValue
    }
  }
  return [pscustomobject]@{ ActiveScheme = $scheme; Settings = @($values) }
}

function New-PixelBrightnessUpgradeSnapshot {
  param(
    [Parameter(Mandatory = $true)][string]$SnapshotRoot,
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$ShowUser,
    [Parameter(Mandatory = $true)][string]$TransactionId,
    [switch]$IncludeTasks,
    [switch]$IncludeAppliancePower
  )
  $TransactionId = Assert-PixelBrightnessUpgradeTransactionId $TransactionId
  $null = Initialize-AdminProtectedDirectory $SnapshotRoot $env:ProgramData $ShowUser 'Pixel Brightness upgrade snapshot'
  $null = Protect-AdminControlPath -Path $SnapshotRoot -ShowUser $ShowUser -ShowAccess None -Label 'Pixel Brightness upgrade snapshot'
  $fileRoot = Join-Path $SnapshotRoot 'files'
  New-Item -ItemType Directory -Path $fileRoot -ErrorAction Stop | Out-Null
  $null = Protect-AdminControlPath -Path $fileRoot -ShowUser $ShowUser -ShowAccess None -Label 'Pixel Brightness upgrade file snapshot'

  $files = [System.Collections.Generic.List[object]]::new()
  $index = 0
  foreach ($control in @(Get-PixelBrightnessUpgradeControlFiles $DataRoot)) {
    $item = Assert-PixelBrightnessPlainFile $control.Path "Upgrade control file $($control.Relative)"
    if ($null -eq $item) {
      $files.Add([pscustomobject]@{
        Relative = $control.Relative; Existed = $false; Backup = $null; Sha256 = $null; Sddl = $null
      })
    } else {
      $bytes = [IO.File]::ReadAllBytes($item.FullName)
      $backup = Join-Path $fileRoot ("{0:D2}.bin" -f $index)
      Write-PixelBrightnessAtomicBytes $backup $bytes
      $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
      $descriptorSections = [Security.AccessControl.AccessControlSections]::Access -bor
        [Security.AccessControl.AccessControlSections]::Owner -bor
        [Security.AccessControl.AccessControlSections]::Group
      $files.Add([pscustomobject]@{
        Relative = $control.Relative
        Existed = $true
        Backup = $backup
        Sha256 = Get-PixelBrightnessSha256 $bytes
        Sddl = $acl.GetSecurityDescriptorSddlForm($descriptorSections)
      })
    }
    $index += 1
  }

  $tasks = [System.Collections.Generic.List[object]]::new()
  if ($IncludeTasks) {
    $taskRoot = Join-Path $SnapshotRoot 'tasks'
    New-Item -ItemType Directory -Path $taskRoot -ErrorAction Stop | Out-Null
    $null = Protect-AdminControlPath -Path $taskRoot -ShowUser $ShowUser -ShowAccess None -Label 'Pixel Brightness task snapshot'
    $taskIndex = 0
    foreach ($taskName in @(Get-PixelBrightnessManagedTaskNames)) {
      $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      if ($null -eq $task) {
        $tasks.Add([pscustomobject]@{
          Name = $taskName; Existed = $false; XmlBackup = $null; XmlSha256 = $null; Enabled = $false; Running = $false
        })
      } else {
        $interactiveTask = $taskName -in @('PixelBrightness-Show', 'PixelBrightness-Schedule-Interactive')
        $expectedLogon = if ($interactiveTask) { 'Interactive' } else { 'ServiceAccount' }
        if ([string]$task.Principal.LogonType -ne $expectedLogon) {
          throw "Existing managed task uses a non-restorable/custom logon contract: $taskName ($($task.Principal.LogonType))"
        }
        if (-not $interactiveTask -and [string]$task.Principal.UserId -notin @('SYSTEM', 'S-1-5-18')) {
          throw "Existing SYSTEM task has an unexpected principal and will not be replaced: $taskName ($($task.Principal.UserId))"
        }
        if ($interactiveTask) {
          $expectedShowSid = Resolve-PixelBrightnessAccountSid $ShowUser 'Show user'
          try {
            $principalValue = [string]$task.Principal.UserId
            $actualShowSid = if ($principalValue -match '^S-1-') {
              [Security.Principal.SecurityIdentifier]::new($principalValue)
            } else {
              ([Security.Principal.NTAccount]::new($principalValue)).Translate([Security.Principal.SecurityIdentifier])
            }
          } catch { throw "Existing interactive task has an invalid principal: $taskName" }
          if ($actualShowSid.Value -cne $expectedShowSid.Value) {
            throw "Existing interactive task belongs to a different Show user: $taskName"
          }
        }
        $xml = [string](Export-ScheduledTask -TaskName $taskName -ErrorAction Stop)
        $xmlBytes = [Text.UTF8Encoding]::new($false).GetBytes($xml)
        $xmlBackup = Join-Path $taskRoot ("{0:D2}.xml" -f $taskIndex)
        Write-PixelBrightnessAtomicBytes $xmlBackup $xmlBytes
        $tasks.Add([pscustomobject]@{
          Name = $taskName
          Existed = $true
          XmlBackup = $xmlBackup
          XmlSha256 = Get-PixelBrightnessSha256 $xmlBytes
          Enabled = [bool]$task.Settings.Enabled
          Running = [string]$task.State -eq 'Running'
        })
      }
      $taskIndex += 1
    }
  }

  $snapshot = [pscustomobject]@{
    SchemaVersion = 1
    TransactionId = $TransactionId
    CreatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    Root = $SnapshotRoot
    DataRoot = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
    ShowUser = $ShowUser
    Files = @($files)
    Tasks = @($tasks)
    Firewall = @(Get-PixelBrightnessFirewallSnapshot)
    Power = $(if ($IncludeAppliancePower) { Get-PixelBrightnessPowerSnapshot } else { $null })
  }
  $journalPath = Join-Path $SnapshotRoot 'snapshot.json'
  $journalBytes = [Text.UTF8Encoding]::new($false).GetBytes(($snapshot | ConvertTo-Json -Depth 12) + "`n")
  Write-PixelBrightnessAtomicBytes $journalPath $journalBytes
  $null = Protect-AdminControlPath -Path $journalPath -ShowUser $ShowUser -ShowAccess None -Label 'Pixel Brightness upgrade journal'
  $null = Assert-AdminProtectedControlTree $SnapshotRoot 'Pixel Brightness upgrade snapshot'
  return $snapshot
}

function Stop-PixelBrightnessTaskForRollback([string]$TaskName) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task -or [string]$task.State -notin @('Running', 'Queued')) { return }
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  } while ([string]$task.State -in @('Running', 'Queued') -and [DateTimeOffset]::UtcNow -lt $deadline)
  if ([string]$task.State -in @('Running', 'Queued')) { throw "Rollback could not stop scheduled task: $TaskName" }
}

function Restore-PixelBrightnessFirewallSnapshot([object[]]$Entries) {
  foreach ($entry in $Entries) {
    $currentRules = @(Get-NetFirewallRule -DisplayName ([string]$entry.DisplayName) -ErrorAction SilentlyContinue)
    foreach ($currentRule in $currentRules) { Remove-NetFirewallRule -InputObject $currentRule -ErrorAction Stop }
    if (@(Get-NetFirewallRule -DisplayName ([string]$entry.DisplayName) -ErrorAction SilentlyContinue).Count -ne 0) {
      throw "Rollback could not remove the current firewall rule: $($entry.DisplayName)"
    }
    if ($entry.Existed -eq $true) {
      New-NetFirewallRule -Name ([string]$entry.Name) -DisplayName ([string]$entry.DisplayName) `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort ([string]$entry.Port) `
        -Profile Private -Enabled ([string]$entry.Enabled) -ErrorAction Stop | Out-Null
    }
  }
}

function Restore-PixelBrightnessPowerSnapshot([object]$Power) {
  if ($null -eq $Power) { return }
  $powerCfg = Join-Path $env:SystemRoot 'System32\powercfg.exe'
  if (-not (Test-Path -LiteralPath $powerCfg -PathType Leaf)) { throw "Trusted powercfg.exe is missing: $powerCfg" }
  foreach ($entry in @($Power.Settings)) {
    & $powerCfg /setacvalueindex ([string]$Power.ActiveScheme) ([string]$entry.Subgroup) ([string]$entry.Setting) ([uint32]$entry.AcValue) | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Rollback could not restore AC power value: $($entry.Name)" }
  }
  & $powerCfg /setactive ([string]$Power.ActiveScheme) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Rollback could not reactivate the prior Windows power scheme' }
}

function Restore-PixelBrightnessUpgradeSnapshot {
  param(
    [Parameter(Mandatory = $true)][object]$Snapshot,
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [switch]$IncludeTasks,
    [switch]$DeferTaskActivation
  )
  if ([int]$Snapshot.SchemaVersion -ne 1) { throw 'Unsupported Pixel Brightness upgrade snapshot schema' }
  foreach ($taskName in @(
    'PixelBrightness-Schedule-Interactive',
    'PixelBrightness-Schedule',
    'PixelBrightness-Show',
    'PixelBrightness-Web',
    'PixelBrightness-Server'
  )) {
    if ($IncludeTasks) { Stop-PixelBrightnessTaskForRollback $taskName }
  }

  foreach ($entry in @($Snapshot.Files)) {
    $destination = Join-Path $DataRoot ([string]$entry.Relative)
    $current = Assert-PixelBrightnessPlainFile $destination "Rollback destination $($entry.Relative)"
    if ($entry.Existed -ne $true) {
      if ($null -ne $current) { Remove-Item -LiteralPath $destination -Force -ErrorAction Stop }
      continue
    }
    $backup = Assert-PixelBrightnessPlainFile ([string]$entry.Backup) "Rollback backup $($entry.Relative)"
    if ($null -eq $backup) { throw "Rollback backup is missing: $($entry.Relative)" }
    $bytes = [IO.File]::ReadAllBytes($backup.FullName)
    if ((Get-PixelBrightnessSha256 $bytes) -cne [string]$entry.Sha256) {
      throw "Rollback backup digest failed: $($entry.Relative)"
    }
    $parent = Split-Path $destination -Parent
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
      throw "Rollback destination parent disappeared and was not part of the file snapshot: $parent"
    }
    Write-PixelBrightnessAtomicBytes $destination $bytes
    $acl = Get-Acl -LiteralPath $destination -ErrorAction Stop
    $descriptorSections = [Security.AccessControl.AccessControlSections]::Access -bor
      [Security.AccessControl.AccessControlSections]::Owner -bor
      [Security.AccessControl.AccessControlSections]::Group
    $acl.SetSecurityDescriptorSddlForm([string]$entry.Sddl, $descriptorSections)
    Set-Acl -LiteralPath $destination -AclObject $acl -ErrorAction Stop
  }

  Restore-PixelBrightnessFirewallSnapshot @($Snapshot.Firewall)
  Restore-PixelBrightnessPowerSnapshot ($Snapshot.Power)

  if ($IncludeTasks) {
    foreach ($entry in @($Snapshot.Tasks)) {
      $currentTask = Get-ScheduledTask -TaskName ([string]$entry.Name) -ErrorAction SilentlyContinue
      if ($null -ne $currentTask) {
        Stop-PixelBrightnessTaskForRollback ([string]$entry.Name)
        Unregister-ScheduledTask -TaskName ([string]$entry.Name) -Confirm:$false -ErrorAction Stop
        if ($null -ne (Get-ScheduledTask -TaskName ([string]$entry.Name) -ErrorAction SilentlyContinue)) {
          throw "Rollback could not unregister current scheduled task: $($entry.Name)"
        }
      }
      if ($entry.Existed -ne $true) { continue }
      $xmlBytes = [IO.File]::ReadAllBytes([string]$entry.XmlBackup)
      if ((Get-PixelBrightnessSha256 $xmlBytes) -cne [string]$entry.XmlSha256) {
        throw "Rollback task XML digest failed: $($entry.Name)"
      }
      $xml = [Text.UTF8Encoding]::new($false).GetString($xmlBytes)
      Register-ScheduledTask -TaskName ([string]$entry.Name) -Xml $xml -Force -ErrorAction Stop | Out-Null
      if ($DeferTaskActivation) { Disable-ScheduledTask -TaskName ([string]$entry.Name) -ErrorAction Stop | Out-Null }
      elseif ($entry.Enabled -eq $true -or $entry.Running -eq $true) { Enable-ScheduledTask -TaskName ([string]$entry.Name) -ErrorAction Stop | Out-Null }
      else { Disable-ScheduledTask -TaskName ([string]$entry.Name) -ErrorAction Stop | Out-Null }
    }
    foreach ($entry in @($Snapshot.Tasks | Where-Object { -not $DeferTaskActivation -and $_.Existed -eq $true -and $_.Running -eq $true })) {
      Start-ScheduledTask -TaskName ([string]$entry.Name) -ErrorAction Stop
      $deadline = [DateTimeOffset]::UtcNow.AddSeconds(45)
      do {
        $task = Get-ScheduledTask -TaskName ([string]$entry.Name) -ErrorAction Stop
        if ([string]$task.State -eq 'Running') { break }
        Start-Sleep -Milliseconds 500
      } while ([DateTimeOffset]::UtcNow -lt $deadline)
      if ([string]$task.State -ne 'Running') {
        throw "Rollback task did not return to its prior Running state: $($entry.Name) (last state: $($task.State))"
      }
    }
    foreach ($entry in @($Snapshot.Tasks | Where-Object { $_.Existed -eq $true -and $_.Enabled -ne $true })) {
      Disable-ScheduledTask -TaskName ([string]$entry.Name) -ErrorAction Stop | Out-Null
    }
  }
}

function Assert-PixelBrightnessUpgradeSnapshotRestored {
  param(
    [Parameter(Mandatory = $true)][object]$Snapshot,
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [switch]$IncludeTasks,
    [switch]$TaskDefinitionsOnly,
    [switch]$TaskEnablementOnly
  )
  foreach ($entry in @($Snapshot.Files)) {
    $destination = Join-Path $DataRoot ([string]$entry.Relative)
    $item = Assert-PixelBrightnessPlainFile $destination "Rollback verification $($entry.Relative)"
    if ($entry.Existed -ne $true) {
      if ($null -ne $item) { throw "Rollback left a newly created control file behind: $($entry.Relative)" }
      continue
    }
    if ($null -eq $item) { throw "Rollback did not restore control file: $($entry.Relative)" }
    $bytes = [IO.File]::ReadAllBytes($item.FullName)
    if ((Get-PixelBrightnessSha256 $bytes) -cne [string]$entry.Sha256) {
      throw "Rollback restored different control bytes: $($entry.Relative)"
    }
    $descriptorSections = [Security.AccessControl.AccessControlSections]::Access -bor
      [Security.AccessControl.AccessControlSections]::Owner -bor
      [Security.AccessControl.AccessControlSections]::Group
    $sddl = (Get-Acl -LiteralPath $item.FullName -ErrorAction Stop).GetSecurityDescriptorSddlForm($descriptorSections)
    if ($sddl -cne [string]$entry.Sddl) { throw "Rollback restored a different control ACL: $($entry.Relative)" }
  }

  $firewall = @(Get-PixelBrightnessFirewallSnapshot)
  foreach ($expected in @($Snapshot.Firewall)) {
    $actual = @($firewall | Where-Object { $_.DisplayName -ceq $expected.DisplayName })
    if ($actual.Count -ne 1 -or $actual[0].Existed -ne $expected.Existed -or
        ($expected.Existed -eq $true -and
          ([string]$actual[0].Name -cne [string]$expected.Name -or [string]$actual[0].Enabled -cne [string]$expected.Enabled))) {
      throw "Rollback did not restore firewall rule exactly: $($expected.DisplayName)"
    }
  }

  if ($null -ne $Snapshot.Power) {
    $power = Get-PixelBrightnessPowerSnapshot
    if ([string]$power.ActiveScheme -cne [string]$Snapshot.Power.ActiveScheme) {
      throw 'Rollback did not restore the prior active Windows power scheme'
    }
    foreach ($expected in @($Snapshot.Power.Settings)) {
      $actual = @($power.Settings | Where-Object { $_.Name -ceq $expected.Name })
      if ($actual.Count -ne 1 -or [uint32]$actual[0].AcValue -ne [uint32]$expected.AcValue) {
        throw "Rollback did not restore AC power value: $($expected.Name)"
      }
    }
  }

  if ($IncludeTasks) {
    foreach ($entry in @($Snapshot.Tasks)) {
      $task = Get-ScheduledTask -TaskName ([string]$entry.Name) -ErrorAction SilentlyContinue
      if ($entry.Existed -ne $true) {
        if ($null -ne $task) { throw "Rollback left a newly created scheduled task behind: $($entry.Name)" }
        continue
      }
      if ($null -eq $task) { throw "Rollback did not restore scheduled task: $($entry.Name)" }
      $xml = [string](Export-ScheduledTask -TaskName ([string]$entry.Name) -ErrorAction Stop)
      $xmlBytes = [Text.UTF8Encoding]::new($false).GetBytes($xml)
      if ((Get-PixelBrightnessSha256 $xmlBytes) -cne [string]$entry.XmlSha256) {
        throw "Rollback restored a different scheduled task definition: $($entry.Name)"
      }
      $enabled = [bool]$task.Settings.Enabled
      $running = [string]$task.State -eq 'Running'
      if ($TaskDefinitionsOnly -and ($enabled -or $running)) {
        throw "Rollback task was not kept disabled behind the boot gate: $($entry.Name)"
      }
      if ($TaskEnablementOnly -and ($enabled -ne [bool]$entry.Enabled -or $running)) {
        throw "Rollback task enablement was not restored safely behind the boot gate: $($entry.Name)"
      }
      if (-not $TaskDefinitionsOnly -and -not $TaskEnablementOnly -and
          ($enabled -ne [bool]$entry.Enabled -or $running -ne [bool]$entry.Running)) {
        throw "Rollback did not restore task enabled/running state: $($entry.Name)"
      }
    }
  }
  return $true
}

function Set-PixelBrightnessUpgradeTaskEnablement {
  param(
    [Parameter(Mandatory = $true)][object]$Snapshot
  )
  foreach ($entry in @($Snapshot.Tasks | Where-Object { $_.Existed -eq $true })) {
    if ($entry.Enabled -eq $true) {
      Enable-ScheduledTask -TaskName ([string]$entry.Name) -ErrorAction Stop | Out-Null
    } else {
      Disable-ScheduledTask -TaskName ([string]$entry.Name) -ErrorAction Stop | Out-Null
    }
  }
}

function Start-PixelBrightnessUpgradePreviouslyRunningTasks {
  param(
    [Parameter(Mandatory = $true)][object]$Snapshot
  )
  foreach ($entry in @($Snapshot.Tasks | Where-Object { $_.Existed -eq $true -and $_.Running -eq $true })) {
    if ($entry.Enabled -ne $true) { Enable-ScheduledTask -TaskName ([string]$entry.Name) -ErrorAction Stop | Out-Null }
    Start-ScheduledTask -TaskName ([string]$entry.Name) -ErrorAction Stop
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(45)
    do {
      $task = Get-ScheduledTask -TaskName ([string]$entry.Name) -ErrorAction Stop
      if ([string]$task.State -eq 'Running') { break }
      Start-Sleep -Milliseconds 500
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    if ([string]$task.State -ne 'Running') {
      throw "Rollback task did not return to its prior Running state: $($entry.Name) (last state: $($task.State))"
    }
  }
  foreach ($entry in @($Snapshot.Tasks | Where-Object { $_.Existed -eq $true -and $_.Enabled -ne $true })) {
    Disable-ScheduledTask -TaskName ([string]$entry.Name) -ErrorAction Stop | Out-Null
  }
}

function Restore-PixelBrightnessUpgradeTaskStates {
  param(
    [Parameter(Mandatory = $true)][object]$Snapshot
  )
  Set-PixelBrightnessUpgradeTaskEnablement -Snapshot $Snapshot
  Start-PixelBrightnessUpgradePreviouslyRunningTasks -Snapshot $Snapshot
}

function Read-PixelBrightnessUpgradeSnapshot {
  param(
    [Parameter(Mandatory = $true)][string]$JournalPath,
    [string]$ExpectedTransactionId = '',
    [Parameter(Mandatory = $true)][string]$DataRoot
  )
  $JournalPath = Assert-PixelBrightnessUpgradeJournalLocation $JournalPath
  $journal = Assert-PixelBrightnessPlainFile $JournalPath 'Pixel Brightness upgrade journal'
  if ($null -eq $journal) { throw "Pixel Brightness upgrade journal is missing: $JournalPath" }
  $snapshotRoot = Split-Path $JournalPath -Parent
  $null = Assert-AdminProtectedDirectoryChain $snapshotRoot $env:ProgramData 'Pixel Brightness upgrade snapshot directory'
  $null = Assert-AdminProtectedControlTree $snapshotRoot 'Pixel Brightness upgrade snapshot tree'
  try { $snapshot = Get-Content -LiteralPath $JournalPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "Pixel Brightness upgrade journal is corrupt: $($_.Exception.Message)" }
  if ([int]$snapshot.SchemaVersion -ne 1) { throw 'Unsupported Pixel Brightness upgrade snapshot schema.' }
  $transactionId = Assert-PixelBrightnessUpgradeTransactionId ([string]$snapshot.TransactionId)
  if ($ExpectedTransactionId) {
    $expectedId = Assert-PixelBrightnessUpgradeTransactionId $ExpectedTransactionId
    if ($transactionId -cne $expectedId) { throw 'Upgrade gate and recovery journal transaction ids do not match.' }
  }
  if (-not [string]::Equals([IO.Path]::GetFullPath([string]$snapshot.Root).TrimEnd('\'), [IO.Path]::GetFullPath($snapshotRoot).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Upgrade journal root does not match its protected snapshot directory.'
  }
  if (-not [string]::Equals([IO.Path]::GetFullPath([string]$snapshot.DataRoot).TrimEnd('\'), [IO.Path]::GetFullPath($DataRoot).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Upgrade journal names a different Pixel Brightness data root.'
  }
  if ([string]::IsNullOrWhiteSpace([string]$snapshot.ShowUser)) { throw 'Upgrade journal is missing its Show user recovery identity.' }
  $currentAllowedFiles = @(Get-PixelBrightnessUpgradeControlFiles $DataRoot | ForEach-Object { [string]$_.Relative })
  $priorScheduleAllowedFiles = @($currentAllowedFiles | Where-Object { $_ -cne 'ArenaSaveEvidence.ps1' })
  $legacyAllowedFiles = @($priorScheduleAllowedFiles | Where-Object { $_ -cne 'ShowSchedule.ps1' })
  $actualFiles = @($snapshot.Files | ForEach-Object { [string]$_.Relative })
  $hasDuplicateFile = @($actualFiles | Group-Object | Where-Object Count -ne 1).Count -gt 0
  $isCurrentFileProfile = -not $hasDuplicateFile -and $actualFiles.Count -eq $currentAllowedFiles.Count -and
    @($currentAllowedFiles | Where-Object { $_ -cnotin $actualFiles }).Count -eq 0
  $isLegacyFileProfile = -not $hasDuplicateFile -and $actualFiles.Count -eq $legacyAllowedFiles.Count -and
    @($legacyAllowedFiles | Where-Object { $_ -cnotin $actualFiles }).Count -eq 0
  $isPriorScheduleFileProfile = -not $hasDuplicateFile -and $actualFiles.Count -eq $priorScheduleAllowedFiles.Count -and
    @($priorScheduleAllowedFiles | Where-Object { $_ -cnotin $actualFiles }).Count -eq 0
  if (-not $isCurrentFileProfile -and -not $isLegacyFileProfile -and -not $isPriorScheduleFileProfile) {
    throw 'Upgrade journal does not contain one record for every managed control file.'
  }
  $allowedFiles = if ($isCurrentFileProfile) { $currentAllowedFiles } elseif ($isPriorScheduleFileProfile) { $priorScheduleAllowedFiles } else { $legacyAllowedFiles }
  foreach ($relative in $allowedFiles) {
    if (@($actualFiles | Where-Object { $_ -ceq $relative }).Count -ne 1) {
      throw "Upgrade journal is missing or duplicated control file record: $relative"
    }
  }
  $fileRoot = Join-Path $snapshotRoot 'files'
  foreach ($entry in @($snapshot.Files)) {
    if ($entry.Existed -isnot [bool]) { throw "Upgrade journal file existence flag is invalid: $($entry.Relative)" }
    if ($entry.Existed -eq $true -and ([string]$entry.Sha256 -notmatch '^[0-9a-f]{64}$' -or [string]::IsNullOrWhiteSpace([string]$entry.Sddl))) {
      throw "Upgrade journal file digest/ACL contract is invalid: $($entry.Relative)"
    }
  }
  foreach ($entry in @($snapshot.Files | Where-Object { $_.Existed -eq $true })) {
    $location = Get-PathWithinAdminRoot ([string]$entry.Backup) $fileRoot "Upgrade backup $($entry.Relative)"
    if (-not (Test-Path -LiteralPath $location.Path -PathType Leaf)) { throw "Upgrade backup is missing: $($entry.Relative)" }
  }
  $currentAllowedTasks = @(Get-PixelBrightnessManagedTaskNames)
  $legacyAllowedTasks = @('PixelBrightness-Server', 'PixelBrightness-Web', 'PixelBrightness-Show')
  $allowedTasks = if ($isCurrentFileProfile) { $currentAllowedTasks } else { $legacyAllowedTasks }
  $actualTasks = @($snapshot.Tasks | ForEach-Object { [string]$_.Name })
  if ($actualTasks.Count -gt 0) {
    if ($actualTasks.Count -ne $allowedTasks.Count -or @($actualTasks | Group-Object | Where-Object Count -ne 1).Count -gt 0) {
      throw 'Upgrade journal does not contain one record for every managed scheduled task.'
    }
    foreach ($taskName in $allowedTasks) {
      if (@($actualTasks | Where-Object { $_ -ceq $taskName }).Count -ne 1) {
        throw "Upgrade journal is missing or duplicated scheduled task record: $taskName"
      }
    }
    foreach ($entry in @($snapshot.Tasks)) {
      if ($entry.Existed -isnot [bool] -or $entry.Enabled -isnot [bool] -or $entry.Running -isnot [bool]) {
        throw "Upgrade journal task-state contract is invalid: $($entry.Name)"
      }
      if ($entry.Existed -eq $true -and [string]$entry.XmlSha256 -notmatch '^[0-9a-f]{64}$') {
        throw "Upgrade journal task digest is invalid: $($entry.Name)"
      }
    }
    $taskRoot = Join-Path $snapshotRoot 'tasks'
    foreach ($entry in @($snapshot.Tasks | Where-Object { $_.Existed -eq $true })) {
      $location = Get-PathWithinAdminRoot ([string]$entry.XmlBackup) $taskRoot "Upgrade task backup $($entry.Name)"
      if (-not (Test-Path -LiteralPath $location.Path -PathType Leaf)) { throw "Upgrade task backup is missing: $($entry.Name)" }
    }
  }
  $firewallNames = @($snapshot.Firewall | ForEach-Object { [string]$_.DisplayName })
  if ($firewallNames.Count -ne 2) { throw 'Upgrade journal firewall snapshot must contain exactly two managed rules.' }
  foreach ($expected in @('Pixel Brightness Web Control', 'Pixel Brightness Control API')) {
    if (@($firewallNames | Where-Object { $_ -ceq $expected }).Count -ne 1) {
      throw "Upgrade journal firewall snapshot is missing or duplicated: $expected"
    }
  }
  foreach ($entry in @($snapshot.Firewall)) {
    $expectedPort = if ([string]$entry.DisplayName -ceq 'Pixel Brightness Web Control') { '3000' } else { '4100' }
    if ([string]$entry.Port -cne $expectedPort -or $entry.Existed -isnot [bool]) {
      throw "Upgrade journal firewall contract is invalid: $($entry.DisplayName)"
    }
  }
  if ($null -ne $snapshot.Power) {
    if ([string]$snapshot.Power.ActiveScheme -notmatch '^[0-9a-fA-F-]{36}$') { throw 'Upgrade journal power scheme id is invalid.' }
    $expectedPower = @{
      'standby-timeout-ac' = @('238C9FA8-0AAD-41ED-83F4-97BE242C8F20', '29F6C1DB-86DA-48C5-9FDB-F2B67B1F44DA')
      'monitor-timeout-ac' = @('7516B95F-F776-4464-8C53-06167F40CC99', '3C0BC021-C8A8-4E07-A973-6B14CBCB2B7E')
      'hibernate-timeout-ac' = @('238C9FA8-0AAD-41ED-83F4-97BE242C8F20', '9D7815A6-7EE4-497E-8888-515A05F02364')
      'disk-timeout-ac' = @('0012EE47-9041-4B5D-9B77-535FBA8B1442', '6738E2C4-E8A5-4A42-B16A-E040E769756E')
    }
    if (@($snapshot.Power.Settings).Count -ne $expectedPower.Count) { throw 'Upgrade journal power snapshot has an unexpected setting count.' }
    foreach ($entry in @($snapshot.Power.Settings)) {
      $contract = $expectedPower[[string]$entry.Name]
      if ($null -eq $contract -or [string]$entry.Subgroup -cne $contract[0] -or [string]$entry.Setting -cne $contract[1]) {
        throw "Upgrade journal power setting contract is invalid: $($entry.Name)"
      }
    }
  }
  $snapshot.TransactionId = $transactionId
  return $snapshot
}

function Test-PixelBrightnessUpgradeCommitRecord([string]$JournalPath) {
  $journal = Assert-PixelBrightnessPlainFile $JournalPath 'Pixel Brightness upgrade journal'
  if ($null -eq $journal) { return $false }
  $commitPath = Join-Path (Split-Path $JournalPath -Parent) 'commit.json'
  $commitItem = Assert-PixelBrightnessPlainFile $commitPath 'Pixel Brightness upgrade commit record'
  if ($null -eq $commitItem) { return $false }
  $null = Assert-AdminProtectedControlTree (Split-Path $JournalPath -Parent) 'Pixel Brightness committed upgrade journal tree'
  try {
    $snapshot = Get-Content -LiteralPath $JournalPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $commit = Get-Content -LiteralPath $commitPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  } catch { return $false }
  if ([int]$commit.schemaVersion -ne 1 -or $commit.healthVerified -ne $true) { return $false }
  try {
    $snapshotId = Assert-PixelBrightnessUpgradeTransactionId ([string]$snapshot.TransactionId)
    $commitId = Assert-PixelBrightnessUpgradeTransactionId ([string]$commit.transactionId)
  } catch { return $false }
  if ($snapshotId -cne $commitId -or [string]::IsNullOrWhiteSpace([string]$commit.releaseRoot)) { return $false }
  try {
    $releaseRoot = Assert-AdminProtectedReleaseLocation ([string]$commit.releaseRoot)
    $releaseManifest = Assert-PixelBrightnessReleaseManifest $releaseRoot
  }
  catch { return $false }
  if ([string]$commit.releaseManifestSha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$commit.releaseManifestSha256 -cne [string]$releaseManifest.ManifestSha256) { return $false }
  return ((Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes($journal.FullName))) -ceq [string]$commit.journalSha256)
}

function Test-PixelBrightnessUpgradeRecoveryRecord([string]$JournalPath) {
  $journal = Assert-PixelBrightnessPlainFile $JournalPath 'Pixel Brightness upgrade journal'
  if ($null -eq $journal) { return $false }
  $recordPath = Join-Path (Split-Path $JournalPath -Parent) 'recovery-complete.json'
  $recordItem = Assert-PixelBrightnessPlainFile $recordPath 'Pixel Brightness recovery completion record'
  if ($null -eq $recordItem) { return $false }
  $null = Assert-AdminProtectedControlTree (Split-Path $JournalPath -Parent) 'Pixel Brightness recovered upgrade journal tree'
  try {
    $snapshot = Get-Content -LiteralPath $JournalPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $record = Get-Content -LiteralPath $recordPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $snapshotId = Assert-PixelBrightnessUpgradeTransactionId ([string]$snapshot.TransactionId)
    $recordId = Assert-PixelBrightnessUpgradeTransactionId ([string]$record.transactionId)
  } catch { return $false }
  return ([int]$record.schemaVersion -eq 1 -and $record.restoredAndVerified -eq $true -and
    $snapshotId -ceq $recordId -and
    (Get-PixelBrightnessSha256 ([IO.File]::ReadAllBytes($journal.FullName))) -ceq [string]$record.journalSha256)
}

function Disable-PixelBrightnessManagedTasksForUpgrade {
  foreach ($taskName in @(Get-PixelBrightnessManagedTaskNames)) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -eq $task) { continue }
    Disable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Stop-PixelBrightnessTaskForRollback $taskName
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if ([string]$task.State -cne 'Disabled') {
      throw "Managed task was not durably disabled before control publication: $taskName ($($task.State))"
    }
  }
}

function Remove-PixelBrightnessUpgradeHealthTasks {
  foreach ($task in @(Get-PixelBrightnessUpgradeHealthTasks)) {
    Stop-PixelBrightnessTaskForRollback ([string]$task.TaskName)
    Unregister-ScheduledTask -TaskName ([string]$task.TaskName) -Confirm:$false -ErrorAction Stop
    if ($null -ne (Get-ScheduledTask -TaskName ([string]$task.TaskName) -ErrorAction SilentlyContinue)) {
      throw "Transient upgrade health task could not be removed: $($task.TaskName)"
    }
  }
}

function Wait-PixelBrightnessUpgradeListenersClosed([int]$TimeoutSeconds = 15) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { [int]$_.LocalPort -in @(3000, 4100) })
    if ($listeners.Count -eq 0) { return }
    Start-Sleep -Milliseconds 500
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw 'Pixel Brightness managed listeners remained open while the upgrade boot gate was active.'
}

function Set-PixelBrightnessUpgradeFailClosed {
  $failures = [System.Collections.Generic.List[string]]::new()
  foreach ($task in @(Get-PixelBrightnessUpgradeHealthTasks)) {
    try {
      Disable-ScheduledTask -TaskName ([string]$task.TaskName) -ErrorAction Stop | Out-Null
      Stop-ScheduledTask -TaskName ([string]$task.TaskName) -ErrorAction SilentlyContinue
      Stop-PixelBrightnessTaskForRollback ([string]$task.TaskName)
    } catch { $failures.Add("$($task.TaskName): $($_.Exception.Message)") }
  }
  foreach ($taskName in @(Get-PixelBrightnessManagedTaskNames)) {
    try {
      $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      if ($null -eq $task) { continue }
      Disable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
      Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      Stop-PixelBrightnessTaskForRollback $taskName
    } catch { $failures.Add("${taskName}: $($_.Exception.Message)") }
  }
  foreach ($renderer in @(Get-Process 'pixel-brightness-renderer' -ErrorAction SilentlyContinue)) {
    try { Stop-Process -Id $renderer.Id -Force -ErrorAction Stop }
    catch { $failures.Add("renderer PID $($renderer.Id): $($_.Exception.Message)") }
  }
  $listeners = @()
  try { $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { [int]$_.LocalPort -in @(3000, 4100) }) }
  catch { $failures.Add("listener enumeration: $($_.Exception.Message)") }
  foreach ($listener in $listeners) {
    try {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction Stop
      if ([string]$process.CommandLine -notmatch '(?:runtime[\\/]server[\\/]index\.mjs|scripts[\\/]run-vinext\.mjs.*start|vinext[\\/].*cli\.js.*start)') {
        throw 'listener command is not provably owned by Pixel Brightness'
      }
      Stop-Process -Id ([int]$listener.OwningProcess) -Force -ErrorAction Stop
    } catch { $failures.Add("port $($listener.LocalPort)/PID$($listener.OwningProcess): $($_.Exception.Message)") }
  }
  foreach ($displayName in @('Pixel Brightness Web Control', 'Pixel Brightness Control API')) {
    try {
      foreach ($rule in @(Get-NetFirewallRule -DisplayName $displayName -ErrorAction SilentlyContinue)) {
        Remove-NetFirewallRule -InputObject $rule -ErrorAction Stop
      }
      if (@(Get-NetFirewallRule -DisplayName $displayName -ErrorAction SilentlyContinue).Count -ne 0) {
        throw 'managed inbound firewall rule is still present'
      }
    } catch { $failures.Add("firewall ${displayName}: $($_.Exception.Message)") }
  }
  foreach ($taskName in @(Get-PixelBrightnessManagedTaskNames)) {
    try {
      $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      if ($null -ne $task -and [string]$task.State -cne 'Disabled') {
        throw "state is $($task.State), expected Disabled"
      }
    } catch { $failures.Add("${taskName}: $($_.Exception.Message)") }
  }
  foreach ($task in @(Get-PixelBrightnessUpgradeHealthTasks)) {
    if ([string]$task.State -cne 'Disabled') { $failures.Add("$($task.TaskName): state is $($task.State), expected Disabled") }
  }
  if (@(Get-Process 'pixel-brightness-renderer' -ErrorAction SilentlyContinue).Count -ne 0) {
    $failures.Add('native renderer process is still running')
  }
  try { Wait-PixelBrightnessUpgradeListenersClosed 15 }
  catch { $failures.Add("listener closure: $($_.Exception.Message)") }
  if ($failures.Count -gt 0) {
    throw "Pixel Brightness recovery is unresolved and fail-closed enforcement was incomplete: $($failures -join '; ')"
  }
}
