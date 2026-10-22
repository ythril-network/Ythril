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
#
# -TimeoutSeconds bounds ONE call: it needs -FilePath (a process this function owns and can end, with its children),
# not a scriptblock, and on the bound it kills the process tree and throws naming the command and the bound. An
# engine that has stopped answering must end a probe with its reason, not hang the script (U4b). Builds and `up`
# are not bounded here: they carry their own --wait-timeout.
#
# The error text never carries a build argument's value: `--build-arg NAME=VALUE` is written NAME=*** (S1), because
# a failed build's command line is printed and a build argument is where a token is passed.
function Invoke-Native {
  param(
    [scriptblock]$Command,
    [string]$FilePath,
    [object[]]$ArgumentList = @(),
    [int]$TimeoutSeconds = 0
  )
  if ($Command -and $FilePath) { throw 'Invoke-Native takes -Command or -FilePath, not both.' }
  if (-not $Command -and -not $FilePath) { throw 'Invoke-Native needs -Command or -FilePath.' }
  if ($TimeoutSeconds -gt 0 -and -not $FilePath) { throw 'Invoke-Native -TimeoutSeconds needs -FilePath: a scriptblock cannot be ended.' }
  $out = New-Object System.Collections.Generic.List[string]
  $err = New-Object System.Collections.Generic.List[string]
  $shown = if ($FilePath) { $FilePath } else { "$Command".Trim() }
  $shownArgs = (Hide-BuildArgValues -ArgumentList $ArgumentList) -join ' '
  if ($FilePath) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = (@($ArgumentList | ForEach-Object { ConvertTo-ProcessArgument -Value "$_" }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    if ($TimeoutSeconds -gt 0) { $finished = $proc.WaitForExit($TimeoutSeconds * 1000) } else { $proc.WaitForExit(); $finished = $true }
    if (-not $finished) {
      try { & taskkill.exe /PID $proc.Id /T /F | Out-Null } catch { }
      try { if (-not $proc.HasExited) { $proc.Kill() } } catch { }
      throw ("{0} {1} did not finish within {2} s and was stopped." -f $shown, $shownArgs, $TimeoutSeconds)
    }
    $proc.WaitForExit()
    $code = $proc.ExitCode
    foreach ($l in ($outTask.Result -split "\r?\n")) { if ($l -ne '') { $out.Add($l) } }
    foreach ($l in ($errTask.Result -split "\r?\n")) { if ($l -ne '') { $err.Add($l) } }
  } else {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $global:LASTEXITCODE = 0
      & $Command @ArgumentList 2>&1 | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) { $err.Add("$_") } else { $out.Add("$_") }
      }
      $code = $global:LASTEXITCODE
    } finally {
      $ErrorActionPreference = $old
    }
  }
  if ($code -ne 0) {
    $said = ($err | Select-Object -Last 5) -join ' | '
    foreach ($v in (Get-BuildArgValues -ArgumentList $ArgumentList)) { $said = $said.Replace($v, '***') }
    throw ("{0} {1} exited {2}: {3}" -f $shown, $shownArgs, $code, $said)
  }
  return $out.ToArray()
}

# The values of every `--build-arg NAME=VALUE` (or `--build-arg=NAME=VALUE`) in an argument list, empties dropped.
function Get-BuildArgValues {
  param([object[]]$ArgumentList = @())
  $a = @($ArgumentList | ForEach-Object { "$_" })
  $values = @()
  for ($i = 0; $i -lt $a.Count; $i++) {
    $pair = $null
    if ($a[$i] -eq '--build-arg' -and ($i + 1) -lt $a.Count) { $pair = $a[$i + 1] }
    elseif ($a[$i].StartsWith('--build-arg=')) { $pair = $a[$i].Substring('--build-arg='.Length) }
    if ($pair -and $pair.Contains('=')) { $v = $pair.Substring($pair.IndexOf('=') + 1); if ($v) { $values += $v } }
  }
  return $values
}

# An argument list with every build argument's value written ***: the form an error or a log line may carry.
function Hide-BuildArgValues {
  param([object[]]$ArgumentList = @())
  $a = @($ArgumentList | ForEach-Object { "$_" })
  $shown = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $a.Count; $i++) {
    if ($a[$i] -eq '--build-arg' -and ($i + 1) -lt $a.Count) {
      $shown.Add($a[$i]); $i++
      $shown.Add(($a[$i] -replace '(?s)^([^=]+)=.*$', '$1=***'))
    } elseif ($a[$i] -match '(?s)^--build-arg=([^=]+)=') {
      $shown.Add("--build-arg=$($Matches[1])=***")
    } else {
      $shown.Add($a[$i])
    }
  }
  return $shown.ToArray()
}

# One argument as a Windows command line carries it (CommandLineToArgvW rules).
function ConvertTo-ProcessArgument {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  if ($Value -ne '' -and $Value -notmatch '[\s"]') { return $Value }
  $v = $Value -replace '(\\*)"', '$1$1\"'
  $v = $v -replace '(\\+)$', '$1$1'
  return ('"' + $v + '"')
}

# `docker info`, bounded at 20 s: the one probe every script asks, and the one that hangs on a half-dead engine.
function Invoke-DockerInfo {
  return (Invoke-Native -FilePath 'docker' -ArgumentList @('info') -TimeoutSeconds 20)
}

# Does the engine answer, within the bound? The one place the scripts ask it.
function Test-DockerEngine {
  try { $null = Invoke-DockerInfo; return $true } catch { return $false }
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
