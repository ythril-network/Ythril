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
#   - The owner's instance (the compose project running from this checkout) is stopped cleanly through
#     scripts/owner-instance.ps1, then Docker Desktop is QUIT: every other container goes down with it.
#   - `wsl --shutdown` stops EVERY WSL distro, not just Docker's.
# Docker Desktop comes back at the end, and the owner's instance is brought back by this script itself
# (`compose up --wait` of the services that ran), in a finally - so a refused UAC prompt or a failed
# diskpart does not leave it down. A restart policy cannot do that: a compose stop disarms it (2026-10-06,
# the instance stayed down). Other containers come back only if their restart policy brings them; work in
# another WSL distro does not.
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
  # cannot attach a disk whose VM still holds it, and fails rather than corrupting anything. Nothing is
  # stopped, so nothing is restarted either.
  [switch]$AssumeStopped
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'docker-desktop.ps1')
. (Join-Path $PSScriptRoot 'owner-instance.ps1')
$repo = Split-Path -Parent $PSScriptRoot

function Section($t) { Write-Host ''; Write-Host ("-- $t " + ('-' * [Math]::Max(0, 60 - $t.Length))) }
function GiB($bytes) { '{0:N2} GiB' -f ($bytes / 1GB) }

# -- Locate the disk ---------------------------------------------------------------------------------
Section 'Locating docker_data.vhdx'
$vhdx = Find-DockerDisk

$before = (Get-Item $vhdx).Length
$drive = (Split-Path -Qualifier $vhdx)
$freeBefore = (Get-PSDrive $drive.TrimEnd(':')).Free
Write-Host "  disk:        $vhdx"
Write-Host "  size:        $(GiB $before)"
Write-Host "  host free:   $(GiB $freeBefore) on $drive"

if ($WhatIf) {
  Write-Host ''
  Write-Host '  -WhatIf: nothing was stopped and nothing was changed.'
  Write-Host "  A real run stops the owner's instance, quits Docker Desktop, runs wsl --shutdown, compacts the disk,"
  Write-Host "  restarts Docker and brings the owner's instance back."
  exit 0
}

# Compaction can only return blocks that were TRIMMED first. Without that it runs, reports success, and
# frees nothing - the outcome most likely to be misread as "compaction does not work".
Write-Host ''
Write-Host '  Run "npm run docker:reclaim" first if you have not: compaction only reclaims blocks trimmed'
Write-Host '  inside the VM. This script prunes nothing itself, on purpose - deleting images is a'
Write-Host '  different decision from returning empty space.'

$owner = $null
$stopAttempted = $false
$dockerQuit = $false
try {
  # -- Stop the VM -----------------------------------------------------------------------------------
  if (-not $AssumeStopped) {
    Section 'Stopping Docker Desktop and WSL'
    $engine = Test-DockerEngine
    if ($engine) {
      # Compaction deletes nothing, so this reads what runs WITHOUT the wipe's data guard.
      $owner = Read-OwnerInstance -RepoRoot $repo
      if ($owner) {
        Write-Host "  stopping the owner's instance: $(Format-OwnerRecord -Record $owner)"
        # Set BEFORE the call: a stop that fails part-way has stopped some of the services, and the finally
        # brings back what it stopped (U4a).
        $stopAttempted = $true
        Stop-OwnerInstance -Record $owner
      }
    }
    $dockerQuit = $true
    Stop-DockerDesktop
  }

  # -- Compact, elevated -----------------------------------------------------------------------------
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
      # Thrown, not `exit`: the finally below still brings Docker and the owner's instance back.
      throw
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

  # -- Result ----------------------------------------------------------------------------------------
  Section 'Result'
  $after = (Get-Item $vhdx).Length
  $freeAfter = (Get-PSDrive $drive.TrimEnd(':')).Free
  Write-Host ("  disk:      {0}  ->  {1}   ({2} returned)" -f (GiB $before), (GiB $after), (GiB ($before - $after)))
  Write-Host ("  host free: {0}  ->  {1}   on {2}" -f (GiB $freeBefore), (GiB $freeAfter), $drive)
  if ($after -ge $before) {
    Write-Host '  Nothing was returned. Almost always means the freed blocks were never trimmed:'
    Write-Host '  run "npm run docker:reclaim" (which fstrims inside the VM), then this again.'
  }
} finally {
  # -- Bring Docker back, and the owner's instance with it ----------------------------------------------
  # Whatever happened above: a refused UAC prompt, a failed diskpart or a script error must not leave the
  # instance down. Nothing was deleted, so the services start from the images they ran (no build).
  if ($dockerQuit) {
    Section 'Restarting Docker Desktop'
    Start-DockerDesktop
  }
  # Whenever the stop was attempted, whether or not Docker was quit after it: a stop that threw has left the
  # engine running and part of the instance down.
  if ($stopAttempted -and $owner) {
    Section "Bringing the owner's instance back"
    Wait-Engine
    Start-OwnerInstance -Record $owner
    Write-Host "  back: $(Format-OwnerRecord -Record $owner)"
  }
}
