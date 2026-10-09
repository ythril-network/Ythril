# Duplicates & Webhooks

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Duplicate Scanner & Action Rules

A background scanner can sweep a space for **semantically duplicate** records and act on them according to per-space rules. It complements the interactive insert-time check ([Duplicate Detection on Insert](#duplicate-detection-on-insert)) but is independent of it: the scanner finds duplicates among **all** records — including those inserted with `checkDuplicates` off — and re-evaluates a pair whenever either record changes (a **dismissed** pair re-opens only when its content materially changes, not on a bare re-embed/re-sync — see below).

**Off by default.** Enable it in `config.json`:

```jsonc
{
  "dupeScanner": {
    "enabled": true,
    "schedule": "0 3 * * *",   // cron — nightly at 03:00 (default)
    "threshold": 0.92,          // cosine score at/above which a pair is a candidate
    "batchSize": 200,           // records fetched per DB batch
    "maxPerRun": 5000,          // max records scanned per space per run
    "types": ["fact", "entity", "chrono"]   // the default set
  }
}
```

> **`types` defaults to `["fact", "entity", "chrono"]`.** Chrono joined the default sweep because logging
> the same event twice is one of the commonest ways a knowledge base goes redundant, and nothing was looking
> for it. On an instance that already had the scanner enabled, the first run after upgrading starts chrono
> from cursor zero — that is a normal first pass, bounded by `maxPerRun` like any other. Set `types`
> explicitly to opt back out.

**How the sweep works.** Each run walks a space's records ordered by `seq` (the monotonic sequence number that advances on every create *and* update), resuming from a per-(space, type) cursor. For each record it runs a vector search using the record's **stored** embedding (no re-embedding) and, for every match at or above `threshold`, applies the space's rules. Because updates advance `seq`, an edited record is re-scanned automatically; because the cursor is `seq`-based (not time-based), a record inserted with insert-time checking disabled is still covered. `maxPerRun` bounds the work per run so the initial full pass spreads across nights rather than one heavy burst. Records relayed from several authors can share a `seq`, so the cursor is a position `(seq, _id)` within that order: a run that ends in the middle of records sharing a `seq` (a batch boundary, or `maxPerRun`) resumes at the next record rather than skipping the rest. A cursor written by an earlier build holds the `seq` alone, so the first run after an upgrade scans the records at that one `seq` once more — a pair already recorded is recorded again as itself, and nothing below it is read again.

**Real-time evaluation (optional).** Set `dupeRulesOnInsert: true` on a space (Settings → Spaces → Duplicates, or `PATCH /api/spaces/:id`) to also apply the rules the moment a record is inserted, not only on the scheduled scan. Evaluation is fire-and-forget (it never blocks or fails the write) and applies to **all** inserts, including bulk — leave it off for scan-time-only. Default off. Note that with an `automerge` rule, real-time evaluation can absorb a just-inserted entity moments after the write returns.

### Action rules

Rules live on the space (local, not synced/governed) and are edited under **Settings → Spaces → (a space) → Duplicates**, or via `PATCH /api/spaces/:id`:

```jsonc
{
  "dupeRules": [
    { "minScore": 0.98, "action": "automerge" },
    { "minScore": 0.90, "action": "notify", "types": ["entity", "fact"] }
  ],
  "dupeMergeSurvivor": "older"   // which record survives an automerge (default: older = lower seq)
}
```

Rules are evaluated **highest `minScore` first**; the first match decides the action. No matching rule ⇒ `flag`.

| Action | Effect |
|--------|--------|
| `flag` | Record a reviewable candidate (default; non-destructive). |
| `automerge` | **Entities only.** Merge losslessly using the existing entity merge (unions edges, tags, and non-conflicting properties). If the two records set the same property to *different* values, the merge is not lossless — it is **not** performed and the pair falls back to `flag`. The survivor is the older record by default (`dupeMergeSurvivor`). A merge every door refuses is refused here too and the pair stays open for review — a survivor a `strict` schema would refuse, or an absorbed entity with more edges, links and face labels than one merge relinks (`merge_too_large`, [04b](04b-graph-api.md#merge-two-entities)). The scan logs ONE warning per refused pair naming both records and the reason, and skips the pair until either record changes. |
| `notify` | Emit a `duplicate.detected` webhook with both full records + the score. By default this goes to your webhook **subscriptions** (subscribe your automation, e.g. an n8n workflow, to `duplicate.detected` for the space); set a rule-level `webhookUrl` to POST directly to a specific (SSRF-validated) endpoint instead. Your automation can then apply custom logic and call back the API (`graph_merge`, delete, etc.). |

An action runs once per pair; it re-runs only after one of the records changes. **A dismissed pair is content-gated:** it stays dismissed when a record is merely re-written with the *same* content — a re-embed, a peer re-sync, an index rebuild (all of which advance `seq`) — but it **re-opens automatically when the pair's content materially changes** (a real edit to the embedded text). This is why a routine re-embed no longer resurfaces every pair you already dismissed, while a genuine edit still comes back for review. You can also bring a dismissed pair back manually at any time by re-rating it (`POST /api/duplicates/:id/reopen`, or the **Re-rate** button in the UI). Mechanically, dismissal records a fingerprint of both records' embedded text; the scanner re-opens the pair only when that fingerprint no longer matches.

### Candidate review API

Base path: `/api/duplicates`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/duplicates?status=open&space=<id>&limit=100&skip=0` | any token (space-scoped) | List candidates, one page. `status` = `open` (default), `dismissed`, or `all`. |
| `POST` | `/api/duplicates/:id/dismiss` | `dataQuality` write | Mark a pair reviewed / not-a-duplicate. A later re-embed/re-sync will not resurface it; a real content change will. |
| `POST` | `/api/duplicates/:id/reopen` | `dataQuality` write | Manually re-rate a **dismissed** pair back onto the open list. `404` if the pair is not currently dismissed. |
| `POST` | `/api/duplicates/:id/merge` | `dataQuality` write **and** `knowledge` write, in the pair's space | Merge an entity candidate losslessly. `409` with the merge plan if there is a value conflict; `422 merge_too_large` (with `relinks` and `bound`) or `400` for a survivor a `strict` schema refuses, before anything is written — the same answers as the entity merge route ([04b](04b-graph-api.md#merge-two-entities)). When the too-large refusal says merging the other way round fits, this route takes its direction from the space's `dupeMergeSurvivor`, so it is the setting that changes it; the entity merge route and `graph_merge` take the two ids in either order. A merge deletes the absorbed entity, so it needs the same `knowledge` write as the entity merge and `graph_merge`. A candidate in a space where the token lacks either answers `404`, so the refusal does not reveal that the candidate exists. |
| `POST` | `/api/duplicates/scan?space=<id>` | `dataQuality` write + MFA | Trigger an on-demand full re-scan. It only ever touches spaces where the token holds `dataQuality` write — naming one it does not answers `404`. Requires `X-TOTP-Code` when MFA is enabled. Answers `{ scannedSpaces, scanned, pairs, failedSpaces }` — see [a scan that could not scan a space](#a-scan-that-could-not-scan-a-space). |

These routes name no space: each one looks the candidate up only in the spaces where the token holds the rung in
the Auth column, so a candidate in any other space is `404`, never `403`.

**Paged, and it says so** (`Q-127`): `limit` (default 100, held to 500) and `skip`, and every answer carries `count` (rows in this page), `total` (every matching candidate across the spaces), `limit`, `skip`, `truncated` and `nextSkip` exactly when there are more — the fields every paged list answers with. It used to stop at 500 with nothing saying so. Across several spaces `skip + limit` is held to 5000 and refused past it; page one space for a deeper sweep. `maxChars` / `maxBytes` bound the body. The web UI reads every page.

A candidate is `{ id, spaceId, type, aId, aSummary, bId, bSummary, score, status, resolution?, contradiction, negationAsymmetry?, detectedAt, updatedAt }`. The web UI (a space's **Brain → Review** tab) lists that space's candidates with dismiss / merge / re-rate actions, a **search box** (handy for a large dismissed pile), and a "Scan now" button.

#### Is the pair the same, or the opposite? (`contradiction`, `negationAsymmetry`)

A high similarity score means the two records are **about** the same thing. It does not say they **agree**.
*"Ship the rough version today"* and *"take the extra days and never ship a rough version"* score ~0.97 and
mean opposite things, and neither sets a conflicting property, so the structured contradiction check has
nothing to fire on. If an automated pass merges that pair, it destroys the fact that someone changed their
mind — so every candidate now carries what is known about the disagreement question.

**`contradiction` is a tri-state, never a bare absence**, because "checked, they do not disagree" and "nobody
has looked" license opposite actions:

| value | meaning | safe to merge automatically? |
|---|---|---|
| `{ "checked": true, "found": true, "basis": …, "confidence": …, "status": …, "id": … }` | this exact pair is a known contradiction — the same record you would get from `/api/contradictions` | **No** |
| `{ "checked": true, "found": false }` | the contradiction scanner has run over this space and did not flag this pair | Yes, as far as this signal goes |
| `{ "checked": false, "reason": "no-judge-configured" }` | no NLI judge is configured, so only the structured field check ever ran. Nothing here has looked at meaning | **Unknown — do not treat as clean** |
| `{ "checked": false, "reason": "never-scanned" }` | the contradiction scanner has never produced a row for this space | **Unknown — do not treat as clean** |

**`negationAsymmetry: true`** is a cheap **lexical** cue: one summary contains negation words ("not",
"never", "cannot", "without", …) that the other does not. It is present only when true.

> **It is a reason to read the pair, not a verdict on it.** It is not semantic: `"approved"` versus
> `"rejected"` contradict with no negation word at all and will not raise it, and two records that both say
> "do not ship on Friday" agree while both negating — which is why the cue requires the negation to be
> *asymmetric* rather than merely present. Use it to decide what a human or a model should look at; use
> `contradiction` to decide what not to merge.

#### A scan that could not scan a space

`POST /api/duplicates/scan` and `POST /api/contradictions/scan` answer alike when a space fails. A space whose scan fails does not
end the request: every other space is still scanned, the answer is `200`, and **`failedSpaces`** names the ones that failed.

```json
{ "scannedSpaces": 3, "scanned": 412, "pairs": 7,
  "failedSpaces": [ { "spaceId": "notes", "reason": "A store-side failure stopped this operation. …" } ] }
```

- `failedSpaces` is **always present**, `[]` when every space was scanned, so read its length without a guard. Each entry is
  `{ spaceId, reason }`.
- `reason` is in Ythril's words and never the database driver's: the driver's text, which can name collections and values, is in
  the Server Log (`Dupe scan failed for space '<id>': … — retried next scan`, `Contradiction scan failed for space '<id>': …`), once
  per ten minutes per space.
- `scannedSpaces` counts the spaces that were **scanned**, so it is the number of spaces asked less `failedSpaces.length`.
  `scanned` and the rest of the counts are over those spaces only.
- A store that is **not answering** (a timeout, or no connection) still ends the request — the next space would wait the same
  time — and answers the retryable `503` with `Retry-After`, as every route does. A space left unscanned by it is not listed.
- There is no MCP tool for either scan (a scan is an operator action, started from the Brain's Review tab or this API), so this
  field has no MCP twin.

### Contradictions API

Base path: `/api/contradictions`. Mirrors the duplicates API — same space scoping, same content-gated
sticky dismissal — because the Review tab presents both under one vocabulary.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/contradictions?status=open&space=<id>&limit=100&skip=0` | any token (space-scoped) | List candidates, one page, paged exactly as duplicates are. `status` = `open` (default), `dismissed`, `resolved`, or `all`. |
| `POST` | `/api/contradictions/:id/dismiss` | non-read-only | Reviewed / not a real disagreement. Content-gated exactly like a duplicate dismissal. |
| `POST` | `/api/contradictions/:id/reopen` | non-read-only | Bring a **dismissed** pair back onto the open list. `404` if it is not currently dismissed. |
| `POST` | `/api/contradictions/:id/resolve` | non-read-only | Body `{ "resolution": "edited" \| "linked" \| "superseded" }`. Records HOW a human settled it. `superseded` also needs `"winner": "a" \| "b"` — see below. |
| `POST` | `/api/contradictions/scan?space=<id>` | `dataQuality` write + MFA | Run the sweep now, over the spaces where the token holds `dataQuality` write. Answers `{ scannedSpaces, scanned, found, judgedPairs, modelCalls, nliStalled, budgetExhausted, failedSpaces }`: `nliStalled: true` if it stopped because the judge was unavailable, and `failedSpaces` as [below](#a-scan-that-could-not-scan-a-space). |

A candidate is `{ id, spaceId, type, aId, aSummary, bId, bSummary, basis, confidence, fields?, truncated?,
status, resolution?, supersededId?, resolvedBy?, detectedAt, updatedAt }`.

**`truncated: true` means the judge probably did not read the whole record.** Encoder NLI models cap at ~512
tokens; a record whose text runs to thousands of characters is judged on its opening paragraphs, and the
confidence comes back looking completely normal — so a confident verdict about the first page is otherwise
indistinguishable from a confident verdict about the record. Treat such a finding as a prompt to read both
records yourself rather than as a settled answer.

Two things it deliberately is not:

- **It is a proxy, not a measurement.** Ythril does not truncate anything; the model does, invisibly, and we
  cannot know the configured model's tokenizer. The flag fires on a conservative character length, so it
  under-reports rather than crying wolf.
- **Its absence is not a guarantee.** No flag means "not long enough to be worth warning about", not "the
  whole text was read". It never appears on a `structured-field` verdict, because that pass compares whole
  property values and no model window is involved.

**`basis` is the important field.** `structured-field` means the two records set the same single-valued
property to different values — deterministic, `confidence` is 1, and `fields` names the offending keys and
both values. `nli` means an entailment model judged the free text, and `confidence` is its score. A reviewer
must be able to tell *"these disagree on `port`"* from *"a model thinks these disagree"*, so do not flatten
the two into one number.

Within `fields`, **`aValue` belongs to `aId` and `bValue` to `bId`** — the sides are named by the record ids
on the candidate, never by the order the sweep happened to encounter them in. Earlier releases did not
re-attribute them when a pair was met the other way round, so roughly half of all `structured-field` findings
reported each value against the other record; the finding was real, only its evidence was inverted. If you
have stored or forwarded findings from before this fix, re-scan rather than trusting their `fields`.

**Contradictions are never merged.** Two records that disagree are both real, and which one is wrong is a
judgement call — so `resolve` records the outcome and leaves the records to the normal edit paths.

| `resolution` | Means |
|---|---|
| `edited` | Someone corrected a record. |
| `linked` | The reviewer drew a `contradicts`/`supersedes` edge by hand instead of changing either record. |
| `superseded` | **The reviewer picked a winner.** Requires `winner: "a"` or `"b"`. |

#### `superseded` — picking a winner

The commonest real decision about two disagreeing records is *"this one is right, that one is stale"*, and
neither of the other two says it. `superseded` records that judgement **and acts on it**:

```http
POST /api/contradictions/:id/resolve
{ "resolution": "superseded", "winner": "a" }

→ 200 {
    "status": "resolved", "resolution": "superseded",
    "supersededId": "<the b record>",         // the one judged out of date
    "resolvedBy": "ops-automation",           // the token's NAME, never the token
    "edge": { "id": "…", "from": "<a>", "to": "<b>", "label": "supersedes" }
  }
```

- **Nothing is deleted or absorbed.** That is the line between this and a duplicate merge: a merge is lossless
  because the two records are the same thing, and a contradiction is not — the loser is a real record that was
  true, or was believed, and its history is the point. Both records still exist afterwards; one now carries a
  `supersedes` edge pointing at it, and the finding names it in `supersededId`.
- **`winner` is required and never guessed.** Omitting it is a `400`, and so is sending it with any other
  resolution. Guessing which record a reviewer meant to keep is the one mistake this endpoint must not make.
- **Repeating the call is safe.** An edge's identity is `(from, to, label)`, so resolving the same pair twice
  lands on the same edge rather than accumulating duplicates.
- **Facts, entities, chrono entries and files all get the edge now.** It used to be drawn for entity pairs
  only, on the ground that an edge between two facts would be stored and never walked; the walk follows an
  edge to a fact, chrono entry or file since 5.0. **A pair of EDGES is the one exception**, because an edge
  cannot be the endpoint of an edge — `note` says so, and it appears in no other case. Branch on `edge` in
  the response if your automation depends on the link.

- **The LOSING RECORD is marked, which is the part that reaches retrieval.** Before 5.0 `supersededId` was
  written onto the review finding and nowhere else, so resolving a contradiction changed nothing about what
  the next `recall` returned: both claims came back ranked together with nothing to choose between them. The
  loser now carries `superseded: true` on the record itself, and `markedRecord` in the response says the
  mark landed:

  ```json
  { "status": "resolved", "resolution": "superseded", "supersededId": "…", "markedRecord": true,
    "edge": { "id": "…", "from": "<winner>", "to": "<loser>", "label": "supersedes" } }
  ```

  It keeps its vector and keeps ranking — see
  [Marking a record as no longer true](04f-write-semantics.md#marking-a-record-as-no-longer-true).

`supersededId` and `resolvedBy` are also returned on the candidate by `GET /api/contradictions`, so a later
reviewer can see who settled it and which side they judged stale without reading the audit log.

**`nliStalled`** is surfaced rather than swallowed: a sweep that stopped because the NLI judge was
unreachable has *not* cleared the space, and that must be distinguishable from a genuinely clean result.

**Scheduling the sweep.** Off by default, and **its own switch** — enabling the duplicate scanner must not
silently start paying for model inference, since the NLI pass is a call per candidate pair and, with an
external endpoint, sends record text off the instance:

```jsonc
{
  "contradictionScanner": {
    "enabled": true,
    "schedule": "30 3 * * *",       // cron — 03:30 daily (default), half an hour after the dupe sweep
    "structuredThreshold": 0.92,    // similarity floor for the free deterministic pass (default)
    "nliThreshold": 0.92,           // floor for the model pass (default)
    "maxJudgedPairsPerRun": 0,      // judge CALLS per run. 0 = unlimited (local default); 2000 for a remote judge
    "batchSize": 200,
    "maxPerRun": 5000
  }
}
```

> **These thresholds are not raw cosine.** `$vectorSearch` normalises cosine similarity to `(1 + cos) / 2`,
> and that is the number compared here. So **0.92 ⇒ cosine 0.84**, **0.85 ⇒ cosine 0.70**, and a
> reasonable-looking **0.70 ⇒ cosine 0.40** — where a lot of barely-related text sits. Read these as cosine
> and you will set them roughly twice as loose as you intended.

**Should you lower it?** In principle 0.92 asks *"are these the same record?"* rather than *"do these
disagree?"*, so a lower floor should surface contradictions between records that are related but not
near-identical. In practice that was hard to reproduce: two deliberately-constructed contradicting pairs
still scored 0.9479 and 0.9259, because records sharing a subject embed close together even when their
descriptions diverge sharply. The default is therefore left at 0.92 — but if you see real contradictions
being missed in your data, this is the knob, and lowering it costs nothing on the structured pass.

**Why the model-pass defaults depend on where the judge runs.** The judge is an MNLI *encoder* — one
forward pass returning three labels, not a generative model — so it is not slow. What differs is that every
pair judged by a **remote** endpoint is record text leaving the instance, and that cost does not shrink with
a faster model or a bigger GPU. So a loopback sidecar gets the same wide floor as the free pass and no pair
cap, while a remote endpoint defaults to the strict floor plus a per-run budget. Override any of it.

> These defaults are **reasoned, not benchmarked** — no NLI sidecar ships with the stack, so there was
> nothing to time against. That is precisely why they are all configurable.

`POST /scan` reports **two** counts, because they answer different questions:

| Field | Means |
|-------|-------|
| `modelCalls` | Requests the NLI endpoint actually served. This is what a remote judge bills you for and what its own request log shows — and it is what `maxJudgedPairsPerRun` bounds. |
| `judgedPairs` | Unique pairs the judge answered *usefully* for. What the sweep **settled**. |

They legitimately differ: a below-threshold answer costs a call and settles nothing, and an unreachable judge
still received the record text. Compare your endpoint's counter against `modelCalls`, not `judgedPairs`.

> **If you measured a 2× gap against your judge's counter on an earlier release, it was real** — and it was
> not only a counting difference. Two mechanisms each doubled the calls. The deterministic pass tried to avoid
> spending the model by demanding an impossible confidence, but a confidence floor is applied to the
> *response*: the request went out, your text egressed, the endpoint billed it, and only then was the answer
> discarded. And a mutually-similar pair was judged from both sides as the sweep walked the space, with the
> second judgement only overwriting the first row. Both are fixed: the deterministic pass now reaches no
> endpoint at all, and a pair is judged once per sweep. Expect a sweep of the same space to cost
> substantially less than it used to.

Plus two *distinct* incomplete endings: `nliStalled` means the judge was unreachable and **nothing** was
settled (the cursor is parked), while `budgetExhausted` means the pairs it judged **are** settled and the next
run continues from there. Neither should be read as a clean result.

Until it is enabled, contradictions are found **only** when somebody runs `POST /api/contradictions/scan`
by hand — so the Review tab's Contradictions view stays empty on an instance nobody has scanned manually.
An invalid cron expression is refused at boot with a warning rather than silently ignored, and a scheduled
run that parks because the judge was unreachable logs that it did **not** clear the queue.

**Retention.** A background prune (every 6 hours, always on, no configuration) removes review findings that
can never resurface: those whose records have been deleted, and duplicate pairs resolved by **merge** — the
absorbed record is gone, so the pair cannot be detected again. Everything else is kept indefinitely, on
purpose: deleting a **dismissed** finding would forget the dismissal and let the next sweep re-flag the same
pair, and deleting a resolution whose records still exist invites the same. Findings are small; re-asking a
settled question is expensive.

**What the sweep covers.** Facts, entities and **chrono** entries. For a chrono pair the structured pass
compares the stored `status` as well as `properties` — the dates are deliberately not compared, for the
reason given under [Duplicate Detection on Insert](#what-counts-as-a-claim). Edges are excluded until edge
labels can declare which relations are single-valued (without that, `knows` / `mentions` / `related-to` all
read as conflicts), and file *records* are excluded permanently.

> **Cost note:** the initial full scan of a large existing space is O(N) vector searches — inherently the expensive part. It is bounded per run (`maxPerRun`) and runs off-hours; steady-state runs only touch new or edited records. Keep `notify` rules and automation idempotent, since an edited record re-fires its pair's action.

### Duplicate Detection on Insert

The `save_fact`, `save_entity` and `save_chrono` tools run a **semantic near-duplicate check** before storing, using the same embedding the new record is stored with — so it costs a vector search, not a re-embed. When a highly similar record already exists, the tool's response flags it (id, a short summary, and the cosine score) so an agent can update or merge the existing record instead of accumulating redundant ones:

```text
Stored fact (seq 1284, ID 7f3c…).
⚠️ Possible duplicate — 1 existing fact is highly similar: "The Vault service stores secrets and rotates auth tokens" (ID 9a1b…, 0.97). This fact was still stored; pass checkDuplicates:false to skip this check, or update the existing one instead.
```

#### It sees the batch you are writing

The check reads **two** places, and the second one matters if your agent writes several related records in
one turn. The vector index is eventually consistent — a record committed a second ago is not in it yet — so
a check that read only the index could never warn you about a sibling from the same batch. Every duplicate
warning named an older record, and none ever named the one you had just written, which is precisely when
duplicates get created.

So the check also scores the space's **most recently written records straight from the collection**. Two
bounds keep that off your latency budget, both settable if your write rate needs different ones:

| variable | default | what it bounds |
|---|---|---|
| `DUPE_FRESH_WINDOW_MS` | `180000` | how far back it reads. `0` disables this half — index only, the pre-2.5 behaviour |
| `DUPE_FRESH_SCAN_CAP` | `200` | the most records one check scores this way, whatever the window says |

The cost is proportional to how much the space is actually churning, not to how large it is: measured on
20,000 records at 768 dimensions, **~9 ms** when nothing was written recently and **~52 ms** when the window
is full. A space sustaining more writes than the cap covers logs a warning naming the cap, so a truncated
scan never quietly reads as a complete one.

#### Contradiction warning on insert

`checkContradictions` (default **off**) asks a different question of the same neighbours: not *"is this
redundant?"* but *"does this conflict with what we already believe?"*. When a near-neighbour sets the same
single-valued property to a different value, the response names the property and **both** values:

```text
Stored fact (seq 1290, ID 4c2e…).
⚠️ Contradiction — 1 existing fact disagrees with this one: "Vault runs in the eu-west cluster" (ID 9a1b…: region eu-west vs us-east). This fact was still stored. If you are correcting an outdated fact, update or supersede the record above instead of leaving both.
```

Three deliberate limits:

- **It is its own flag**, not a rider on `checkDuplicates` — a caller may well want the conflict check
  without the redundancy check. One neighbour search serves both when both are on.
- **Deterministic only.** The entailment (NLI) judge is a model call *per pair*; on the write path that
  would add latency to every insert and, with an external endpoint, send record text off the instance on
  every insert. The nightly scanner runs the NLI pass over the same pairs, so nothing is lost — this is a
  fast-path courtesy, not the safety net.
- **It never blocks the write.** An agent correcting an outdated fact *should* be able to contradict the
  record it supersedes; the point is to tell it, not to stop it.

Available on `save_fact`, `save_entity` and `save_chrono`. **Not** on edges or files: edge writes are the
bulk path (imports, peer sync, subgraph building) where a per-insert vector search would be felt most, and a
file record "disagreeing" with another is not a meaningful claim.

#### What counts as a claim

The check compares **single-valued claims**. For facts and entities those are the entries in
`properties`. A **chrono** entry additionally claims its **`status`** — one entry saying an event
`completed` and a near-identical one saying it was `cancelled` is a genuine conflict, and because status is
part of a chrono entry's embedded text, a pair similar enough to be flagged *while disagreeing about it* is
near-certainly the same event logged twice.

A chrono entry's **`startsAt`/`endsAt` are deliberately excluded.** The dates are not embedded, so two
hand-logged occurrences of a repeating event ("Team sync", every Monday) reach ~1.0 similarity with
different dates *every time*. Reporting those would fill the review queue with the one thing that is
certainly not a contradiction — and a pair that similar is already reported by the duplicate scanner, so it
would also be the same two records named twice under two different headings.

- **The write always succeeds** — the check is advisory, never blocking. It also never fails an insert: if vector search is unavailable or the space needs reindexing, the check is silently skipped.
- **Default on** for all three tools. Pass `checkDuplicates: false` to skip it, or `dupeThreshold` (0–1, default ~0.92) to tune sensitivity — lower flags looser matches.
- For `save_entity` the check fires only on a **new insert** (no `id`, or an `id` that does not yet exist), not on updates.
- Because `$vectorSearch` has indexing latency, a record inserted moments earlier may not yet be visible to the check — duplicates are detected against the already-indexed corpus.
- Not applied by `save_bulk` (it would add a search per item); use single-item `save_fact`/`save_entity` when you want duplicate feedback.

---

## Webhooks API

Base path: `/api/admin/webhooks` — **requires an admin token on all endpoints** (`requireAdminMfa`), including the read-only `GET`s (`/`, `/:id`, `/:id/deliveries`). When MFA is enabled, every request must also carry an `X-TOTP-Code: <code>` header, or it returns `403 MFA_REQUIRED`.

Webhooks allow external systems to receive real-time HTTP POST notifications when write events occur on Ythril spaces. This replaces the need to poll for changes.

> **Delivery & SSRF:** target URLs must be `https://` and are SSRF-validated at creation. At delivery the target is re-resolved, the connection is **pinned to the validated IP** (so a DNS rebind cannot redirect it to an internal host), and redirects are followed manually with each hop re-validated. The redirect-follow cap defaults to 3 and is configurable via `webhookMaxRedirects` in `config.json` (or the `WEBHOOK_MAX_REDIRECTS` env var), clamped to `[0, 20]`.

### Event Types

| Event | Fired when |
|-------|-----------|
| `fact.created` | A new fact is stored |
| `fact.updated` | An existing fact is updated |
| `fact.deleted` | A fact is deleted |
| `entity.created` | A new entity is created |
| `entity.updated` | An existing entity is updated (including upsert of existing) |
| `entity.deleted` | An entity is deleted |
| `entity.merged` | Two entities are merged (the survivor keeps its id). Payload `entry` = `{ survivor: {record}, absorbedId }` |
| `edge.created` | A new edge is created |
| `edge.updated` | An existing edge is updated |
| `edge.deleted` | An edge is deleted |
| `link_violation.created` | A strict-linkage reference violation is recorded |
| `chrono.created` | A new chrono entry is created |
| `chrono.updated` | A chrono entry is updated |
| `chrono.deleted` | A chrono entry is deleted |
| `file.created` | A file is written (new or overwrite) by a person or a token on this instance. **A file a peer delivers — its bytes pushed to this instance's upload door, or pulled by the sync engine — fires nothing** (it used to fire for a push, with the peer's token as the actor) |
| `file.updated` | A file is moved/renamed |
| `file.deleted` | A file is deleted |
| `bulk.write` | A bulk write completed (`POST /bulk` or MCP `save_bulk`). Per-item events are **not** fired for bulk; this one summary carries `entry` = `{ inserted, updated, connections, errorCount }` for a workflow to inspect. It fires whenever the call wrote anything — a batch that only converged on existing records (`updated`) or only attached connections counts. |
| `duplicate.detected` | The duplicate scanner found a near-duplicate pair under a `notify` rule (see [Duplicate Scanner](#duplicate-scanner--action-rules)). Payload `entry` = `{ type, score, a: {record}, b: {record} }` |
| `change_note.received` | A change note arrived from the instance above this one in a network (see [Sync API → A sync can carry a change note](09-sync-api.md#a-sync-can-carry-a-change-note)). Fired once per space the note concerns, or per space the network carries here for a note about the whole network. Payload `entry` = `{ id, networkId, networkLabel, from, author, generated, note, spaces }` |
| `test.ping` | Synthetic test event sent via the test endpoint |

> Events fire for **both** REST API and MCP (agent) writes — emission lives in the shared
> brain/file functions, so an agent creating a fact or entity delivers the same events a REST
> client would. Internal writes (sync replication, file bytes included, and space import) do not emit, and the
> same rule decides the live-view stream: a write no user made emits neither a webhook nor a stream event.

### Create Subscription

```http
POST /api/admin/webhooks
Authorization: Bearer <admin-token>
Content-Type: application/json
```

```json
{
  "url": "https://n8n.example.com/webhook/ythril-events",
  "secret": "whsec_your_shared_secret",
  "spaces": ["dev-lessons", "dev-infrastructure"],
  "events": ["fact.created", "entity.created"],
  "enabled": true
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `url` | ✅ | HTTPS endpoint to receive POST requests |
| `secret` | ✅ | Shared secret for HMAC-SHA256 signature (min 8 chars) |
| `spaces` | — | Space ID filter; omit or empty = all spaces |
| `events` | — | Event type filter; omit or empty = all events |
| `enabled` | — | Default `true`; set `false` to pause without deleting |

**Response** `201`:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "url": "https://n8n.example.com/webhook/ythril-events",
  "spaces": ["dev-lessons", "dev-infrastructure"],
  "events": ["fact.created", "entity.created"],
  "enabled": true,
  "status": "active",
  "consecutiveFailures": 0,
  "createdAt": "2026-04-11T14:30:00.000Z",
  "updatedAt": "2026-04-11T14:30:00.000Z"
}
```

> **Security:** The `secret` is stored server-side for HMAC signing but is **never returned** in any GET response after creation.

### List Subscriptions

```http
GET /api/admin/webhooks
Authorization: Bearer <admin-token>
```

**Response** `200`:

```json
{
  "webhooks": [
    {
      "id": "...",
      "url": "https://...",
      "spaces": [],
      "events": [],
      "enabled": true,
      "status": "active",
      "consecutiveFailures": 0,
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

### Get Subscription

```http
GET /api/admin/webhooks/:id
Authorization: Bearer <admin-token>
```

### Update Subscription

```http
PATCH /api/admin/webhooks/:id
Authorization: Bearer <admin-token>
Content-Type: application/json
```

```json
{
  "url": "https://new-endpoint.example.com/hook",
  "enabled": false
}
```

All fields are optional. Only provided fields are updated.

### Delete Subscription

```http
DELETE /api/admin/webhooks/:id
Authorization: Bearer <admin-token>
```

**Response** `204` — subscription and delivery logs removed.

### Test Delivery

```http
POST /api/admin/webhooks/:id/test
Authorization: Bearer <admin-token>
```

Sends a synthetic `test.ping` event to the subscription's URL. Useful for verifying connectivity.

### Delivery Log

```http
GET /api/admin/webhooks/:id/deliveries
Authorization: Bearer <admin-token>
```

Returns the last 100 deliveries for the subscription:

```json
{
  "deliveries": [
    {
      "id": "...",
      "webhookId": "...",
      "event": "fact.created",
      "spaceId": "general",
      "timestamp": "2026-04-11T14:30:00.000Z",
      "responseStatus": 200,
      "latencyMs": 142,
      "success": true
    }
  ]
}
```

### Event Payload

When an event fires, Ythril sends an HTTP POST to the webhook URL:

```http
POST https://your-endpoint.example.com/hook
Content-Type: application/json
X-Ythril-Signature: sha256=<HMAC-SHA256 hex digest>
X-Ythril-Event: entity.created
X-Ythril-Delivery: <unique delivery UUID>
```

```json
{
  "event": "entity.created",
  "timestamp": "2026-04-11T14:30:00.000Z",
  "spaceId": "dev-infrastructure",
  "spaceName": "Dev Infrastructure",
  "entry": {
    "_id": "...",
    "name": "cilium",
    "type": "infra-component"
  },
  "tokenId": "...",
  "tokenLabel": "mcp-bridge"
}
```

- `entry` contains the full document for created/updated events (excluding embeddings), just `{ _id }` for deleted events.
- `tokenId` + `tokenLabel` identify which token performed the write.

### Signature Verification

Verify the `X-Ythril-Signature` header using your shared secret. **Compare in constant time** — a
`===` on an HMAC leaks the digest a byte at a time to anyone who can measure your response latency, and the
thing it leaks is derived from your secret:

```js
const crypto = require('crypto');

function verify(rawBody, headerValue, secret) {
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(headerValue ?? '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on a length mismatch, so check length first — and note that doing so leaks only
  // the LENGTH, which is fixed and public for a sha256 hex digest.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

**Sign over the RAW body**, before any JSON parsing. A re-serialised body will not match — key order and
whitespace are not preserved by a parse/stringify round trip.

### Delivery Guarantees

- **At-least-once delivery.** On HTTP 2xx the delivery is marked successful. On timeout (10 s) or non-2xx, Ythril retries with exponential backoff: 10 s → 30 s → 1 m → 5 m → 30 m → 1 h.
- **So you WILL receive the same event more than once, and you must deduplicate on `X-Ythril-Delivery`.**
  That header is a unique id per delivery attempt-chain, and it is the same across every retry of one event —
  which is what makes it usable as an idempotency key. At-least-once without a dedupe key would mean duplicate
  records in your data on any transient failure of your own endpoint, including one you never noticed.
- **The signature covers the body only, not a timestamp**, so a delivery captured off the wire stays valid
  indefinitely. Deduplicating on the delivery id is what bounds that: a replay of an id you have already
  processed is a no-op. If you need a hard time bound as well, reject deliveries whose `X-Ythril-Delivery`
  you have not seen **and** whose payload timestamp is older than your own tolerance.
- After all retries are exhausted, the subscription status changes to `failing`.
- Re-enabling a failing subscription (`PATCH` with `enabled: true`) resets the failure counter.

---
