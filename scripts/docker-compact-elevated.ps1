# The ELEVATED half of `npm run docker:compact`: attach docker_data.vhdx read-only, compact it, detach it.
#
# THIS FILE IS NEVER RUN FROM THE REPO. `docker-compact-install.ps1` (run once, elevated) copies it to
# C:\ProgramData\Ythril\docker-compact-elevated.ps1, where only Administrators and SYSTEM may write, and registers
# the scheduled task "Ythril Docker Compact" that runs THAT copy with highest privileges, on demand only.
# `docker-compact.ps1` starts the task, so the compaction needs no UAC prompt (owner, 2026-09-28: "is it possible to
# always allow or something?") - and an unattended recovery from a full drive no longer waits on a person.
#
# WHY THE COPY IS PROTECTED, because this is the whole point: a task that runs elevated is a door. If it ran a file a
# normal user can edit, anyone who can edit that file could run anything as administrator - disabling UAC by
# another name. The protected copy can be changed only by an administrator, so starting the task grants exactly one
# thing: this compaction. It also loads nothing from the repo or any other user-writable location.
#
# WHAT IT CAN DO, and nothing more: find a file named docker_data.vhdx (the same places docker-compact.ps1 looks),
# attach it READONLY, compact it, detach it. It takes no arguments, so a caller cannot point it anywhere else. The
# Docker settings it reads to find the disk are the user's own; the most a tampered setting achieves is compacting a
# different docker_data.vhdx read-only, which cannot change any content.
#
# Docker Desktop and WSL must already be stopped - docker-compact.ps1 does that before starting the task. With the
# disk still held, diskpart fails to attach it rather than corrupting anything.
#
# ASCII ONLY, like docker-compact.ps1: Windows PowerShell 5.1 reads a BOM-less script as ANSI.

$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:ProgramData 'Ythril'
$log = Join-Path $dir 'docker-compact.log'

function Log($line) { Add-Content -Path $log -Value $line -Encoding ascii }

Set-Content -Path $log -Value ("started " + (Get-Date -Format o)) -Encoding ascii
$code = 1
try {
  $store = Join-Path $env:APPDATA 'Docker\settings-store.json'
  $roots = @()
  if (Test-Path $store) {
    $s = Get-Content $store -Raw | ConvertFrom-Json
    $roots += @($s.CustomWslDistroDir, $s.DataFolder) | Where-Object { $_ }
  }
  $roots += (Join-Path $env:LOCALAPPDATA 'Docker\wsl\')

  $vhdx = $null
  foreach ($r in $roots) {
    if (-not (Test-Path $r)) { continue }
    $hit = Get-ChildItem $r -Recurse -Filter docker_data.vhdx -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit -and $hit.Name -eq 'docker_data.vhdx') { $vhdx = $hit.FullName; break }
  }
  if (-not $vhdx) { Log 'docker_data.vhdx not found'; Log 'EXIT 2'; exit 2 }
  Log "disk: $vhdx"

  # The diskpart script lives in the protected directory too, so nothing between writing and running it can swap it.
  $script = Join-Path $dir 'docker-compact.diskpart.txt'
  @(
    "select vdisk file=`"$vhdx`"",
    'attach vdisk readonly',
    'compact vdisk',
    'detach vdisk'
  ) | Set-Content -Path $script -Encoding ascii

  $out = & diskpart /s $script 2>&1
  $code = $LASTEXITCODE
  foreach ($l in $out) { Log "$l" }
} catch {
  Log "error: $($_.Exception.Message)"
  $code = 1
}
Log "EXIT $code"
exit $code
