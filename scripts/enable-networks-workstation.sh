#!/usr/bin/env bash
set -euo pipefail

write_step() {
  echo "[enable-networks] $1"
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_path="${repo_root}/.env"
state_dir="${HOME}/.ythril-local-connector"
token_file="${state_dir}/token"

get_env_value() {
  local key="$1"
  [[ -f "$env_path" ]] || return 1
  local line
  line="$(grep -E "^${key}=" "$env_path" | tail -n1 || true)"
  [[ -n "$line" ]] || return 1
  printf '%s' "${line#*=}"
}

upsert_env_value() {
  local key="$1"
  local value="$2"
  mkdir -p "$(dirname "$env_path")"

  if [[ ! -f "$env_path" ]]; then
    printf '%s=%s\n' "$key" "$value" > "$env_path"
    return
  fi

  if grep -qE "^${key}=" "$env_path"; then
    local tmp
    tmp="$(mktemp)"
    awk -v k="$key" -v v="$value" 'BEGIN{re="^" k "="} $0 ~ re {print k "=" v; next} {print}' "$env_path" > "$tmp"
    mv "$tmp" "$env_path"
  else
    printf '%s=%s\n' "$key" "$value" >> "$env_path"
  fi
}

new_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -d '\n=' | tr '+/' '-_'
    return
  fi

  node -e "const c=require('node:crypto');console.log(c.randomBytes(48).toString('base64url'))"
}

get_stable_token() {
  if token="$(get_env_value YTHRIL_LOCAL_AGENT_TOKEN 2>/dev/null)"; then
    if [[ -n "$token" ]]; then
      printf '%s' "$token"
      return
    fi
  fi

  if [[ -f "$token_file" ]]; then
    token="$(tr -d '\r\n' < "$token_file")"
    if [[ -n "$token" ]]; then
      printf '%s' "$token"
      return
    fi
  fi

  new_token
}

ensure_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then
    write_step "cloudflared found."
    return
  fi

  write_step "cloudflared not found; attempting install via package manager..."

  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y cloudflared
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y cloudflared
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y cloudflared
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -Sy --noconfirm cloudflared
  elif command -v zypper >/dev/null 2>&1; then
    sudo zypper --non-interactive install cloudflared
  else
    echo "cloudflared is not installed and no supported package manager was found. Install cloudflared manually and rerun." >&2
    exit 1
  fi

  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "cloudflared installation did not complete successfully. Install it manually and rerun." >&2
    exit 1
  fi

  write_step "cloudflared installed."
}

ensure_cloudflare_login() {
  local cert_path="${HOME}/.cloudflared/cert.pem"
  if [[ -f "$cert_path" ]]; then
    write_step "cloudflared login already present."
    return
  fi

  write_step "Opening Cloudflare login flow (one-time)..."
  cloudflared tunnel login

  if [[ ! -f "$cert_path" ]]; then
    echo "Cloudflare login did not finish (cert.pem missing). Rerun and complete browser auth." >&2
    exit 1
  fi

  write_step "cloudflared login completed."
}

test_helper_auth() {
  local token="$1"
  curl -fsS --max-time 3 -H "Authorization: Bearer ${token}" "http://127.0.0.1:38123/v1/status" >/dev/null 2>&1
}

is_port_listening() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn | grep -q ':38123 '
    return
  fi

  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:38123 -sTCP:LISTEN >/dev/null 2>&1
    return
  fi

  return 1
}

ensure_helper_running() {
  local token="$1"

  if is_port_listening; then
    if test_helper_auth "$token"; then
      write_step "local helper already listening on 127.0.0.1:38123 and token is valid."
      return
    fi

    echo "Port 38123 is already in use, but helper auth failed with the configured token. Stop the stale process and rerun." >&2
    exit 1
  fi

  write_step "Starting local helper service in background..."
  mkdir -p "$state_dir"
  (
    cd "$repo_root"
    YTHRIL_CONNECTOR_TOKEN="$token" nohup npm run local-connector:dev --workspace=server >"${state_dir}/connector.log" 2>&1 &
  )
  write_step "local helper started."
}

write_step "Preparing workstation for Enable Networks auto setup..."
ensure_cloudflared
ensure_cloudflare_login

mkdir -p "$state_dir"
token="$(get_stable_token)"
printf '%s\n' "$token" > "$token_file"
chmod 600 "$token_file" || true

upsert_env_value YTHRIL_LOCAL_AGENT_ENABLED true
upsert_env_value YTHRIL_LOCAL_AGENT_URL http://127.0.0.1:38123
upsert_env_value YTHRIL_LOCAL_AGENT_TOKEN "$token"
write_step "Wrote/updated .env values for local-agent integration."

ensure_helper_running "$token"

write_step "Restarting Ythril container to apply env changes..."
cd "$repo_root"
docker compose up -d ythril

write_step "Done. Open Settings -> Networks -> Enable Networks."
