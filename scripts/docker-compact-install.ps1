# One-time setup so `npm run docker:compact` compacts the Docker disk without a UAC prompt. RUN ONCE, ELEVATED.
#
# What it does:
#   1. copies scripts/docker-compact-elevated.ps1 to C:\ProgramData\Ythril\docker-compact-elevated.ps1;
#   2. locks that folder down: Administrators and SYSTEM may write, Users may only read and execute - so the file the
#      task runs can be changed by an administrator alone (see the header of docker-compact-elevated.ps1 for why this
#      is the part that matters);
#   3. registers the scheduled task "Ythril Docker Compact": highest privileges, as YOU, interactive, no trigger - it
#      runs only when docker-compact.ps1 starts it.
#
# Afterwards docker-compact.ps1 starts the task instead of asking UAC; without the task it asks UAC as before.
# Re-run it after changing docker-compact-elevated.ps1: the task runs the protected COPY, never the repo file.
#
# Usage (from an elevated PowerShell):
#   powershell -ExecutionPolicy Bypass -File scripts\docker-compact-install.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\docker-compact-install.ps1 -Uninstall
#
# ASCII ONLY, like docker-compact.ps1.

[CmdletBinding()]
param(
  # Remove the task and the protected copy, and go back to the UAC prompt.
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$taskName = 'Ythril Docker Compact'
$dir = Join-Path $env:ProgramData 'Ythril'
$target = Join-Path $dir 'docker-compact-elevated.ps1'

$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Run this from an ELEVATED PowerShell: it registers a task with highest privileges.'
  exit 1
}

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed task '$taskName'."
  }
  if (Test-Path $target) { Remove-Item $target -Force; Write-Host "Removed $target." }
  Write-Host 'docker-compact.ps1 will ask UAC again.'
  exit 0
}

$source = Join-Path $PSScriptRoot 'docker-compact-elevated.ps1'
if (-not (Test-Path $source)) { Write-Host "Not found: $source"; exit 1 }

New-Item -ItemType Directory -Force -Path $dir | Out-Null
# Inheritance off and explicit grants, so a looser ACL on ProgramData cannot leak write access in.
& icacls $dir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
Copy-Item $source $target -Force
& icacls $target /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' '*S-1-5-32-545:RX' | Out-Null

$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$target`""
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "Installed: task '$taskName' runs $target with highest privileges, on demand only."
Write-Host 'npm run docker:compact now compacts without a UAC prompt.'
