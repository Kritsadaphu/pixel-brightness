[CmdletBinding()]
param()

Set-StrictMode -Version Latest

function Assert-PixelBrightnessSourceManifest {
  param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [string]$ExpectedManifestSha256 = '',
    [switch]$AllowMissing
  )

  $root = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $SourceRoot -ErrorAction Stop).Path).TrimEnd('\')
  $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop
  if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Pixel Brightness SourceRoot must be one real directory: $root"
  }

  $manifestPath = Join-Path $root 'MANIFEST-SHA256.txt'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    if ($AllowMissing) {
      return [pscustomobject]@{
        Root = $root
        ManifestPath = $null
        ManifestSha256 = $null
        FileCount = 0
        TotalBytes = 0
        FileDigests = $null
      }
    }
    throw "Source handoff manifest is missing: $manifestPath. Use the packaged Windows source ZIP, or explicitly pass -AllowUnverifiedDeveloperSource only for local development."
  }
  $manifestItem = Get-Item -LiteralPath $manifestPath -Force -ErrorAction Stop
  if (($manifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $manifestItem.Length -le 0 -or $manifestItem.Length -gt 8MB) {
    throw "Source manifest must be one bounded regular file: $manifestPath"
  }
  $manifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
  if (-not [string]::IsNullOrWhiteSpace($ExpectedManifestSha256)) {
    $expectedManifest = $ExpectedManifestSha256.Trim().ToLowerInvariant()
    if ($expectedManifest -notmatch '^[a-f0-9]{64}$' -or
        -not [string]::Equals($manifestSha256, $expectedManifest, [StringComparison]::Ordinal)) {
      throw "Source manifest changed across the UAC/build boundary: expected $expectedManifest, found $manifestSha256"
    }
  }

  $expected = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
  $lines = [IO.File]::ReadAllLines($manifestPath, [Text.Encoding]::UTF8)
  if ($lines.Count -lt 1 -or $lines.Count -gt 10000) {
    throw 'Source manifest must contain 1-10000 canonical file entries.'
  }
  foreach ($line in $lines) {
    if ($line -notmatch '^([a-f0-9]{64})  (.+)$') {
      throw "Source manifest contains a non-canonical line: $line"
    }
    $digest = $Matches[1]
    $relative = $Matches[2]
    $segments = @($relative -split '/')
    if ($relative -ne $relative.Trim() -or $relative.StartsWith('/') -or $relative.Contains('\') -or
        $relative.Contains(':') -or $segments.Count -lt 1 -or
        @($segments | Where-Object { -not $_ -or $_ -in @('.', '..') }).Count -gt 0 -or
        [string]::Equals($relative, 'MANIFEST-SHA256.txt', [StringComparison]::OrdinalIgnoreCase)) {
      throw "Source manifest contains an unsafe path: $relative"
    }
    if ($expected.ContainsKey($relative)) {
      throw "Source manifest contains a duplicate or case-colliding path: $relative"
    }
    $expected.Add($relative, $digest)
  }

  $rootPrefix = $root + [IO.Path]::DirectorySeparatorChar
  $actual = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
  [int64]$totalBytes = 0
  foreach ($item in @(Get-ChildItem -LiteralPath $root -Force -Recurse -ErrorAction Stop)) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Source tree contains a reparse point: $($item.FullName)"
    }
    if ($item.PSIsContainer) { continue }
    if ($item.Length -lt 0 -or $item.Length -gt 512MB) {
      throw "Source tree contains an unbounded file: $($item.FullName)"
    }
    $totalBytes += [int64]$item.Length
    if ($totalBytes -gt 4GB) { throw 'Source tree exceeds the 4 GiB protected-build limit.' }
    $full = [IO.Path]::GetFullPath($item.FullName)
    if (-not $full.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Source file escaped SourceRoot: $full"
    }
    $relative = $full.Substring($rootPrefix.Length).Replace('\', '/')
    if ([string]::Equals($relative, 'MANIFEST-SHA256.txt', [StringComparison]::OrdinalIgnoreCase)) { continue }
    if ($actual.ContainsKey($relative)) {
      throw "Source tree contains a duplicate or case-colliding path: $relative"
    }
    $actual.Add($relative, $full)
  }
  if ($actual.Count -ne $expected.Count) {
    throw "Source tree file count differs from its manifest: expected $($expected.Count), found $($actual.Count)"
  }
  foreach ($entry in $expected.GetEnumerator()) {
    if (-not $actual.ContainsKey($entry.Key)) {
      throw "Source manifest file is missing: $($entry.Key)"
    }
    $observed = (Get-FileHash -LiteralPath $actual[$entry.Key] -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    if (-not [string]::Equals($observed, $entry.Value, [StringComparison]::Ordinal)) {
      throw "Source file failed its manifest digest: $($entry.Key)"
    }
  }
  return [pscustomobject]@{
    Root = $root
    ManifestPath = $manifestPath
    ManifestSha256 = $manifestSha256
    FileCount = $actual.Count
    TotalBytes = $totalBytes
    FileDigests = $expected
  }
}
