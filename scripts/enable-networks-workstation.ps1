$ErrorActionPreference = 'Stop'

function Write-Step([string]$message) {
  Write-Host "[enable-networks] $message"
}

function Ensure-Cloudflared {
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cmd) {
    Write-Step 'cloudflared found.'
    return
  }

  Write-Step 'cloudflared not found; attempting install via winget...'
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw 'cloudflared is not installed and winget is unavailable. Install cloudflared manually, then rerun this command.'
  }

  & winget install --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements | Out-Null

  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw 'cloudflared installation did not complete successfully. Install it manually and rerun.'
  }

  Write-Step 'cloudflared installed.'
}

function Ensure-CloudflareLogin {
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

function Get-DotEnvValue([string]$envPath, [string]$key): string {
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

function Upsert-DotEnvValue([string]$envPath, [string]$key, [string]$value) {
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

function Get-StableToken([string]$envPath, [string]$tokenFile): string {
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

function Test-HelperAuth([string]$token): bool {
  try {
    Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:38123/v1/status' -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 3 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Ensure-HelperRunning([string]$repoRoot, [string]$token) {
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
  $cmd = "`$env:YTHRIL_CONNECTOR_TOKEN='$token'; Set-Location '$repoRoot'; npm run local-connector:dev --workspace=server"
  $psExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
  Start-Process -FilePath $psExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd) -WindowStyle Minimized | Out-Null
  Write-Step 'local helper started.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot '.env'
$tokenFile = Join-Path $HOME '.ythril-local-connector/token'

Write-Step 'Preparing workstation for Enable Networks auto setup...'
Ensure-Cloudflared
Ensure-CloudflareLogin

$token = Get-StableToken -envPath $envPath -tokenFile $tokenFile
Upsert-DotEnvValue -envPath $envPath -key 'YTHRIL_LOCAL_AGENT_ENABLED' -value 'true'
Upsert-DotEnvValue -envPath $envPath -key 'YTHRIL_LOCAL_AGENT_URL' -value 'http://127.0.0.1:38123'
Upsert-DotEnvValue -envPath $envPath -key 'YTHRIL_LOCAL_AGENT_TOKEN' -value $token
Write-Step 'Wrote/updated .env values for local-agent integration.'

Ensure-HelperRunning -repoRoot $repoRoot -token $token

Write-Step 'Restarting Ythril container to apply env changes...'
Set-Location $repoRoot
& docker compose up -d ythril

Write-Step 'Done. Open Settings -> Networks -> Enable Networks.'
