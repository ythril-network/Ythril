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

# The one door a secret file is written through: its content on stdin, the file that results is mode 0600.
#
# A temp file is made in the target's own directory (so the final mv is a rename on one filesystem, never a copy), set to
# 0600 BEFORE any content reaches it, and moved over the target. So it does not matter what umask the caller had or what
# mode an earlier run left: the file that results is the caller's own, at 0600. It REPLACES the target, so the owner, group
# and any ACL of an earlier file are not kept either. A symlink standing at the target is refused rather than followed
# or replaced. The temp file is removed when anything fails, including the mv.
write_private() {
  local target="$1"
  if [[ -L "$target" ]]; then
    echo "refusing to write ${target}: it is a symbolic link (a secret is never written through one)" >&2
    return 1
  fi
  (
    umask 077
    tmp="$(mktemp "$(dirname "$target")/.tmp.XXXXXX")" || exit 1
    trap 'rm -f "$tmp"' EXIT
    chmod 600 "$tmp"
    cat > "$tmp"
    mv "$tmp" "$target"
  )
}

# The value goes to awk through its environment, never as an argument: an argument is readable by every local user
# for as long as the command runs, and `awk -v` also reads backslash sequences in the value.
upsert_env_value() {
  local key="$1"
  local value="$2"
  mkdir -p "$(dirname "$env_path")"

  if [[ ! -f "$env_path" ]]; then
    printf '%s=%s\n' "$key" "$value" | write_private "$env_path"
    return
  fi

  if grep -qE "^${key}=" "$env_path"; then
    K="$key" V="$value" awk 'BEGIN{k=ENVIRON["K"]; v=ENVIRON["V"]; re="^" k "="} $0 ~ re {print k "=" v; next} {print}' "$env_path" | write_private "$env_path"
  else
    { awk '{print}' "$env_path"; printf '%s=%s\n' "$key" "$value"; } | write_private "$env_path"
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

# The header goes to curl on its stdin (`-H @-`), not in its argument list, where `ps` shows it to every local user.
test_helper_auth() {
  local token="$1"
  printf 'Authorization: Bearer %s\n' "$token" | curl -fsS --max-time 3 -H @- "http://127.0.0.1:38123/v1/status" >/dev/null 2>&1
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
  # The log is created owner-only BEFORE the connector writes to it, and an earlier run's mode is set right again: a
  # `>` redirect keeps the mode the file already has. (The state directory exists and is 0700: the main flow made it.)
  ( umask 077; : >> "${state_dir}/connector.log" )
  chmod 600 "${state_dir}/connector.log"
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
# Every run, not only the first: a directory an earlier version of this script made keeps the mode it was made with.
chmod 700 "$state_dir"
token="$(get_stable_token)"
printf '%s\n' "$token" | write_private "$token_file"

upsert_env_value YTHRIL_LOCAL_AGENT_ENABLED true
upsert_env_value YTHRIL_LOCAL_AGENT_URL http://127.0.0.1:38123
upsert_env_value YTHRIL_LOCAL_AGENT_TOKEN "$token"
write_step "Wrote/updated .env values for local-agent integration."

ensure_helper_running "$token"

write_step "Restarting Ythril container to apply env changes..."
cd "$repo_root"
docker compose up -d ythril

write_step "Done. Open Settings -> Networks -> Enable Networks."
