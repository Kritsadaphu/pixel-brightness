[CmdletBinding()]
param()

function Invoke-PixelBrightnessElevatedBootstrap {
  param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$ExpectedManifestSha256,
    [Parameter(Mandatory = $true)][string]$SetupOptionsBase64
  )

  $ErrorActionPreference = 'Stop'
  Set-StrictMode -Version Latest

  function Protect-BootstrapDirectory([string]$Path, [string]$Label) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label must be one real directory: $Path"
    }
    $administrators = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($administrators)
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
      [Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($sid in @($system, $administrators)) {
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $sid,
        [Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
      ))
    }
    Set-Acl -LiteralPath $item.FullName -AclObject $acl -ErrorAction Stop
    $verified = Get-Item -LiteralPath $item.FullName -Force -ErrorAction Stop
    $verifiedAcl = Get-Acl -LiteralPath $verified.FullName -ErrorAction Stop
    $owner = $verifiedAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -ne $administrators.Value -or -not $verifiedAcl.AreAccessRulesProtected) {
      throw "$Label owner/DACL could not be protected: $($verified.FullName)"
    }
    $writeMask = [Security.AccessControl.FileSystemRights]::WriteData -bor `
      [Security.AccessControl.FileSystemRights]::AppendData -bor `
      [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor `
      [Security.AccessControl.FileSystemRights]::WriteAttributes -bor `
      [Security.AccessControl.FileSystemRights]::Delete -bor `
      [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor `
      [Security.AccessControl.FileSystemRights]::ChangePermissions -bor `
      [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $verifiedAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
          ($rule.FileSystemRights -band $writeMask) -ne 0 -and
          $rule.IdentityReference.Value -notin @($system.Value, $administrators.Value)) {
        throw "$Label grants write access to a non-privileged trustee: $($rule.IdentityReference.Value)"
      }
    }
  }

  function Get-CanonicalManifestEntries([string]$ManifestPath) {
    $entries = [Collections.Generic.List[object]]::new()
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $lines = [IO.File]::ReadAllLines($ManifestPath, [Text.Encoding]::UTF8)
    if ($lines.Count -lt 1 -or $lines.Count -gt 10000) {
      throw 'Bootstrap source manifest must contain 1-10000 entries.'
    }
    foreach ($line in $lines) {
      if ($line -notmatch '^([a-f0-9]{64})  (.+)$') {
        throw "Bootstrap source manifest contains a non-canonical line: $line"
      }
      $relative = $Matches[2]
      $segments = @($relative -split '/')
      if ($relative -ne $relative.Trim() -or $relative.StartsWith('/') -or $relative.Contains('\') -or
          $relative.Contains(':') -or @($segments | Where-Object { -not $_ -or $_ -in @('.', '..') }).Count -gt 0 -or
          [string]::Equals($relative, 'MANIFEST-SHA256.txt', [StringComparison]::OrdinalIgnoreCase) -or
          -not $seen.Add($relative)) {
        throw "Bootstrap source manifest contains an unsafe or duplicate path: $relative"
      }
      [void]$entries.Add([pscustomobject]@{ Relative = $relative; Sha256 = $Matches[1] })
    }
    return @($entries)
  }

  $source = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $SourceRoot -ErrorAction Stop).Path).TrimEnd('\')
  $expectedManifest = $ExpectedManifestSha256.Trim().ToLowerInvariant()
  if ($expectedManifest -notmatch '^[a-f0-9]{64}$') { throw 'Bootstrap expected manifest SHA-256 is invalid.' }
  $sourceManifest = Join-Path $source 'MANIFEST-SHA256.txt'
  $sourceManifestItem = Get-Item -LiteralPath $sourceManifest -Force -ErrorAction Stop
  if ($sourceManifestItem.PSIsContainer -or
      ($sourceManifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $sourceManifestItem.Length -le 0 -or $sourceManifestItem.Length -gt 8MB) {
    throw "Bootstrap source manifest must be one bounded regular file: $sourceManifest"
  }
  $observedManifest = (Get-FileHash -LiteralPath $sourceManifest -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
  if (-not [string]::Equals($observedManifest, $expectedManifest, [StringComparison]::Ordinal)) {
    throw "Source manifest changed before protected elevation staging: expected $expectedManifest, found $observedManifest"
  }

  $bootstrapParent = Join-Path $env:ProgramData 'Pixel Brightness Bootstrap'
  if (-not (Test-Path -LiteralPath $bootstrapParent)) {
    New-Item -ItemType Directory -Path $bootstrapParent -ErrorAction Stop | Out-Null
  }
  Protect-BootstrapDirectory $bootstrapParent 'Pixel Brightness bootstrap parent'
  $stageRoot = Join-Path $bootstrapParent "source-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $stageRoot -ErrorAction Stop | Out-Null
  Protect-BootstrapDirectory $stageRoot 'Pixel Brightness protected bootstrap source'
  if (@(Get-ChildItem -LiteralPath $stageRoot -Force -ErrorAction Stop).Count -ne 0) {
    throw "New protected bootstrap source was not empty: $stageRoot"
  }

  try {
    $stageManifest = Join-Path $stageRoot 'MANIFEST-SHA256.txt'
    Copy-Item -LiteralPath $sourceManifest -Destination $stageManifest -ErrorAction Stop
    $copiedManifest = (Get-FileHash -LiteralPath $stageManifest -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    if (-not [string]::Equals($copiedManifest, $expectedManifest, [StringComparison]::Ordinal)) {
      throw 'Protected bootstrap manifest copy failed its expected digest.'
    }
    $entries = @(Get-CanonicalManifestEntries $stageManifest)
    $sourcePrefix = $source + [IO.Path]::DirectorySeparatorChar
    $stagePrefix = $stageRoot + [IO.Path]::DirectorySeparatorChar
    [int64]$copiedBytes = 0
    foreach ($entry in $entries) {
      $relativeWindows = ([string]$entry.Relative).Replace('/', '\')
      $sourcePath = [IO.Path]::GetFullPath((Join-Path $source $relativeWindows))
      $destination = [IO.Path]::GetFullPath((Join-Path $stageRoot $relativeWindows))
      if (-not $sourcePath.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase) -or
          -not $destination.StartsWith($stagePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Bootstrap manifest path escaped its root: $($entry.Relative)"
      }
      $sourceItem = Get-Item -LiteralPath $sourcePath -Force -ErrorAction Stop
      if ($sourceItem.PSIsContainer -or ($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Bootstrap source is not a regular file: $sourcePath"
      }
      if ($sourceItem.Length -lt 0 -or $sourceItem.Length -gt 512MB) {
        throw "Bootstrap source file exceeds its 512 MiB bound: $sourcePath"
      }
      $copiedBytes += [int64]$sourceItem.Length
      if ($copiedBytes -gt 4GB) { throw 'Bootstrap source exceeds the 4 GiB protected-copy limit.' }
      $destinationDirectory = Split-Path $destination -Parent
      New-Item -ItemType Directory -Force -Path $destinationDirectory -ErrorAction Stop | Out-Null
      Copy-Item -LiteralPath $sourcePath -Destination $destination -ErrorAction Stop
      $destinationItem = Get-Item -LiteralPath $destination -Force -ErrorAction Stop
      if ($destinationItem.PSIsContainer -or ($destinationItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Protected bootstrap destination is not a regular file: $destination"
      }
      $observed = (Get-FileHash -LiteralPath $destination -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
      if (-not [string]::Equals($observed, [string]$entry.Sha256, [StringComparison]::Ordinal)) {
        throw "Protected bootstrap file failed its manifest digest: $($entry.Relative)"
      }
    }

    $optionsJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SetupOptionsBase64))
    $options = $optionsJson | ConvertFrom-Json -ErrorAction Stop
    $setupPath = Join-Path $stageRoot 'deploy\windows\Setup-PixelBrightness.ps1'
    $setupParameters = @{
      SourceRoot = $stageRoot
      ShowUser = [string]$options.showUser
      Role = [string]$options.role
      CameraProfile = [string]$options.cameraProfile
      ServerUrl = [string]$options.serverUrl
      NodeId = [string]$options.nodeId
      TrustedWebClient = [string[]]@($options.trustedWebClient)
      TrustedWebHost = [string[]]@($options.trustedWebHost)
      ExpectedSourceManifestSha256 = $expectedManifest
      Elevated = $true
      SkipNativeBuild = [bool]$options.skipNativeBuild
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$options.nodeTokenFile)) {
      $setupParameters.NodeTokenFile = [string]$options.nodeTokenFile
    }
    & $setupPath @setupParameters
  } finally {
    if (Test-Path -LiteralPath $stageRoot) {
      Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
