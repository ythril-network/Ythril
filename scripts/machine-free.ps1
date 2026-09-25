# Free this machine's disk AND memory in one command: `npm run machine:free`.
#
# ## Why one command
#
# Docker Desktop's VM keeps both: pruning frees space INSIDE docker_data.vhdx and never shrinks the file, and
# WSL2 holds on to every memory peak (vmmem sat at 16 GB with 5 GB in use, 2026-09-24) until the VM restarts.
# Each half already had a script - docker:reclaim, docker:compact, docker:wipe - and the owner had to know which
# to run in which order. This runs them in the order that works and reports what it got back.
#
# ## What it does, in order
#
#   1. Removes the test stack (containers AND volumes). It is rebuilt by `npm run test:up:rebuild`, which
#      re-provisions its tokens - a bare `down -v` without that is what breaks the suites, not the removal.
#   2. `docker system prune -af --volumes`: every image, build cache entry, stopped container and unused volume
#      no RUNNING container needs. Running containers and their data are never touched.
#   3. fstrim inside the VM, so compaction has freed blocks to give back.
#   4. docker-compact.ps1: quits Docker Desktop, `wsl --shutdown` (this is what releases the VM's memory and
#      applies .wslconfig), compacts the disk file (one UAC prompt), starts Docker Desktop again. Containers with
#      a restart policy come back with it.
#
# With -Wipe, step 4 is docker-wipe.ps1 instead: the WHOLE data disk is deleted - every image, container and
# volume, including a running instance's database. Opt-in because it cannot be undone.
#
# ASCII ONLY: Windows PowerShell 5.1 reads a BOM-less script as ANSI (see docker-compact.ps1).
#
# Usage:  npm run machine:free
#         npm run machine:free -- -Wipe

[CmdletBinding()]
param([switch]$Wipe)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
function Section($t) { Write-Host ''; Write-Host ("-- $t " + ('-' * [Math]::Max(0, 60 - $t.Length))) }
function GiB($bytes) { '{0:N1} GiB' -f ($bytes / 1GB) }
# A native command's STDERR is not an error: docker writes its progress there, and Windows PowerShell 5.1 turns
# each line into an ErrorRecord that `Stop` makes fatal. Native calls run under `Continue` and return their lines.
function Native([scriptblock]$cmd) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $cmd 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $old }
}
function Snapshot() {
  $os = Get-CimInstance Win32_OperatingSystem
  $vm = Get-Process vmmem, vmmemWSL -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum
  [pscustomobject]@{
    MemFree = $os.FreePhysicalMemory * 1KB
    VmMem   = [double]($vm.Sum)
    DiskO   = (Get-PSDrive O -ErrorAction SilentlyContinue).Free
    DiskC   = (Get-PSDrive C).Free
  }
}

$before = Snapshot
Section 'Before'
Write-Host "  memory free: $(GiB $before.MemFree)   Docker VM holds: $(GiB $before.VmMem)"
Write-Host "  disk free:   C: $(GiB $before.DiskC)   O: $(GiB $before.DiskO)"

$engine = $true
Native { docker info } | Out-Null; if ($LASTEXITCODE -ne 0) { $engine = $false }

if ($engine) {
  Section 'Removing the test stack'
  $compose = Join-Path $repo 'testing\docker-compose.test.yml'
  Native { docker compose -p ythril-test -f $compose down -v --remove-orphans } | Out-Null
  Write-Host '  done - rebuild with: npm run test:up:rebuild'

  Section 'Pruning everything no running container needs'
  Native { docker system prune -af --volumes } | Select-String 'Total reclaimed space' | ForEach-Object { Write-Host "  $_" }

  Section 'Trimming the VM disk'
  Native { wsl -d docker-desktop -e sh -c 'fstrim -av' } | ForEach-Object { Write-Host "  $_" }
} else {
  Write-Host ''
  Write-Host '  Docker engine not running - skipping the prune; the next step works from outside it.'
}

if ($Wipe) {
  Section 'Wiping the Docker data disk'
  & (Join-Path $PSScriptRoot 'docker-wipe.ps1')
} elseif ($engine) {
  & (Join-Path $PSScriptRoot 'docker-compact.ps1')
} else {
  # Compaction needs the engine's disk location from a running Docker; without it, restart WSL at least.
  Section 'Releasing the VM memory'
  wsl --shutdown
}

Start-Sleep -Seconds 5
$after = Snapshot
Section 'After'
Write-Host "  memory free: $(GiB $after.MemFree)   (was $(GiB $before.MemFree))"
Write-Host "  disk free:   C: $(GiB $after.DiskC) (was $(GiB $before.DiskC))   O: $(GiB $after.DiskO) (was $(GiB $before.DiskO))"
