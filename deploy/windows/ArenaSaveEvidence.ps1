# Read-only save verification helpers. No window control or shutdown here.
function Get-ArenaCompositionSaveEvidence([string]$Path) {
  $item = Get-Item -LiteralPath $Path -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -le 0 -or $item.Length -gt 67108864) {
    throw 'Arena composition is missing, empty, linked, or exceeds 64 MiB; save cannot be verified.'
  }
  $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256 -ErrorAction Stop).Hash
  $after = Get-Item -LiteralPath $Path -ErrorAction Stop
  if ($after.LastWriteTimeUtc.Ticks -ne $item.LastWriteTimeUtc.Ticks -or $after.Length -ne $item.Length) {
    throw 'Arena composition is still changing; save cannot be verified.'
  }
  return @{ ticks = $item.LastWriteTimeUtc.Ticks; length = $item.Length; sha256 = $hash }
}

function Wait-ArenaCompositionSaved {
  param([string]$Path, [hashtable]$Before, [DateTime]$RequestedAtUtc, [int]$TimeoutSeconds = 15)
  if ($TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 30) { throw 'Invalid save verification timeout.' }
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $previous = $null
  do {
    try {
      $current = Get-ArenaCompositionSaveEvidence $Path
      if ($current.ticks -gt $Before.ticks -and $current.ticks -ge $RequestedAtUtc.AddSeconds(-1).Ticks) {
        if ($null -ne $previous -and $current.ticks -eq $previous.ticks -and $current.length -eq $previous.length -and $current.sha256 -ceq $previous.sha256) {
          return $current
        }
        $previous = $current
      } else { $previous = $null }
    } catch { $previous = $null }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'No stable new save was observed in the scheduled composition file. Arena remains open and shutdown is blocked; check Save As, file permissions, and the currently opened composition.'
}
