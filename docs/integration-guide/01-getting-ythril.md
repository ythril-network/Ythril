# Getting Ythril

> Part of the [Ythril Integration Guide](../integration-guide.md). API and MCP reference for
> developers building on Ythril.

Audience: integrators building clients, automation, or multi-instance deployments on top of Ythril.

If you are here for web UI usage, read [User Guide](../userguide.md). If you are contributing to source code, read [Contribution Guide](../contribution-guide.md).

## Which version does this describe?

This guide tracks the **latest release**, so a section may document something your instance does not have
yet. Anything added after 2.0.0 is marked `*New in <version>.*` directly under its heading — an unmarked
section has been there since 2.0.0 or earlier. `GET /api/about` reports the version you are running.

**New in 2.1**, in rough order of how likely you are to notice it:

| Area | What changed |
|---|---|
| Retrieval | Hybrid search — a lexical channel fused into `recall` by RRF; optional cross-encoder reranking |
| Diagnosis | [Diagnosing a Misconfiguration](02-hosting.md#diagnosing-a-misconfiguration); every egress refusal is now logged with the setting that would permit it |
| Config | `OLLAMA_URL` → `VISION_BASE_URL`, `WHISPER_URL` → `STT_BASE_URL`, `WHISPER_MODEL` → `STT_MODEL` (old names **removed in 4.0** — they refuse the boot and name the replacement) |
| Lifecycle | Graceful shutdown actually drains; `/ready` fails first (`SHUTDOWN_DRAIN_MS`, `SHUTDOWN_READY_GRACE_MS`) |
| Recall | An end-to-end budget (`RECALL_BUDGET_MS`, `RERANK_MIN_BUDGET_MS`) and a `ythril_recall_degraded_total` metric |
| Brain | Space completeness scoring; Review → Suggestions |
| MCP | Roughly half-size recall responses; `includeFileContent: false` for a fifth |
| Posture | `mcp.publicUrl`; endpoint classes no longer imply a DNS resolution that did not happen |

Full detail in [CHANGELOG.md](https://github.com/ythril-network/Ythril/blob/main/CHANGELOG.md).

---

## Getting Ythril

### Container Images

Published images are available on two registries:

| Registry | Image | Pull command |
|----------|-------|-------------|
| GitHub Container Registry | `ghcr.io/ythril-network/ythril` | `docker pull ghcr.io/ythril-network/ythril:latest` |
| Docker Hub | `docker.io/ythril/ythril` | `docker pull ythril/ythril:latest` |

Tags follow semver: `:latest`, `:1.0.0`, `:1.0`, `:1`. All images are multi-arch (`linux/amd64`, `linux/arm64`).

#### What a version upgrade actually downloads

The single largest thing in the image is the **embedding model, ~482 MiB**, baked in so an instance can embed
text on first boot with no network. That layer is built to be **stable across releases**: it is warmed in a
build stage of its own and materialised with fixed file metadata, so its digest depends on the model and the
`@huggingface/transformers` version and on nothing else. When neither changes, `docker pull` for a new Ythril
version skips it.

Two caveats, because they are the difference between a small upgrade and a full one:

- **A release that changes the model id or the transformers version re-downloads it.** That is the layer doing
  its job, not a regression.
- **The ffmpeg apt layer (~472 MiB) is not stable and cannot be.** `apt-get update` is not reproducible, so
  that layer's digest moves on essentially every build. If your upgrade download is larger than you expect,
  this is usually why.

If you are measuring, compare the layer digests in the two registry manifests rather than the reported image
sizes — sizes tell you what the image weighs, not what a pull has to fetch.

### Quick Start

```bash
docker compose up -d
```

The included `docker-compose.yml` pulls the GHCR image and starts Ythril + MongoDB. On first run, open `http://localhost:3200` — you'll be redirected to the setup page.

### Local Host Port Override

By default, Docker Compose publishes Ythril on host port `3200`.

If you want your personal/local instance on a different host port (for example `3210`) without changing tracked project files, set `YTHRIL_PORT` in a local `.env` file:

```env
YTHRIL_PORT=3210
```

Then start as usual:

```bash
docker compose up -d
```

Now Ythril is reachable at `http://localhost:3210` while the container still listens on internal port `3200`.

Enter an instance label and complete setup:

```http
POST http://localhost:3200/api/setup/json
{ "label": "My Ythril" }
```

This returns your admin token. Store it — it is shown once.

### Health Check

```http
GET http://localhost:3200/health
→ { "status": "ok", "ts": "2026-03-26T10:00:00.000Z" }
```

### Base URL

All API paths in this guide are relative to `http://<host>:3200`. In production behind a reverse proxy, substitute your public URL.

---
