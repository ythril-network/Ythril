# Docker Desktop on this machine, as the scripts that take the engine away need it: where its data disk is, how
# it is started again, and how a native command is run so that its stderr is not mistaken for a failure.
#
# DOT-SOURCE it (`. scripts\docker-desktop.ps1`); it defines functions and runs nothing.
#
# ## Why this is a module
#
# docker-wipe.ps1 and docker-compact.ps1 each located docker_data.vhdx, and the two copies disagreed: the wipe
# read only `CustomWslDistroDir` and looked in one fixed place under it, compact also read `DataFolder` and
# searched below each root. A disk relocated through `DataFolder` was found by the script that compacts it and
# missed by the one that deletes it. Both also started `Docker Desktop.exe` by hand, and machine-free.ps1 had
# the only copy of the stderr rule that owner-instance.ps1's default docker seam needs as well. One copy each,
# here, so they cannot drift apart again (bundle-64, Q-294).
#
# ASCII ONLY: Windows PowerShell 5.1 reads a BOM-less script as ANSI (see docker-compact.ps1).

# Run a native command and return its STDOUT lines as strings. THROWS when it exits non-zero, naming the
# command, its exit code and the last lines it wrote to stderr - a failure is never an empty answer.
#
# Its stderr is NOT an error by itself: docker writes progress there, and Windows PowerShell 5.1 turns each
# such line into an ErrorRecord that `$ErrorActionPreference = 'Stop'` makes fatal. So the command runs under
# `Continue`, and only its exit code decides.
function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Command,
    [object[]]$ArgumentList = @()
  )
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = New-Object System.Collections.Generic.List[string]
  $err = New-Object System.Collections.Generic.List[string]
  try {
    $global:LASTEXITCODE = 0
    & $Command @ArgumentList 2>&1 | ForEach-Object {
      if ($_ -is [System.Management.Automation.ErrorRecord]) { $err.Add("$_") } else { $out.Add("$_") }
    }
    $code = $global:LASTEXITCODE
  } finally {
    $ErrorActionPreference = $old
  }
  if ($code -ne 0) {
    $said = ($err | Select-Object -Last 5) -join ' | '
    throw ("{0} {1} exited {2}: {3}" -f "$Command".Trim(), ($ArgumentList -join ' '), $code, $said)
  }
  return $out.ToArray()
}

# The full path of docker_data.vhdx. THROWS when it is not found: a caller that deletes or compacts "nothing"
# believes it has space it does not have.
#
# Docker Desktop lets the disk be relocated to any drive and records that in its settings store, under
# `CustomWslDistroDir` or `DataFolder`, so the default path is frequently wrong; each root is searched below
# itself, the default root last.
function Find-DockerDisk {
  $roots = @()
  $store = Join-Path $env:APPDATA 'Docker\settings-store.json'
  if (Test-Path -LiteralPath $store) {
    $s = [IO.File]::ReadAllText($store) | ConvertFrom-Json
    $roots += @($s.CustomWslDistroDir, $s.DataFolder) | Where-Object { $_ }
  }
  $roots += (Join-Path $env:LOCALAPPDATA 'Docker\wsl')
  foreach ($r in $roots) {
    if (-not (Test-Path -LiteralPath $r)) { continue }
    $hit = Get-ChildItem -LiteralPath $r -Recurse -Filter docker_data.vhdx -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  throw ("No docker_data.vhdx under {0}. Docker Desktop -> Settings -> Resources -> 'Disk image location' names the folder." -f ($roots -join ', '))
}

# Quit Docker Desktop and release its data disk: the UI, the engine processes it leaves behind (they outlive the
# UI and keep the disk open), then `wsl --shutdown` - EVERY distro, not just Docker's, because Docker's distro is
# the one holding the disk and a disk WSL holds can be neither compacted nor deleted. A process that is not there
# is the normal case after a crash, not an error. The wipe and compaction each had their own list and they
# differed (only the wipe stopped dockerd and the docker CLI); this is the one list.
function Stop-DockerDesktop {
  $dd = Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue
  if ($dd) { Write-Host '  quitting Docker Desktop...'; $dd | Stop-Process -Force -ErrorAction SilentlyContinue }
  else { Write-Host '  Docker Desktop is not running.' }
  foreach ($n in 'com.docker.backend', 'com.docker.build', 'dockerd', 'docker', 'vpnkit', 'com.docker.dev-envs') {
    Get-Process $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 3
  Write-Host '  wsl --shutdown...'
  wsl --shutdown
  Start-Sleep -Seconds 5
}

# Start Docker Desktop. THROWS when it is not installed where it is expected, so a caller that then waits for
# the engine is not left waiting for something that was never started.
function Start-DockerDesktop {
  $exe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (-not (Test-Path -LiteralPath $exe)) { throw "Docker Desktop not found at $exe - start it yourself." }
  Start-Process $exe
  Write-Host '  started Docker Desktop; the engine takes a minute.'
}
