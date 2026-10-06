# Compact docker_data.vhdx and return the freed space to the HOST drive.
#
# `npm run docker:reclaim` frees space INSIDE the VM and then prints four diskpart commands for a human to
# run in an elevated shell. Nobody runs four commands out of a log. On this machine the disk lives on the
# near-full O: drive, so the space pruning "freed" stayed unavailable: 33 GB reclaimable inside a vhdx that
# was still holding the host at 918 MB free.
#
# So this does the whole sequence and elevates only the step that needs it (diskpart, via UAC).
#
# WHAT IT STOPS, because this is not a read-only operation:
#   - Docker Desktop is QUIT. Every container goes down, including a Ythril instance on :3210.
#   - `wsl --shutdown` stops EVERY WSL distro, not just Docker's.
# Both come back at the end; containers with a restart policy come back with them. Work in another WSL
# distro does not.
#
# Compaction itself only removes unallocated space - never an image, a volume or a layer. The disk is
# attached READONLY while it runs, which is what makes that guarantee hold rather than assert it.
#
# ASCII ONLY in this file, deliberately: Windows PowerShell 5.1 reads a BOM-less script as ANSI, so a
# single em dash in a comment breaks string parsing four functions later with an error that points at the
# wrong line. Learned the hard way here.
#
# Usage:  npm run docker:compact
#         npm run docker:compact -- -WhatIf        (report sizes and exit, touching nothing)
#         npm run docker:compact -- -AssumeStopped (Docker is already stopped)

[CmdletBinding()]
param(
  # Report what would happen - the disk path, its size, what would be stopped - and change nothing.
  [switch]$WhatIf,
  # Skip the "quit Docker / shut down WSL" steps. Only correct when Docker is ALREADY stopped; diskpart
  # cannot attach a disk whose VM still holds it, and fails rather than corrupting anything.
  [switch]$AssumeStopped
)

$ErrorActionPreference = 'Stop'

function Section($t) { Write-Host ''; Write-Host ("-- $t " + ('-' * [Math]::Max(0, 60 - $t.Length))) }
function GiB($bytes) { '{0:N2} GiB' -f ($bytes / 1GB) }

# -- Locate the disk ---------------------------------------------------------------------------------
# Same detection as docker-reclaim.mjs: Docker Desktop lets the disk be relocated to any drive and records
# that in its settings store, so the default path is frequently wrong.
Section 'Locating docker_data.vhdx'
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
  if ($hit) { $vhdx = $hit.FullName; break }
}
if (-not $vhdx) {
  Write-Host '  Not found. Docker Desktop -> Settings -> Resources -> "Disk image location" names the folder.'
  exit 1
}

$before = (Get-Item $vhdx).Length
$drive = (Split-Path -Qualifier $vhdx)
$freeBefore = (Get-PSDrive $drive.TrimEnd(':')).Free
Write-Host "  disk:        $vhdx"
Write-Host "  size:        $(GiB $before)"
Write-Host "  host free:   $(GiB $freeBefore) on $drive"

if ($WhatIf) {
  Write-Host ''
  Write-Host '  -WhatIf: nothing was stopped and nothing was changed.'
  Write-Host '  A real run quits Docker Desktop, runs wsl --shutdown, compacts the disk, restarts Docker.'
  exit 0
}

# Compaction can only return blocks that were TRIMMED first. Without that it runs, reports success, and
# frees nothing - the outcome most likely to be misread as "compaction does not work".
Write-Host ''
Write-Host '  Run "npm run docker:reclaim" first if you have not: compaction only reclaims blocks trimmed'
Write-Host '  inside the VM. This script prunes nothing itself, on purpose - deleting images is a'
Write-Host '  different decision from returning empty space.'

# -- Stop the VM -------------------------------------------------------------------------------------
if (-not $AssumeStopped) {
  Section 'Stopping Docker Desktop and WSL'
  $dd = Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue
  if ($dd) {
    Write-Host '  quitting Docker Desktop...'
    $dd | Stop-Process -Force
    Start-Sleep -Seconds 5
  } else {
    Write-Host '  Docker Desktop is not running.'
  }
  # The backend processes outlive the UI and keep the disk open.
  foreach ($n in 'com.docker.backend', 'com.docker.build', 'vpnkit', 'com.docker.dev-envs') {
    Get-Process $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  Write-Host '  wsl --shutdown...'
  wsl --shutdown
  Start-Sleep -Seconds 5
}

# -- Compact, elevated -------------------------------------------------------------------------------
# diskpart needs administrator. With the task `scripts/docker-compact-install.ps1` registers, that is the task's
# job and there is no prompt (Q-119): it runs a protected copy of docker-compact-elevated.ps1 that only an
# administrator can change. Without it, elevate just this step: a UAC prompt appears and the script waits.
$taskName = 'Ythril Docker Compact'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  Section 'Compacting (elevated through the installed task - no prompt)'
  $taskLog = Join-Path $env:ProgramData 'Ythril\docker-compact.log'
  # Its own name: `$before` is the disk size the result line prints, and reusing it here made that line throw.
  $logWrittenBefore = if (Test-Path $taskLog) { (Get-Item $taskLog).LastWriteTimeUtc } else { [DateTime]::MinValue }
  Start-ScheduledTask -TaskName $taskName
  # Wait for it to start writing, then for it to finish; the log's last line is the exit code.
  $deadline = (Get-Date).AddHours(2)
  do {
    Start-Sleep -Seconds 2
    $state = (Get-ScheduledTask -TaskName $taskName).State
    $written = (Test-Path $taskLog) -and ((Get-Item $taskLog).LastWriteTimeUtc -gt $logWrittenBefore)
  } while (((-not $written) -or $state -eq 'Running') -and (Get-Date) -lt $deadline)
  $lines = if (Test-Path $taskLog) { @(Get-Content $taskLog) } else { @() }
  foreach ($l in $lines) { Write-Host "  $l" }
  $last = $lines | Where-Object { $_ -like 'EXIT *' } | Select-Object -Last 1
  $code = if ($last) { [int]($last -replace '^EXIT ', '') } else { 1 }
  if ($code -ne 0) {
    Write-Host ''
    Write-Host "  The compaction task exited $code. If the disk was left ATTACHED, detach it from an elevated shell:"
    Write-Host '     diskpart'
    Write-Host "     select vdisk file=`"$vhdx`""
    Write-Host '     detach vdisk'
  }
} else {
Section 'Compacting (elevated - accept the UAC prompt)'
Write-Host '  (scripts\docker-compact-install.ps1, run once elevated, makes this run without the prompt)'
$script = Join-Path $env:TEMP ("ythril-compact-{0}.txt" -f [Guid]::NewGuid().ToString('N'))
@(
  "select vdisk file=`"$vhdx`"",
  # readonly is the guarantee, not a detail: an attached-for-write disk could be modified, and this
  # operation must be incapable of changing content.
  'attach vdisk readonly',
  'compact vdisk',
  'detach vdisk'
) | Set-Content -Path $script -Encoding ascii

$log = Join-Path $env:TEMP ("ythril-compact-{0}.log" -f [Guid]::NewGuid().ToString('N'))
$code = 1
try {
  $p = Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/c', "diskpart /s `"$script`" > `"$log`" 2>&1" `
    -Verb RunAs -Wait -PassThru -WindowStyle Hidden
  $code = $p.ExitCode
} catch {
  Write-Host "  Elevation was refused or failed: $($_.Exception.Message)"
  Write-Host "  The diskpart script is at: $script"
  exit 1
}

if (Test-Path $log) { Get-Content $log | ForEach-Object { Write-Host "  $_" } }
Remove-Item $script -ErrorAction SilentlyContinue

# A non-zero exit, or a disk left attached, is worth naming explicitly: the recovery is not obvious and the
# disk must not be left attached.
if ($code -ne 0) {
  Write-Host ''
  Write-Host "  diskpart exited $code. If the disk was left ATTACHED, detach it from an elevated shell:"
  Write-Host '     diskpart'
  Write-Host "     select vdisk file=`"$vhdx`""
  Write-Host '     detach vdisk'
}
}

# -- Result ------------------------------------------------------------------------------------------
Section 'Result'
$after = (Get-Item $vhdx).Length
$freeAfter = (Get-PSDrive $drive.TrimEnd(':')).Free
Write-Host ("  disk:      {0}  ->  {1}   ({2} returned)" -f (GiB $before), (GiB $after), (GiB ($before - $after)))
Write-Host ("  host free: {0}  ->  {1}   on {2}" -f (GiB $freeBefore), (GiB $freeAfter), $drive)
if ($after -ge $before) {
  Write-Host '  Nothing was returned. Almost always means the freed blocks were never trimmed:'
  Write-Host '  run "npm run docker:reclaim" (which fstrims inside the VM), then this again.'
}

# -- Bring Docker back -------------------------------------------------------------------------------
if (-not $AssumeStopped) {
  Section 'Restarting Docker Desktop'
  $exe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path $exe) {
    Start-Process $exe
    Write-Host '  started; the engine takes a minute. Containers with a restart policy come back on their own.'
  } else {
    Write-Host "  Could not find Docker Desktop.exe at $exe - start it yourself."
  }
}
