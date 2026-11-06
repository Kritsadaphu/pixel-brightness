[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SourceRoot, [Parameter(Mandatory=$true)][string]$ShowAccount)
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath $SourceRoot).Path
if (-not (Test-Path -LiteralPath (Join-Path $root 'scripts\run-windows-ndi-preview.mjs') -PathType Leaf)) { throw 'Expected an isolated Pixel preview source root.' }
$data=Join-Path (Split-Path $root -Parent) 'preview-data'
$item=Get-Item -LiteralPath $data
if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Expected a real preview-data directory.' }
$sid=([Security.Principal.NTAccount]::new($ShowAccount)).Translate([Security.Principal.SecurityIdentifier])
$acl=Get-Acl -LiteralPath $data
# Keep all existing rules. Only the named interactive show user gains Modify
# on runtime data; no program code, parent folder, or other account is changed.
$backup=Join-Path $data ('access-before-'+[Guid]::NewGuid().ToString('N')+'.json')
[IO.File]::WriteAllText($backup,(@{path=$data;sddl=$acl.Sddl;account=$ShowAccount}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'Modify','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $data -AclObject $acl
Write-Output 'Preview data access repaired for the specified show account. Existing settings were retained.'
