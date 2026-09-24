# Ingest API — a conversation in, records out

> Part of the [Ythril Integration Guide](../integration-guide.md).

`ingest` reads a conversation and writes what was in it: the people, places and things (entities), one claim per
exchange (facts), the dated events (chrono), the relationships between them (edges), and one transcript file per
session, linked to the claims it produced. The same capability on both doors:

| | REST | MCP | rights |
|---|---|---|---|
| start a run | `POST /api/brain/spaces/:spaceId/ingest` | `ingest` | `knowledge: write` |
| read a run | `GET /api/brain/spaces/:spaceId/ingest/:runId` | `ingest_status` | `knowledge: read` |

## Two kinds of body — send exactly one

```json
{ "kind": "conversation", "conversationId": "chat-7",
  "sessions": [
    { "date": "2023-05-10", "turns": [
      { "speaker": "Ada", "text": "We adopted a cat yesterday! Her name is Luna." },
      { "speaker": "Bo",  "text": "Congrats!" } ] } ] }
```

- **`sessions`** — a raw conversation. Each session needs a `date` (`YYYY-MM-DD`: every relative date in it —
  *"yesterday"*, *"next Friday"* — is resolved against it), and may carry `time` (`HH:MM`, orders two sessions on
  one day) and `key`. A turn is `{ speaker, text, role? }`; `role` is `person` or `assistant` when the source knows
  it. This runs every phase of the extractor: **minutes of model calls**.
- **`extraction`** — one already made, in the committed extraction format (`benchmarks/plan/extraction-format.md`).
  It is validated and written; **no model is asked**. This is how a committed extraction is replayed.

`conversationId` names the conversation and the transcripts' folder, `transcripts/<conversationId>/<session>.md`:
1–100 letters, digits, dots, dashes or underscores. Omitted, it is derived from the content, so the same
conversation sent twice names the same folder. A key the door does not read is refused by name, not ignored.

**Re-ingesting creates new records.** Record ids are minted by the write, so sending the same conversation twice
writes its claims twice; only the transcripts, which live at a derived path, are replaced.

## It answers at once, and the run is read back

`202 { "runId": "…", "conversationId": "chat-7", "phase": "queued" }`. Poll `GET …/ingest/:runId` (or
`ingest_status`) until `phase` is `done` or `failed`:

| field | what it says |
|---|---|
| `phase` | `queued`, `extracting`, `writing`, `done` or `failed` |
| `error` | why a `failed` run failed |
| `written` | counts per step: `entities`, `claims`, `chrono`, `edges`, `transcripts` |
| `writeErrors` | records the write refused, each with its step, key and reason — nothing was sent pointing at them |
| `dropped` | claims that could not be written true to their turns, and why |
| `uncovered` | turns no claim covers |
| `backends` | which models answered (`jev` or `assist`) |
| `transcripts` | set when transcripts were skipped, with the reason |

**Runs are held in memory.** A restart forgets the run — never the records a finished run wrote. A run is found
only under the space it was started in; asked for from another space it is a `404`.

## Refused before anything is paid for — `409`

Everything that would make the run fail is checked first, and the answer lists every problem in `refusals`:

- **The space must declare every type of the `conversation` group.** The group ships in every instance's Schema
  Library. Add it to a space with
  [`POST /api/schema-library/groups/conversation/apply`](06b-schema-library-api.md); `ingest` never changes a
  space's schema itself.
- **For `sessions` only:** a decision model (Settings → Media Processing → Models → Decision model, or the assist
  model it falls back to), the assist model that writes claims, and the `doc-nlp` sidecar (`NLP_SIDECAR_URL`) must all answer.

`400` is a malformed body (with every problem the loader found); `404` a space that does not exist.

## What it writes, and under which rules

Every record goes through the same door as [`POST /bulk`](04d-brain-ops-api.md#bulk-write), so the space's schema,
strict linkage and the record flags apply exactly as they do to any other write. A claim is the group's
`utterance` fact type, carrying `speaker` and `statedOn`; a claim an assistant originated is marked `attributed` and
stored unranked; a claim a later one overtook is `superseded`, with a `supersedes` edge from the new one. An entity
the space already held is linked, not written again.

**Transcripts are files**, so they are written only when the token also holds `files: write` in the space. Without
it the records are still written, and the run's `transcripts` field says what was left out.

**Proxy spaces:** add `?targetSpace=<member>` (MCP: `targetSpace`) on both the start and the read.
