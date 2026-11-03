$ErrorActionPreference = 'Stop'

function Write-Step([string]$message) {
  Write-Host "[enable-networks] $message"
}

# Windows has no Unix modes, so "private" is an ACL: this file or directory belongs to the current user ALONE (inheritance
# off, one explicit entry for this user's SID). The `.env` lands under the repository's ACL and the token under the user
# profile's; without this each is only as private as the folder it happens to be in. A failure stops the script rather than
# leaving a secret readable.
function Set-OwnerOnlyAcl([string]$path) {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $isDir = Test-Path -LiteralPath $path -PathType Container
  $grant = if ($isDir) { "*${sid}:(OI)(CI)F" } else { "*${sid}:F" }
  & icacls $path /inheritance:r /grant:r $grant | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls could not restrict '$path' to the current user (exit $LASTEXITCODE)" }
}

# The file exists and is the user's alone BEFORE a secret is written into it: Set-Content writes into an existing file and
# keeps its ACL, so there is no moment at which the content sits under an inherited one.
function Initialize-OwnerOnlyFile([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { New-Item -ItemType File -Path $path | Out-Null }
  Set-OwnerOnlyAcl $path
}

function Update-SessionPath {
  # winget (and other installers) register new PATH entries in the registry but do not
  # mutate the current process environment. Refresh from both registry scopes so that
  # any newly installed binary is findable without opening a new shell.
  $machine = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine')
  $user    = [System.Environment]::GetEnvironmentVariable('PATH', 'User')
  $combined = @($machine, $user) | Where-Object { $_ }
  $env:PATH = $combined -join ';'
}

function Install-CloudflaredDirect {
  # Direct download from the official Cloudflare GitHub release as a fallback.
  $arch    = if ([System.Environment]::Is64BitOperatingSystem) { 'amd64' } else { '386' }
  $destDir = Join-Path $env:LOCALAPPDATA 'Programs\cloudflared'
  $destExe = Join-Path $destDir 'cloudflared.exe'

  if (-not (Test-Path $destDir)) {
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
  }

  $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${arch}.exe"
  Write-Step "Downloading cloudflared from $url ..."
  Invoke-WebRequest -Uri $url -OutFile $destExe -UseBasicParsing

  # Persist to user PATH so future sessions also find it.
  $userPath = [System.Environment]::GetEnvironmentVariable('PATH', 'User')
  if (-not $userPath) { $userPath = '' }
  if ($userPath -notlike "*$destDir*") {
    [System.Environment]::SetEnvironmentVariable('PATH', "${userPath};${destDir}", 'User')
  }

  # Also update the current session immediately.
  $env:PATH = "$env:PATH;$destDir"
}

function Initialize-Cloudflared {
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cmd) {
    Write-Step 'cloudflared found.'
    return
  }

  # --- attempt 1: winget ---
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Write-Step 'cloudflared not found; attempting install via winget...'
    & winget install --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements | Out-Null
    # winget adds a new PATH entry in the registry; refresh the current session to pick it up.
    Update-SessionPath
    $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($cmd) {
      Write-Step 'cloudflared installed via winget.'
      return
    }
    Write-Step 'winget install reported success but cloudflared still not in PATH; falling back to direct download.'
  } else {
    Write-Step 'winget is unavailable; falling back to direct download.'
  }

  # --- attempt 2: direct download from GitHub releases ---
  try {
    Install-CloudflaredDirect
  } catch {
    throw "cloudflared could not be installed automatically ($_). Install it manually from https://developers.cloudflare.com/cloudflared/get-started/ and rerun."
  }

  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw 'cloudflared binary was downloaded but is still not reachable. Check antivirus/execution policy and rerun.'
  }

  Write-Step 'cloudflared installed via direct download.'
}

function Initialize-CloudflareLogin {
  $certPath = Join-Path $HOME '.cloudflared/cert.pem'
  if (Test-Path $certPath) {
    Write-Step 'cloudflared login already present.'
    return
  }

  Write-Step 'Opening Cloudflare login flow (one-time)...'
  & cloudflared tunnel login

  if (-not (Test-Path $certPath)) {
    throw 'Cloudflare login did not finish (cert.pem missing). Rerun and complete browser auth.'
  }

  Write-Step 'cloudflared login completed.'
}

function New-Token {
  $bytes = New-Object byte[] 48
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-DotEnvValue([string]$envPath, [string]$key) {
  if (-not (Test-Path $envPath)) { return '' }
  $pattern = "^$([regex]::Escape($key))=(.*)$"
  $lines = Get-Content -Path $envPath
  foreach ($line in $lines) {
    if ($line -match $pattern) {
      return $Matches[1].Trim()
    }
  }
  return ''
}

function Set-DotEnvValue([string]$envPath, [string]$key, [string]$value) {
  $lines = @()
  if (Test-Path $envPath) {
    $lines = Get-Content -Path $envPath
  }

  $updated = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^${key}=") {
      $lines[$i] = "${key}=${value}"
      $updated = $true
      break
    }
  }

  if (-not $updated) {
    $lines += "${key}=${value}"
  }

  Set-Content -Path $envPath -Value $lines -Encoding UTF8
}

function Get-StableToken([string]$envPath, [string]$tokenFile) {
  $existing = Get-DotEnvValue -envPath $envPath -key 'YTHRIL_LOCAL_AGENT_TOKEN'
  if ($existing) {
    return $existing
  }

  if (Test-Path $tokenFile) {
    try {
      $fileToken = (Get-Content -Path $tokenFile -Raw).Trim()
      if ($fileToken) {
        return $fileToken
      }
    } catch {
      # ignore token file read errors; fall back to new token generation
    }
  }

  return New-Token
}

function Test-HelperAuth([string]$token) {
  try {
    Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:38123/v1/status' -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 3 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Initialize-HelperRunning([string]$repoRoot, [string]$token) {
  $isListening = $false
  try {
    $listen = Get-NetTCPConnection -LocalPort 38123 -State Listen -ErrorAction Stop
    if ($listen) { $isListening = $true }
  } catch {
    $isListening = $false
  }

  if ($isListening) {
    if (Test-HelperAuth -token $token) {
      Write-Step 'local helper already listening on 127.0.0.1:38123 and token is valid.'
      return
    }
    throw 'Port 38123 is already in use, but helper auth failed with the configured token. Stop the stale process and rerun.'
  }

  Write-Step 'Starting local helper service in background...'
  # Token is read from the token file by the connector; do not embed it in the command
  # line where it would be visible to other local processes via Get-CimInstance / Task Manager.
  $cmd = "Set-Location '$repoRoot'; npm run local-connector:dev --workspace=server"
  $psExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
  Start-Process -FilePath $psExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd) -WindowStyle Minimized | Out-Null
  Write-Step 'local helper started.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot '.env'
$tokenFile = Join-Path $HOME '.ythril-local-connector/token'

Write-Step 'Preparing workstation for Enable Networks auto setup...'
# Intentionally defer cloudflared install/login to the one-click local connector
# action so first-run operator flow only requires confirming browser login there.
Write-Step 'Cloudflare install/login will be handled by one-click execution when needed.'

$token = Get-StableToken -envPath $envPath -tokenFile $tokenFile

# Persist the resolved token to the state file so the connector can discover it
# without needing it injected on the command line.
$tokenDir = Split-Path -Parent $tokenFile
if (-not (Test-Path $tokenDir)) { New-Item -ItemType Directory -Path $tokenDir -Force | Out-Null }
Set-OwnerOnlyAcl $tokenDir
Initialize-OwnerOnlyFile $tokenFile
Set-Content -Path $tokenFile -Value $token -Encoding UTF8 -NoNewline

Initialize-OwnerOnlyFile $envPath
Set-DotEnvValue -envPath $envPath -key 'YTHRIL_LOCAL_AGENT_ENABLED' -value 'true'
Set-DotEnvValue -envPath $envPath -key 'YTHRIL_LOCAL_AGENT_URL' -value 'http://127.0.0.1:38123'
Set-DotEnvValue -envPath $envPath -key 'YTHRIL_LOCAL_AGENT_TOKEN' -value $token
Write-Step 'Wrote/updated .env values for local-agent integration.'

Initialize-HelperRunning -repoRoot $repoRoot -token $token

Write-Step 'Restarting Ythril container to apply env changes...'
Set-Location $repoRoot
& docker compose up -d ythril

Write-Step 'Done. Open Settings -> Networks -> Enable Networks.'
