[CmdletBinding()]
param()

Set-StrictMode -Version Latest

# PixelBrightnessCameraRuntimeAuthorityContract:v1

$script:PixelBrightnessCameraManifestName = 'camera-runtime.manifest.json'
$script:PixelBrightnessCameraRuntimeMaxFiles = 512
$script:PixelBrightnessCameraRuntimeMaxBytes = [int64]4GB

function Get-PixelBrightnessCameraAuthorityRoot([string]$DataRoot) {
  return (Join-Path $DataRoot 'camera-runtime')
}

function Get-PixelBrightnessCameraAuthorityPath([string]$DataRoot) {
  return (Join-Path (Get-PixelBrightnessCameraAuthorityRoot $DataRoot) 'active.json')
}

function Get-PixelBrightnessCameraTransactionGatePath([string]$DataRoot) {
  return (Join-Path (Get-PixelBrightnessCameraAuthorityRoot $DataRoot) 'in-progress.json')
}

function Get-PixelBrightnessCameraTransactionRoot([string]$DataRoot, [string]$TransactionId) {
  return (Join-Path (Join-Path (Get-PixelBrightnessCameraAuthorityRoot $DataRoot) 'transactions') $TransactionId)
}

function Get-PixelBrightnessCameraGenerationsRoot([string]$InstallRoot) {
  return (Join-Path $InstallRoot 'camera-runtimes\canon-edsdk')
}

function Assert-PixelBrightnessCameraTransactionId([string]$TransactionId) {
  $parsed = [guid]::Empty
  if (-not [guid]::TryParseExact($TransactionId, 'D', [ref]$parsed) -or $parsed -eq [guid]::Empty) {
    throw "Camera-runtime transaction id is invalid: $TransactionId"
  }
  return $parsed.ToString('D')
}

function Assert-PixelBrightnessCameraExactObject([object]$Value, [string[]]$Properties, [string]$Label) {
  if ($null -eq $Value) { throw "$Label must be an object." }
  # Constructors return ordered dictionaries; JSON readers return PSCustomObject.
  # Dictionary PSObject properties describe the collection, not the document keys.
  $actual = if ($Value -is [System.Collections.IDictionary]) {
    @($Value.Keys | Sort-Object)
  } else {
    @($Value.PSObject.Properties.Name | Sort-Object)
  }
  $expected = @($Properties | Sort-Object)
  if ($actual.Count -ne $expected.Count) { throw "$Label has an unexpected property count." }
  for ($index = 0; $index -lt $expected.Count; $index += 1) {
    if ([string]$actual[$index] -cne [string]$expected[$index]) {
      throw "$Label must contain exactly: $($expected -join ', ')"
    }
  }
  return $Value
}

function Assert-PixelBrightnessCameraCanonicalText(
  [object]$Value,
  [string]$Label,
  [int]$Maximum = 128,
  [switch]$AllowNull
) {
  if ($null -eq $Value -and $AllowNull) { return $null }
  $text = [string]$Value
  if ([string]::IsNullOrWhiteSpace($text) -or $text.Length -gt $Maximum -or $text -cne $text.Trim() -or
      $text.IndexOf([char]0) -ge 0) {
    throw "$Label is not a canonical 1-$Maximum character value."
  }
  return $text
}

function New-PixelBrightnessCameraProfile([string]$Profile = 'CanonR50RfS1018') {
  switch ($Profile) {
    'CanonR50RfS1018' {
      return [ordered]@{
        id = 'canon-eos-r50-rfs-10-18-v1'
        camera = [ordered]@{ vendor = 'Canon'; model = 'EOS R50'; serialNumber = $null }
        lens = [ordered]@{
          vendor = 'Canon'
          model = 'RF-S10-18mm F4.5-6.3 IS STM'
          serialNumber = $null
          mount = 'RF'
          focalLengthMm = 10.0
        }
      }
    }
    'SonyA7IV' {
      return [ordered]@{
        id = 'sony-a7iv-fe-16-35-v1'
        camera = [ordered]@{ vendor = 'Sony'; model = 'ILCE-7M4'; serialNumber = $null }
        lens = [ordered]@{
          vendor = 'Sony'
          model = 'FE 16-35mm F2.8 GM II'
          serialNumber = $null
          mount = 'E'
          focalLengthMm = 16.0
        }
      }
    }
    'Disabled' {
      return [ordered]@{
        id = 'disabled'
        camera = [ordered]@{ vendor = 'None'; model = 'Disabled'; serialNumber = $null }
        lens = [ordered]@{
          vendor = 'None'
          model = 'Disabled'
          serialNumber = $null
          mount = 'none'
          focalLengthMm = 1.0
        }
      }
    }
    default { throw "Unknown camera profile: $Profile" }
  }
}

function Assert-PixelBrightnessCameraProfile([object]$Profile) {
  $null = Assert-PixelBrightnessCameraExactObject $Profile @('id', 'camera', 'lens') 'Camera profile'
  $null = Assert-PixelBrightnessCameraExactObject $Profile.camera @('vendor', 'model', 'serialNumber') 'Camera profile body'
  $null = Assert-PixelBrightnessCameraExactObject $Profile.lens @(
    'vendor', 'model', 'serialNumber', 'mount', 'focalLengthMm'
  ) 'Camera profile lens'
  $profileId = Assert-PixelBrightnessCameraCanonicalText $Profile.id 'Camera profile id' 128
  if ($profileId -notin @('canon-eos-r50-rfs-10-18-v1', 'sony-a7iv-fe-16-35-v1', 'disabled')) {
    throw "Camera profile id is unsupported: $profileId"
  }
  $null = Assert-PixelBrightnessCameraCanonicalText $Profile.camera.vendor 'Camera vendor'
  $null = Assert-PixelBrightnessCameraCanonicalText $Profile.camera.model 'Camera model'
  $null = Assert-PixelBrightnessCameraCanonicalText $Profile.camera.serialNumber 'Camera serial number' 128 -AllowNull
  $null = Assert-PixelBrightnessCameraCanonicalText $Profile.lens.vendor 'Lens vendor'
  $null = Assert-PixelBrightnessCameraCanonicalText $Profile.lens.model 'Lens model'
  $null = Assert-PixelBrightnessCameraCanonicalText $Profile.lens.serialNumber 'Lens serial number' 128 -AllowNull
  $null = Assert-PixelBrightnessCameraCanonicalText $Profile.lens.mount 'Lens mount' 32
  $focalLength = [double]$Profile.lens.focalLengthMm
  if ([double]::IsNaN($focalLength) -or [double]::IsInfinity($focalLength) -or
      $focalLength -lt 1 -or $focalLength -gt 2000) {
    throw 'Camera profile focal length is invalid.'
  }
  if ($profileId -ceq 'canon-eos-r50-rfs-10-18-v1' -and
      ([string]$Profile.camera.vendor -cne 'Canon' -or [string]$Profile.camera.model -cne 'EOS R50' -or
       [string]$Profile.lens.vendor -cne 'Canon' -or
       [string]$Profile.lens.model -cne 'RF-S10-18mm F4.5-6.3 IS STM' -or
       [string]$Profile.lens.mount -cne 'RF' -or $focalLength -ne 10.0)) {
    throw 'Canon R50 profile does not match the locked R50 + RF-S 10-18 identity.'
  }
  return $Profile
}

function New-PixelBrightnessUnconfiguredCameraAuthority {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [ValidateSet('CanonR50RfS1018', 'SonyA7IV', 'Disabled')][string]$Profile = 'CanonR50RfS1018'
  )
  $profileValue = New-PixelBrightnessCameraProfile $Profile
  $backend = switch ($Profile) {
    'CanonR50RfS1018' { 'canon-edsdk' }
    'SonyA7IV' { 'sony-sdk' }
    default { 'disabled' }
  }
  return [ordered]@{
    schemaVersion = 1
    state = 'unconfigured'
    backend = $backend
    profile = $profileValue
    generationRoot = $null
    manifestPath = $null
    manifestSha256 = $null
    helperPath = $null
    helperSha256 = $null
    sdkEntryDllPath = $null
    sdkEntryDllSha256 = $null
    cameraCaptureDir = (Join-Path $DataRoot 'state\node\camera-captures')
    helperTimeoutMs = 30000
    configuredAt = $null
  }
}

function Assert-PixelBrightnessCameraRelativePath([string]$Value, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -cne $Value.Trim() -or
      $Value.StartsWith('/') -or $Value.StartsWith('\') -or $Value.Contains('\') -or $Value.Contains(':')) {
    throw "$Label is not a canonical forward-slash relative path: $Value"
  }
  $segments = @($Value -split '/')
  if (@($segments | Where-Object { [string]::IsNullOrWhiteSpace($_) -or $_ -in @('.', '..') }).Count -gt 0) {
    throw "$Label contains an unsafe path segment: $Value"
  }
  return $Value
}

function Get-PixelBrightnessCameraSha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}

function Assert-PixelBrightnessX64Pe([string]$Path, [string]$Label) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 256 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
    throw "$Label is not a Windows PE file: $Path"
  }
  $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
  if ($peOffset -lt 0 -or $peOffset + 6 -gt $bytes.Length -or
      $bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45 -or
      [BitConverter]::ToUInt16($bytes, $peOffset + 4) -ne 0x8664) {
    throw "$Label is not an x64 Windows PE file: $Path"
  }
  return $Path
}

function Read-PixelBrightnessCameraJson([string]$Path, [string]$Label) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $item.Length -le 0 -or $item.Length -gt 4MB) {
    throw "$Label must be one bounded regular file: $Path"
  }
  try {
    $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
    return ($strictUtf8.GetString([IO.File]::ReadAllBytes($item.FullName)) | ConvertFrom-Json -ErrorAction Stop)
  } catch {
    throw "$Label is not valid strict UTF-8 JSON: $($_.Exception.Message)"
  }
}

function Assert-PixelBrightnessCameraRuntimeManifest {
  param(
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [string]$ExpectedManifestSha256 = '',
    [switch]$RequireProtected
  )
  $root = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $RuntimeRoot -ErrorAction Stop).Path).TrimEnd('\')
  $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop
  if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Camera runtime root must be one real directory: $root"
  }
  if ($RequireProtected) {
    $null = Assert-AdminProtectedDirectoryChain $root $env:ProgramFiles 'Pixel Brightness camera runtime'
    $null = Assert-AdminProtectedControlTree $root 'Pixel Brightness camera runtime'
  } else {
    $null = Get-NonReparseTree $root 'Camera runtime source'
  }
  $manifestPath = Join-Path $root $script:PixelBrightnessCameraManifestName
  $manifest = Read-PixelBrightnessCameraJson $manifestPath 'Camera runtime manifest'
  $manifestSha256 = Get-PixelBrightnessCameraSha256 $manifestPath
  if (-not [string]::IsNullOrWhiteSpace($ExpectedManifestSha256)) {
    $expected = $ExpectedManifestSha256.Trim().ToLowerInvariant()
    if ($expected -notmatch '^[a-f0-9]{64}$' -or $manifestSha256 -cne $expected) {
      throw "Camera runtime manifest digest mismatch: expected $expected, found $manifestSha256"
    }
  }
  $null = Assert-PixelBrightnessCameraExactObject $manifest @(
    'schemaVersion', 'runtimeId', 'backend', 'architecture', 'helperRelativePath',
    'sdkEntryDllRelativePath', 'files'
  ) 'Camera runtime manifest'
  if ([int]$manifest.schemaVersion -ne 1 -or [string]$manifest.backend -cne 'canon-edsdk' -or
      [string]$manifest.architecture -cne 'x64') {
    throw 'Camera runtime manifest must be canon-edsdk schema v1 for x64.'
  }
  $runtimeId = Assert-PixelBrightnessCameraTransactionId ([string]$manifest.runtimeId)
  $helperRelative = Assert-PixelBrightnessCameraRelativePath ([string]$manifest.helperRelativePath) 'Camera helper path'
  $sdkRelative = Assert-PixelBrightnessCameraRelativePath ([string]$manifest.sdkEntryDllRelativePath) 'EDSDK entry DLL path'
  if ([IO.Path]::GetFileName($sdkRelative) -ine 'EDSDK.dll') {
    throw 'Camera runtime manifest must select exactly EDSDK.dll as its SDK entry DLL.'
  }
  $entries = @($manifest.files)
  if ($entries.Count -lt 2 -or $entries.Count -gt $script:PixelBrightnessCameraRuntimeMaxFiles) {
    throw "Camera runtime manifest must contain 2-$script:PixelBrightnessCameraRuntimeMaxFiles files."
  }
  $byPath = @{}
  [int64]$totalBytes = 0
  foreach ($entry in $entries) {
    $null = Assert-PixelBrightnessCameraExactObject $entry @('path', 'byteLength', 'sha256') 'Camera runtime file entry'
    $relative = Assert-PixelBrightnessCameraRelativePath ([string]$entry.path) 'Camera runtime file path'
    $folded = $relative.ToUpperInvariant()
    if ($byPath.ContainsKey($folded)) { throw "Camera runtime manifest has a duplicate path: $relative" }
    $length = [int64]$entry.byteLength
    $digest = [string]$entry.sha256
    if ($length -lt 1 -or $length -gt 1GB -or $digest -notmatch '^[a-f0-9]{64}$') {
      throw "Camera runtime manifest has an invalid size or SHA-256: $relative"
    }
    $totalBytes += $length
    if ($totalBytes -gt $script:PixelBrightnessCameraRuntimeMaxBytes) {
      throw 'Camera runtime exceeds the 4 GiB bounded inventory.'
    }
    $byPath[$folded] = [pscustomobject]@{ Relative = $relative; Length = $length; Sha256 = $digest }
  }
  foreach ($required in @($helperRelative, $sdkRelative)) {
    if (-not $byPath.ContainsKey($required.ToUpperInvariant())) {
      throw "Camera runtime manifest omits required executable: $required"
    }
  }
  $treeFiles = @(Get-NonReparseTree $root 'Camera runtime inventory' | Where-Object { -not $_.PSIsContainer })
  $actual = @{}
  $rootPrefix = $root + '\'
  foreach ($file in $treeFiles) {
    if (-not $file.FullName.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Camera runtime inventory escaped its root: $($file.FullName)"
    }
    $relative = $file.FullName.Substring($rootPrefix.Length).Replace('\', '/')
    if ($relative -ceq $script:PixelBrightnessCameraManifestName) { continue }
    $folded = $relative.ToUpperInvariant()
    if ($actual.ContainsKey($folded)) { throw "Camera runtime has a case-colliding file: $relative" }
    $actual[$folded] = [pscustomobject]@{ Relative = $relative; FullName = $file.FullName; Length = [int64]$file.Length }
  }
  if ($actual.Count -ne $byPath.Count) {
    throw "Camera runtime inventory differs from its manifest: expected $($byPath.Count), found $($actual.Count)."
  }
  foreach ($folded in $byPath.Keys) {
    $expectedEntry = $byPath[$folded]
    if (-not $actual.ContainsKey($folded)) { throw "Camera runtime file is missing: $($expectedEntry.Relative)" }
    $file = $actual[$folded]
    if ([string]$file.Relative -cne [string]$expectedEntry.Relative -or
        [int64]$file.Length -ne [int64]$expectedEntry.Length -or
        (Get-PixelBrightnessCameraSha256 $file.FullName) -cne [string]$expectedEntry.Sha256) {
      throw "Camera runtime file failed exact path, size, or digest verification: $($expectedEntry.Relative)"
    }
  }
  $helperPath = [IO.Path]::GetFullPath((Join-Path $root $helperRelative.Replace('/', '\')))
  $sdkEntryDllPath = [IO.Path]::GetFullPath((Join-Path $root $sdkRelative.Replace('/', '\')))
  $null = Assert-PixelBrightnessX64Pe $helperPath 'Canon camera helper'
  $null = Assert-PixelBrightnessX64Pe $sdkEntryDllPath 'Canon EDSDK entry DLL'
  return [pscustomobject]@{
    RuntimeId = $runtimeId
    RuntimeRoot = $root
    ManifestPath = $manifestPath
    ManifestSha256 = $manifestSha256
    HelperPath = $helperPath
    HelperSha256 = [string]$byPath[$helperRelative.ToUpperInvariant()].Sha256
    SdkEntryDllPath = $sdkEntryDllPath
    SdkEntryDllSha256 = [string]$byPath[$sdkRelative.ToUpperInvariant()].Sha256
    FileCount = $byPath.Count
    TotalBytes = $totalBytes
  }
}

function Assert-PixelBrightnessCameraAuthorityObject {
  param(
    [Parameter(Mandatory = $true)][object]$Authority,
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'Pixel Brightness'),
    [switch]$RequireConfigured
  )
  $null = Assert-PixelBrightnessCameraExactObject $Authority @(
    'schemaVersion', 'state', 'backend', 'profile', 'generationRoot', 'manifestPath',
    'manifestSha256', 'helperPath', 'helperSha256', 'sdkEntryDllPath',
    'sdkEntryDllSha256', 'cameraCaptureDir', 'helperTimeoutMs', 'configuredAt'
  ) 'Camera runtime authority'
  if ([int]$Authority.schemaVersion -ne 1 -or [string]$Authority.state -notin @('unconfigured', 'configured')) {
    throw 'Camera runtime authority must be schema v1 in configured or unconfigured state.'
  }
  $profile = Assert-PixelBrightnessCameraProfile $Authority.profile
  $expectedBackend = switch ([string]$profile.id) {
    'canon-eos-r50-rfs-10-18-v1' { 'canon-edsdk' }
    'sony-a7iv-fe-16-35-v1' { 'sony-sdk' }
    default { 'disabled' }
  }
  if ([string]$Authority.backend -cne $expectedBackend) { throw 'Camera authority backend does not match its exact profile.' }
  $captureDir = [IO.Path]::GetFullPath([string]$Authority.cameraCaptureDir)
  $expectedCaptureRoot = [IO.Path]::GetFullPath((Join-Path $DataRoot 'state\node')).TrimEnd('\') + '\'
  if (-not $captureDir.StartsWith($expectedCaptureRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Camera capture directory escaped the protected Node state root.'
  }
  $timeoutMs = [int]$Authority.helperTimeoutMs
  if ($timeoutMs -lt 1000 -or $timeoutMs -gt 300000) { throw 'Camera helper timeout is outside 1-300 seconds.' }
  if ([string]$Authority.state -ceq 'unconfigured') {
    foreach ($property in @('generationRoot', 'manifestPath', 'manifestSha256', 'helperPath', 'helperSha256',
      'sdkEntryDllPath', 'sdkEntryDllSha256', 'configuredAt')) {
      if ($null -ne $Authority.$property) { throw "Unconfigured camera authority must leave $property null." }
    }
    if ($RequireConfigured) { throw 'Canon camera runtime is not configured.' }
    return [pscustomobject]@{ State = 'unconfigured'; Authority = $Authority; Runtime = $null }
  }
  if ($expectedBackend -cne 'canon-edsdk') {
    throw 'Only canon-edsdk may use the external camera-runtime authority; Sony remains an explicit legacy release helper.'
  }
  if ([string]::IsNullOrWhiteSpace([string]$profile.camera.serialNumber)) {
    throw 'Configured Canon authority must bind the exact EOS R50 serial number.'
  }
  $generationRoot = [IO.Path]::GetFullPath([string]$Authority.generationRoot).TrimEnd('\')
  $allowedRoot = [IO.Path]::GetFullPath((Get-PixelBrightnessCameraGenerationsRoot $InstallRoot)).TrimEnd('\') + '\'
  if (-not $generationRoot.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Configured Canon generation escaped the protected Pixel Brightness camera-runtimes root.'
  }
  $runtime = Assert-PixelBrightnessCameraRuntimeManifest -RuntimeRoot $generationRoot `
    -ExpectedManifestSha256 ([string]$Authority.manifestSha256) -RequireProtected
  foreach ($comparison in @(
    @{ Actual = [string]$Authority.manifestPath; Expected = [string]$runtime.ManifestPath; Label = 'manifest path' },
    @{ Actual = [string]$Authority.helperPath; Expected = [string]$runtime.HelperPath; Label = 'helper path' },
    @{ Actual = [string]$Authority.sdkEntryDllPath; Expected = [string]$runtime.SdkEntryDllPath; Label = 'EDSDK entry DLL path' }
  )) {
    if (-not [string]::Equals([IO.Path]::GetFullPath($comparison.Actual), [IO.Path]::GetFullPath($comparison.Expected), [StringComparison]::OrdinalIgnoreCase)) {
      throw "Camera authority $($comparison.Label) differs from its verified generation."
    }
  }
  if ([string]$Authority.helperSha256 -cne [string]$runtime.HelperSha256 -or
      [string]$Authority.sdkEntryDllSha256 -cne [string]$runtime.SdkEntryDllSha256) {
    throw 'Camera authority helper or EDSDK digest differs from its verified generation.'
  }
  try { $null = [DateTimeOffset]::ParseExact([string]$Authority.configuredAt, 'o', [Globalization.CultureInfo]::InvariantCulture) }
  catch { throw 'Configured Canon authority has an invalid configuredAt timestamp.' }
  return [pscustomobject]@{ State = 'configured'; Authority = $Authority; Runtime = $runtime }
}

function Read-PixelBrightnessCameraRuntimeAuthority {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'Pixel Brightness'),
    [switch]$AllowMissing,
    [switch]$RequireConfigured
  )
  $path = Get-PixelBrightnessCameraAuthorityPath $DataRoot
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    if ($AllowMissing) { return $null }
    throw "Camera runtime authority is missing: $path"
  }
  $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
  $null = Assert-AdminProtectedItem $item 'Pixel Brightness camera runtime authority'
  $authority = Read-PixelBrightnessCameraJson $path 'Camera runtime authority'
  $verified = Assert-PixelBrightnessCameraAuthorityObject -Authority $authority -DataRoot $DataRoot `
    -InstallRoot $InstallRoot -RequireConfigured:$RequireConfigured
  $verified | Add-Member -NotePropertyName AuthorityPath -NotePropertyValue $path -Force
  return $verified
}

function Assert-PixelBrightnessCameraLauncherGate([string]$DataRoot) {
  $gatePath = Get-PixelBrightnessCameraTransactionGatePath $DataRoot
  if (-not (Test-Path -LiteralPath $gatePath)) { return $null }
  $item = Get-Item -LiteralPath $gatePath -Force -ErrorAction Stop
  $null = Assert-AdminProtectedItem $item 'Pixel Brightness camera-runtime transaction gate'
  $gate = Read-PixelBrightnessCameraJson $gatePath 'Camera-runtime transaction gate'
  $null = Assert-PixelBrightnessCameraExactObject $gate @(
    'schemaVersion', 'transactionId', 'journalPath', 'phase', 'createdAt'
  ) 'Camera-runtime transaction gate'
  if ([int]$gate.schemaVersion -ne 1) { throw 'Camera-runtime transaction gate schema is unsupported.' }
  $null = Assert-PixelBrightnessCameraTransactionId ([string]$gate.transactionId)
  throw 'PixelBrightness-Show startup is blocked by an in-progress Canon camera-runtime transaction. Re-run the Canon provisioner locally as Administrator.'
}

function Write-PixelBrightnessCameraAuthority {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$ShowUser,
    [Parameter(Mandatory = $true)][object]$Authority,
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'Pixel Brightness')
  )
  $null = Assert-PixelBrightnessCameraAuthorityObject -Authority $Authority -DataRoot $DataRoot -InstallRoot $InstallRoot
  $root = Get-PixelBrightnessCameraAuthorityRoot $DataRoot
  $null = Initialize-AdminProtectedDirectory $root $env:ProgramData $ShowUser 'Pixel Brightness camera authority root'
  $path = Get-PixelBrightnessCameraAuthorityPath $DataRoot
  $bytes = ConvertTo-PixelBrightnessUtf8JsonBytes -Value $Authority -Depth 20
  Write-PixelBrightnessAtomicBytes $path $bytes
  $null = Protect-AdminControlPath -Path $path -ShowUser $ShowUser -ShowAccess Read -Label 'Pixel Brightness camera runtime authority'
  $null = Read-PixelBrightnessCameraRuntimeAuthority -DataRoot $DataRoot -InstallRoot $InstallRoot
  return $path
}

function Clear-PixelBrightnessCameraEnvironment {
  foreach ($name in @(
    'PIXEL_BRIGHTNESS_CAMERA_BACKEND', 'PIXEL_BRIGHTNESS_CAMERA_HELPER_COMMAND',
    'PIXEL_BRIGHTNESS_CAMERA_HELPER_TIMEOUT_MS', 'PIXEL_BRIGHTNESS_CAMERA_CAPTURE_DIR',
    'PIXEL_BRIGHTNESS_CAMERA_EXPECTED_MODEL', 'PIXEL_BRIGHTNESS_CAMERA_EXPECTED_SERIAL',
    'PIXEL_BRIGHTNESS_CAMERA_EXPECTED_LENS_MODEL', 'PIXEL_BRIGHTNESS_CAMERA_EXPECTED_LENS_SERIAL',
    'PIXEL_BRIGHTNESS_CAMERA_EXPECTED_FOCAL_LENGTH_MM',
    'PIXEL_BRIGHTNESS_CAMERA_RUNTIME_MANIFEST', 'PIXEL_BRIGHTNESS_CAMERA_RUNTIME_MANIFEST_PATH'
  )) {
    Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
  }
}

function Set-PixelBrightnessCameraEnvironment {
  param([Parameter(Mandatory = $true)][object]$VerifiedAuthority)
  Clear-PixelBrightnessCameraEnvironment
  $authority = $VerifiedAuthority.Authority
  $env:PIXEL_BRIGHTNESS_CAMERA_BACKEND = [string]$authority.backend
  $env:PIXEL_BRIGHTNESS_CAMERA_HELPER_TIMEOUT_MS = [string]$authority.helperTimeoutMs
  $env:PIXEL_BRIGHTNESS_CAMERA_CAPTURE_DIR = [string]$authority.cameraCaptureDir
  $env:PIXEL_BRIGHTNESS_CAMERA_EXPECTED_MODEL = [string]$authority.profile.camera.model
  if ($null -ne $authority.profile.camera.serialNumber) {
    $env:PIXEL_BRIGHTNESS_CAMERA_EXPECTED_SERIAL = [string]$authority.profile.camera.serialNumber
  }
  $env:PIXEL_BRIGHTNESS_CAMERA_EXPECTED_LENS_MODEL = [string]$authority.profile.lens.model
  if ($null -ne $authority.profile.lens.serialNumber) {
    $env:PIXEL_BRIGHTNESS_CAMERA_EXPECTED_LENS_SERIAL = [string]$authority.profile.lens.serialNumber
  }
  $env:PIXEL_BRIGHTNESS_CAMERA_EXPECTED_FOCAL_LENGTH_MM = [string]$authority.profile.lens.focalLengthMm
  if ([string]$VerifiedAuthority.State -ceq 'configured') {
    $env:PIXEL_BRIGHTNESS_CAMERA_HELPER_COMMAND = [string]$authority.helperPath
    $env:PIXEL_BRIGHTNESS_CAMERA_RUNTIME_MANIFEST_PATH = [string]$authority.manifestPath
  }
}
