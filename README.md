<!-- markdownlint-disable MD033 MD041 MD001 MD022 MD026 -->
<div align="center">

<img src="docs/assets/ythril-mark.svg" width="112" height="112" alt="Ythril" />

# Ythril

### Give your AI a fact that's actually yours.

**Ythril is a private, self-hosted brain that every AI assistant can plug into** — so Claude, Cursor, Copilot, and anything that speaks [MCP](https://modelcontextprotocol.io) stops forgetting, and starts remembering *your* projects, files, people, and decisions. On your hardware. Under your control.

[![License: PolyForm SB](https://img.shields.io/badge/license-PolyForm%20Small%20Business-2b7bb9)](LICENSE)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-native-9eec55?labelColor=0d1117)](https://modelcontextprotocol.io)
[![Self-hosted](https://img.shields.io/badge/self--hosted-docker%20compose%20up-0d1117)](#-quickstart)
[![Runs offline](https://img.shields.io/badge/works-fully%20offline-6e7681)](#your-data-your-rules)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ythril-network/Ythril)

</div>

---

## Every AI conversation starts from zero. That's the problem.

You explain your project. It helps. You close the tab. It forgets **everything** — your stack, your preferences, the decision you made last week, who "Sarah from finance" is. Tomorrow you start over. Your actual knowledge is scattered across chats, docs, drives, and three different assistants that don't talk to each other, half of it sitting on someone else's cloud being used to train the next model.

**Ythril fixes that.** It's one persistent brain that all your AI tools read from and write to — and it's *yours*.

> Ask, months later: *"What did we decide about the auth rewrite, and who owns it?"* — and your assistant just knows. Because it wrote it down, in a brain you host.

---

## 🧠 What becomes possible

<table>
<tr>
<td width="50%" valign="top">

### Never re-explain yourself
Your assistant remembers your projects, people, and past decisions across **every session and every tool**. Context follows you instead of dying when you close the window.

</td>
<td width="50%" valign="top">

### One brain, every assistant
Claude on the web, Cursor in your editor, Copilot in your IDE — all reading and writing the **same** fact over MCP. Switch tools freely; the knowledge stays put.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Turn your files into answers
Drop in PDFs, docs, images, audio, even video. Ythril OCRs, transcribes, and captions all of it, then makes it **searchable in one plain-language question** — with the source, not a folder to dig through.

</td>
<td width="50%" valign="top">

### It knows who's who
Label a face once and every future photo of that person is tagged automatically. People, relationships, and timelines are stored as **structure** — a real knowledge graph, not a soup of embeddings.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### A team brain that syncs — without a cloud
Everyone runs their own Ythril; share exactly the spaces you choose through **governed networks** (vote to admit members, push-only trees, publisher→subscriber). Institutional fact that no vendor holds hostage.

</td>
<td width="50%" valign="top">

### One question, across everything
A single semantic query crosses facts, notes, documents, speech, and pictures — because it *all* lands in the same vector space. Ask once; get the answer wherever it lives.

</td>
</tr>
</table>

> **For teams & managers:** stop paying per seat for assistants that forget your business by lunch. Ythril is the institutional-fact layer you *own* — onboard faster, keep decisions and context in one searchable place, and never hand your knowledge to a third party to train on.

---

## Your data, your rules

- **Self-hosted, `docker compose up`.** No accounts, no per-seat pricing, no data leaving your machine.
- **Works fully offline** — and the image *enforces* it. Bundled local models for embeddings, vision and speech; runtime model downloads are switched off (`HF_HUB_OFFLINE=1`), so a cache miss fails loudly instead of quietly fetching from `huggingface.co`. Plug in OpenAI/Azure/your own endpoints only if you *want* to.
- **Never trains on your knowledge.** It's a database you run, not a service that mines you.
- **Enterprise-grade security out of the box** — OIDC/SSO, optional MFA, an immutable audit log, per-token scopes, and aggressive SSRF/injection hardening. [Details ↓](#-under-the-hood)

---

## ⚡ Quickstart

```bash
docker compose up -d
# → open http://localhost:3200 and finish setup in your browser
```

Then point any MCP client at your new brain:

```json
{
  "mcpServers": {
    "ythril": {
      "url": "http://localhost:3200/mcp/general",
      "headers": { "Authorization": "Bearer ythril_your_token_here" }
    }
  }
}
```

That's it. Your assistant instantly sees the space's purpose, its schema, and every tool it can call — and can start remembering.

> Each **space** is an isolated container (its own facts, entities, files, and schema) with its own MCP endpoint at `/mcp/{spaceId}`. Keep *work* and *home* and *client-X* cleanly apart, or aggregate them with a proxy space.

<div align="center">

**Where next?**

| I'm a… | Start here |
|---|---|
| 👤 User / operator | [Workstation Mode](docs/workstation-mode-guide.md) · [User Guide](docs/userguide.md) · [Use-case examples](docs/usecase-examples.md) |
| 🔌 Integrator (API / MCP) | [Integration Guide](docs/integration-guide.md) · [Network Types](docs/network-types.md) · [Sync Protocol](docs/sync-protocol.md) |
| 🛠️ Developer | [Contribution Guide](docs/contribution-guide.md) · [UI Primitives](docs/ui-primitives.md) · [Docker Build](docs/docker-build-protocol.md) |

</div>

---

## What's inside

A quick tour — every capability is also a callable **MCP tool** (45 of them), a REST endpoint, and a screen in the web UI.

**Every capability is on both doors, not a subset** — a build fails if one reaches REST without its MCP tool, and the exemption list for that check is empty. Same parameters, same defaults, same refusals is the rule the project holds itself to on every change; the build enforces the capability half of it.

A refused write comes back **machine-readable** rather than as a sentence: a schema violation arrives as `structuredContent`, separating what your write introduced from what was already stored, so an agent can decide whether to fix and retry without parsing prose.

| | |
|---|---|
| 🔎 **Four ways to look, and the docs say which is WRONG** | `recall` ranks by meaning across facts, entities, edges, timelines and files at once. `query` is an exact filter with total ordering, for when you need COMPLETENESS rather than the best few. `find_similar` reuses a record's stored vector — no re-embedding, which is cheaper and more accurate for finding near-duplicates. `traverse` walks the graph from a known node, or nested inside a `recall` for 0–5 hops. Picking the wrong one is the common mistake, so each read tool's own description carries a **blind-spots section** — what this door does NOT send you — which a caller reads while constructing the arguments rather than after being surprised. |
| 🎛️ **Recall you can actually tune** | A filter that runs INSIDE the vector index rather than after it, so nothing is silently dropped by a `topK`. Per-type quotas (`minPerType` / `maxPerType`) so one noisy type cannot crowd out the rest. A time budget (`maxTimeMS`) that returns what it has with a `degraded` flag instead of hanging or erroring. `includeFreshWrites`, so a record written seconds ago and not yet vector-indexed is still found. Field projection applied recursively through traversal results. And the lexical, fused and rerank scores on request, so a bad ranking can be diagnosed rather than guessed at. |
| 🕸️ **Knowledge graph** | Typed **entities**, labelled **edges**, and multi-hop **traversal** — model how things actually connect, then let the AI walk the graph. `er_model` reports the shape a space has ACTUALLY taken — which entity types exist, which edge labels connect which types, and how many of each — so an assistant can learn a space before writing into it instead of guessing from the declared schema. |
| 📅 **Chrono timeline** | Events, deadlines, plans, milestones — with date ranges, tags, and full-text search built in. |
| 📎 **Files that answer back** | Chunked uploads, inline preview, and automatic OCR / transcription / captioning → instantly searchable. |
| 🖼️ **Media understanding** | Images captioned, audio transcribed, video keyframed — all in the same searchable vector space. |
| 🙂 **Face recognition** | In-process, CPU-only, no GPU. Label once, auto-tag forever. |
| ⚖️ **Contradictions, flagged not overwritten** | Two records that disagree are usually both real, so Ythril **flags** them and records how it was settled — someone corrected a record, or a `contradicts` / `supersedes` edge was drawn. The two kinds are kept apart on purpose: `structured-field` is deterministic (both records set the same single-valued property to different values, and the offending fields are named), `nli` is a model's opinion carrying its confidence. A reviewer can tell *"these disagree on `port`"* from *"a model thinks these disagree"*. |
| 👯 **Duplicates, reviewed** | A background scanner proposes near-duplicate pairs with a similarity score; you dismiss or merge, and a dismissal sticks. Per-space rules can also act at INSERT time, so a duplicate can be caught on the way in rather than found later. |
| 📐 **Schema validation** | Per-type rules (naming patterns, enums, ranges, required fields) in strict / warn / off modes, with a shared **schema library** (`$ref`), dry-run validation, and a backup taken before an overwrite. **`strict` blocks what your write BROKE, not what was already broken** — a violation is reported as introduced or pre-existing, and only the introduced ones refuse the write. Otherwise tightening a schema makes every later edit to an old record impossible, which is how a validation mode gets switched off and left off. |
| 🔗 **Referential integrity** | Deleting an entity that anything still points at is refused with a `409` that NAMES the blockers — and says which end matched, `from`, `to` or both, because "an edge references this" does not tell you which one to fix. Upserts warn on a duplicate name instead of quietly creating a second record; properties shallow-merge and tags union, so a partial write cannot erase what it did not mention. |
| ⏳ **Retention windows** | Per space, and per record type within it — chrono entries, files, facts, entities and edges can each have their own age limit, or none. A chrono entry can also lose its detail and keep its date, which is recorded on the entry so a redacted one cannot be mistaken for one that never had any. |
| 🔁 **Multi-brain sync** | Governed **networks** with signed votes, incremental replication, and conflict resolution. |
| 🧾 **Audit log & webhooks** | An immutable trail of who, when, which route, and **what changed** — field-level before/after, on an allowlist rather than a redaction list, so a secret can never be written into a queryable store by forgetting to strip it. Every MCP tool call is recorded under the same operation name as its REST twin, so one query answers *"who created this fact"* without knowing which door they used. Plus HMAC-signed, SSRF-protected event delivery to your systems. |
| 🧩 **Bulk, proxy, export, find-similar** | Batch writes, virtual aggregate spaces, one-file backup/restore, and "more like this" dedup. |

*(Full detail for every one of these lives in the [Integration Guide](docs/integration-guide.md).)*

---

## Multi-brain networks

Run one brain, or many that sync only the spaces you choose — with the governance model that fits your trust boundary.

<div align="center">

```mermaid
flowchart LR
  subgraph BA["🧠 Brain A"]
    SA[space]
  end
  subgraph BB["🧠 Brain B"]
    SB[space]
  end
  subgraph BC["🧠 Brain C"]
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

Replication is watermark-based and incremental, with SHA-256 file manifests and Merkle verification. Membership changes are **cryptographically signed** (each brain holds an Ed25519 keypair; peers pin keys on first contact) so no member can forge another's vote — even relayed multiple hops through a tree. Full spec: [Network Types](docs/network-types.md) · [Sync Protocol](docs/sync-protocol.md).

---

## 🔐 Under the hood

Security is not an add-on:

- **Auth** — PAT tokens (`ythril_*`, bcrypt-hashed, per-space scope, read-only mode, expiry) · **OIDC/SSO** (Keycloak, Entra ID, Okta, Auth0…) · optional **TOTP MFA** for admin actions.
- **Network trust** — RSA-4096-OAEP zero-knowledge invite handshake; Ed25519-signed governance votes and tombstones.
- **Hardening** — MongoDB operator whitelist, ReDoS-guarded regex, path-traversal sandboxing, storage quotas, global rate limiting, CSP + security headers, `0600` config enforcement.
- **SSRF defense-in-depth** — outbound targets are DNS-re-resolved and every resolved IP validated (blocks RFC-1918, CGNAT, loopback, IMDS, IPv6 ULA/link-local, and encoded-IP tricks); webhook delivery pins the connection to the checked IP and re-validates every redirect hop, closing the DNS-rebind window.

Runs on Docker Compose or Kubernetes. Bundled sidecars (Ollama, Whisper, document OCR) mean it works **completely offline** — or wire in hosted models from **Settings → Models**.

---

## License

Source-available under the [PolyForm Small Business License 1.0.0](LICENSE). **Free to use, modify, and self-host** for individuals and small businesses (< 100 people, < $1M revenue). Larger organisations — or anyone offering Ythril as a paid managed/cloud service — need a commercial license: `contact@ythril.net`.

**There is one build, and it is the whole product.** No feature gates, no activation key, no licence check anywhere in the code, no telemetry, no call home — a gate in the test suite asserts the absence rather than promising it. The licence limits **who** may use Ythril commercially; it does not limit **what** the software does for anyone who runs it.

## Contributing

Issues and PRs welcome — keep changes scoped and testable, and include a short rationale. See the [Contribution Guide](docs/contribution-guide.md).

<div align="center">
<br/>
<sub>Ythril — the fact layer your AI should have shipped with.</sub>
</div>
