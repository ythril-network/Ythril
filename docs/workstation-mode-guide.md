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

Why: pulls latest images and recreates containers while keeping volumes.

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

- It helps your workstation become reachable from other Ythril instances.
- Other machines connect to your Ythril URL (public hostname/tunnel).

Prerequisites:

- You are running Ythril on your own workstation.
- You can sign in as admin (and provide MFA code if enabled).
- You have a Cloudflare account with a domain managed in Cloudflare DNS.

Run this once:

```bash
npm run enable-networks:setup
```

This command automatically:

- Installs `cloudflared` using your platform package manager if missing.
- Runs Cloudflare login if not already authenticated.
- Configures required local-agent env values for Docker Compose.
- Starts the local helper in the background.
- Restarts the `ythril` container so settings are active.

About `127.0.0.1`:

- It means "only this workstation".
- This protects the helper service.
- It does NOT block brain-to-brain networking. Other machines still connect through your normal Ythril URL.

Server note:

- On real servers, keep this disabled.
