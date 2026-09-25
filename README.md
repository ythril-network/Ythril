<!-- markdownlint-disable MD033 MD041 MD001 MD022 MD026 -->
<div align="center">

<img src="docs/assets/ythril-mark.svg" width="112" height="112" alt="Ythril" />

# Ythril

### Self-hosted knowledge management for people, teams and their AI tools.

**One place for what you know** — facts, people, decisions, timelines and files. Search it by meaning,
follow how things connect, keep it in sync between your own machines, and let AI assistants use it over
**MCP** and your own programs over a **REST API**. On your hardware, under your control.

[![License: PolyForm SB](https://img.shields.io/badge/license-PolyForm%20Small%20Business-2b7bb9)](LICENSE)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-native-9eec55?labelColor=0d1117)](https://modelcontextprotocol.io)
[![Self-hosted](https://img.shields.io/badge/self--hosted-docker%20compose%20up-0d1117)](#-quickstart)
[![Runs offline](https://img.shields.io/badge/works-fully%20offline-6e7681)](#your-data-your-rules)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ythril-network/Ythril)

</div>

---

## Knowledge is scattered. Ythril puts it in one place.

Decisions sit in chat threads, documents in drives, and who-knows-whom in people's heads. Every AI assistant
you use starts each conversation knowing none of it. Ythril keeps all of it in one store, and everything
that talks to that store — you in the web UI, a script over REST, an assistant over MCP — reads and writes
the same records.

> Months later: *"What did we decide about the auth rewrite, and who owns it?"* — one question, and the answer
> comes back with the record it came from.

---

## What's in the box

| | |
|---|---|
| 🔎 **Search by meaning** | Ask in your own words across facts, people, relationships, events and files at once, and find what answers the question even when it uses different words. Narrowing a search to one project or tag never quietly drops a match. |
| 🎯 **Four ways to look** | `recall` finds the best matches by meaning. `filter` is an exact query (`$or`, `$and`, `$regex`, `$elemMatch`, sorting, paging, totals) for when you need *every* match. `similar` finds near-copies of a record. `graph_traverse` follows the links from one record to everything connected to it. Each tool's description lists its blind spots — what it will not find — so an assistant picks the right one. |
| 🕸️ **Knowledge graph** | Store people, projects and places as entities, connect them with named relationships (*works on*, *depends on*), and ask about chains of them. A space can set rules for which kinds of things a relationship may connect. |
| 📅 **Timeline** | Events, deadlines, plans and milestones with date ranges, tags and text search. |
| 📎 **Files that answer back** | Upload PDFs, office documents, images, audio and video. Ythril pulls out the text, reads scanned pages, transcribes speech and describes pictures, and all of it becomes searchable. |
| 🙂 **Faces** | Name a person in one photo and later photos of them are recognised. Runs on the CPU, inside Ythril. |
| 📐 **Rules for your data** | Define what each type of record must contain — required fields, allowed values, naming patterns — and choose strict, warn or off. Each problem is reported as introduced or pre-existing, and strict refuses only what an edit broke, never what was already broken, so tightening the rules never locks you out of old records. |
| ⚖️ **Contradictions and duplicates** | When two records disagree, both are kept and flagged instead of one overwriting the other. Near-duplicates are suggested for merging, and "these are different" is remembered. |
| 🔁 **Sync networks** | Copy the spaces you choose between Ythril instances, with no cloud in between. Who may join is decided by signed votes, under one of five governance models. |
| 🔌 **MCP + REST, one API** | Every tool is also `POST /api/<tool>` with the same body: same parameters, same limits, same refusals, whichever way you call it. A refusal comes back machine-readable, so a program can fix the request and retry. |
| 🧾 **Audit, webhooks, retention** | A field-level log of who changed what, signed webhooks to your own systems, automatic deletion after an age you set, and one-file export and restore. |

Everything above is a callable MCP tool (51 of them), a REST endpoint and a screen in the web UI. The full
reference is the [Integration Guide](docs/integration-guide.md).

---

## Measured, not promised

**97.6% of the score of reading the whole conversation, from about 2% of the text per question.**

The test is **LoCoMo**: ten long conversations, each spread over weeks of sessions, with 1,540 questions
about them. Answers built from what Ythril retrieved were judged correct **82.5%** of the time. Answers built
from the entire conversation scored 84.5%, which is the most the same answering model could reach.

| | judged correct (n=200) | text read per question |
|---|---|---|
| **Ythril** | **82.5%** | ~1.8k characters |
| whole conversation | 84.5% | ~86k characters |

**In plain words:** Ythril hands the model the right few notes almost every time reading everything would
have, and the 2-point gap is small enough to be chance on a sample this size (95% CI −6.2 to +2.2). Reading
everything stops working once a history is larger than a model can hold. Ythril keeps working.

How it was measured: Claude Opus 5.5 answered both ways, and a GPT model from a different vendor graded a
blind sample without knowing which way each answer was produced. Published leaderboards use other models, so
compare the **gap to reading everything**, not the raw percentage. Method, F1 scores and what the misses look
like: [benchmarks/](benchmarks/README.md#results).

---

## Your data, your rules

- **Self-hosted with `docker compose up`.** No accounts, no per-seat pricing, no data leaving your machine.
- **Works fully offline, and the image enforces it.** The models for search, pictures and speech ship
  inside it, and runtime model downloads are switched off (`HF_HUB_OFFLINE=1`), so a missing model fails
  loudly instead of quietly downloading one. Connect hosted models under **Settings → Models** only if you
  want to.
- **Never trains on your knowledge.** It is a database you run, not a service that mines you.
- **Security built in** — single sign-on (OIDC), optional two-factor login, access tokens limited to a space
  or to reading, OAuth for MCP clients, an audit log that cannot be edited, and hardening against request
  forgery and injection. [Details ↓](#-under-the-hood)

---

## ⚡ Quickstart

```bash
docker compose up -d
# → open http://localhost:3200 and finish setup in your browser
```

Create a token under **Settings → Tokens**, then point any MCP client at your instance:

```json
{
  "mcpServers": {
    "ythril": {
      "url": "http://localhost:3200/mcp",
      "headers": { "Authorization": "Bearer ythril_your_token_here" }
    }
  }
}
```

The client sees every space the token can reach, what each space is for, its schema, and every tool it can
call. Clients that support OAuth can connect without a pasted token and ask you to approve them instead.

Or call the same tools over HTTP:

```bash
curl -X POST http://localhost:3200/api/recall \
  -H "Authorization: Bearer ythril_your_token_here" -H "Content-Type: application/json" \
  -d '{"space": "general", "query": "what did we decide about auth?"}'
```

> A **space** is a separate store with its own records, files, schema and retention. Keep *work*, *home* and
> *client-X* apart, or search several at once.

<div align="center">

**Where next?**

| I'm a… | Start here |
|---|---|
| 👤 User / operator | [Workstation Mode](docs/workstation-mode-guide.md) · [User Guide](docs/userguide.md) · [Use-case examples](docs/usecase-examples.md) |
| 🔌 Integrator (API / MCP) | [Integration Guide](docs/integration-guide.md) · [Network Types](docs/network-types.md) · [Sync Protocol](docs/sync-protocol.md) |
| 🛠️ Developer | [Contribution Guide](docs/contribution-guide.md) · [UI Primitives](docs/ui-primitives.md) · [Docker Build](docs/docker-build-protocol.md) |

</div>

---

## Sync networks

Run one instance, or several that copy only the spaces you choose to each other. The type of network decides
who may join.

<div align="center">

```mermaid
flowchart LR
  subgraph BA["Instance A"]
    SA[space]
  end
  subgraph BB["Instance B"]
    SB[space]
  end
  subgraph BC["Instance C"]
    SC[space]
  end
  SA <--> SB
  SA <--> SC
  SB <--> SC
```

</div>

| Type | Flow | Who gets in |
|---|---|---|
| **Closed** | full mesh | unanimous vote |
| **Democratic** | full mesh | majority vote |
| **Club** | full mesh | inviter approves |
| **Braintree** | push-only, root → leaves | ancestor approves |
| **Pub / Sub** | one publisher → many subscribers | auto-accept |

Only changes are sent, and each side can prove it holds the same data as the other (SHA-256 file manifests,
Merkle verification). Every membership vote is signed with the voting instance's own Ed25519 key, so no member
can fake another's vote, even when the vote is passed along through other members. Full spec:
[Network Types](docs/network-types.md) · [Sync Protocol](docs/sync-protocol.md).

---

## 🔐 Under the hood

- **Auth** — personal access tokens (bcrypt-hashed, per-space scope, per-area rights, read-only mode, expiry) ·
  **OIDC/SSO** (Keycloak, Entra ID, Okta, Auth0…) · OAuth with dynamic client registration for MCP clients ·
  optional **TOTP MFA** for admin actions.
- **Network trust** — RSA-4096-OAEP invite handshake; Ed25519-signed governance votes and tombstones.
- **Hardening** — query-operator allowlist, ReDoS-guarded regex, path-traversal sandboxing, storage quotas,
  rate limiting, CSP and security headers.
- **SSRF defence in depth** — outbound targets are re-resolved and every resolved IP checked (private ranges,
  loopback, cloud metadata, IPv6 local, encoded-IP tricks); webhook delivery pins the connection to the
  checked address and re-validates every redirect.

Runs on Docker Compose or Kubernetes. The bundled sidecars (Ollama, Whisper, document extraction) make it
work completely offline.

---

## License

Source-available under the [PolyForm Small Business License 1.0.0](LICENSE). **Free to use, modify and
self-host** for individuals and small businesses (< 100 people, < $1M revenue). Larger organisations — or
anyone offering Ythril as a paid managed or cloud service — need a commercial licence: `contact@ythril.net`.

**There is one build, and it is the whole product.** No feature gates, no activation key, no licence check,
no telemetry, no call home — a test asserts the absence rather than promising it. The licence limits **who**
may use Ythril commercially, never **what** the software does.

## Contributing

Issues and PRs welcome — keep changes scoped and testable, and include a short rationale. See the
[Contribution Guide](docs/contribution-guide.md).

<div align="center">
<br/>
<sub>Ythril — your knowledge, in one place you own.</sub>
</div>
