[CmdletBinding()]
param([string]$SourceRoot = '', [string]$ProfilesJson = '', [switch]$PasswordsFromStdin)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($SourceRoot)) { $SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$root = (Resolve-Path -LiteralPath $SourceRoot).Path
$data = Join-Path (Split-Path $root -Parent) 'preview-data'
$existingProfiles = @()
$existingPath = Join-Path $data 'ndi-receivers.json'
if (Test-Path -LiteralPath $existingPath -PathType Leaf) { $existingProfiles = Get-Content -LiteralPath $existingPath -Raw | ConvertFrom-Json }
# Detect a read-only deployment before asking the operator for credentials.
$null = New-Item -ItemType Directory -Path $data -Force
$probe = Join-Path $data ('receiver-write-check-' + [Guid]::NewGuid().ToString('N') + '.tmp')
try { $stream = [IO.File]::Open($probe, 'CreateNew', 'Write', 'None'); $stream.Dispose(); [IO.File]::Delete($probe) }
catch { throw 'The Windows show account cannot write preview-data. Repair preview data access before entering receiver credentials; existing settings were not changed.' }
$headers = @{ Origin = 'http://127.0.0.1:3001' }
$status = Invoke-RestMethod 'http://127.0.0.1:4101/v1/calibrations/uvc-geometry' -Headers $headers -TimeoutSec 10
if ($status.routing.pendingRecovery -or ($null -ne $status.job -and [string]$status.job.state -notin @('failed','cancelled','candidate-not-applied','applied-to-project','restored-to-project'))) { throw 'Finish calibration and restore receiver routing before changing profiles.' }
$response = Invoke-RestMethod 'http://127.0.0.1:4101/v1/projects/default' -Headers $headers -TimeoutSec 10
$project = $response.project
if ($null -eq $project -or @($project.outputs).Count -eq 0) { throw 'No saved project outputs.' }
$supplied = @()
if ($ProfilesJson) {
  $supplied = ConvertFrom-Json -InputObject $ProfilesJson
  $supplied = @($supplied)
  $known = @($project.outputs | Where-Object { $_.enabled -ne $false } | ForEach-Object { [string]$_.id })
  if ($supplied.Count -lt 1 -or $supplied.Count -gt 5 -or @($supplied | Select-Object -ExpandProperty outputId -Unique).Count -ne $supplied.Count) { throw 'Expected unique configured outputs.' }
  foreach ($entry in $supplied) { if ([string]$entry.outputId -notin $known) { throw 'Unknown or disabled output in supplied receiver profiles.' } }
}
if ($PasswordsFromStdin -and -not $ProfilesJson) { throw 'Stdin passwords require explicit receiver profiles.' }
Write-Host 'Configure the NDI DECODER account, not the Panasonic projector account.'
Write-Host 'Passwords are entered locally, encrypted with Windows DPAPI, and never printed.'
$profiles = @(); $secrets = @{}
foreach ($output in @($project.outputs | Where-Object { $_.enabled -ne $false })) {
  $entry = $null
  if ($ProfilesJson) {
    $entry = $supplied | Where-Object { [string]$_.outputId -eq [string]$output.id } | Select-Object -First 1
    if ($null -eq $entry) { continue }
  }
  Write-Host ('Output: ' + $output.id + ' / ' + $output.name)
  $address = if ($null -ne $entry) { [string]$entry.address } else { Read-Host 'Decoder IP (blank skips this output)' }
  if ([string]::IsNullOrWhiteSpace($address)) { continue }
  $ip = $null
  if (-not [Net.IPAddress]::TryParse($address, [ref]$ip) -or $ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'Use an IPv4 decoder address.' }
  $kind = if ($null -ne $entry) { [string]$entry.kind } else { Read-Host 'API kind: magewell-ip-v1, kiloview-v1, or kiloview-web-v2 (N6 web API)' }
  if ($kind -notin @('magewell-ip-v1','kiloview-v1','kiloview-web-v2')) { throw 'Unsupported API kind; no fallback changes are made.' }
  $username = if ($null -ne $entry) { [string]$entry.username } else { Read-Host 'Decoder username' }
  if ([string]::IsNullOrWhiteSpace($username)) { throw 'A real decoder username is required.' }
  if ($PasswordsFromStdin) {
    $line = [Console]::In.ReadLine()
    if ([string]::IsNullOrEmpty($line)) { throw 'Missing supplied receiver password.' }
    $password = ConvertTo-SecureString -String $line -AsPlainText -Force
    $line = $null
  } else { $password = Read-Host 'Decoder password' -AsSecureString }
  if ($password.Length -eq 0) { throw 'Password cannot be empty.' }
  $key = 'RECEIVER_OUTPUT_' + $profiles.Count + '_PASSWORD'
  $secrets[$key] = ConvertFrom-SecureString $password
  $profile = @{ outputId = [string]$output.id; kind = $kind; baseUrl = 'http://' + $address; username = $username; passwordEnv = $key }
  # Retain the explicitly configured pattern-source NIC only for the same receiver.
  $previous = @($existingProfiles) | Where-Object { $_.outputId -eq $profile.outputId -and $_.baseUrl.TrimEnd('/') -eq $profile.baseUrl } | Select-Object -First 1
  if ($null -ne $previous -and $null -ne $previous.PSObject.Properties['sourceHost']) { $profile.sourceHost = [string]$previous.sourceHost }
  if ($null -ne $entry -and $null -ne $entry.PSObject.Properties['sourceHost']) { $profile.sourceHost = [string]$entry.sourceHost }
  if ($profile.ContainsKey('sourceHost')) {
    $sourceIp = $null
    if (-not [Net.IPAddress]::TryParse($profile.sourceHost,[ref]$sourceIp) -or $sourceIp.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'Pattern sourceHost must be an IPv4 address.' }
  }
  $profiles += $profile
}
if ($profiles.Count -lt 1 -or $profiles.Count -gt 5) { throw 'Choose one to five receivers.' }
$null = New-Item -ItemType Directory -Path $data -Force
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
foreach ($record in @(@{ file='ndi-receiver-secrets.json'; value=$secrets }, @{ file='ndi-receivers.json'; value=@($profiles) })) {
  $file = Join-Path $data $record.file
  if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination ($file + '.backup-' + $stamp) }
  $temp = $file + '.tmp-' + [Guid]::NewGuid().ToString('N')
  [IO.File]::WriteAllText($temp, (ConvertTo-Json -InputObject $record.value -Depth 6), [Text.UTF8Encoding]::new($false))
  if (Test-Path -LiteralPath $file) { [IO.File]::Replace($temp, $file, [NullString]::Value) } else { [IO.File]::Move($temp, $file) }
}
Write-Host 'Profiles saved. No receiver was switched. Restart the idle preview to load them; then run the read-only receiver check.'
