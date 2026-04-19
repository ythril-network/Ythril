# Ythril Workstation Mode Guide

> Fast, production-style local install on one workstation using Docker Compose.

This guide is for operators who want a real Ythril instance running quickly on a workstation, with clear explanations for each step.

For server/API details see [integration-guide.md](integration-guide.md).
For UI usage details see [userguide.md](userguide.md).

---

## Prerequisites

1. Docker Engine or Docker Desktop installed and running.
2. Docker Compose v2 available (`docker compose version`).
3. Port `3200` free on your host (or choose an alternate host port like `3201`).
4. Internet access for first image pull (`ghcr.io/ythril-network/ythril:latest`, `mongodb/mongodb-atlas-local:latest`).

Recommended host minimums:

- CPU: 2 cores
- RAM: 4 GB
- Disk: at least 10 GB free

Quick checks:

```bash
docker --version
docker compose version
```

---

## Step 1: Open the project root

```bash
cd O:/Projects/Ythril
```

Why: all compose paths and mounts in this guide assume you run commands from the repository root.

---

## Step 2: Ensure no old test stack is running

```bash
docker compose -p ythril-test -f testing/docker-compose.test.yml down -v --remove-orphans
```

Why: test containers and networks can clutter Docker Desktop and cause confusion while validating the real instance.

---

## Step 3: Choose port/Mongo, then start

Why: this step decides how Ythril should run before you launch containers.

Default stack from `docker-compose.yml`:

- `ythril` (app server)
- `ythril-mongo` (MongoDB Atlas Local with vector search support)

Option A: keep defaults (port 3200 + bundled MongoDB)

Option B: port `3200` is occupied (use `3201` instead)

Create an override file:

```yaml
# docker-compose.override.yml
services:
  ythril:
    ports:
      - "3201:3200"
```

You will open `http://localhost:3201` instead of `http://localhost:3200`.

How to check what is using 3200 on Windows:

```powershell
Get-NetTCPConnection -LocalPort 3200 -State Listen |
  Select-Object LocalAddress, LocalPort, OwningProcess
Get-Process -Id <PID>
```

How to check what is using 3200 on Linux:

```bash
ss -ltnp '( sport = :3200 )'
# or
sudo lsof -nP -iTCP:3200 -sTCP:LISTEN
```

Option C: use an existing MongoDB instead of bundled `ythril-mongo`

Ythril can use any MongoDB that supports `$vectorSearch` (Atlas Local, Atlas, or MongoDB 8.2+).

Authentication note:

- The bundled `ythril-mongo` in this compose file is internal-only and uses no username/password by default.
- For an external MongoDB, use a real authenticated connection string from your database setup.
- If your username or password contains special characters (`@`, `:`, `/`, `?`, `#`), URL-encode them.

1. Set `MONGO_URI` to your existing database.
2. Start only `ythril` and skip dependencies.

PowerShell example:

```powershell
$env:MONGO_URI = "mongodb://ythril_user:YOUR_PASSWORD@my-mongo-host:27017/ythril?authSource=admin&directConnection=true"
```

Atlas example:

```powershell
$env:MONGO_URI = "mongodb+srv://ythril_user:YOUR_PASSWORD@cluster0.example.mongodb.net/ythril?retryWrites=true&w=majority"
```

Why `--no-deps`: the default compose file has `ythril` depending on `ythril-mongo`. When you use external MongoDB, you intentionally bypass that local dependency.

Start command (run exactly one):

```bash
# A) Default (port 3200 + bundled MongoDB)
docker compose up -d

# B) Alternate port (after creating docker-compose.override.yml)
docker compose up -d

# C) Existing MongoDB (after setting MONGO_URI)
docker compose up -d --no-deps ythril
```

---

## Step 4: Confirm services are healthy

```bash
docker compose ps
curl http://localhost:3200/health
curl http://localhost:3200/ready
```

What `docker compose ps` does:

- Lists containers in this compose project (`ythril`, `ythril-mongo`).
- Shows whether each container is running.
- Shows health status when a healthcheck exists (`healthy`, `starting`, `unhealthy`).
- Shows port bindings (for example host `3200` to container `3200`).

Quick interpretation for this install:

- `ythril` should be `Up ... (healthy)`.
- `ythril-mongo` should be `Up ... (healthy)`.
- `ythril` should show `0.0.0.0:3200->3200/tcp` unless you changed host port.

Expected:

- `/health` returns `{ "status": "ok", ... }`
- `/ready` returns `200` with dependency checks when startup is complete

If you mapped a different host port (for example `3201`), replace `3200` in the URLs.

Why both checks:

- `/health` confirms the HTTP process is alive.
- `/ready` confirms backend dependencies are ready for real traffic.

---

## Step 5: Run first-time setup in browser

Open:

- `http://localhost:3200`

If you changed the host port, use that port instead (example: `http://localhost:3201`).

Then:

1. Enter an instance label.
2. Complete setup.
3. Copy the admin token immediately and store it safely.

Important:

- The initial plaintext admin token is shown once.
- Do not pre-create `config/config.json` from `config/config.example.json` for first run unless you intentionally manage config manually.

---

## Step 6: Validate authenticated access

Replace `YOUR_TOKEN`:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:3200/api/about
```

If you changed the host port, replace `3200` accordingly.

Why: this confirms token auth and core API routing are functioning.

### Check installed Ythril version

The same `/api/about` response includes `version`.

PowerShell:

```powershell
(Invoke-RestMethod -Headers @{ Authorization = "Bearer YOUR_TOKEN" } -Uri "http://localhost:3200/api/about").version
```

curl (raw JSON):

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:3200/api/about
```

If you changed the host port, replace `3200` accordingly.

---

## Step 7: (Optional) Connect an MCP client

Use endpoint:

- `http://localhost:3200/mcp/general`

Example MCP config:

```json
{
  "mcpServers": {
    "ythril": {
      "url": "http://localhost:3200/mcp/general",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

---

## Data persistence and lifecycle

Persistent data locations:

- Host bind mount: `./config` (config and secrets)
- Docker volumes: `ythril-data`, `ythril-mongo-data`, `ythril-mongo-configdb`

Common operations:

```bash
# Stop services, keep data
docker compose down

# Start again
docker compose up -d

# Full destructive cleanup (removes persistent data)
docker compose down -v
```

---

## Update to newer image version

```bash
docker compose pull
docker compose up -d
```

Why: pulls latest images and recreates containers while keeping volumes (data).

---

## Quick troubleshooting

1. Port 3200 already in use
- Symptom: compose fails to bind `0.0.0.0:3200`.
- Fix: stop the conflicting process or create `docker-compose.override.yml` with `"3201:3200"` and use `http://localhost:3201`.

2. UI opens but setup/auth fails
- Check logs:

```bash
docker compose logs -f ythril
```

3. Ready check stays non-ready
- Wait for MongoDB initialization.
- Check mongo container status:

```bash
docker compose logs -f ythril-mongo
```

4. Docker Desktop still shows stale resources
- Refresh UI and run a clean down:

```bash
docker compose down -v --remove-orphans
```

---

## Enable Networks (Workstation)

Use the UI wizard in **Settings -> Networks -> Enable Networks**.

What this does:

- Makes your workstation reachable from other Ythril instances via a public hostname.
- Installs and configures a Cloudflare Tunnel so traffic reaches your local Ythril securely.

Prerequisites:

- You are running Ythril on your own workstation.
- You can sign in as admin (and provide MFA code if enabled).
- You have a Cloudflare account with a domain managed in Cloudflare DNS.

### Workstation (Docker) setup — one-time

The `docker-compose.override.yml` file is gitignored and not included in the repo. Create it once in the project root with the following content, then commit it nowhere (it stays local):

```yaml
# docker-compose.override.yml — local workstation overrides, not committed
services:
  ythril:
    build: .
    image: ythril-local
    extra_hosts:
      - "host-gateway:host-gateway"
    volumes:
      - ./local-data/ythril:/data
      - ${USERPROFILE}/.ythril-local-connector:/home/node/.ythril-local-connector:ro
    environment:
      YTHRIL_LOCAL_AGENT_URL: http://host-gateway:38123
      YTHRIL_LOCAL_AGENT_ALLOW_REMOTE: "true"
      YTHRIL_LOCAL_AGENT_ALLOW_INSECURE: "true"
      # cloudflared runs on Windows and must forward to the host-exposed port,
      # not the internal container port 3200. Set YTHRIL_PORT in .env if you use a
      # non-default host port (e.g. YTHRIL_PORT=3210).
      YTHRIL_LOCAL_AGENT_ORIGIN: http://localhost:${YTHRIL_PORT:-3200}

  ythril-mongo:
    volumes:
      - ./local-data/mongo/db:/data/db
      - ./local-data/mongo/configdb:/data/configdb
```

After creating this file, rebuild and restart the stack:

```powershell
docker compose build
docker compose up -d
```

### Start the local connector

The Ythril container cannot spawn processes on your Windows host, so the local connector must be started separately. Run this in a terminal in the project root:

```powershell
npm run local-connector:start
```

Keep this terminal open (or set it up as a startup item) — the connector must be running before you use the wizard.

Why: the wizard communicates with a small HTTP helper process (`local-agent-connector`) that runs on Windows and executes cloudflared on your behalf. This process cannot be started from inside the Docker container.

### Run the wizard

Once the connector is running:

1. Open **Settings -> Networks -> Enable Networks**.
2. Enter your public hostname (e.g. `ythril.example.com`).
3. Check "I understand this can install software, open Cloudflare login, create/update tunnel and DNS records, and start a background tunnel process/service on this machine."
4. Click **Run automatically**.

What happens on a fresh machine:

- `cloudflared` is installed automatically via winget (Windows) if not present.
- If you have never logged into Cloudflare from this machine (`~/.cloudflared/cert.pem` absent), the wizard opens the system browser for a one-time OAuth flow. Complete the authorization — the wizard waits and then continues automatically.
- The tunnel is created (or reused if it already exists), DNS is routed, `~/.cloudflared/config.yml` is written, and the tunnel process is started.
- Your public URL is set in the wizard automatically.

The acknowledgement checkbox is required precisely because these are real, persistent changes on your machine. DNS overwrite is a separate opt-in toggle (off by default) — enable it only if you intentionally want to replace an existing DNS record.

### Subsequent runs

On machines where `cert.pem` already exists and the tunnel is already created, the wizard is idempotent — clicking "Run automatically" again is safe and just re-validates/restarts the tunnel.

### Tunnel persistence (Windows service)

On Windows the wizard installs cloudflared as a Windows service automatically so the tunnel survives reboots without any manual intervention. When the wizard calls service install, a UAC elevation dialog will appear — click **Yes** to allow it.

If service install is intentionally unwanted, set `YTHRIL_CONNECTOR_ALLOW_SERVICE_INSTALL=false` in the environment before starting the local connector. In that case the connector will start cloudflared as a background process instead, but it will not survive reboots automatically.

Server note:

- On real servers, keep the local connector disabled. `YTHRIL_LOCAL_AGENT_ENABLED` is unset by default.

---

## Cloudflare Setup (Detailed)

This section is a full walkthrough for the Cloudflare side of workstation networking.

### Goal

Expose only your Ythril HTTP service to the internet through Cloudflare Tunnel, not your full workstation.

### Before you start

1. You own a domain (or subdomain) you can manage in Cloudflare.
2. Your Cloudflare zone status is **Active** (nameserver change completed).
3. Local Ythril works first (for example `http://localhost:3200/health`).

### Step A: Add your domain to Cloudflare (one-time)

1. In Cloudflare dashboard, click **Add a domain**.
2. Follow onboarding and copy the two Cloudflare nameservers.
3. Update nameservers at your registrar.
4. Wait until Cloudflare shows zone status **Active**.

Why this matters: `cloudflared tunnel login` requires an active zone. If no active zone exists, login may not complete and no `cert.pem` is written.

### Step B: Run one-click setup

Open **Settings -> Networks -> Enable Networks** and run one-click setup.

Start the local connector first (`npm run local-connector:start`), then click **Run automatically**.

On first run (no `cert.pem` yet), the wizard automatically runs `cloudflared tunnel login`, which opens your system browser for a one-time authorization. Complete it — the wizard waits and continues automatically.

Expected success signals:

- `C:\Users\<you>\.cloudflared\cert.pem` exists
- One-click setup completes and your public URL is set to `https://<your-hostname>`

### Step C: Manual Cloudflare fallback only

You normally do **not** need this section when one-click works.

Use these steps only if one-click reports DNS/tunnel mapping errors.

Manual path (Cloudflare dashboard):

1. Open **Zero Trust -> Networks -> Tunnels**.
2. Select your tunnel.
3. Open **Public Hostnames** and click **Add a public hostname**.
4. Set values:
  - **Subdomain**: e.g. `ythril`
  - **Domain**: your zone
  - **Service type**: `HTTP`
  - **URL**: `http://localhost:3200` (or the host port you set with `YTHRIL_PORT`)
5. Save.

This usually creates the DNS record for you.

CLI fallback (only if needed):

```bash
cloudflared tunnel route dns --overwrite-dns ythril-local your-hostname.example.com
```

### Step D: DNS proxy mode

Use **Proxied** (orange cloud ON) for the Ythril hostname.

Why:

- Public clients connect with HTTPS to Cloudflare edge.
- Cloudflare forwards through the tunnel to your local Ythril service.
- Your local origin can stay HTTP on localhost.

### Step E: Set Ythril public URL

In Ythril network settings, set your public URL to your Cloudflare hostname, for example:

- `https://ythril.example.com`

Do not use the one-time Cloudflare login callback URL as your service URL.

### Security model

With this setup, internet traffic reaches only what the tunnel hostname maps to.

- Good: hostname mapped to Ythril only.
- Good: local helper remains on `127.0.0.1`.
- Avoid: adding extra ingress rules for unrelated local ports.

### Validation checklist

1. Local health works:

```bash
curl http://localhost:3200/health
```

2. Public health works (replace hostname):

```bash
curl https://ythril.example.com/health
```

3. Authenticated API works through public URL:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" https://ythril.example.com/api/about
```

### Troubleshooting (Cloudflare-specific)

1. Error: "Cloudflare login did not complete (cert.pem still missing)"
- Cause: browser window was closed before authorizing, or the 5-minute wizard timeout expired before you clicked Authorize.
- Fix: ensure zone is **Active**, run `cloudflared tunnel login` in a terminal to authorize manually, then click Run automatically again.

2. Browser did not open during wizard
- Cause: on headless or remote systems, `cloudflared tunnel login` cannot open a browser.
- Fix: run `cloudflared tunnel login` in a terminal on the same machine — copy and visit the URL it prints — then click Run automatically again.

3. Public hostname resolves but app does not load
- Check tunnel public hostname maps to `http://localhost:3200` (or your actual port).
- Verify Ythril container is healthy with `docker compose ps`.

4. Connection works on localhost but not public hostname
- Verify DNS record is proxied.
- Verify tunnel is connected in Cloudflare dashboard.
- Verify local firewall is not blocking local process binding unexpectedly.
