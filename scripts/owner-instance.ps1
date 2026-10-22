# The owner's running Ythril instance, as a script that takes Docker's engine away needs it: what runs, whether
# taking the engine away would delete data, and how to stop it cleanly and bring it back (Q-294, bundle-64).
#
# DOT-SOURCE it (`. scripts\owner-instance.ps1`); it defines functions and runs nothing.
#
# ## Why this exists
#
# docker-wipe.ps1 deletes Docker's data disk, and with it every image and container of the instance running from
# this checkout. Its data survives - the override binds it under the checkout (local-data/, config/) - but nothing
# recorded what ran, so after a wipe the instance stayed down until someone remembered how it had been started,
# from which commit, with which override. docker-compact.ps1 stopped it the same way and relied on a restart
# policy to bring it back, which a compose stop had already disarmed (2026-10-06: the instance stayed down).
#
# ## What it promises
#
# - It records only what RUNS, and only named fields (image, build, bind mounts): never an environment and never
#   the resolved config's text, which carries the Mongo password.
# - A wipe is only harmless while every volume it deletes is disposable. `Get-OwnerInstance` refuses - throws,
#   naming the service, the volume and the mount target - when a running service mounts a named volume that the
#   config's top-level `x-ythril: disposable-volumes:` list does not name, and always for one at /data, /data/db or
#   /data/configdb, named or not. Binds are never refused: they live outside the disk the wipe deletes. A list
#   and not a volume label: a label added to an existing volume makes compose ask "Recreate (data will be
#   lost)?" on every install at its next `up` (probed, compose 5.4.0), and a non-interactive `up` answers no.
# - A pending record (saved, not yet restored) is never overwritten without being told to: a wipe that died
#   between the delete and the restore left the only description of the instance in it.
# - Docker and git are reached through a parameter seam (-Docker, -Git: scriptblocks that return stdout and THROW
#   on failure), so the behaviour is exercised from canned answers without touching an engine
#   (testing/standalone/the-owner-instance-comes-back-after-a-wipe.test.js). The module never reads $LASTEXITCODE.
# - Every wait is bounded: Wait-Engine by its timeout, compose by --wait-timeout.
#
# ASCII ONLY: Windows PowerShell 5.1 reads a BOM-less script as ANSI (see docker-compact.ps1).

. (Join-Path $PSScriptRoot 'docker-desktop.ps1')

# The real CLIs behind the seam: stdout back, a non-zero exit thrown (Invoke-Native).
function Invoke-DockerCli { Invoke-Native -Command { docker @args } -ArgumentList $args }
function Invoke-GitCli { Invoke-Native -Command { git @args } -ArgumentList $args }

# -- Paths, compared as strings --------------------------------------------------------------------------------
# Compose writes working_dir as the shell spelled it (O:\Projects\Ythril, o:\projects\ythril, with or without a
# trailing separator). Every comparison goes through this one spelling.

function ConvertTo-ComparablePath {
  param([Parameter(Mandatory = $true)][string]$Path)
  $p = $Path.Replace('\', '/').ToLowerInvariant()
  while ($p.Length -gt 1 -and $p.EndsWith('/')) { $p = $p.Substring(0, $p.Length - 1) }
  return $p
}

function Test-SameDirectory {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Root)
  return ((ConvertTo-ComparablePath -Path $Path) -eq (ConvertTo-ComparablePath -Path $Root))
}

# The root itself or anything below it - with a boundary, so O:\Projects\Ythril-old is not under O:\Projects\Ythril.
function Test-PathUnder {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Root)
  $p = ConvertTo-ComparablePath -Path $Path
  $r = ConvertTo-ComparablePath -Path $Root
  return ($p -eq $r -or $p.StartsWith($r + '/'))
}

# The `com.docker.compose.project.config_files` label: absolute paths joined by commas.
function Split-ConfigFiles {
  param([AllowEmptyString()][string]$Value)
  return @("$Value".Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

# -- What runs -------------------------------------------------------------------------------------------------

# The compose project of -RepoRoot that runs now, as a record WITHOUT the data guard - what docker-compact.ps1
# needs, since compaction deletes nothing. $null when no project of this checkout runs, whatever else runs:
# compaction stops nobody it cannot bring back, and other containers come back by their own restart policy.
function Read-OwnerInstance {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [scriptblock]$Docker = ${function:Invoke-DockerCli},
    [scriptblock]$Git = ${function:Invoke-GitCli}
  )
  return (Read-RunningProjects -RepoRoot $RepoRoot -Docker $Docker -Git $Git).record
}

# What runs: the record of -RepoRoot's project (or $null) and the other projects that run and are not test
# projects. One read for both callers, so the wipe's refusal and compaction's tolerance judge the same listing.
function Read-RunningProjects {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][scriptblock]$Docker,
    [Parameter(Mandatory = $true)][scriptblock]$Git
  )
  $none = [pscustomobject]@{ record = $null; others = @() }
  $ids = @(& $Docker ps -q | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
  if ($ids.Count -eq 0) { return $none }
  $parsed = (@(& $Docker inspect @ids) -join "`n") | ConvertFrom-Json
  $containers = @($parsed)

  $projects = [ordered]@{}
  foreach ($c in $containers) {
    $labels = $c.Config.Labels
    if (-not $labels) { continue }
    $name = $labels.'com.docker.compose.project'
    if (-not $name) { continue }
    if (-not $projects.Contains($name)) {
      $projects[$name] = [pscustomobject]@{
        name        = $name
        workingDir  = $labels.'com.docker.compose.project.working_dir'
        configFiles = @(Split-ConfigFiles -Value $labels.'com.docker.compose.project.config_files')
        services    = New-Object System.Collections.Generic.List[string]
      }
    }
    $svc = $labels.'com.docker.compose.service'
    if ($svc -and -not $projects[$name].services.Contains($svc)) { $projects[$name].services.Add($svc) }
  }

  $mine = @($projects.Values | Where-Object { $_.workingDir -and (Test-SameDirectory -Path $_.workingDir -Root $RepoRoot) })
  if ($mine.Count -gt 1) {
    throw ("More than one compose project runs from {0}: {1}. Stop all but the owner's instance first." -f $RepoRoot, (($mine | ForEach-Object { $_.name }) -join ', '))
  }
  if ($mine.Count -eq 0) {
    return [pscustomobject]@{ record = $null; others = @($projects.Values | Where-Object { $_.name -notmatch '^ythril-test' }) }
  }
  $p = $mine[0]
  $wd = $p.workingDir

  $argv = @('compose', '-p', $p.name, '--project-directory', $wd)
  foreach ($f in $p.configFiles) { $argv += @('-f', $f) }
  $argv += @('config', '--format', 'json')
  $config = (@(& $Docker @argv) -join "`n") | ConvertFrom-Json
  $commit = "$(@(& $Git -C $wd rev-parse HEAD) | Select-Object -First 1)".Trim()

  # Named fields only: image, build, binds. Never `environment`, never the config text.
  $services = [ordered]@{}
  $mounts = New-Object System.Collections.Generic.List[object]
  foreach ($s in ($p.services | Sort-Object)) {
    $def = $config.services.$s
    if (-not $def) { throw "Service '$s' of project '$($p.name)' runs, but its config does not declare it: the config read is not the one it was started with." }
    $build = $null
    if ($def.build) {
      $build = [pscustomobject]@{ context = $def.build.context; dockerfile = $def.build.dockerfile; args = $def.build.args; target = $def.build.target }
    }
    $binds = @(@($def.volumes) | Where-Object { $_ -and $_.type -eq 'bind' } | ForEach-Object { [pscustomobject]@{ source = $_.source; target = $_.target } })
    foreach ($v in @($def.volumes)) { if ($v -and $v.type -eq 'volume') { $mounts.Add([pscustomobject]@{ service = $s; volume = $v.source; target = $v.target }) } }
    $services[$s] = [pscustomobject]@{ image = $def.image; build = $build; binds = $binds }
  }

  $record = [pscustomobject]@{
    schema      = 1
    project     = $p.name
    workingDir  = $wd
    configFiles = @($p.configFiles)
    commit      = $commit
    services    = [pscustomobject]$services
  }
  # Carried beside the record, never written: the guard reads it, the record file does not hold it.
  $disposable = @()
  $ext = $config.'x-ythril'
  if ($ext -and $ext.'disposable-volumes') { $disposable = @($ext.'disposable-volumes' | ForEach-Object { "$_" }) }
  Add-Member -InputObject $record -MemberType NoteProperty -Name '__volumes' -Value @{ mounts = $mounts.ToArray(); disposable = $disposable }
  return [pscustomobject]@{ record = $record; others = @() }
}

# The record of the instance a WIPE may take away: Read-OwnerInstance plus the data guard. Throws, naming the
# service, the volume and the mount target, when deleting the data disk would delete data. Throws as well when no
# project of this checkout runs and another, non-test project does: the wipe deletes that one too, and which of
# them is the owner's is not ours to guess.
function Get-OwnerInstance {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [scriptblock]$Docker = ${function:Invoke-DockerCli},
    [scriptblock]$Git = ${function:Invoke-GitCli}
  )
  $state = Read-RunningProjects -RepoRoot $RepoRoot -Docker $Docker -Git $Git
  $record = $state.record
  if (-not $record) {
    if ($state.others.Count -gt 0) {
      $named = ($state.others | ForEach-Object { "$($_.name) ($($_.workingDir))" }) -join ', '
      throw ("No compose project of {0} runs, and other projects do: {1}. Which of them is the owner's instance is not ours to guess - run this from that project's checkout, or stop them first." -f $RepoRoot, $named)
    }
    return $null
  }
  $neverDisposable = @('/data', '/data/db', '/data/configdb')
  $refused = @()
  foreach ($m in $record.__volumes.mounts) {
    $vol = if ($m.volume) { $m.volume } else { '(anonymous)' }
    $target = "$($m.target)".TrimEnd('/')
    if ($neverDisposable -contains $target) {
      $refused += "service '$($m.service)' mounts the named volume '$vol' at $($m.target), which holds the instance's data and is never disposable"
      continue
    }
    if (-not ($m.volume -and ($record.__volumes.disposable -contains $m.volume))) {
      $refused += "service '$($m.service)' mounts the named volume '$vol' at $($m.target), which x-ythril.disposable-volumes does not name"
    }
  }
  if ($refused.Count -gt 0) {
    throw ("The wipe would delete data: {0}. A named volume lives on the disk the wipe deletes; bind it to a directory under the checkout (as docker-compose.override.yml does with local-data/), or name a volume that only holds what is fetched again in the compose file's x-ythril.disposable-volumes." -f ($refused -join '; '))
  }
  $record.PSObject.Properties.Remove('__volumes')
  return $record
}

# -- The record on disk ----------------------------------------------------------------------------------------

function Read-OwnerRecord {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not [IO.File]::Exists($Path)) { return $null }
  return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json)
}

# Written whole or not at all: a temporary file in the same directory, then swapped in.
function Write-OwnerRecord {
  param([Parameter(Mandatory = $true)]$Record, [Parameter(Mandatory = $true)][string]$Path)
  $dir = Split-Path -Parent $Path
  [void][IO.Directory]::CreateDirectory($dir)
  $json = ConvertTo-Json -InputObject $Record -Depth 12
  $tmp = Join-Path $dir ('.{0}.{1}.tmp' -f [IO.Path]::GetFileName($Path), [Guid]::NewGuid().ToString('N'))
  try {
    [IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($tmp, $Path, [NullString]::Value) } else { [IO.File]::Move($tmp, $Path) }
  } finally {
    if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) }
  }
}

function Format-OwnerRecord {
  param([Parameter(Mandatory = $true)]$Record)
  $names = @($Record.services.PSObject.Properties | ForEach-Object { $_.Name })
  $commit = "$($Record.commit)"
  if ($commit.Length -gt 7) { $commit = $commit.Substring(0, 7) }
  return ("project {0}, commit {1}, services {2}" -f $Record.project, $commit, ($names -join ', '))
}

# A pending record at -Path, decided: returned with -UseRecord, $null with -DiscardRecord or when there is none
# (or it was restored), and a refusal naming its age, commit and services otherwise.
function Resolve-PendingRecord {
  param([Parameter(Mandatory = $true)][string]$Path, [switch]$UseRecord, [switch]$DiscardRecord)
  if ($UseRecord -and $DiscardRecord) { throw '-UseRecord and -DiscardRecord contradict each other: pass one.' }
  $old = Read-OwnerRecord -Path $Path
  if (-not $old -or $old.state -ne 'pending') { return $null }
  if ($UseRecord) { return $old }
  if ($DiscardRecord) { return $null }
  $saved = $old.savedAt
  if ($saved -isnot [datetime]) { $saved = [DateTime]::Parse("$saved", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) }
  $age = [DateTime]::UtcNow - $saved.ToUniversalTime()
  throw ("A pending record of the owner's instance is at {0}, saved {1:N1} hours ago: {2}. A wipe stopped before it brought that instance back. Pass -UseRecord to restore THAT record, or -DiscardRecord to replace it." -f $Path, $age.TotalHours, (Format-OwnerRecord -Record $old))
}

# Record what runs before the engine goes away. Returns the record the caller is to restore: the new one, or with
# -UseRecord the pending one already at -Path.
function Save-OwnerInstance {
  param([Parameter(Mandatory = $true)]$Record, [Parameter(Mandatory = $true)][string]$Path, [switch]$UseRecord, [switch]$DiscardRecord)
  $pending = Resolve-PendingRecord -Path $Path -UseRecord:$UseRecord -DiscardRecord:$DiscardRecord
  if ($pending) { return $pending }
  $full = [pscustomobject]@{
    schema      = 1
    state       = 'pending'
    savedAt     = [DateTime]::UtcNow.ToString('o')
    project     = $Record.project
    workingDir  = $Record.workingDir
    configFiles = @($Record.configFiles)
    commit      = $Record.commit
    services    = $Record.services
  }
  Write-OwnerRecord -Record $full -Path $Path
  return $full
}

# -- Stop, start, restore --------------------------------------------------------------------------------------

function Get-ComposeArguments {
  param([Parameter(Mandatory = $true)]$Record)
  $argv = @('compose', '-p', $Record.project, '--project-directory', $Record.workingDir)
  foreach ($f in @($Record.configFiles)) { $argv += @('-f', $f) }
  return $argv
}

function Get-RecordedServices {
  param([Parameter(Mandatory = $true)]$Record)
  return @($Record.services.PSObject.Properties | ForEach-Object { $_.Name })
}

# A clean stop of the recorded services only, with the grace mongod needs to shut down rather than be killed with
# the VM. Nothing is removed.
function Stop-OwnerInstance {
  param([Parameter(Mandatory = $true)]$Record, [scriptblock]$Docker = ${function:Invoke-DockerCli})
  $argv = @(Get-ComposeArguments -Record $Record) + @('stop', '-t', '60') + @(Get-RecordedServices -Record $Record)
  $null = & $Docker @argv
}

# The recorded services up again from images that exist (nothing was deleted, so nothing is built), waiting until
# they are healthy - bounded.
function Start-OwnerInstance {
  param([Parameter(Mandatory = $true)]$Record, [scriptblock]$Docker = ${function:Invoke-DockerCli})
  $argv = @(Get-ComposeArguments -Record $Record) + @('up', '-d', '--no-build', '--wait', '--wait-timeout', '900') + @(Get-RecordedServices -Record $Record)
  $null = & $Docker @argv
}

# A path under the recorded working directory, moved to the same place under the rebuild worktree.
function Get-RebuildPath {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$From, [Parameter(Mandatory = $true)][string]$To)
  if (-not (Test-PathUnder -Path $Path -Root $From)) {
    Write-Warning "$Path is outside $From, so it is built as it is now, not at the recorded commit."
    return $Path
  }
  $rest = $Path.Replace('\', '/').Substring((ConvertTo-ComparablePath -Path $From).Length).TrimStart('/')
  if (-not $rest) { return $To }
  return (Join-Path $To $rest)
}

# Bring a pending record back: every service with a build is rebuilt from a worktree at the recorded commit (its
# image tagged as the record names it, with GIT_REVISION set), then the recorded services start and are waited
# for. The record is marked restored only after that. With -RestoreOnly a record already restored is said and left.
function Restore-OwnerInstance {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [scriptblock]$Docker = ${function:Invoke-DockerCli},
    [scriptblock]$Git = ${function:Invoke-GitCli},
    [switch]$RestoreOnly
  )
  $record = Read-OwnerRecord -Path $Path
  if (-not $record) { throw "No record of the owner's instance at $Path - nothing to restore." }
  if ($record.state -eq 'restored') {
    # Said and left, whether asked with -RestoreOnly or reached after a save: a restored record has nothing to bring back.
    Write-Host ("  The owner's instance recorded at {0} is already restored ({1}); nothing to do." -f $Path, (Format-OwnerRecord -Record $record))
    return
  }
  $wd = $record.workingDir
  $commit = "$($record.commit)"
  $built = @(Get-RecordedServices -Record $record | Where-Object { $record.services.$_.build })
  if ($built.Count -gt 0) {
    $null = & $Git -C $wd cat-file -e "$commit^{commit}"
    $wt = Join-Path (Split-Path -Parent $Path) 'owner-rebuild'
    # A worktree a failed restore left behind would make `worktree add` refuse; this one is ours to replace.
    if (Test-Path -LiteralPath $wt) { $null = & $Git -C $wd worktree remove --force $wt }
    $null = & $Git -C $wd worktree prune
    $null = & $Git -C $wd worktree add --detach $wt $commit
    try {
      foreach ($n in $built) {
        $svc = $record.services.$n
        $b = $svc.build
        $tag = if ($svc.image) { $svc.image } else { "$($record.project)-$n" }
        $ctx = Get-RebuildPath -Path $b.context -From $wd -To $wt
        $argv = @('build', '-t', $tag, '--build-arg', "GIT_REVISION=$commit")
        if ($b.args) { foreach ($a in $b.args.PSObject.Properties) { $argv += @('--build-arg', "$($a.Name)=$($a.Value)") } }
        if ($b.dockerfile) {
          $df = if ([IO.Path]::IsPathRooted($b.dockerfile)) { Get-RebuildPath -Path $b.dockerfile -From $wd -To $wt } else { Join-Path $ctx $b.dockerfile }
          $argv += @('-f', $df)
        }
        if ($b.target) { $argv += @('--target', $b.target) }
        $argv += $ctx
        Write-Host "  building $n as $tag at $($commit.Substring(0, [Math]::Min(7, $commit.Length)))..."
        $null = & $Docker @argv
      }
    } finally {
      try { $null = & $Git -C $wd worktree remove --force $wt } catch { Write-Warning "The rebuild worktree $wt was not removed: $($_.Exception.Message)" }
    }
  }
  Write-Host '  starting the recorded services and waiting for them to be healthy...'
  Start-OwnerInstance -Record $record -Docker $Docker
  $record.state = 'restored'
  Add-Member -InputObject $record -MemberType NoteProperty -Name restoredAt -Value ([DateTime]::UtcNow.ToString('o')) -Force
  Write-OwnerRecord -Record $record -Path $Path
  Write-Host ("  The owner's instance is back: {0}." -f (Format-OwnerRecord -Record $record))
}

# The bytes the recorded services' images take now: what rebuilding and pulling them will need again. An image
# that is not there counts nothing.
function Measure-OwnerImages {
  param([Parameter(Mandatory = $true)]$Record, [scriptblock]$Docker = ${function:Invoke-DockerCli})
  [long]$total = 0
  foreach ($n in (Get-RecordedServices -Record $Record)) {
    $img = $Record.services.$n.image
    if (-not $img) { continue }
    try { $total += [long]("$(@(& $Docker image inspect --format '{{.Size}}' $img) | Select-Object -First 1)".Trim()) } catch { }
  }
  return $total
}

# -- The engine ------------------------------------------------------------------------------------------------

# Returns once `docker info` answers; throws when it has not by the timeout. Bounded on purpose: an engine that
# never comes back must end the script with its reason, not hang it.
function Wait-Engine {
  param([scriptblock]$Docker = ${function:Invoke-DockerCli}, [int]$TimeoutSeconds = 300, [int]$IntervalSeconds = 5)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $last = $null
  while ($true) {
    try { $null = & $Docker info; return } catch { $last = $_.Exception.Message }
    if ([DateTime]::UtcNow -ge $deadline) { throw "The Docker engine did not answer within $TimeoutSeconds s: $last" }
    if ($IntervalSeconds -gt 0) { Start-Sleep -Seconds $IntervalSeconds }
  }
}
