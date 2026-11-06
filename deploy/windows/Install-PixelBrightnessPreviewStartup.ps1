[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$SourceRoot)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Resolve-Path -LiteralPath $SourceRoot -ErrorAction Stop).Path
$launcher = Join-Path $root 'deploy\windows\Start-PixelBrightnessPreview.ps1'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Missing preview startup wrapper: $launcher" }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($user -eq 'NT AUTHORITY\SYSTEM') { throw 'Install from the signed-in Show user, not SYSTEM.' }
$name = 'PixelBrightness-NDI-Preview'
$existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($null -ne $existing) {
  if ($existing.State -eq 'Running') { throw 'Preview task is already running; leave its live jobs untouched.' }
  if (@($existing.Actions).Count -ne 1 -or [string]$existing.Actions[0].Arguments -notlike ('*"' + $launcher + '"*')) {
    throw 'Existing task points to another preview installation; refusing to overwrite it.'
  }
}
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $launcher + '" -SourceRoot "' + $root + '"'
$action = New-ScheduledTaskAction -Execute $shell -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
# The existing preview is in an administrator-owned build directory, including
# its web build and data. Keep that protection instead of granting write access
# to the installation; use the same signed-in administrator as manual setup.
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$null = Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force `
  -Description 'Local Pixel NDI/camera control on 3001/4101. Starts after sign-in. No automatic output, Arena, projector power or receiver routing changes.'
Start-ScheduledTask -TaskName $name
Write-Output 'Preview startup installed and started. Check HTTP readiness; Running alone is not readiness.'
