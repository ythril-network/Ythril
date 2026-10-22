# Wipe Docker's data disk, let Docker Desktop recreate an empty one, and bring the owner's instance back.
#
# ## Why this exists as a script
#
# `docker:reclaim` and `docker:compact` both need a RUNNING ENGINE, and the failure this is for is the
# one where the engine cannot start: on 2026-09-18 the host volume holding the VHD reached 14 MB free,
# containerd took a SIGBUS reading its own memory-mapped bbolt metadata, and Docker Desktop died. From
# there the two existing scripts are a deadlock -- pruning needs the engine, the engine needs space.
#
# So this one works from OUTSIDE the engine: stop Docker and WSL, delete the data disk, start Docker. The
# disk is recreated empty on the next start.
#
# ## What goes with the disk, and what survives
#
# Every image, every container, every named volume and the whole build cache: they live on the disk this
# deletes. There is no partial mode on purpose -- a selective wipe is what `docker:reclaim` is for, and
# reaching for this one means that option is already gone. Owner, 2026-09-18: *"for all i care just full
# wipe docker space"*.
#
# Data in bind mounts survives, because it is not on that disk: the owner's instance keeps its database
# under local-data/ and its configuration under config/ in the checkout, and the wipe never touches them.
# What a wipe used to lose was the instance itself -- nothing recorded what ran, so it stayed down until
# someone remembered how it had been started (Q-294). Now, while the engine answers, the wipe records the
# instance running from this checkout (scripts/owner-instance.ps1), refuses if any named volume of its project
# is not in the compose file's x-ythril.disposable-volumes list, or if another project runs (the wipe deletes it
# and does not bring it back), stops it cleanly, deletes the disk, waits for the engine and brings it back,
# rebuilt from the commit it ran. The guard runs only while the engine answers: when it does not, there is
# nothing to read, nothing is recorded and NOTHING IS CHECKED, and the last line names the command that
# brings an instance up by hand.
#
# The test stack rebuilds with `npm run test:up:rebuild`.
#
# Usage:  npm run docker:wipe
#         npm run docker:wipe -- -UseRecord      (restore the pending record a stopped wipe left behind)
#         npm run docker:wipe -- -DiscardRecord  (replace that record with what runs now)
#         npm run docker:wipe -- -RestoreOnly    (delete nothing; bring the recorded instance back)
#
# ASCII ONLY: Windows PowerShell 5.1 reads a BOM-less script as ANSI (see docker-compact.ps1).

[CmdletBinding()]
param(
  # Delete nothing: wait for the engine and bring the recorded instance back (a restore that failed, rerun).
  [switch]$RestoreOnly,
  # A pending record is at the record path: restore THAT one rather than refusing.
  [switch]$UseRecord,
  # A pending record is at the record path: replace it with what runs now (or drop it when nothing runs).
  [switch]$DiscardRecord
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'docker-desktop.ps1')
. (Join-Path $PSScriptRoot 'owner-instance.ps1')

function Section($t) { Write-Host ''; Write-Host "-- $t " -NoNewline; Write-Host ('-' * [Math]::Max(0, 62 - $t.Length)) }

# A TCP connection, bounded at five seconds: can a rebuild reach what it pulls from?
function Test-Reachable([string]$HostName, [int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try { return $client.ConnectAsync($HostName, $Port).Wait(5000) } catch { return $false } finally { $client.Dispose() }
}

$repo = Split-Path -Parent $PSScriptRoot
# Under local-data/, which is bound into containers and never on Docker's disk: the record survives the wipe it
# describes.
$recordPath = Join-Path $repo 'local-data\owner-instance\owner-instance.json'
$record = $null
$reclaimed = $null

# Bounded at 20 s: a half-dead engine is "not answering", not a hang.
$engine = Test-DockerEngine

if ($RestoreOnly) {
  Section 'Restoring only - nothing is deleted'
  $record = Read-OwnerRecord -Path $recordPath
  if (-not $record) { throw "No record of the owner's instance at $recordPath - -RestoreOnly has nothing to bring back." }
  if (-not $engine) { Start-DockerDesktop }
} else {
  $disk = Find-DockerDisk

  Section "Recording the owner's instance"
  $found = $null
  if ($engine) {
    # The data guard runs here, BEFORE anything is stopped: a refusal leaves the machine exactly as it was.
    $found = Get-OwnerInstance -RepoRoot $repo
    if ($found) {
      $record = Save-OwnerInstance -Record $found -Path $recordPath -UseRecord:$UseRecord -DiscardRecord:$DiscardRecord
      Write-Host "  recorded at $recordPath"
      Write-Host "  $(Format-OwnerRecord -Record $record)"
      $note = Get-CommitNote -Record $record
      if ($note) { Write-Host "  $note" }
    } else {
      Write-Host "  no compose project of $repo runs."
      $record = Resolve-PendingRecord -Path $recordPath -UseRecord:$UseRecord -DiscardRecord:$DiscardRecord
    }
  } else {
    Write-Host '  the engine does not answer: the data guard runs only while it does, so what runs is not read, nothing is recorded and NO volume is checked.'
    $record = Resolve-PendingRecord -Path $recordPath -UseRecord:$UseRecord -DiscardRecord:$DiscardRecord
  }
  if ($record -and -not $found) { Write-Host "  restoring the pending record: $(Format-OwnerRecord -Record $record)" }
  if (-not $record -and $DiscardRecord -and [IO.File]::Exists($recordPath)) {
    [IO.File]::Delete($recordPath)
    Write-Host "  discarded the pending record at $recordPath"
  }

  if ($engine -and $record) {
    Section 'Checking the instance can be brought back'
    # The free space AFTER the delete is what the rebuild has: the disk's own size comes back with it.
    $drive = Split-Path -Qualifier $disk
    $free = (Get-PSDrive $drive.TrimEnd(':')).Free
    $size = (Get-Item -LiteralPath $disk).Length
    $need = Measure-OwnerImages -Record $record
    if ($need -gt 0 -and ($free + $size) -lt [long]($need * 1.25)) {
      throw ("{0} will have {1:N1} GiB free after the delete, and the owner's images alone took {2:N1} GiB: the rebuild would fill the drive. Free space on {0} first." -f $drive, (($free + $size) / 1GB), ($need / 1GB))
    }
    $hosts = @('registry-1.docker.io')
    if (@(Get-RecordedServices -Record $record | Where-Object { $record.services.$_.build }).Count -gt 0) { $hosts += 'registry.npmjs.org' }
    foreach ($h in $hosts) {
      if (-not (Test-Reachable $h 443)) { throw "$h does not answer on 443: the instance could not be rebuilt or pulled after the delete. Nothing was changed." }
    }
    Write-Host ('  {0:N1} GiB free after the delete; {1} reachable.' -f (($free + $size) / 1GB), ($hosts -join ', '))
    Write-Host '  named volumes in x-ythril.disposable-volumes (media models, caches) go with the disk and are fetched again on first use.'

    if ($found) {
      Section "Stopping the owner's instance"
      # A clean stop: mongod shuts down rather than being killed with the VM.
      Stop-OwnerInstance -Record $found
      Write-Host '  stopped.'
    }
  }

  Section 'Stopping Docker Desktop and WSL'
  Stop-DockerDesktop

  Section 'Deleting the data disk'
  $reclaimed = [math]::Round((Get-Item -LiteralPath $disk).Length / 1GB, 2)
  Remove-Item -LiteralPath $disk -Force
  Write-Host "  removed $disk ($reclaimed GiB)"

  Section 'Starting Docker Desktop'
  Start-DockerDesktop
}

if ($record) {
  Section "Bringing the owner's instance back"
  Wait-Engine
  Restore-OwnerInstance -Path $recordPath -RestoreOnly:$RestoreOnly
}

Section 'Result'
if ($null -ne $reclaimed) { Write-Host "  reclaimed about $reclaimed GiB. Rebuild the test stack with: npm run test:up:rebuild" }
if (-not $record) {
  Write-Host '  Nothing was recorded, so nothing was brought back. Start an instance from its checkout with:'
  Write-Host '     docker compose up -d --build --wait'
}
