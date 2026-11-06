# Passwords stay encrypted for this Windows user on this computer. Decrypt
# only into the launcher's process environment; never print them or persist PATH.
function Import-PixelReceiverCredentials([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
  $item = Get-Item -LiteralPath $Path -ErrorAction Stop
  if ($item.Length -gt 65536 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Invalid receiver credential file.' }
  $config = [IO.File]::ReadAllText($Path) | ConvertFrom-Json -ErrorAction Stop
  $entries = @($config.PSObject.Properties)
  if ($entries.Count -lt 1 -or $entries.Count -gt 5) { throw 'Receiver credentials require one to five entries.' }
  foreach ($entry in $entries) {
    if ($entry.Name -notmatch '^RECEIVER_[A-Za-z0-9_]{1,64}_PASSWORD$' -or [string]::IsNullOrWhiteSpace([string]$entry.Value)) { throw 'Invalid receiver credential entry.' }
  }
  foreach ($entry in $entries) {
    $pointer = [IntPtr]::Zero
    try {
      $secure = ConvertTo-SecureString ([string]$entry.Value) -ErrorAction Stop
      $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      [Environment]::SetEnvironmentVariable($entry.Name, [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer), 'Process')
    } catch { throw 'Receiver credentials cannot be decrypted by this Windows user. Run receiver setup in the Show account again.' }
    finally { if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) } }
  }
}
