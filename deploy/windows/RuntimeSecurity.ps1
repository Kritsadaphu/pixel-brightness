[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$script:PixelBrightnessResolvedSidCache = @{}

function Get-PixelBrightnessTrustedOwnerSids {
  return @(
    'S-1-5-18',       # LOCAL SYSTEM
    'S-1-5-32-544',   # BUILTIN\Administrators
    'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464' # TrustedInstaller
  )
}

function Get-PixelBrightnessWriteMask {
  # Use only primitive mutating bits. Composite Modify/FullControl values also
  # contain read bits; using them as a mask would misclassify legitimate
  # read-only Show ACEs as writers and make every protected startup fail.
  return [Security.AccessControl.FileSystemRights]::WriteData -bor
    [Security.AccessControl.FileSystemRights]::AppendData -bor
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership
}

function Get-PixelBrightnessReplacementMask {
  # A standard ProgramData root may deliberately allow users to create their
  # own child directory. That is harmless to an already-protected child. These
  # are the rights that would let a low-privilege principal replace or take
  # control of that protected child through its parent.
  return [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership
}

function Resolve-PixelBrightnessAccountSid([string]$Account, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Account)) { throw "$Label account cannot be empty." }
  $cacheKey = $Account.Trim().ToUpperInvariant()
  if ($script:PixelBrightnessResolvedSidCache.ContainsKey($cacheKey)) {
    return [Security.Principal.SecurityIdentifier]::new([string]$script:PixelBrightnessResolvedSidCache[$cacheKey])
  }
  try {
    $sid = ([Security.Principal.NTAccount]::new($Account)).Translate([Security.Principal.SecurityIdentifier])
    $script:PixelBrightnessResolvedSidCache[$cacheKey] = $sid.Value
    return $sid
  } catch {
    throw "$Label account cannot be resolved securely: $Account"
  }
}

function Assert-AdminProtectedItem(
  [IO.FileSystemInfo]$Item,
  [string]$Label,
  [Security.AccessControl.FileSystemRights]$WriteMask = (Get-PixelBrightnessWriteMask),
  [string[]]$AdditionalWriteSids = @()
) {
  if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label contains a reparse point and cannot be trusted: $($Item.FullName)"
  }
  $trustedOwners = @(Get-PixelBrightnessTrustedOwnerSids)
  $allowedWriters = @($trustedOwners) + @($AdditionalWriteSids)
  $acl = Get-Acl -LiteralPath $Item.FullName -ErrorAction Stop
  try { $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value }
  catch { throw "$Label owner cannot be resolved securely for $($Item.FullName)" }
  if ($ownerSid -notin $trustedOwners) {
    throw "$Label is not owned by SYSTEM, Administrators, or TrustedInstaller: $($Item.FullName) ($ownerSid)"
  }
  # Ask the ACL API for SIDs directly. Translating display names and then
  # ignoring IdentityNotMappedException would fail open on an effective ACE.
  $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        ($rule.FileSystemRights -band $WriteMask) -eq 0) { continue }
    $sid = $rule.IdentityReference.Value
    if ($sid -in $allowedWriters) { continue }
    if ($sid -eq 'S-1-3-0' -and
        ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    if ($sid -eq 'S-1-3-4') { continue }
    throw "$Label grants write or replacement access to a non-privileged trustee ($sid): $($Item.FullName)"
  }
  return $Item.FullName
}

function Protect-AdminControlPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ShowUser,
    [ValidateSet('None', 'Read', 'Modify')][string]$ShowAccess = 'Read',
    [string]$Label = 'Pixel Brightness control path'
  )
  if (-not (Test-Path -LiteralPath $Path)) { throw "$Label is missing: $Path" }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label is a reparse point and cannot be protected safely: $Path"
  }
  $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $administratorsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $showSid = Resolve-PixelBrightnessAccountSid $ShowUser 'Show user'
  $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  $acl.SetOwner($administratorsSid)
  $inheritance = if ($item.PSIsContainer) {
    [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    [Security.AccessControl.InheritanceFlags]::None
  }
  $entries = @(
    @{ Identity = $systemSid; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
    @{ Identity = $administratorsSid; Rights = [Security.AccessControl.FileSystemRights]::FullControl }
  )
  if ($ShowAccess -ne 'None') {
    $showRights = if ($ShowAccess -eq 'Modify') {
      [Security.AccessControl.FileSystemRights]::Modify
    } else {
      [Security.AccessControl.FileSystemRights]::ReadAndExecute
    }
    $entries += @{ Identity = $showSid; Rights = $showRights }
  }
  foreach ($entry in $entries) {
    $accessRule = [Security.AccessControl.FileSystemAccessRule]::new(
      $entry.Identity,
      $entry.Rights,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($accessRule)
  }
  Set-Acl -LiteralPath $item.FullName -AclObject $acl -ErrorAction Stop
  $additionalWriteSids = if ($ShowAccess -eq 'Modify') { @($showSid.Value) } else { @() }
  [void](Assert-AdminProtectedItem (Get-Item -LiteralPath $item.FullName -Force -ErrorAction Stop) $Label (Get-PixelBrightnessWriteMask) $additionalWriteSids)
  return $item.FullName
}

function Get-PathWithinAdminRoot([string]$Path, [string]$Root, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw "$Label trusted root is missing: $Root" }
  $rootPath = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Root -ErrorAction Stop).Path).TrimEnd('\')
  $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  if (-not $fullPath.StartsWith(($rootPath + '\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be a child of the administrator-controlled root $rootPath, never a user profile or writable custom root: $fullPath"
  }
  return [pscustomobject]@{ Path = $fullPath; Root = $rootPath }
}

function Assert-AdminProtectedDirectoryChain([string]$Path, [string]$Root, [string]$Label) {
  $location = Get-PathWithinAdminRoot $Path $Root $Label
  if (-not (Test-Path -LiteralPath $location.Path -PathType Container)) { throw "$Label directory is missing: $($location.Path)" }
  $candidate = $location.Path
  while ($true) {
    $item = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
    $mask = if ([string]::Equals($candidate.TrimEnd('\'), $location.Root, [StringComparison]::OrdinalIgnoreCase)) {
      Get-PixelBrightnessReplacementMask
    } else {
      Get-PixelBrightnessWriteMask
    }
    [void](Assert-AdminProtectedItem $item $Label $mask)
    if ([string]::Equals($candidate.TrimEnd('\'), $location.Root, [StringComparison]::OrdinalIgnoreCase)) { break }
    $parent = Split-Path $candidate -Parent
    if ([string]::IsNullOrWhiteSpace($parent) -or
        -not ($parent.StartsWith(($location.Root + '\'), [StringComparison]::OrdinalIgnoreCase) -or
              [string]::Equals($parent, $location.Root, [StringComparison]::OrdinalIgnoreCase))) {
      throw "$Label escaped its trusted root: $($location.Path)"
    }
    $candidate = $parent
  }
  return $location.Path
}

function Initialize-AdminProtectedDirectory(
  [string]$Path,
  [string]$Root,
  [string]$ShowUser,
  [string]$Label
) {
  $location = Get-PathWithinAdminRoot $Path $Root $Label
  $rootItem = Get-Item -LiteralPath $location.Root -Force -ErrorAction Stop
  [void](Assert-AdminProtectedItem $rootItem $Label (Get-PixelBrightnessReplacementMask))
  $relative = $location.Path.Substring($location.Root.Length + 1)
  $current = $location.Root
  $segments = @($relative -split '\\' | Where-Object { $_ })
  for ($index = 0; $index -lt $segments.Count; $index += 1) {
    $current = Join-Path $current $segments[$index]
    $isTarget = $index -eq ($segments.Count - 1)
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
      if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path component is not a real directory: $current"
      }
      if (-not $isTarget) { [void](Assert-AdminProtectedItem $item $Label) }
    } else {
      New-Item -ItemType Directory -Path $current -ErrorAction Stop | Out-Null
      $null = Protect-AdminControlPath -Path $current -ShowUser $ShowUser -ShowAccess Read -Label $Label
    }
  }
  $null = Protect-AdminControlPath -Path $location.Path -ShowUser $ShowUser -ShowAccess Read -Label $Label
  return (Assert-AdminProtectedDirectoryChain $location.Path $location.Root $Label)
}

function Get-NonReparseTree([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Label directory is missing: $Path"
  }
  $pending = [System.Collections.Generic.Stack[IO.FileSystemInfo]]::new()
  $items = [System.Collections.Generic.List[IO.FileSystemInfo]]::new()
  $pending.Push((Get-Item -LiteralPath $Path -Force -ErrorAction Stop))
  while ($pending.Count -gt 0) {
    $item = $pending.Pop()
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label contains a reparse point and cannot be trusted by a SYSTEM scheduled task: $($item.FullName)"
    }
    $items.Add($item)
    if ($item.PSIsContainer) {
      foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force -ErrorAction Stop)) {
        $pending.Push($child)
      }
    }
  }
  return @($items)
}

function Assert-AdminProtectedControlTree([string]$Path, [string]$Label) {
  foreach ($item in @(Get-NonReparseTree $Path $Label)) {
    [void](Assert-AdminProtectedItem $item $Label)
  }
  return (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
}

function Protect-AdminControlTree {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ShowUser,
    [ValidateSet('None', 'Read')][string]$ShowAccess = 'Read',
    [Parameter(Mandatory = $true)][string]$Label
  )
  # Inventory the complete existing tree before changing it. This makes an
  # upgrade fail without following or silently retaining an attacker-planted
  # junction/symlink. Lock the root, enumerate again to close the writable-root
  # race, then replace owner/DACL on every existing descendant without deleting
  # application state or logs.
  $null = Get-NonReparseTree $Path $Label
  # Temporarily remove Show access at the tree root while descendants are
  # rewritten. Otherwise an old explicit child ACE could remain reachable
  # during the children-first canonicalization window.
  $null = Protect-AdminControlPath -Path $Path -ShowUser $ShowUser -ShowAccess None -Label $Label
  $items = @(Get-NonReparseTree $Path $Label) |
    Sort-Object { $_.FullName.Length } -Descending
  foreach ($item in $items) {
    $null = Protect-AdminControlPath -Path $item.FullName -ShowUser $ShowUser -ShowAccess $ShowAccess -Label $Label
  }
  return (Assert-AdminProtectedControlTree $Path $Label)
}

function Protect-AdminSystemTree([string]$Path, [string]$ShowUser, [string]$Label) {
  return (Protect-AdminControlTree -Path $Path -ShowUser $ShowUser -ShowAccess None -Label $Label)
}

function Protect-AdminReadOnlyReleaseTree([string]$Path, [string]$ShowUser) {
  if ([string]::IsNullOrWhiteSpace($ShowUser)) { throw 'ShowUser cannot be empty.' }
  return (Protect-AdminControlTree -Path $Path -ShowUser $ShowUser -ShowAccess Read -Label 'Pixel Brightness release')
}

function Assert-AdminProtectedReleaseTree([string]$Path) {
  $items = @(Get-NonReparseTree $Path 'Pixel Brightness release')
  foreach ($item in $items) {
    [void](Assert-AdminProtectedItem $item 'Pixel Brightness release')
  }
  return (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
}

function Assert-AdminProtectedReleaseLocation([string]$Path) {
  $release = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path).TrimEnd('\')
  $releasesRoot = Split-Path $release -Parent
  if (-not [string]::Equals((Split-Path $releasesRoot -Leaf), 'releases', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Pixel Brightness release must be an immutable version below an exact releases directory: $release"
  }
  [void](Assert-AdminProtectedDirectoryChain $releasesRoot $env:ProgramFiles 'Pixel Brightness install parent')
  [void](Assert-AdminProtectedReleaseTree $release)
  return $release
}

function Assert-AdminOnlyPixelBrightnessSecret([string]$Path, [string]$Label) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  [void](Assert-AdminProtectedItem $item $Label)
  $trustedReaders = @(Get-PixelBrightnessTrustedOwnerSids)
  $readMask = [Security.AccessControl.FileSystemRights]::ReadData
  $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
  $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        ($rule.FileSystemRights -band $readMask) -eq 0) { continue }
    $sid = $rule.IdentityReference.Value
    if ($sid -in $trustedReaders -or $sid -eq 'S-1-3-4') { continue }
    if ($sid -eq 'S-1-3-0' -and
        ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    throw "$Label grants secret-read access to a non-privileged trustee ($sid): $($item.FullName)"
  }
  return $item.FullName
}

function Assert-PixelBrightnessControlPlane {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [switch]$IncludeSystemDirectories,
    [switch]$AllowLegacyCredentials
  )
  [void](Assert-AdminProtectedDirectoryChain $DataRoot $env:ProgramData 'Pixel Brightness data root')
  $protectedDirectories = @('logs', 'secrets', 'state')
  foreach ($relative in $protectedDirectories) {
    $path = Join-Path $DataRoot $relative
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
      throw "Pixel Brightness protected directory is missing: $path"
    }
    [void](Assert-AdminProtectedItem (Get-Item -LiteralPath $path -Force -ErrorAction Stop) 'Pixel Brightness protected directory')
  }
  if ($IncludeSystemDirectories) {
    foreach ($relative in @('logs\system', 'state\server')) {
      $path = Join-Path $DataRoot $relative
      [void](Assert-AdminProtectedControlTree $path "Pixel Brightness SYSTEM-only $relative tree")
    }
  }
  $baseControlFiles = @(
    'current-release.txt',
    'Start-PixelBrightness.ps1',
    'Bind-PixelBrightnessDisplays.ps1',
    'Test-PixelBrightness.ps1',
    'RuntimeSecurity.ps1',
    'secrets\runtime.json',
    'secrets\trusted-web.json'
  )
  $showSchedulePath = Join-Path $DataRoot 'ShowSchedule.ps1'
  $showScheduleTaskPresent = $false
  if ($null -ne (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) {
    $showScheduleTaskPresent = $null -ne (Get-ScheduledTask -TaskName 'PixelBrightness-Schedule' -ErrorAction SilentlyContinue) -or
      $null -ne (Get-ScheduledTask -TaskName 'PixelBrightness-Schedule-Interactive' -ErrorAction SilentlyContinue)
  }
  if (Test-Path -LiteralPath $showSchedulePath -PathType Leaf) {
    $baseControlFiles += 'ShowSchedule.ps1'
  } elseif ($showScheduleTaskPresent) {
    throw "Pixel Brightness show scheduler control file is missing: $showSchedulePath"
  }
  foreach ($cameraControlFile in @('CameraRuntime.ps1', 'Provision-PixelBrightnessCanonCamera.ps1')) {
    $cameraControlPath = Join-Path $DataRoot $cameraControlFile
    if (Test-Path -LiteralPath $cameraControlPath -PathType Leaf) {
      $baseControlFiles += $cameraControlFile
    } elseif (-not $AllowLegacyCredentials) {
      throw "Pixel Brightness camera control file is missing: $cameraControlPath"
    }
  }
  $installationPath = Join-Path $DataRoot 'secrets\installation.json'
  if (Test-Path -LiteralPath $installationPath -PathType Leaf) {
    $baseControlFiles += 'secrets\installation.json'
    try { $installation = Get-Content -LiteralPath $installationPath -Raw | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "Pixel Brightness installation role is invalid: $($_.Exception.Message)" }
    $installedRole = [string]$installation.role
  } elseif ($AllowLegacyCredentials) {
    # The legacy single-PC generation predated installation.json and is
    # treated as All only inside the installer's guarded rotation preflight.
    $installedRole = 'All'
  } else {
    throw "Pixel Brightness installation role is missing: $installationPath"
  }
  if ($installedRole -notin @('All', 'Server', 'Node')) { throw "Pixel Brightness installation role is invalid: $installedRole" }
  if ($installedRole -in @('All', 'Node')) {
    $cameraAuthorityRoot = Join-Path $DataRoot 'camera-runtime'
    $cameraAuthorityPath = Join-Path $cameraAuthorityRoot 'active.json'
    if (Test-Path -LiteralPath $cameraAuthorityPath -PathType Leaf) {
      [void](Assert-AdminProtectedItem (Get-Item -LiteralPath $cameraAuthorityRoot -Force -ErrorAction Stop) 'Pixel Brightness camera authority root')
      $baseControlFiles += 'camera-runtime\active.json'
    } elseif (-not $AllowLegacyCredentials) {
      throw "Pixel Brightness camera runtime authority is missing: $cameraAuthorityPath"
    }
  }
  $credentialFiles = switch ($installedRole) {
    'All' { @('secrets\control-token.txt', 'secrets\node-signing-key.txt', 'secrets\node-token.txt') }
    'Server' { @('secrets\control-token.txt', 'secrets\node-signing-key.txt') }
    'Node' { @('secrets\node-token.txt') }
  }
  $missingCanonicalCredential = @($credentialFiles | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $DataRoot $_) -PathType Leaf)
  }).Count -gt 0
  if ($missingCanonicalCredential -and $AllowLegacyCredentials) {
    $legacyCredential = Join-Path $DataRoot 'secrets\cluster-token.txt'
    if (-not (Test-Path -LiteralPath $legacyCredential -PathType Leaf)) {
      throw 'Pixel Brightness has neither complete role credentials nor the legacy credential required for a guarded migration.'
    }
    $credentialFiles = @('secrets\cluster-token.txt')
  } elseif ($missingCanonicalCredential) {
    throw "Pixel Brightness $installedRole credentials are incomplete; refusing startup."
  }
  foreach ($relative in @($baseControlFiles) + @($credentialFiles)) {
    $path = Join-Path $DataRoot $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Pixel Brightness protected control file is missing: $path"
    }
    [void](Assert-AdminProtectedItem (Get-Item -LiteralPath $path -Force -ErrorAction Stop) 'Pixel Brightness protected control file')
  }
  foreach ($relative in @('secrets\control-token.txt', 'secrets\node-signing-key.txt')) {
    $path = Join-Path $DataRoot $relative
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      [void](Assert-AdminOnlyPixelBrightnessSecret $path 'Pixel Brightness Server-only secret')
    }
  }
  $projectorPasswordPath = Join-Path $DataRoot 'secrets\panasonic-projector-password.txt'
  if (Test-Path -LiteralPath $projectorPasswordPath -PathType Leaf) {
    [void](Assert-AdminProtectedItem (Get-Item -LiteralPath $projectorPasswordPath -Force -ErrorAction Stop) 'Panasonic projector password')
    [void](Assert-AdminOnlyPixelBrightnessSecret $projectorPasswordPath 'Panasonic projector password')
  }
  return [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $DataRoot -ErrorAction Stop).Path).TrimEnd('\')
}

function Assert-AdminProtectedRuntimePath([string]$Path, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label runtime executable is missing: $Path"
  }

  $resolved = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path)
  $programRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) |
    Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } |
    ForEach-Object { [IO.Path]::GetFullPath([string]$_).TrimEnd('\') } |
    Select-Object -Unique
  $programRoot = @($programRoots | Where-Object {
    $resolved.StartsWith(($_ + '\'), [StringComparison]::OrdinalIgnoreCase)
  } | Sort-Object Length -Descending | Select-Object -First 1)
  if ($programRoot.Count -ne 1) {
    throw "$Label runtime must be installed under an administrator-protected Program Files directory, never AppData, a user profile, nvm, or a writable tools folder: $resolved"
  }

  $trustedOwners = @(Get-PixelBrightnessTrustedOwnerSids)
  $privilegedWriteSids = @($trustedOwners)
  $writeMask = Get-PixelBrightnessWriteMask

  $candidate = $resolved
  while ($true) {
    $item = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label runtime path contains a reparse point and cannot be trusted by a SYSTEM scheduled task: $candidate"
    }
    $acl = Get-Acl -LiteralPath $candidate -ErrorAction Stop
    try {
      $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    } catch {
      throw "$Label runtime owner cannot be resolved securely for $candidate"
    }
    if ($ownerSid -notin $trustedOwners) {
      throw "$Label runtime path is not owned by SYSTEM, Administrators, or TrustedInstaller: $candidate ($ownerSid)"
    }
    $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    foreach ($rule in $rules) {
      if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
          ($rule.FileSystemRights -band $writeMask) -eq 0) { continue }
      $sid = $rule.IdentityReference.Value
      if ($sid -in $privilegedWriteSids) { continue }
      # CREATOR OWNER is safe only as an inherit-only template: the current
      # directory still has no low-privilege create/write ACE, and each real
      # child owner is independently validated while walking this chain.
      if ($sid -eq 'S-1-3-0' -and
          ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
      # OWNER RIGHTS resolves to the already-validated privileged owner above.
      if ($sid -eq 'S-1-3-4') { continue }
      throw "$Label runtime path grants write access to a non-privileged trustee ($sid): $candidate"
    }
    if ([string]::Equals($candidate.TrimEnd('\'), $programRoot[0], [StringComparison]::OrdinalIgnoreCase)) { break }
    $parent = Split-Path $candidate -Parent
    if ([string]::IsNullOrWhiteSpace($parent) -or
        -not $parent.StartsWith($programRoot[0], [StringComparison]::OrdinalIgnoreCase)) {
      throw "$Label runtime path escaped its trusted Program Files root: $resolved"
    }
    $candidate = $parent
  }
  return $resolved
}

function Assert-ProtectedNodeRuntime([string]$NodePath, [string]$NpmPath) {
  $node = Assert-AdminProtectedRuntimePath $NodePath 'Node.js'
  $npm = Assert-AdminProtectedRuntimePath $NpmPath 'npm'
  $runtimeRoot = Split-Path $node -Parent
  if (-not [string]::Equals($runtimeRoot, (Split-Path $npm -Parent), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Node.js and npm must come from the same protected installation directory.'
  }
  # npm.cmd executes sibling node_modules\npm\bin\npm-cli.js and that script
  # loads many more descendants. A file-and-ancestor check is insufficient for
  # a SYSTEM task, so every item in the pinned Node installation is audited.
  foreach ($item in @(Get-NonReparseTree $runtimeRoot 'Pinned Node.js installation')) {
    [void](Assert-AdminProtectedItem $item 'Pinned Node.js installation')
  }
  return [pscustomobject]@{ node = $node; npm = $npm; root = $runtimeRoot }
}
