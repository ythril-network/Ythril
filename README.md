<!-- markdownlint-disable MD033 MD041 MD001 MD022 MD026 -->
<div align="center">

<img src="docs/assets/ythril-mark.svg" width="112" height="112" alt="Ythril" />

# Ythril

### Self-hosted knowledge management for people, teams and their AI tools.

**One place for what you know** — facts, people, decisions, timelines and files — searchable by meaning,
connected as a graph, synced between the machines you choose, and open to every program through
**MCP and a REST API that are the same thing**. On your hardware. Under your control.

[![License: PolyForm SB](https://img.shields.io/badge/license-PolyForm%20Small%20Business-2b7bb9)](LICENSE)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-native-9eec55?labelColor=0d1117)](https://modelcontextprotocol.io)
[![Self-hosted](https://img.shields.io/badge/self--hosted-docker%20compose%20up-0d1117)](#-quickstart)
[![Runs offline](https://img.shields.io/badge/works-fully%20offline-6e7681)](#your-data-your-rules)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ythril-network/Ythril)

</div>

---

## Knowledge is scattered. Ythril puts it in one place.

Decisions live in chats, documents live in drives, who-knows-whom lives in people's heads, and every AI
assistant you use starts each conversation knowing none of it. Ythril is one store for all of it — and
everything that can talk to it, whether a person in the web UI, a script over REST or an assistant over MCP,
reads and writes the same knowledge.

> Months later: *"What did we decide about the auth rewrite, and who owns it?"* — one question, and the answer
> comes back with the record it came from.

---

## What's in the box

| | |
|---|---|
| 🔎 **Search by meaning** | Ask a question in your own words and get back the facts, people, events and files that answer it — even when none of them use your words. Narrowing a search (say, to one project) never quietly drops a match. |
| 🎯 **Four ways to look** | *Search by meaning* (`recall`) for the best few answers. *Exact lookup* (`filter`) when you need every record that matches, like a database query. *More like this* (`similar`) to find near-copies of a record. *Follow the connections* (`graph_traverse`) from one thing to everything linked to it. Each one says in its own description what it cannot find — its blind spots — so an assistant picks the right one. |
| 🕸️ **Things and how they connect** | Store people, projects and places, and the links between them — *Ada works on Apollo*, *Apollo depends on Billing* — then ask about chains of links, not just single records. |
| 📅 **Timeline** | Events, deadlines, plans and milestones with dates, tags and text search. |
| 📎 **Files that answer back** | Drop in PDFs, office documents, images, audio and video. Ythril reads the text, reads scans, writes down what is said in recordings and describes pictures — and all of it becomes searchable. |
| 🙂 **Faces** | Name a person in one photo, and later photos of them are recognised. Runs on your CPU, nothing sent out. |
| 📐 **Rules for your data** | Say what a record must look like — required fields, allowed values, naming patterns — and choose whether a breach is refused, warned about or ignored. Each problem is reported as introduced or pre-existing, and strict mode refuses only what a new edit broke, never what was already broken, so tightening the rules never locks you out of old records. |
| ⚖️ **Contradictions and duplicates** | When two records disagree, both are kept and flagged for you instead of one silently overwriting the other. Near-copies are suggested for merging, and a "no, these are different" answer sticks. |
| 🔁 **Sync between machines** | Copy the spaces you choose between Ythril instances — your laptop, your team's server — with no cloud in the middle, and rules for who may join. |
| 🔌 **One API, two doors** | AI assistants connect over MCP; programs call the REST API. Both doors are the same code: every tool is also `POST /api/<tool>` with the same body — same parameters, same limits, same refusals. A refusal says what went wrong in a machine-readable form, so a program can fix and retry. |
| 🧾 **History and housekeeping** | A log of who changed what — field-level, the value before and after; notifications to your own systems when data changes; automatic deletion after an age you set; one-file backup and restore. |

Everything above is a callable MCP tool (45 of them), a REST endpoint and a screen in the web UI. The full
reference is the [Integration Guide](docs/integration-guide.md).

---

## Measured, not promised

On **LoCoMo** — ten long multi-session conversations, 1,540 questions — answers written from what Ythril
retrieved were judged correct **82.5%** of the time. Answers written with the *whole conversation* in front of
the same model scored 84.5%. Ythril's answers used **about 2% of the text** to get there.

| | judged correct (n=200) | text per question |
|---|---|---|
| **Ythril** | **82.5%** | ~1.8k characters |
| whole conversation in context | 84.5% | ~86k characters |

**In plain words:** Ythril found the right handful of notes almost every time the whole conversation
would have — and the 2-point gap is small enough to be chance on a sample this size (95% interval −6.2 to
+2.2). Reading everything stops working once your history is bigger than a model can hold; Ythril does not.

How it was measured: the same AI (Claude Opus 5.5) answered both ways, and an AI from a different company (a
GPT model) graded the answers without knowing which way each was written. Other published scores use other
AIs, so compare the **gap to reading everything**, not the percentage. Full method and what the misses look
like: [benchmarks/](benchmarks/README.md#results).

---

## Your data, your rules

- **Self-hosted with `docker compose up`.** No accounts, no per-seat pricing, no data leaving your machine.
- **Works fully offline, and the image enforces it.** Local models for embeddings, vision and speech are
  bundled, and runtime model downloads are switched off (`HF_HUB_OFFLINE=1`), so a missing model fails loudly
  instead of quietly fetching one. Connect hosted models under **Settings → Models** only if you want to.
- **Never trains on your knowledge.** It is a database you run, not a service that mines you.
- **Security built in** — OIDC/SSO, optional MFA, scoped and read-only tokens, OAuth for MCP clients, an
  immutable audit log, and SSRF and injection hardening. [Details ↓](#-under-the-hood)

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

The client sees every space the token can reach, each space's purpose and schema, and every tool it can
call. Clients that support OAuth can connect without a pasted token and ask you to approve them instead.

Or call the same tools over HTTP:

```bash
curl -X POST http://localhost:3200/api/recall \
  -H "Authorization: Bearer ythril_your_token_here" -H "Content-Type: application/json" \
  -d '{"space": "general", "query": "what did we decide about auth?"}'
```

> A **space** is an isolated store with its own records, files, schema and retention. Keep *work*, *home* and
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

Run one instance, or several that copy only the spaces you choose to each other. The table is who decides
when a new instance wants to join.

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

Only what changed is sent, and each side can check that it holds exactly what the other holds (SHA-256
manifests, Merkle verification). Every vote to let someone in is signed with that instance's own key
(Ed25519), so nobody can fake another member's vote, even when it is passed along through others. Full spec: [Network Types](docs/network-types.md) ·
[Sync Protocol](docs/sync-protocol.md).

---

## 🔐 Under the hood

For the security reviewer. Everyone else can skip this section.

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
