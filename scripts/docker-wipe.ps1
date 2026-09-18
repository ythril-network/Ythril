# Wipe Docker's data disk and let Docker Desktop recreate an empty one.
#
# ## Why this exists as a script
#
# `docker:reclaim` and `docker:compact` both need a RUNNING ENGINE, and the failure this is for is the
# one where the engine cannot start: on 2026-09-18 the host volume holding the VHD reached 14 MB free,
# containerd took a SIGBUS reading its own memory-mapped bbolt metadata, and Docker Desktop died. From
# there the two existing scripts are a deadlock -- pruning needs the engine, the engine needs space.
#
# So this one works from OUTSIDE the engine: stop everything, delete the data disk, start Docker. The
# disk is recreated empty on the next start.
#
# ## What it destroys, and it is everything
#
# Every image, every container, every volume and the whole build cache. There is no partial mode on
# purpose -- a selective wipe is what `docker:reclaim` is for, and reaching for this one means that
# option is already gone. Owner, 2026-09-18: *"for all i care just full wipe docker space"*, on a
# machine whose only containers are this project's test stack.
#
# The test stack rebuilds with `npm run test:up:rebuild`, which is the reason this is cheap here and
# would not be somewhere else.
$ErrorActionPreference = 'Stop'

function Section($t) { Write-Host ''; Write-Host "-- $t " -NoNewline; Write-Host ('-' * [Math]::Max(0, 62 - $t.Length)) }

Section 'Stopping Docker Desktop'
# The GUI first, then the engine processes it leaves behind. `-ErrorAction SilentlyContinue` because a
# crashed Docker may have left none of them, which is the normal case here rather than an error.
Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
foreach ($n in 'com.docker.backend', 'com.docker.build', 'dockerd', 'docker', 'vpnkit', 'com.docker.dev-envs') {
  Get-Process $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3

Section 'Shutting down WSL'
# EVERY distro, not just Docker's -- the VHD cannot be deleted while WSL holds it open, and Docker's
# distro is the one that holds it.
wsl --shutdown
Start-Sleep -Seconds 5

Section 'Deleting the data disk'
$settings = Join-Path $env:APPDATA 'Docker\settings-store.json'
$root = $null
if (Test-Path $settings) {
  $s = Get-Content $settings -Raw | ConvertFrom-Json
  # `CustomWslDistroDir` is where Docker Desktop was told to keep its disks; absent means the default.
  if ($s.CustomWslDistroDir) { $root = $s.CustomWslDistroDir }
}
if (-not $root) { $root = Join-Path $env:LOCALAPPDATA 'Docker\wsl' }

$disk = Join-Path $root 'disk\docker_data.vhdx'
if (-not (Test-Path $disk)) {
  # Named rather than guessed at: a wipe that silently deletes nothing is worse than one that stops,
  # because the caller then believes they have space they do not have.
  throw "No data disk at $disk -- Docker Desktop keeps it somewhere else; check its Resources settings."
}
$before = [math]::Round((Get-Item $disk).Length / 1GB, 2)
Remove-Item $disk -Force
Write-Host "  removed $disk ($before GiB)"

Section 'Starting Docker Desktop'
$exe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
if (Test-Path $exe) {
  Start-Process $exe
  Write-Host '  started; the engine takes a minute and recreates an empty disk.'
} else {
  Write-Host "  Docker Desktop not found at $exe -- start it yourself."
}

Section 'Result'
Write-Host "  reclaimed about $before GiB. Rebuild the test stack with: npm run test:up:rebuild"
