# Changelog

All notable changes to Ythril are documented here. This file covers the **current major series**;
earlier majors are archived under [`changelog/`](changelog/) and linked at the bottom.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **An agent can mint an invite key and fork a network over MCP** (`F-36`, slice 3). `network_invite` and
  `network_fork` are the same acts as `POST /api/networks/:id/invite` and `/fork` — same parameters, answers and
  refusals on both doors.

- **A passed space-settings vote reaches every member** (`F-39.4`). On a club the organiser's own yes passed a
  meta change before any member could see the round, and a member that joined later never saw it either, so the
  change stayed on the instance that proposed it. The passed round is now served to peers, each member re-decides it
  from the casts, and applies it as that network's definition — beside its own, never over it.

- **See and settle a schema clash between networks** (`F-39.3`). A space in several schema-sending networks
  shows, on its Schema tab, each network's layer in the order it applies and every clash between them, with the
  network that currently applies marked; the order can be changed there. `GET /api/spaces/:id/schema-layers` and
  `PUT /api/spaces/:id/network-precedence`, and MCP `space_schema_layers` / `space_set_network_precedence`, with the
  same parameters and answers.

- **An agent can see and cast network votes over MCP** (`F-36`, slice 2). `network_votes`, `network_vote` and
  `network_sync_history` are the same acts as the votes and sync-history routes — same parameters, answers and
  refusals, instance-admin on both doors. A vote is how a networked space approves a destructive act, and until now
  an agent could be a member of a governance process it could not take part in.

- **A space in two networks keeps each network's schema apart** (`F-39.2`). What each network sends is kept as
  its own layer beside this instance's own definitions, and the space runs on own ⊕ layers in precedence: the network
  joined first wins where two define the same property differently, and both keep syncing their records. Each
  network is sent only this instance's own definitions plus its own layer, never the other network's, and an
  operator's schema edits land in the own definitions so they survive the next layer. Seeing clashes and reordering
  come next (`F-39.3`).

- **A space can be added to a club, closed or democratic network too** (`F-38.4`). There it is a `space_addition`
  vote: a club organiser's own yes carries it at once, a closed network needs every member, a democratic one a
  majority with no veto. Same route, tool and picker as the pub/sub and braintree case; a vote answers `202`. Each
  member applies the passed round itself, and a member that already has a local space of that name keeps it out of
  the network unless it voted yes, because those networks sync both ways and joining it would send its records to
  everyone.

- **A space's schema flows down its network with the records** (`F-39.1`). On a pub/sub network or a tree, each
  instance now takes a shared space's type schemas, purpose, usage notes and the rest of its governed meta from the
  instance above it every cycle (`GET /api/sync/meta`), so a space created by a join is no longer bare. The merge only
  adds: new types are added, a type both sides hold keeps its local properties and gains the network's, and an exact
  type-and-property match takes the network's definition. Nothing local is removed, nothing flows up, operational
  settings stay local, and a schema that cannot be merged is skipped without stopping the records.

- **A space can be added to an existing network** (`F-38.3`). Until now a network carried the spaces it was created
  with and nothing more. The publisher of a pub/sub network, or the root of a tree, now adds one from the network card,
  `POST /api/networks/:id/spaces` or MCP `network_add_space` — same parameters, rights and refusals on all three. The
  members' tokens reach the new space at once, and each instance below adopts it on its next sync from its upstream
  only (a subscriber from its publisher, a node from its parent): created if missing, merged into if present, nothing
  overwritten or deleted. Club, closed and democratic networks decide it by vote (`F-38.4`, below). Audited as
  `network.space.add`.

- **Joining a network lets you choose where each of its spaces goes** (`F-38.2`). The join dialog lists every space
  the invite carries, not only the ones whose name collides with a local space, and each can go under the same name,
  into any space you already have, or under a new name. The dialog says, beside the choice, that joining only adds:
  nothing local is overwritten or deleted.

- **Each network says what this instance is in it** (`F-38.1`). The Networks page shows a role — Publisher or
  Subscriber, Organiser or Member, Root, Node or Leaf — instead of a flat member count, and lists the members that
  role acts on: a publisher's subscribers, a subscriber's publisher, a club's or voted network's peers, and in a tree
  the path to the root and the subtree below. It also lists the spaces the network carries. `GET /api/networks/:id`,
  the list, and MCP `network_get` carry the same `myRole`. A club created from now on remembers its organiser; one
  stored before reads as Member.

- **A network can be read, created, updated and left over MCP** (`F-36`, first slice): `network_get`,
  `network_create`, `network_update` and `network_leave`. Each is the same act as its REST route — same parameters,
  the same rights (the Networks column, or administering every space), the same refusal sentence and the same body
  — so an agent is no longer limited to listing peers and triggering a sync. Joining, invites, members, votes,
  topology and sync history stay REST-only for now and are listed as such.

- **A space admin creates, joins and invites into networks with the spaces it administers** (`F-37`). A token
  administering every space an act touches may create a network carrying them, join a network mapped onto them —
  onto a new space too, when it may also create spaces — see that network, and generate its invite, with no
  Networks column. A space it does not administer still needs the column and is named in the refusal; a network
  carrying one stays invisible to it. Peers, votes, topology and sync are unchanged and instance-admin.

- **Joining a remote network goes by the Networks column too** (`F-34.1`, `POST /api/networks/join-remote`). A
  token below instance admin may join with `networks: write` on every local space the join maps to; a space the
  join would create also needs `createSpaces` and a floor of `write`. The check runs after the handshake's apply
  and before finalize — the only point the space list is known and nothing is written — so a refused join leaves
  nothing behind, and the membership is recorded as the joining token's for the leave rule.
- **Token rights gain a Networks column** (`F-34`). A token below instance admin can now act on networks through
  the `networks` rung it holds on the spaces a network carries — on EVERY one of them: `read` sees a network
  (`GET /api/networks`, `GET /api/networks/:id`, MCP `network_peers`; one it may not see is a 404), `write` creates
  one with the space and leaves a membership it established, `admin` changes a network's settings and leaves
  anyone's. A membership with no recorded establisher needs `admin` to leave. Joining a remote network, invites,
  peers, topology, votes and sync stay instance-admin. Existing tokens hold `networks: none`; a matrix body may
  omit `networks` and gets `none`, so a client written before the column keeps minting. Space admin does not
  include it — sharing a space with another instance is its own decision.
- **An `ingest` run reports its provenance** — `ids` (each key of the extraction → the record id it has now)
  and `sourceTurns` (record id → the turns it came from), on `GET …/ingest/:runId` and `ingest_status`.
  Reported, never stored: a turn id in a record would be noise in its vector, so the run is the one place a
  caller can join a record back to the conversation.
- **`ingest`: a conversation in, records out** (`F-31`; `POST /api/brain/spaces/:spaceId/ingest` and
  `GET …/ingest/:runId`, MCP `ingest` and `ingest_status`). A raw conversation (`sessions`) runs every phase of
  the conversation extractor; an extraction already made (`extraction`) is validated and written with no model.
  It answers `202` with a run id at once and the run is read back: phase, counts written, claims dropped and
  why, turns no claim covers, which backends answered. Refused with `409` BEFORE any model is paid for when the
  space lacks the `conversation` group or, for a raw conversation, a decision model, the assist model or the
  `doc-nlp` sidecar — each refusal names what to change. Every record goes through the batch door's rules;
  transcripts are files, so they are written only for a token that also holds `files: write`. Runs are held in
  memory. See the integration guide's Ingest page.
- **The Schema Library ships the `conversation` group** — the types the extractor writes — seeded into every
  instance at start, first run included. Seeding adds a missing entry by name and never replaces one, so an
  operator's edit is kept. Apply it to a space with **Apply group to space**.
- **A batch answers with the ids its keys were given** (`refs` on `POST /bulk` and `save_bulk`). An item's
  `$ref` key was resolved inside the call and thrown away, so a caller that needed the new ids read the
  space back by text. The response now carries `{ "post-1": { id, kind } }`, one row per key whose item
  was written; a refused item's key is absent.
- **An NLP sidecar for the conversation extractor** (`F-31`, `sidecars/doc-nlp`). It is bundled like the
  other models, and `DOC_NLP_REPLICAS=0` leaves it out. It returns spaCy's named entities and noun phrases, which the
  extractor proposes as candidate mentions (step 4.1). The decision model then judges them, so casing and
  misspellings are its to handle, not a rule's.
  - **Why spaCy's transformer model:** measured on the ten committed LoCoMo extractions, it proposes 96% of
    the entities whose name the conversation says. That is ahead of spaCy's large model (92%), wink-nlp
    (87%), hand-written rules (88%) and GLiNER (87%), at about 30 ms a turn over HTTP.
  - **Hardening and wiring:** it is hardened like `doc-render` (non-root, read-only, internal network, no
    egress) and never downloads at runtime. The server reaches it through `NLP_SIDECAR_URL`.

- **A decision model for the extractors, configurable on Settings → Models** (`F-31`). The conversation
  extractor asks a model only its judgement questions (*who is "she"*, *is this turn pasted*), and this is
  the model it asks. It defaults to TypeSafe's System One (`https://api.typesafe.ai`, `jev-latest`) and
  follows that API's contract, so choices come back with their full probability distribution. Set it in
  config (`decisionModel`), through `PATCH /api/admin/media-config`, or with `DECISION_URL` /
  `DECISION_MODEL` / `DECISION_API_KEY`. The key lives in `secrets.json`. **Nothing is sent until the operator
  acknowledges the host**, and that is checked when the call is made as well as on save. Without consent,
  the same questions go to the assist model, constrained to the listed options. With neither, extraction
  is refused up front instead of guessed. Code checks every answer before anything reads it: a choice
  outside its options, or a missing answer, is marked `invalid`. A question that offers no no-match option
  is refused before it is sent. It has its own call budget (`modelSlots.decision`) and private-address
  switch (`YTHRIL_ALLOW_PRIVATE_DECISION`), and appears in the egress matrix.
- **`graph_traverse` returns the records it reached, not only their names** (`F-32`). A new `projection`
  parameter on both doors (MCP `graph_traverse` and `POST /spaces/:spaceId/traverse`) takes the same
  grammar as `query` and `recall` and is applied to every node and every stored edge. With it, one call
  reads a whole subgraph with its content. Without it, reading one flow from a space took a walk plus a
  `query` per collection over the ids the walk returned.
  - Omitted, the answer is the lean one, unchanged.
  - The walk's envelope always survives: `_id`, `depth` and `kind` on a node; `_id`, `from`, `to` and `label`
    on an edge.
  - The vector never comes back, and the diagnostics only with the new `includeDiagnostics`.
  - An edge's `properties` come with it, so a conditional edge's instruction and predicate arrive in the
    same answer.

  The owner, shown the three-call recipe, asked *"is that not just an includes flag?"* — and `recall`'s own
  traverse has taken a projection for a long time.

- **The benchmark schema is fingerprinted beside the prompt, and a pet can like a place** (`Q-27`). The
  schema is an input every extractor reads, exactly as the prompt is, and it went unrecorded — so a
  vocabulary change landing mid-round would leave half a corpus written against one schema and half against
  another, with nothing in any file to say so. Every extraction now carries `schemaSha256` beside
  `promptSha256`; `check` refuses a file without it, `merge` stamps it from the tree, `status` counts a file
  done only under both, and `stats` warns on a two-schema corpus.

  **The ten committed extractions are stamped with the schema of the commit that produced them**, which
  neither the schema nor any of the ten has moved from since. Then `likes` widened to run from an `animal`
  as well as a `person`: `conv-44`'s extractor drew one from a dog to a dog park and the merge refused it.
  Landed between rounds and after the stamp, so the corpus records the vocabulary it was written against.

- **One graded benchmark run: every question, both arms, every seed, one report** (`B-6`). The retrieve, arm
  and grade steps each held one rule; `benchmarks/harness/run.mjs` holds the ones that only exist once they
  are joined, and each of them produces a plausible number when dropped. The judge's independence is checked
  before anything is called. Retrieval runs once per question, not once per seed. The answerer is handed
  the question, the context and the seed, and nothing that names which arm it is in. A failed step leaves a
  seed UNSCORED rather than low, and the published figure carries its min and max across seeds.

  **The grade step ships with it, and had never been committed.** `grade.mjs` and its test were written for
  the previous `B-6` increment and existed in one working tree only. The answerer and the judge are handed
  in, so all of this runs against fakes today; with the two provider keys it is configuration, not a build.

- **A graded run that needs no provider key, and survives a rate limit** (`B-6`). `benchmarks/tier0.mjs`
  runs the whole round as files: one input and one answer file per conversation per arm, one batch file
  per judge upload, every write atomic, and `status` read off the disk. So a run stopped at any point
  resumes from what is already there. An answer file counts as done only for the input it was made
  from, so a changed input cannot be graded against a stale answer. Every answer gets LoCoMo's token F1
  with no model. A balanced 200-question sample goes to an external judge blind to the arm, and a
  truncated reply leaves the rest ungraded rather than wrong. What the answerer is handed is checked to
  carry no reference answer, adversarial answer or evidence.

  **The first round is recorded, and its method is disclosed with it.** One answerer answered both arms
  of all ten conversations, memory arm first and each arm independently of the other, so a baseline
  answer never saw the retrieved hits and a memory answer never saw the transcript. On F1 over 1,540
  scored questions the memory arm reads 62.7 against the baseline's 67.5. The baseline is the whole
  transcript in context, which is the ceiling and not a competitor. **Judged by a GPT model from a
  different vendor on a blind, balanced 200-question sample: memory 82.5% against the baseline's 84.5%,
  a gap of −2.0 with a 95% interval of −6.2 to +2.2**, from about 2% of the text per question. With the
  judge in place the graded runner shipped: retrieve, both arms, a different-family judge and the baseline
  column. Method and caveats are in `benchmarks/README.md` → Results.

### Changed

- **The compose install caps the app and the database's memory** (`Q-46`). `ythril` and `ythril-mongo` had no
  ceiling while every sidecar did, so on a shared host MongoDB sized its cache from the whole machine and the
  app grew without bound. Both now default to 4 GB (`YTHRIL_MEM_LIMIT`, `YTHRIL_MONGO_MEM_LIMIT`), and MongoDB
  sizes its cache from the ceiling. An existing install picks the limit up on the next `docker compose up`;
  raise it in `.env` for very large spaces or ingests. Kubernetes deployments keep setting their own pod limits.

- **The benchmark writes its corpus through `ingest`** (`F-31`). `benchmarks/writer/write-space.mjs` validates
  an extraction, creates the space and hands the extraction to the product's door, so the space a benchmark
  scores is written exactly as a user's conversation is — by one writer. Three things the old writer never
  did now happen, so **a score measured after this is not comparable blind to one before it**: an entity's
  description is written, a chrono entry links the claims that dated it, and transcripts live under
  `transcripts/<conversationId>/`.
- **The External assist model is consented to per use** (`F-35`). It does two jobs that send different things —
  the document repair pass, and conversation work for `ingest` (writing claims, and answering the extractor's
  questions when no decision model is set). Consent was one host acknowledgement, given under a dialog that
  named document content alone, and both jobs read it. `acknowledgedHost` now means documents only, so no
  consent given before grows; conversations have their own `acknowledgedHostForConversations`, set by the card's
  **Allow conversations** in a dialog that names what they send. **An instance that ingested raw conversations
  through the assist model must allow conversations once** — until then ingest refuses and says so.
- **The user guide's media, model and embedding settings are their own chapter**
  (`docs/userguide/04a-media-and-embedding.md`). The settings chapter had reached the 900-line limit, and
  the Models tab is a topic of its own. Every anchor is unchanged, so the in-app help links still land.

- **The README describes Ythril as a knowledge management system, and its quickstart works on 5.x.**
  It pitched a memory for one assistant, and a rename had left it saying *"give your AI a fact"* and *"the
  fact layer"*. The quickstart pointed MCP clients at `/mcp/general`, a 4.x per-space address that 5.0
  replaced with the single `/mcp`, and it named two tools, `find_similar` and `er_model`, that 5.x does
  not register. It now leads with what the product holds (semantic search, the graph, the timeline,
  files, sync, one API over MCP and REST), shows the REST door beside the MCP one, and publishes the
  LoCoMo result with its method. The gate holding the README's lookup claim matched the retired
  `find_similar` name, so it kept passing on a stale sentence. It now matches the blind-spots claim, and
  the tool names are checked against the registry.

### Fixed

- **An unchanged network schema no longer rewrites the config every sync cycle** (`F-39.2` follow-up). Storing what
  an upstream sent, and rebuilding the space's schema from it, saved the whole config file for every space on every
  cycle even when nothing had changed. An identical layer is now nothing to do, and a rebuild writes only when
  something it holds changed.

- **A networked space's schema is changed by the network's vote on every door** (`Q-52`). `PATCH` and MCP
  `schema_update` turned a schema edit on a networked space into a vote; `PUT /schema`, the single-type upsert and
  delete, and the schema library's apply wrote it at once. They now open the same `meta_change` round and answer
  `202 vote_pending`. A space in no network is unchanged.
  **For an integrator:** a script that writes a networked space's schema through those routes now gets `202`
  rather than `200`, and the schema changes only when the round passes.

- **An edit made through MCP is audited with what it changed** (`Q-50`). The REST door recorded each edit's
  before and after as the audit entry's `changes`; the same edit through an MCP tool left the operation alone, and
  no record id. Ten tools now record both — the record edits, the entity merge, the network settings and space
  additions, and the space and schema updates — and a gate derives the set from the routes that record changes, so a
  new pair cannot miss it.

- **A space mapped under another name at join answers its peers** (`Q-51`). When a join maps a network's space onto
  a local space of a different name, this instance translated the name on its own requests but not on its peers':
  they asked for the network's name and were refused with `403`, so every sync cycle a peer ran for that space
  failed, while this instance's own cycle still moved the data. Incoming sync requests are now translated before
  anything admits or reads by them.

- **A network member's link direction and address were never shown on the Networks page.** Each member row read two
  field names the server does not send, so every member was labelled `both` — a publisher's subscriber included —
  and no address appeared. The rows now show the real direction and the peer's URL.

- **A stored rights matrix missing an area read as reaching the space** (`reachesSpace`). The check compared each
  area's rung to `none`, and a missing area is `undefined`, which is not `none` — so a matrix without an area
  reached every space it had a row or floor for. Latent until an area was added; a missing area is now `none`.
- **A document pasted into an ingested conversation could be mined into claims** (`F-31`, 2.5). The claim
  writer now sees a pasted turn marked as material the speaker brought, as a bounded preview, under a rule to
  say what was shared and asked — never to state its contents as facts. A pasted document also no longer sets
  the size of the writer's prompt.
- **An ingested conversation with an assistant in it filed the assistant's facts as the person's** (`F-31`,
  5.4 / 5.5). A claim took the speaker of its exchange's first turn, so a restaurant or a dosage an assistant
  supplied became something the person said — and a speaker named `assistant` failed the whole ingest at
  validation. Where an assistant speaks, the extractor now asks who originated the fact: only the assistant
  as origin is its claim, marked `attributed` and stored unranked; restating, unclear or a refused answer is the
  person's. An assistant's fact the conversation did nothing with is dropped and reported.
- **A batch item dropped `superseded` and `suppressEmbeddings`** (`POST /bulk`, `save_bulk`), on all four
  record kinds and both doors. The guide says an item takes the same fields as its single-record endpoint,
  and every single create takes both; the batch answered 207 and stored the record without them. Both are
  now read by one shared parser that iterates the declared flags (`parseRecordFlags`), so a non-boolean
  refuses the item and a future flag reaches the batch door by being declared.
- **A REST upload whose metadata write failed answered 2xx** (`files/store-file.ts`). The single-request
  upload swallowed that failure and reported the file as written, so the bytes sat on disk with no record
  behind them and nothing said so. It now fails the request, the same as MCP `write_file` always did.
- **MCP clients were told to call tools that no longer exist** (Q-45). The server instructions, the first
  text a connecting agent reads, named `list_chrono`, `find_similar`, `list_peers` and `sync_now`. `help()`
  named `find_entities_by_name`, `get_space_meta` and a `query` tool. All of these were renamed or folded
  away. The instructions' space sentence is now derived from the tools' own schemas.
  `mcp-text-names-only-real-tools.test.js` fails on any snake_case word in the help, the instructions or a
  tool description that is neither a tool nor a parameter. `retry_embed_record` pointed files at a
  nonexistent `retry_embedding` (it is `retry_embed_file`), and a schema refusal said `get_space_meta`.
- **The entity-delete refusal contradicted itself** (Q-45). The 409 said *"there is no cascade delete for an
  entity"* while the same body described the cascade. It now says the cascade removes the blocking edges.

- **A recall across several spaces reranks once, over all of them** (`P-35`). Reported by the platform
  operator, 2026-09-23T1842Z: one recall naming no space, on an instance reaching 15 spaces, put 13
  concurrent requests on the reranker. Ten of them died under the shared deadline, so the answer came back
  `degraded: ["rerank_unavailable"]` with 2 of 10 rows reranked. Each per-space `recall` ran its own
  cross-encoder pass, the same fan-out the query embedding had until it was embedded once. The spaces now
  hand back their candidate pools, and the merged pool is scored in one request of at most 100 passages, so
  the scores in one answer also come from one call. Single-space recall is unchanged.

- **The benchmark harness reaches a 5.x instance** (`B-6`). Three 4.x addresses stopped it the first
  time it ran against 5.1. The writer sent `entityIds`/`memoryIds`, which 5.0 refuses by name, so every
  conversation stopped at its first chrono entry. The client called `recall` and `query` at their 4.x
  per-space addresses, both removed in 5.0. And retrieval flattened recall's results but not the
  `_graph` each one carries, so a run recorded `traverse: 1` and handed the answerer nothing the
  traversal reached. The dropped half was the multi-hop half of the graph.

- **The 5.0.0 breaking table names the retired routes with their methods, and says to reconnect MCP clients.**
  Reported by the canary operator, 2026-09-23T0850Z and 0840Z. It said *"the five per-collection list routes
  are gone"* — ten `GET` routes went, and an audit that matched on PATH cleared `GET .../files` because
  `PATCH .../files` still exists. The path survived, the method did not, and their documentation ingest
  went stale with one warning in a long log. The table now lists all ten with their verb. A client that
  stayed connected across the upgrade holds the old tool list and sees every call fail rather than the
  rename, so the table now says to reconnect.

### Internal

- **A merge its dates contradict can be seen as one** (`F-31`, 4.7). The entity judge now sees each turn's resolved
  dates beside every candidate's description, and the merge question says a card whose dates contradict them is
  not it — judged where both halves are visible, rather than guessed by a code rule.
- **The conversation extractor writes the ARC as well as the moments** (`F-31`, 5.8, `arcs.ts`). A subject with
  claims in three or more sessions gets one claim saying how it developed, written from those claims and checked
  like any claim — linted, refused by the evidence gate, citation-checked, one rewrite; the writer may answer NONE.
  It cites a few turns, never most of the conversation, and is added after change tracking so it cannot retire
  the moments it describes.
- **A state told in several sessions is written once** (`F-31`, 5.9, `repeats.ts`). A later telling of the same
  unchanged fact is folded into the first claim as its source turns, so one answer does not fill five ranked slots.
  Asked only across sessions and between claims sharing an entity; it runs before change tracking, so a change is
  never folded away, and a person's claim is never merged with an assistant's.
- **The conversation extractor dates an edge only when its text does** (`F-31`, 6.3, `edge-dates.ts`). `since`
  and `until` are asked per day-precise, non-approximate date of the edge's own claims, and written only on a
  confident yes; a date merely near the relationship dates nothing, and an end before its start writes neither.
- **The server build copies `src/**/*.json` into `dist/`** (`server/scripts/copy-src-assets.mjs`). `tsc` emits
  JavaScript only and the image ships `dist` only, so a data file under `src` did not exist at runtime; an empty
  copy fails the build.
- **The conversation extractor writes what it found** (`F-31`, phase 10, `extractor/conversation/write-extraction.ts`).
  The server port of the benchmark's `write-space.mjs`, over the batch door rather than the bare record
  writers, so an ingested record meets the same schema, linkage and flag rules as any other write. An
  entity the space already held is linked by id; the validator now accepts those keys and requires a UUID.
- **Every door writes a file through one sequence** (`files/store-file.ts`, `storeFile` / `recordStoredFile`):
  quota, bytes, metadata, the processing queue and the webhook. The REST upload (single and chunked) and MCP
  `write_file` each held a copy, and `ingest` was about to be the third. The hash-hand-over gate now asserts
  the sequence once and that no door writes metadata or dispatches on its own.
- **The extraction validator moved into the server** (`F-31`, 9.2, `extractor/validate-extraction.ts`). The
  benchmark's `writer/validate-extraction.mjs` now re-exports it, so the benchmark writer and the product's
  `ingest` refuse the same files for the same reasons, from one copy of the rules.

- **An evidence check refutes what code can prove, before any model is asked** (`evidence/evidence-check.ts`).
  - **What it refutes.** A text that names someone, states a number or states a date its evidence does not
    hold is refused, with the reason.
  - **What it never does.** It never passes a text: every term being present proves nothing about the relation
    between them. A negation mismatch is reported as a signal and decides nothing.
  - **Where it runs.** It is reusable. The extractor calls it in front of the citation check on claims and on
    entity descriptions, so those failures are rewritten without a model call.
  - The month and number words it shares with the time tagger now live in one list (`text/english.ts`).

- **The conversation extractor runs end to end** (`F-31`, `extract.ts`, `assemble.ts`). Phases 1–9 run in order,
  from a raw conversation to an extraction in the committed format. The benchmark's own validator accepts
  the output under test.
  - **Injected.** Every model and service is: the decision model, the writer, the NLP sidecar, the space's
    search.
  - **Returned.** Every judgement is kept with its raw answers, alongside the dropped claims and any
    uncovered turns.
  - **Existing entities.** Mentions merged into entities the space already holds go in `existingEntities`,
    so no Ythril id appears inside a record.

- **The conversation extractor describes each entity from its own claims** (`F-31`, 4.10,
  `describe-entities.ts`). Each description is written once, at the end, and the assist model is handed only
  the claims that name the entity. It is checked like a claim and gets one rewrite. If it still fails, the
  entity's first claim is used as the description, because the format requires every entity to have one.

- **The conversation extractor tracks change over time** (`F-31`, 7.1–7.6, `change.ts`). Each claim is compared
  with the few earlier claims that share an entity with it. The decision model is asked four things:
  - whether the situation was replaced, simply ended, or is unchanged;
  - whether the earlier claim was still true of its own period (a yes vetoes retiring it);
  - whether the two are incompatible tellings of the same fact;
  - how two numbers relate.

  Only a clear change supersedes, and a `supersedes` edge is drawn only when something replaced the earlier
  claim. Incompatible tellings and cumulative counts are both dated to their telling ("As of 9 June 2023, …").

- **The conversation extractor builds its timeline** (`F-31`, 8.1–8.4, `timeline.ts`). A claim with a resolved
  day is a candidate event, and the decision model is asked three things:
  - its status: completed, upcoming, cancelled, or unclear (`active` and `overdue` cannot be chosen);
  - whether it is merely ongoing;
  - whether it genuinely lasted more than a day, asked only when the conversation gave both ends.

  An unclear status, an ongoing thing, or no usable date means no timeline entry, and the date stays in the
  claim. A span needs both given ends and a confident multi-day answer.

- **The conversation extractor draws only legal edges** (`F-31`, 6.1 / 6.2, `relations.ts`). For each pair of
  entities one claim names, the decision model chooses among the labels whose declared endpoint types fit the
  pair, in the direction they fit, or `none`. Code filters the vocabulary before asking and checks the answer
  after, so an illegal edge is never written. The same edge from two claims is one edge citing both.

- **The conversation extractor writes one claim per exchange, and checks it** (`F-31`, 5.2 + 5.10,
  `write-claim.ts`).
  - **Writing.** The assist model is handed the exchange with its dates already resolved ("9 May 2023") and
    its entities already named, so it has nothing to work out itself. Turns about nothing are cited but never
    handed to it.
  - **Checking.** The claim is linted, then the decision model judges whether its own turns support it.
  - **Failures.** Either failure gets one rewrite with the reason attached; a second failure drops the claim
    and reports it. A refused check is not a pass.

- **The extractors write through the assist model, and wait out a busy model in one place** (`F-31`,
  `extractor/generate.ts`, `extractor/model-post.ts`).
  - **Who writes.** The steps that must write text (a claim's sentence, an arc, a description) go to
    `documentProcessing.assistModel`, and only once its host is consented to.
  - **Waiting.** The retry-and-stop logic for 429, 503 and 529 is now one helper, shared by the decision
    client and the generation client.

- **The conversation extractor groups turns into exchanges and checks its claims** (`F-31`, 5.1 / 5.3 / 5.7,
  `claims.ts`).
  - **Grouping.** Per session, one request asks whether each turn continues the exchange before it, starts
    one, or is about nothing. A refused answer continues; a turn about nothing rides along and is never
    written from.
  - **Checking.** A written claim is refused if a resolved date is missing, if it opens with a pronoun, or if
    it carries turn or session references.
  - **Coverage.** Every turn ends up in some claim's source turns, and an exchange with no claim is reported.
  - **Linking.** A claim is linked to the entities it names among those its turns mention. A thing
    mentioned once is minted when a claim names it; a turn that merely falls inside a claim is not enough.

- **The conversation extractor judges its entities** (`F-31`, 4.12 / 4.2 / 4.4 / 4.6, `judge-entities.ts`).
  - **What is asked.** Per turn, one request asks the decision model about every mention: is it a thing the
    conversation is about, which shortlisted entity is it or is it new, which of the space's types it would
    be, and whether it names a group.
  - **What is not asked.** A pronoun is only asked what it refers to. *"I"* and *"you"* are the speaker and
    the addressee, and are not asked at all.
  - **The policy, in code.**
    - A picked entity is a merge.
    - A type the space does not declare, or `none`, means no entity.
    - Only what the conversation returns to is minted: a thing mentioned once is kept aside for a claim to
      link.
    - Every other surface form becomes an alias.
  - Raw answers are kept with the run; the thresholds are 0.5 and still unmeasured.

- **The conversation extractor shortlists what a mention could be** (`F-31`, 4.3, `shortlist.ts`). The
  decision model then picks from the shortlist (4.4); it can only pick a card it was dealt, so the hand is
  generous, bounded to six, and built from four sources:
  - the run's own entities, exact names first, then near spellings and shared distinctive words;
  - the speaker for *"I"* and the other person for *"you"*;
  - the recent turns' entities for *"it"*, *"they"* and *"the book"*;
  - the space's own entity search, once per distinct mention.

  On the committed extractions it deals the right entity for 85% of later mentions, up from 62% on names
  alone. The recall gate is local-only.

- **Cleanup, part 1** (Q-45). Removed, in each case with nothing referencing it:
  - 165 committed build files (`client/out-tsc/`, now ignored).
  - Debris files: `purge_networks.py`, `server/_gen_token.mjs`, two `testing/_init` scratch scripts, and a
    one-off script carrying a personal path.
  - Eight npm packages that nothing imports: `multer`, `@types/multer`, eslint and its two plugins (there is no
    eslint config), `@phosphor-icons/core`, `@angular/platform-browser-dynamic`, `@types/sharp`,
    `@types/dompurify`. The lockfile is ~1,100 lines shorter.
  - 24 eslint-disable comments.
  - 30 exported functions and constants that no code or test used, including a second, unused file-quota
    check.
  - Six test files that guarded features removed in 3.0/3.1 or tested local copies of the code instead of the
    code.

- **Sidecar health probes are one module** (`util/sidecar-health.ts`). The cached `/health` probe was private
  to the render client, and the NLP client would have been its second copy.

- **The conversation extractor asks its first judgement questions** (`F-31`, DECOMPOSITION.md 2.3, 2.5,
  3.4, 3.12). `judge-turns.ts` asks only about what the code half flagged:
  - a speaker's role, when the source does not say, asked once per speaker;
  - whether a candidate paste is material the speaker brought;
  - whether a bare weekday points back or forward;
  - whether a forward weekday said on that same weekday means today.

  A turn with nothing to ask sends no request. An unclear or refused answer always takes the outcome that
  cannot add a wrong fact: a person, the speaker's own words, no day. The raw answers are kept with the run,
  so the thresholds (0.5, unmeasured) can be measured later without asking again.

- **Egress consent is one function** (`config/egress-consent.ts`). The *"is this the host the operator
  acknowledged"* comparison was written out in the document describer, the repair pass, the face model and
  the settings route. All four now ask `egressConsented`, and a gate refuses a hand-written comparison
  anywhere in `server/src`. The save-time refusal moved there too, so the decision model's settings reuse it.

- **The conversation extractor's load, classify and time phases are code** (`F-31`). `classify.ts` splits
  image captions from speech and keeps them apart, so a caption can never become a claim. It proposes paste
  candidates, each with the reason it was proposed. It also marks a photo-only reaction to ride along in a
  neighbour's claim. `load.ts` refuses a conversation it
  cannot read, naming every problem at once. It puts sessions in time order rather than page order, keys
  two sessions on one day apart, and gives every turn an id. `time.ts` finds temporal expressions and
  resolves them by the prompt's own rules, as calendar arithmetic in UTC:
  - *"last Friday"* said on a Friday is seven days back;
  - a weekend that contains today is not *"last weekend"*;
  - *"about three weeks ago"* stays approximate, with no day derived from it;
  - *"last week"* gives no day.

  It also decides what may reach a timeline. A two-ended range becomes a span only when the event
  genuinely took more than a day. That judgement, and whether the exchange places a weekday today, are
  handed in rather than guessed. So is a bare weekday's direction — newly decomposed as step 3.12,
  because it is the sentence's tense. 30 tests, each worked from a rule the prompt states; two were seen
  red by letting the day of speaking count. No route yet.

- **The conversation extractor is decomposed before it is built** (`F-31`, first step). `ingest` will turn
  a raw conversation into records inside the product, so an independent harness can reproduce what today
  needs an assistant session. `server/src/extractor/conversation/DECOMPOSITION.md` traces every rule of the
  extraction prompt to one of three treatments:
  - code;
  - a bounded Jev-style decision over a domain the code supplies (choice, score or probability);
  - open-world writing.

  Of 66 steps, 40 become code and 4 remain writing: even a mention is found by code and judged by the
  model, never named by it, and every written claim is checked against its own source turns. The space must already hold the extractor's schema
  group; `ingest` refuses before any model call otherwise, and never writes schema itself. The type and label choices draw from the schema, so an
  invented type is impossible rather than forbidden. The schemas sit beside it one file per record type, the
  way the `flows` space lays its own out. A gate recounts the tally from the tables and holds the split
  schemas identical to the benchmark's until the benchmark reads them from here.

- **`F-19` leaves the manual-verify exemption map.** Its exploration finished — no demand signal for a rules
  engine, and the cheap parts already exist — so it became an owner decision rather than open work, and a
  stale exemption fails `todo:check`. The map stays, empty, for the next item whose evidence cannot be a count.

## [5.1.4] — 2026-09-25

A patch for the web interface: network votes can be seen and cast from the Networks page again.

**Who is affected.** Every operator who governs a network from the web interface. Since the vote list was written,
the page read a vote round in a shape the server never sent, so it listed no open round at all — on the Networks page
and on the Brain overview's Governance panel — and showed nothing to vote on. Votes cast through the API or MCP, and
votes that peers cast, were never affected: the server always held and decided the rounds correctly, and a round
nobody could see from the page simply ran to its deadline. A network whose join, removal or space-settings change
seemed stuck for that reason can now be decided from the page.

**What to do.** Roll the image, open Settings → Networks, and look under **Open votes** on each network. There is no
config change and no migration.

### Fixed

- **The Networks page lists open votes, and Yes and Veto reach the round.** The page read `id`, `subject` and
  `status` where the server sends `roundId`, `subjectLabel` and `concluded`, so every round was filtered out as not
  open, and a cast would have gone to `/votes/undefined`. The rounds are now translated in one place, where both the
  Networks page and the Governance panel read them.

## [5.1.3] — 2026-09-25

A patch: a token granted only space administration can write again.

**Who is affected.** Only tokens whose rights are a space-administration grant and nothing else — no floor and no
per-space rungs. That shape has been possible since 5.0, when space administration became a grant of its own. Such a token could read its
spaces and was refused every write with *"This token has read-only access"*, although it administers them. A token
that also holds any written `write` rung was never affected.

**What to do.** Nothing, beyond rolling the image. There is no config change and no migration: the grant was always
stored correctly, and it is only the check that now reads it.

### Fixed

- **A token granted only space administration was refused as read-only.** Since 5.0 space administration can be
  granted on its own, and it means `admin` in every data area of those spaces — but the read-only check counted
  only written rungs, so a token holding just the grant was turned away with *"This token has read-only access"* by
  every route that refuses read-only tokens, before that route's own check ran. It now counts the grant.

## [5.1.2] — 2026-09-25

A patch for networks: two instances that share more than one network keep syncing all of them, a sync that
transferred nothing no longer reports success, and a space-settings change your own vote passes applies at once.

### Fixed

- **Joining a second network with the same peer no longer cuts off the first.** Each instance keeps one token per
  peer, and every handshake replaced it with a token that reached only the network being joined — so the moment
  two instances shared a second network, every push and pull on the first answered `403`, in both directions, with
  nothing logged as an error. A peer token now reaches every network the two instances share; each request is still
  admitted only to the spaces of networks the peer is a member of, so leaving one network still withdraws its
  spaces. The joining side also no longer hands over an all-spaces token when the network carries no spaces — it
  reaches none. **After upgrading, re-join any second network created between the same two instances**, so both
  sides hold a token that reaches all of them.

- **A sync cycle whose transfers were refused is no longer recorded as a success.** A refused or cut-short
  transfer held its watermark and logged a warning, and the cycle still counted the member as synced — so a network
  answering `403` on every request showed `success` in its history while nothing transferred. Such a member now
  fails the cycle (`partial` or `failed`), the history's `errors` names the space, direction and transfers that
  stopped, and the member's consecutive-failure count rises. A member with no peer token is reported the same way.

- **A space-settings change your own vote already passes is applied at once.** On a club or pub/sub network one
  yes passes a vote, and the proposer's yes was recorded when the vote opened, but nothing counted it — so the
  change answered `202 vote_pending` and did nothing until somebody cast the same yes again or the vote expired a
  day later. It now concludes when it opens if the proposer's vote is enough, and answers `200`.

## [5.1.1] — 2026-09-24

A security patch: a network invite that was applied and never finalized no longer leaves a permanent peer
token behind, and any left by earlier handshakes are revoked when the instance starts.

### Fixed

- **A network invite that was applied and never finalized left a permanent peer token behind** (security). Apply
  creates the joiner's token on the inviting instance before finalize registers the member, and it had no expiry;
  the handshake session that knew about it lived only in memory for an hour. So a joiner that crashed, was
  refused, or lost the connection between the two steps — or a restart in between — left a token to the
  network's spaces that never expired and belonged to no member. The token now expires with its handshake and
  finalize clears the expiry once the member is real. **At start, peer tokens whose instance shares no network
  with this one are revoked**, which removes any left by earlier handshakes; a member or a joiner with an open
  vote round is never touched.

## [5.1.0] — 2026-09-23

**A batch item can carry its own relationships, and five things that answered success while doing nothing
now say so.** One capability and a week of reports from the canary operator and the fleet integrator,
released before the benchmark work starts so none of it waits behind that.

| | |
|---|---|
| new | a `/bulk` / `save_bulk` item takes the `link*` fields its kind can hold plus `edges`, and the reply counts them under `connections` |
| now refused | `/bulk` with a retired key (`memories`) or an item with a retired link array (`entityIds`), which used to answer `207` with nothing written |
| now visible | a failed watched config reload, on `ythril_config_reload_pending` and `ythril_config_reload_failed_total` |
| now works | reranking against a stock reranker, which refused the unbatched request |
| what to do | upgrade. A batch still sending `memories` gets a `400` naming `facts` — that is the fix, not a regression |

### Added

- **A batch item attaches its own relationships, exactly as a single write does** (`Q-44`). Every
  single-record door takes the link classes its kind can hold plus `edges`, so a record and everything it
  points at is one call. The batch door took two link classes, validated by its own copy of the rule, and
  refused `edges` outright — so the door where the arithmetic is worst, hundreds of records at a time, was
  the one that still needed a second pass.

  Both surfaces now build those fields from the same module the single doors call, which is also what
  retires the copy: this loop had a UUID pattern per link field that checked less than the shared one and
  had drifted from it in the direction nothing reports — a `linkFiles` on a fact was accepted and never
  read, a non-array `linkEntities` was quietly treated as empty.

  **The response grew a `connections` count**, separate from `inserted.edges` deliberately: that number is
  the top-level `edges` array, a collection the caller wrote, while these are relationships hung off records
  the caller wrote. Folded together neither could be reconciled against the payload. The `bulk.write`
  webhook carries it too, and it counts toward whether that webhook fires at all — fifty attachments to
  records that were only updated is fifty rows written, and a workflow watching for exactly that would have
  been told nothing happened.

  **An item's own `edges` name records that already exist; a `$ref` there is refused** and the refusal names
  the top-level array, which runs after every record array and resolves one. An item is applied when it is
  written, so a key declared further down could not resolve, and resolving only backwards would make a
  payload's validity depend on the order it was typed in. **A connection that cannot be honoured is refused
  before the record is written**, so a bad `edges` entry leaves no row behind.

### Fixed

- **A config reload that failed left one log line and nothing to alert on** (`Q-43`). Reported by the
  canary operator, whose edit sat out of effect until the next restart with the only evidence in a pod log
  nobody was tailing. The endpoint they blamed is correct — `POST /api/admin/reload-config` answers `500`
  on a file it refuses. The silent half is the **watcher**, which has no caller to answer and logs instead.

  Two metrics now, because they answer different questions. `ythril_config_reload_pending` is the one to
  alert on: `1` while a refused reload has left the running configuration older than the file, cleared by
  the next reload that succeeds. `ythril_config_reload_failed_total` is the history beside it.

  **The gauge matters more than the counter here**, and the reason is in the watcher: it claims the file's
  modification time *before* reloading, so broken bytes are not re-read every tick — which means a failed
  watched reload is never retried on its own. A counter that moved an hour ago says it happened; the gauge
  says it is still true.

- **`/bulk` read a retired name as success, and it was the one write door that did** (`Q-41`). Reported by
  the fleet integrator: `{"memories": […]}` answered `207` with nothing inserted and an empty `errors`
  array — the same answer a body that legitimately wrote nothing gives. Around thirty of their builders had
  been writing into that key and seeing success.

  The batch body takes its four keys and no others now. `memories` is refused by name with `facts` as the
  replacement; any other unrecognised key is refused with the four that are accepted. **An item carrying a
  retired link array is refused the same way** — `entityIds`, `memoryIds` and `chronoIds` were dropped just
  as quietly one level down, and a batch is where that costs most.

  Both go through the module every single-record door already calls, rather than a second check that would
  need its own sentence kept in step. The allowed keys are derived from one tuple, so a fifth collection
  cannot be accepted by the writer and refused by the door.

- **The reranker was sent up to a hundred passages in one request, and a stock server refuses that**
  (`Q-42`). Reported by the canary operator: every unfiltered search on their fleet had been served in
  fused order, for as long as their settings had been what they are. A `413 Payload Too Large` reaches the
  caller as `degraded: ["rerank_unavailable"]`, which is indistinguishable from a search with no reranker
  configured — so it can be true for months with nothing to see.

  Candidates are split into batches of **32** now, settable as
  `mediaEmbedding.rerank.maxPassagesPerRequest` (1 … 100) through the admin API. Total work is unchanged —
  a cross-encoder is a forward pass per passage — and the pass keeps **one** deadline rather than one per
  batch, so a recall somebody is waiting on is bounded exactly as it was.

  **If any batch fails the whole pass is abandoned** and the vector order stands. A list ordered partly by
  cross-encoder score and partly by vector score, with nothing saying which is which, is a plausible wrong
  answer; no opinion at all is an honest one.

  The candidate pool still scales with the number of knowledge types searched, which is why an unfiltered
  recall is the most expensive shape there is. That is a separate question and is not changed here.

- **Sync never checked a FILE's links, so a broken one was recorded as nothing at all** (`Q-39`). A peer
  sending a file linked to an entity this instance does not hold produced no violation, no warning and no
  trace — and an operator reads an empty violation list as everything being fine. Absent and clean looked
  identical, which is the one failure a diagnostic must not have.

  A file's links are checked like any other record's now, and `docType` on a link violation can be `file`.
  For that one, `docId` is the file's **path** rather than a UUID, because that is what identifies a file.

  **The narrowing was removed rather than extended.** It read `fromKind !== 'fact' && fromKind !== 'chrono'`;
  what decides whether a link is checked is now the link vocabulary itself, so a fifth kind declared next
  year is checked on the day it is declared instead of waiting for somebody to add it to a list.

- **Deleting an entity that has an edge failed SILENTLY in the Brain UI.** Reported by the owner: the row
  stayed on screen, nothing was said, and the click looked as though it had not registered.

  **The server had already said everything.** It answers `409` with what blocks the delete, the preview
  route and the name of the parameter that authorises a cascade. The client's handler was
  `error: () => {}`.

  The refusal now opens a confirmation naming what would go — **counted by kind, not listed as
  identifiers**, because the decision in front of an operator is *how much goes with it* and twenty UUIDs
  obscure that. It also says what does NOT go: an edge is removed and the record at the other end of it
  stays. On confirm the delete repeats with the token from the preview, which removes the entity and the
  records blocking it. A stale token is not retried — the server returns the CURRENT set with its
  refusal, so the operator is asked again about the set as it now stands.

  An entity with nothing pointing at it still deletes in one click. Asking to confirm a cascade that
  would remove nothing is a dialog that teaches people to dismiss dialogs.

- **All four record tabs threw their delete error away, not just entities.** Facts, chrono and edges had
  the identical `error: () => {}` — the same omission four times, so the surface for it lives on the
  state the four already share rather than being added to each. A delete that did not happen now says
  why, above the list, where the row that would not go is still visible.

- **An integration file stopped testing anything the day 5.0 shipped, and reported itself as skipped**
  (`Q-38`). `a-traversed-recall-returns-whole-graphs` sent `includeFreshWrites: true` on every recall.
  5.0 removed that parameter, so every call answered `400` — and the file's own fixture guard turned that
  into a skip, saying *"could not measure the full traversed answer"*, which reads as a fixture that
  could not be built.

  **A test that skips is indistinguishable from one that passes in every summary anybody reads.** The
  measuring call asserts its status now, so a refusal fails loudly instead of disappearing into a guard
  written for a different problem.

  **Waking it found a SECOND 5.0 change it had been too inert to notice**, which is the argument for
  doing this rather than deleting the file: `recall`'s hit became `{score, spaceId, type, record}`,
  so every `r._id` read `undefined`. The comparison keyed every graph on that same `undefined`,
  collapsed to one entry, and compared one hub's subtree against a different hub's — reporting *"the
  graph on undefined differs"*, which is the tell. One accessor now reads the record, and it falls
  back to the hit itself rather than asserting which shape it got.

  A gate derives the allowed parameter names from the `recall` tool's own input schema — which IS the
  REST body's schema, because the route hands its body to `callTool` — and refuses any test sending a
  name that is not one of them. A parameter renamed or removed next year is covered as it stands.

- **A missing import in a Docker-only suite now fails in `preflight` instead of in CI.** Adding the
  index wait above to four files and the import to three of them threw `waitForIndexed is not
  defined` inside a `before` — which CANCELS every subtest under it, so one missing word reported as
  **eight failures**, seven of them saying only *"test did not finish before its parent and was
  cancelled"*.

  There is no ESLint here to lean on, and `preflight` cannot run the integration, sync or red-team
  suites because they need Docker — so that class of mistake was invisible locally and cost a full
  CI round trip. A gate derives the helper names from the shared module and checks those three
  directories, which is where the cost is: a standalone gate with the same mistake fails the moment
  anybody runs preflight.

- **Three tests recalled a record they had just written without waiting for the vector index** (`Q-38`).
  Recall's fresh-write scan covers a record whose embedding is still PENDING, so there is a window —
  after the embed job finishes and before `$vectorSearch` holds the vector — where neither path finds it.
  A test landing in it fails saying its own control is missing, which reads as a defect in the thing
  under test.

  **Pinning a seed by `_id` is not an exemption**, which is what two of the three assumed: recall ranks,
  and a filter narrows what `$vectorSearch` may return rather than replacing it.

  **Read one by one rather than swept.** Of the fifteen recall tests with no wait, most are right without
  one: some assert a refusal, some assert only a status, and `result-spill-both-doors` deliberately
  relies on the fresh-write scan and records the measurement behind that choice — waiting there hit the
  index-lag timeout and failed twelve assertions for a reason unrelated to its subject.

### Internal

- **A test named after the bulk 500-item cap had never exercised it** — exposed by the `/bulk` refusal
  above. It posted its 502 items under the retired `memories` key, so nothing was written, and its
  assertion — `inserted + errors <= 500` — was satisfied by zero. It sends `facts` now and asserts that
  exactly 500 of the 502 were processed, because a bound a zero satisfies is not a bound.

## [5.0.1] — 2026-09-22

**A read was logged as a write on the MCP door, so an operator who had turned read logging OFF still got
them.** Found hours after 5.0.0 published, and patched rather than held: a defect in an image people can
already pull is a different thing from one in a tree nobody has.

| | |
|---|---|
| who is affected | any instance on the default `audit.logReads: false` whose agents call `filter` or `similar` |
| what it cost | extra rows in the audit log. No data lost, no call refused, no record changed |
| what to do | upgrade. Nothing to re-point and nothing to re-configure |

Entries already written for those two operations stay where they are. They are correct entries under a
wrong classification, not wrong entries.

### Fixed

- **Two read tools were logged as writes, so an operator who turned reads OFF still got them.** A
  regression of the 5.0 renames, found the same day. `audit.logReads` is off by default; REST declares
  which operations are reads with `read: true` on the route rule, and the MCP door held a second,
  hand-written set of nine operation names beside it.

  `query` became `filter` and `find_similar` became `similar`; the audit MAP was updated and that set was
  not. So it still named `brain.query`, which nothing records any more, and named neither `brain.filter`
  nor `brain.similar` — **the two highest-volume read paths an agent has**. Nothing said so, because a
  read logged as a write is an extra row rather than an error, and a dead name in a hand-written set is
  never wrong out loud.

  The set is derived from the route rules now, where `read: true` sits beside the route it describes. One
  rule, one declaration: a capability cannot be a read on one door and not the other, and a new read
  route classifies the tool that mirrors it without anybody remembering to. `entity.cascade_preview` was
  also reclassified by that — it reports what a cascade would remove and removes nothing.

- **The audit guide documented 53 of the 115 operations the log can contain** (`Q-40`). The page opens by
  promising *"a full access trail"* and then lists the operations; 62 were missing, including every
  `conflict.*` and `contradiction.*`, all of `data.*`, all of `schema_library.*`, `token.update`,
  `token.regenerate`, `link.create` and `link.delete`. An integrator builds an audit query from that
  table, so an operation absent from it is a filter nobody writes.

  Found by deriving the set to check that the two operations above were documented — they were not.

  **A gate keeps it true rather than a corrected table**, which would be the same defect with a later
  date: the set comes from the route rules, the tool map and the one operation neither produces, and the
  window is the table itself, because several operations appear in that page's prose and a whole-file
  check would pass while the table stayed short.

  The gate also runs the other way. It found five operations the table named that nothing records —
  `brain.query`, `brain.er_model`, `brain.find_similar`, `brain.recall_global` and `brain.bulk_write`,
  all left behind by the 5.0 renames and folds. An integrator filtering for those reads the silence as
  *"this never happens here"* rather than as a stale page.

- **An agent syncing ONE peer was audited under the network-wide name** (`Q-37`). `network_sync` with a
  `peerId` does exactly what `POST /api/networks/peers/:peerId/sync` does, and that route records
  `peer.sync_trigger` — the tool recorded `network.sync_trigger` for both subjects, because the resolver
  was handed the tool NAME and nothing else. So an operator filtering the audit log for
  `peer.sync_trigger` saw the browser's peer syncs and none of an agent's.

  It is the defect `a-tool-and-its-route-log-one-operation` exists for, one level down, and invisible to
  that gate because the tool's first operation IS a name a route records.

  **The resolver takes the call's arguments now, and it does not trust them.** A chooser is a function of
  caller input, so it is caught, and a result outside the tool's own declared operations is refused.
  Both failures fall back to the first name: **an unaudited call is worse than one under a
  slightly-wrong name**, and that is the direction this must not fail in. The gate asserts the rule for
  every tool with a chooser rather than for the one that has one.

  **Not put on the tool definition**, where it would have been lighter for a single case: that puts the
  audit name somewhere the coverage gate does not read, and answers a question the audit map already
  answers — the same rule in two places.

## [5.0.0] — 2026-09-22

**Ythril 5 breaks every public name.** A tool, a route, a record type and a link field were each spelled
the way they happened to be spelled first; this release fixes all of them at once, with no aliases and no
compatibility window. Owner decision, 2026-09-15: *"break everything right away."* One upgrade, one edit
to your client, and the vocabulary stops being a thing you look up.

**A peer below 5.0.0 is refused at the handshake with a `426`** — `MIN_PEER_VERSION` derives from our own
major — so a network upgrades together or not at all. Upgrade every instance in a network before you
restart any of them.

### What breaks, and what to do about it

| what changed | what to do |
|---|---|
| A peer below 5.0.0 is refused at the handshake (`426`) | Upgrade every instance in the network together |
| The knowledge type `memory` is now `fact`, everywhere | Send `fact`; `memory` is refused, not translated |
| Every MCP tool is renamed verb-first, and three fold into others — 45 tools, not 48 | Re-read `tools/list`; a retired name is an error, not an alias |
| Every tool is `POST /api/<tool-name>`, and ten `GET` routes are gone: `GET /api/brain/spaces/:spaceId/{facts,entities,edges,chrono,files}`, `GET /api/brain/spaces/:spaceId/{facts,entities,edges,chrono}/:id` and `GET /api/brain/spaces/:spaceId/entities/by-ids`. **Match on METHOD and path**: `PATCH`/`DELETE` on the `:id` paths, `PATCH .../files`, `GET .../entities/:id/cascade-preview` and `GET .../files/extract` all still exist | Read a collection with `POST /api/filter` |
| An MCP client that stayed connected across the upgrade still holds the 4.x tool list | Reconnect it. The list is fetched at connect, so a live session sees every call fail rather than the rename |
| The search family drops the space from its path | `POST /api/brain/recall`, with `space` in the BODY |
| The six link ARRAY fields are gone | Send `linkEntities` / `linkFacts` / `linkChronos` — the same ids. The refusal names the field |
| A record no longer returns its links | Walk them: `traverse`, or a `filter` over the `links` collection |
| `completeLinkage` cannot be turned off, by anyone | Nothing. A space whose conversion FAILED is named in the startup log and refuses link reads until it is converted |
| Three recall parameters renamed or removed (`includeFreshWrites`, `includeContent`, `charsPerToken`) | Delete the first and third; `includeContent` is `includeFileContent` |
| Emptying a space is `POST /api/delete_space_data` | Re-point the call |
| Space administrator is a rung you GRANT | Grant it; four admin rungs no longer imply it |
| `recall`'s REST response has the tool's result shape | One handler for both doors — see the recall entry |

**The link change is the largest one and it is under `Removed` → *The 4.x link arrays*.** Read that
section before upgrading an instance that other people write to: the conversion runs itself on the first
5.0 boot, and the only thing an operator can be asked to do is re-run it for a space whose walk failed.

### Documentation changed in this release

**44 of the 52 documentation files changed, and not one of them kept its byte size.** A refresh that skips
a file whose size did not move therefore sees every change in this release — `--force` is not needed for
5.0.0. The eight that did NOT change are the four decision records (`docs/decisions.md` and
`docs/decisions/01`–`03`), `docs/integration-guide/10-mfa-and-conflicts.md`,
`docs/integration-guide/15-about-and-embedding.md`, `docs/network-types.md` and `docs/ui-primitives.md`.

Two guides are NEW: `docs/integration-guide/04g-links-api.md` (links as their own collection) and
`docs/integration-guide/04h-graph-augmented-recall.md`.

### Added

#### The benchmark corpus and its extraction pipeline

- **The seven gaps the extraction round found in the rules it was run under, and the uneven-treatment figure halves
  again** (`B-19`). 5,882 turns → 2,236 claims, 462 entities, 290 chrono entries, 470 edges. **Chrono entries per
  1,000 turns now spread 2.4x across the ten, against 4.6x and 6.6x in the two rounds before** — the number this
  work is judged by, because a corpus whose timeline is decided by the grammar somebody happened to use has a
  timeline that means nothing.

  **The lever was one clause.** An undated *"it just happened"* now takes the session date, while *"last
  week I got married"* does not: an offset makes the session date KNOWN to be wrong. Also: `active` is no
  longer a status an extraction may write, `knows.kind` gains `partner` beside `ex_partner`, *"this
  weekend"* said on a Saturday or Sunday is the weekend in progress, and `upcoming` being rare is recorded
  as a limit of the format.

  **One rule bought nothing and is reported anyway.** Lexical knowledge now counts as knowing a duration —
  camping entails a night, a 5K does not — and the span count did not move: 6 before, 6 after. What it
  bought is that a file no longer depends on which reading its author picked.

- **An extraction round survives the session that started it** (`B-19`). Parts are written to `benchmarks/.cache/`
  as they are finished, rather than to a session scratch directory that is wiped between sessions — exactly when the
  parts are needed. `bench.mjs status` answers *"where did the last round get to"*: `done` means extracted under the
  prompt in the tree, so a file from an earlier prompt reads `RE-DO`.

  **Measured twice.** Ten extractors launched together exhausted the session window in twenty minutes and
  finished none. With checkpoints, a later limit killed three mid-flight and cost one conversation.

  **A resume refuses a directory whose parts name a different prompt**, because merging last week's parts
  with today's produces one conversation under two sets of rules wearing a single fingerprint.

- **An extraction records how it was produced, and the whole corpus is regenerated under one prompt** (`B-15`,
  `B-18`, and the chrono vocabulary). 5,882 turns → 2,275 claims, 474 entities, 199 chrono entries, 489 edges, every
  one stamped by the run that made it.

  **`producedBy`, split so neither half can be forgotten.** Which prompt produced a file is a fact about
  the working tree, so `bench.mjs merge` stamps its sha256. Whether a retrieval score was visible is an
  attestation only the extractor can make, so it travels in the first part, and a missing flag is refused
  rather than read as `true`. `stats` warns when a corpus came from more than one prompt.

  **It found a real defect on first use:** the 3.5x figure published earlier the same day was measured
  across eight files from one prompt and two from another. It is withdrawn.

  **The chrono vocabulary is now one type.** The five conversation chrono types become `event` alone with
  `status` required. `deadline` had collected one record across 5,882 turns and `prediction` none;
  `milestone` was an opinion nothing filters on; `plan` duplicated a field the store already had.
  `overdue` is refused, because the read path derives it. **No product default changes** —
  `getAllowedChronoTypes` still returns the same five to a space that declares none.

  **The headline moved the wrong way and that is the result.** Spread 6.6x → 4.6x, a third narrower rather
  than the halving the withdrawn number suggested. Spans fell 42 → 6 and chrono entries 251 → 199, because
  the tightened duration rule refuses far more than it admits — which `B-19` then corrected.

- **All ten conversations re-extracted under the revised prompt, and the uneven-treatment figure halves** (`B-16`,
  `B-17`). 5,882 turns → 2,445 claims, 457 entities, 251 chrono entries, 477 edges, every turn named by a claim.

  **Two extractions had to be redone, and why was worth more than the number.** `conv-43` came back at 34
  chrono entries against 7, which alone would have closed most of the gap — and all 24 of its spans were
  week-windows over one-day events. It was following a convention rather than a rule, so the spread
  appeared to narrow because two extractors applied a different one.

  **`B-17` is the clarification that decided it.** `endsAt` is how long something lasted, never how unsure
  you are about when it happened. Bracketing a wedding to the Monday and Sunday of its week says the
  wedding took a week, and nothing downstream can tell that from a genuine week-long event. Stated with no
  size threshold, because a threshold only says how large a lie is tolerable.

  **The cost is documented rather than hidden.** Events dated only to a week stay off the timeline — eight
  of about twenty datable happenings in `conv-43`, which is why it remains the sparsest conversation at
  17.6 entries per 1,000 turns against `conv-26`'s 62.1. That is a property of two speakers who date
  everything to a week, and it turns `F-29` from a preference into a measured argument.

- **`bench.mjs stats` — the corpus states how unevenly one prompt treated it** (`B-16`).
  `benchmarks/writer/corpus-spread.mjs`, printed by a new CLI verb.

  The figure that decided the last three rows was a 6.6x range in chrono entries per 1,000 turns across ten
  conversations extracted by one prompt and one model. It was arrived at by a command typed once, and the
  next round is judged by whether it narrows — **a number nobody can recompute is a number everybody
  quotes**, so the derivation is code.

  Two headlines it refuses to print rather than render: a conversation with no chrono entries makes the
  ratio infinite, and a corpus of one has no spread at all, so `1.0` would read as perfect consistency.
  Totals are summed rather than averaged, because an average weights a 369-turn conversation like a
  689-turn one.

- **The extraction prompt's nine gaps are closed, and a two-day event can now reach the timeline** (`B-14`). Every
  one was reported independently by extractions that could not see each other — one model finding an ambiguity is a
  model having an opinion; five finding the same one is the prompt not saying something.

  **The one that was a bug rather than a judgement call.** A Ythril chrono record carries `startsAt` and
  `endsAt`; the extraction format offered only a single `date`, so a weekend was inexpressible and five
  runs each invented the same fallback — write the span into the sentence and emit no chrono entry. A
  marriage, a gastritis diagnosis, a pride parade and a career-high game are absent from their timelines
  while a photograph taken on a named Friday is present. **What reached the timeline was being decided by
  the grammar the speaker happened to use.** `endsAt` is now in the format, the prompt, the writer and
  `conversation.event`; a backwards range is refused, a same-day range is accepted as explicit, and a
  one-day event carries no `endsAt` key at all.

  **Six new prompt sections**, each answering a question ten runs had to answer for themselves: a
  conversation that contradicts itself (date the claim to its telling); a turn carrying a machine-written
  image caption (context, never a fact, because captions are frequently wrong); a recurring subject with no
  name; order within a session (position orders claims inside one, the date between); *"last Tuesday"*
  (the most recent past occurrence); and that a thin supersession count is the expected result.

  Also: `aliases` now exists on `place`, `organization` and `work`, and the format documents that an entity
  or chrono entry may carry `sourceTurns` — **the validator has always capped it at 12% of a transcript,
  and a run following the format exactly never wrote the field, so that rule had never once fired.**

- **All ten LoCoMo conversations are extracted unattended, and conv-26 was re-extracted unattended too** (`B-4`).
  5,882 turns across 272 sessions, producing 2,294 claims, 470 entities, 212 chrono entries and 527 edges, every
  file passing `bench.mjs check`.

  **Each conversation was extracted in a context that had seen none of the others, and no retrieval score
  was measured until all ten were committed.** That is the row rather than a procedural detail: a prompt
  that only works while its author watches the scoreboard is not a product capability, and the only way to
  find out is to not look. `conv-26`'s previous extraction was written by hand with the scores visible —
  legitimate development, illegitimate evidence — and the unattended replacement finds 198 claims where it
  found 129.

  **What the run measured about the prompt.** One prompt and one model produce a 6.6x spread in how much of
  a conversation reaches the timeline, and supersessions ranging 0 to 8 across conversations of comparable
  length. The prompt says two models disagreeing a lot is a finding about the prompt; one model disagreeing
  with itself by 6.6x meets that test without a second model.

  **The prompt is deliberately unchanged.** Editing it between conversation six and seven would produce a
  corpus extracted by two prompts, and every per-conversation difference afterwards would be
  unattributable.

- **An extraction is now checked against the conversation it NAMES, not only against itself** (`B-4`).
  `benchmarks/writer/extraction-matches-conversation.mjs`, called by `bench.mjs check`.

  The validator reads the extraction alone and the merge refuses a run with a part missing. Between them
  they catch everything except records from a **different conversation**: a spliced file is internally
  perfect, and turn coverage reads 100% because the foreign part brought its own `sessions` block. The
  graph is consistent and it is about somebody else.

  It is not hypothetical. The ten extractions run in ten separate contexts and the scratch directory they
  wrote into turned out to be shared; two runs had a working file overwritten mid-extraction. Nothing
  foreign reached a committed file — which is the point, because nothing would have said so.

  **A turn id is the witness**, and the check is honest about how far that goes: ids are positional, so
  swapping one whole extraction in under another's name leaves only 23 of 369 foreign. Coverage measured
  against the CORPUS is the other half, because the file's own `sessions` block is the reading a truncated
  extraction passes at 100%. The corpus is never present in CI, so the skip is loud.

- **`benchmarks/bench.mjs` — the four things an extraction takes, so the next nine do not rewrite them** (`B-4`).
  `conv-30` was extracted with four throwaway scripts — dump, merge, validate, write — each written at the keyboard
  and deleted. Nine conversations remained, each extracted in a fresh context, so without this every one starts by
  rewriting those four slightly differently.

  `status` reads which are done off the directory rather than a list. `check` reports every problem at once
  and counts the turns no claim names, since an extraction that dropped the quiet turns once covered 34.6%
  of a conversation.

  **The part a rewritten copy would drop is why it is committed:** `dump` goes through `loadConversations`.
  The pinned release is one object per instance — history, question, answer and evidence together — so
  parsing it directly is one line shorter and puts the answer key in front of the model doing the
  extraction.

- **The no-memory baseline, built so the two arms cannot differ in anything but the memory** (`B-6`). `B-2` says the
  number to publish is not the accuracy but *"the accuracy minus what the same answerer scores with the whole
  history in its context"*. Without it a figure in the eighties says nothing about whether the memory did anything,
  and it is the column every self-reported figure omits.

  **One configuration produces both arms, and there is no way to ask for one.** A subtraction measures the
  memory only if the arms differ in exactly one thing, and two arms configured separately drift in a way
  nothing reports. `MEMORY_ONLY` is the whole list of what may differ, and `armsDisagreeOn` catches a pair
  somebody else assembled.

  Two refusals, both in the flattering direction nobody checks: a baseline handed a conversation with no
  sessions answers nothing and makes the memory look better by exactly that much, and absent hits are not
  empty hits. A negative delta is a real result and is reported as one.

- **`benchmarks/harness/` exists again, with the half of a graded run that needs no model** (`B-6`, first
  increment). `#1282` deleted the previous one — 56 files, on the owner's instruction — because everything in it
  rested on the premise that a conversation is a pile of transcript chunks, under which multi-hop scored **0.0%
  across all twelve** strategies. This retrieves from the graph the writer produces instead.

  The exact request comes back beside the answer, because `topK` and the traversal depth are part of what a
  figure means. The `superseded` mark is carried through, since a grader that cannot see it scores a correct
  historical answer as a wrong current one.

  **A failed call is not an empty result.** If a broken instance reported "no results", a run against a down
  service would publish a low score rather than an error, and nothing afterwards would tell them apart.

  The answerer and the judge are **parked on two provider API keys**, which `B-2` requires from different
  hosted families so the judge is not marking its own phrasing.

- **The second-corpus work is finished, and its measurements are written down** (`B-5`, closed). Six fixes shipped
  from `longmemeval_s` and each has its own entry; what none of them carried is the arithmetic. That is now one
  entry in `benchmarks/DEVELOPMENT-LOG.md`.

  **The row's method was substituted and the log says so.** It asked for three histories to be extracted and
  read; two were read directly and the whole 500-instance release was measured instead. Four of the six
  defects are distribution facts — 211 of 500 histories out of time order, 18,565 of 25,112 sessions sharing
  a date, 253 of 500 carrying a pasted document, 896 turns flagged as evidence — invisible in any single
  extraction and undeniable across the release.

  The extraction prompt is now FROZEN, which is what `B-4` waits on.

- **The conversation-writer ships, and `B-3` closes on work that was already done** (`B-3`). The row's remaining
  scope read *"what is left to build is the writer"* — and all of it was in `benchmarks/writer/` already. What had
  never happened is the CHANGELOG line the row watches for, so a reader of the tracker would have concluded the
  writer did not exist.

  The proof arrived with `conv-30`: a committed extraction carrying no Ythril ids, replayed deterministically
  into a live space as 133 records. Anybody can rebuild the exact graph from the repository, and only
  re-deriving the extraction needs a model.

  **Three rows in a row have now turned out to be stale in their central premise** — `B-2` said a graded
  harness exists when it was deleted, this one said the writer was unbuilt when it was built. A verify clause
  catches the second kind and not the first: it can tell you a row has not closed, and cannot tell you the
  reason it gives is no longer true.

- **`conv-30` is extracted, and it is the first conversation the shipped pipeline has produced end to end** (`B-4`,
  1 of 10). 19 sessions, 369 turns, 84 claims, 12 entities, 25 chrono entries, 12 edges — and **all 369 turns are
  named by some claim's `sourceTurns`**, with none invented.

  Delivered in three parts and joined by `mergeExtractionParts`, which is the protocol's first real use
  rather than its test fixture; the merged file passed `validateExtraction` first time and wrote 133 records
  into a live space.

  **It carries a real supersession**, which is what `Q-35` and the prompt rule were built for: Jon goes
  full-time on the dance studio on 9 July and takes a temporary job on 21 July. The July claim carries
  `superseded: true`, a `supersedes` edge runs from the later claim to it, and a recall returns the earlier
  one **marked** rather than hidden.

  **No score was read.** No retrieval score may be measured until all ten extractions are committed.

- **A pasted document is treated as material rather than assertion** (`B-5`). Measured on the pinned corpora:
  LoCoMo's longest turn ever is **454 characters**; LongMemEval has **351 user turns over 5,000**, across **253 of
  500 histories**, the largest **76,560** — somebody pasting the Wikipedia article on the GDPR. Assistant turns over
  5,000: three, in the entire corpus. So a long turn is almost always somebody pasting something in, and half the
  corpus has one.

  The prompt had a rule for the ASSISTANT supplying world knowledge and none for a person pasting it, and
  `attributed` is the wrong tool twice over. So a pasted article would have become either a hundred unmarked
  claims the graph ASSERTS, or a refusal. It is now a third thing: the person did not say what is in it, they
  brought it, and the fact is that they brought it and what they wanted from it.

  **With a validator rule, because the prompt half depends on the model having read it.** No single turn may
  account for more than a share of a file's claims — a share rather than a count, because a threshold in
  records is wrong for a short conversation and meaningless for a long one.

- **LongMemEval has a loader, and it exists because the answer key is inside the histories** (`B-5`). LoCoMo keeps
  its questions beside the conversation; a LongMemEval instance is one object holding the history AND `question`,
  `answer`, `question_type` and `answer_session_ids` — and **896 turns inside the haystack carry `has_answer:
  true`**. That last one is the dangerous one: a third key on a turn otherwise holding `role` and `content`, on
  exactly the turns a score is computed from. Anything reading the release directly would have handed the extraction
  model a flag saying *this turn is the evidence*.

  A turn is BUILT from named fields rather than copied, so a field the authors add later cannot ride along, and
  an unknown key stops the run. Twelve turns of 246,930 carry no content and are dropped and REPORTED. Ids are
  minted from the PUBLISHED position, so a dropped turn leaves a gap — renumbering would make a committed
  extraction's `sourceTurns` point at the wrong remark with nothing to reveal it.

- **An extraction may arrive in parts, and an incomplete run is refused** (`B-5`). A long history reads in one pass;
  the graph of one does not always write back in one. A part declares `part: {index, of}` and covers a contiguous
  run of sessions, and `mergeExtractionParts` joins them.

  **The refusal is the point:** three parts of four concatenate into a file that is valid in every other way
  and describes three-quarters of a conversation, so the hole only ever surfaces as a question that returns
  nothing — which reads as a retrieval failure. Identity crosses the seam by every part repeating every
  entity; a key whose TYPE changed between parts is refused rather than resolved, because whichever side won,
  the edges the other part drew now run to the wrong kind of thing.

- **`longmemeval_s` is measured rather than quoted, and the number this repository had been repeating was wrong
  twice over.** The tracker called the corpus structurally different because *"a history runs to 500 sessions rather
  than 20"*. 500 is the number of INSTANCES, and the 500-sessions figure belongs to `longmemeval_m`, which is
  neither pinned nor fetched. Measured from the file: 39–66 sessions per history (p50 50), 396–616 turns (p50 492),
  462–514 KB. The pin now carries an `observed` block beside the authors' `stated` one.

- **The extraction harness can say that a later session made an earlier fact wrong** (`B-5`). The prompt had no
  sentence about supersession, so a chat log saying *"I left Acme"* produced two equally live claims. A claim may
  now carry `superseded: true`, written as a record field rather than a property — `superseded` is the product's
  vocabulary, and a second spelling of a real field in the space people read to judge the product is worse than no
  mark. It does not suppress: the retired claim keeps its vector and keeps ranking, so *"where DID she work?"* still
  has an answer.

  A claim may also carry a local `key`, and the three key spaces became one, because an edge end is a bare key
  and says nothing about which collection it is in. `supersedes` is exempt from the schema's label allowlist
  for the reason the server exempts it, and a gate compares the harness's spelling against the server's.

  **The validator's rule is the implication and not the pair.** A retirement need not have a successor —
  demanding an edge would make the model invent one. An edge saying X replaced Y with Y unmarked is refused,
  because both then come back looking equally current. Between two entities it is refused outright: that is a
  merge, and `aliases` is where a merge belongs.

#### Claims, chrono, supersession and contradictions

- **A superseded record is badged wherever a record is listed** (`Q-36`). The mark reached the API, an
  export, a sync and every assistant answer, and no view in the app. An operator resolving a contradiction
  saw the pair leave the review queue and then found both claims sitting in the Facts tab looking identical
  — which reads as the resolve having done nothing, the impression `Q-35` existed to end. It is the same
  defect one surface down: `Q-35` was *the judgement reaches the record and not retrieval*, this was *it
  reaches retrieval and not the operator*.

- **A record can be marked as no longer true, and it keeps ranking.** `superseded` is a boolean on facts,
  entities, edges and chrono entries, accepted on the create and the update, on both doors. Owner's
  decision, answering a proposal that a retired record be stored unembedded the way an attributed claim is:
  *"what if you ask 'where did ada work?' or 'list all workplaces' — A kills that."* It does, so the mark
  does not touch the vector. A superseded record still embeds, still ranks and comes back carrying
  `superseded: true`; retrieval marks rather than decides. Which record replaced it, if any did, is a
  `supersedes` edge — kept separate because *"she left and has no new job"* is a retirement with no
  successor. Filtering on it is index-served, so *"only what is still believed"* costs nothing extra.

- **Resolving a contradiction now reaches retrieval, and draws the edge for every pair kind** (`Q-35`).
  `supersededId` was written onto the review finding and nowhere else, so a reviewer could settle a
  contradiction and change nothing at all about the next `recall`: both claims came back ranked together
  with nothing to choose between them. The losing RECORD is now marked, through its own writer so the change
  replicates and is audited, and the response carries `markedRecord`. The edge was drawn for entity pairs
  only, on the ground that a fact→fact edge would be stored and never walked — true when it was written, and
  no longer, since 5.0 made the walk follow an edge to a fact, chrono entry or file. Re-measured against a
  control before the refusal was removed. The one pair that still gets no edge is a pair of EDGES, because
  an edge is not a thing an edge can point at, and which kinds can is read out of `REF_KINDS` rather than
  restated — the `note` field says so in that case and in no other.

- **An attributed claim is stored without a vector, so nothing can rank it — and everything can still reach
  it.** Owner's decision: a model's contribution must not compete for space in an answer somebody asked a
  question to get, and must not be hidden either. Suppression is the one mechanism that is neither. A record
  with no vector cannot be ranked by `recall` even deliberately, while `filter`, `graph_traverse` and
  recall's own expansion still reach it in full, because the walk follows links and never consults a vector.

### Changed

#### The benchmark corpus and its extraction pipeline

- **The extraction prompt learned three things from reading a second corpus, which is what `B-5` is for.**
  Each was visible in the output with no question involved, which is the rule that keeps this work from
  contaminating the benchmark.

  **World knowledge is only worth recording when the conversation TURNS on it.** An assistant answers at
  length — lists of options, examples, background — and the rule as written would have made a claim of each
  one, burying the handful of facts about the person under a hundred records of generic advice. The test is
  now whether the exchange did something: the user picked one, said they would use it, or came back to it.

  **An approximation stays approximate.** *"For about three weeks now"* was being resolved to an exact day,
  which is searchable and invented. The anchor date is the exact part and the offset is as exact as the
  speaker made it — and a fuzzy span gets no chrono entry, because a chrono entry is for something that
  happened ON a date and one built from a guess puts a made-up day on the timeline.

  **A day may hold more than one session**, so each gets a `key` and each claim names its session.

- **The gate that keeps the extractor blind now derives its corpora.** Its title has claimed something
  about *"the extraction step"* since it was written, while its body read LoCoMo alone — so LongMemEval
  would have been covered by nothing, and it is the corpus that needed covering most. Adding a third is now
  a row rather than an edit to the assertions. Seen red before being believed: putting `has_answer` back
  into the loader's output fails it.

#### One API, two doors: the 5.0 renames

- **A link is audited again, as the sets a caller sends.** An audit entry recorded what changed by diffing
  the record before against the record after, and a record no longer carries its connections — so a re-link
  would have left an entry saying something changed and not what, which reads as *the links were untouched*.
  The fact, chrono and file update routes now fold the before/after link sets into their snapshots, under
  the names a caller writes: `linkEntities`, `linkFacts`, `linkChronos`.

- **`update_file_meta` honours the link fields its own description promised.** Both doors accept
  `linkEntities`, `linkFacts` and `linkChronos` on a file, and the MCP tool declares them, so the schema a
  caller reads while constructing arguments is the contract the dispatcher enforces.

- **A link id is existence-checked wherever it is written.** It was checked at each door for the array
  spelling and NOWHERE for `linkEntities`, so on a strict space one spelling was refused and the other
  stored. The check moved into the writer, which is what `write-connections.ts` always claimed. `save_bulk`
  checks its edge endpoints under the same `strictLinkage` setting the single-record doors read — a space
  that turns linkage off still accepts a staged import whose targets resolve later.

- **A refused link no longer leaves the record behind.** The existence check moved into the writers, and
  they reconcile AFTER the insert — so a link id naming nothing answered `400` with the record already
  stored, which is the silent unlinked write made noisy rather than fixed. Every writer now refuses the
  whole call before it touches anything, and the refusal is a `400` rather than a `500`.

- **A write door cannot ask for a link class that does not exist.** There are six, and a pair outside them
  has no label — so `save_fact` naming `linkChronos` stored a link nothing reads. Refused now, on both
  doors, and the create tools advertise only the classes their record kind can hold.

- **The UI reads a record's links as records.** The Brain and Files tabs draw their chips from one query
  over the links collection per page, and every form and label names the field the API takes. A searched
  list shows the same links the paged list does.

- **An index the conversion never created.** A space upgraded from 4.x got its `links` collection from the
  conversion's first insert, which creates a collection and no indexes — so the spaces with the most links
  to read were the ones reading them unindexed. The boot backfill now asks for the same index set space
  creation does.

- **BREAKING — three recall parameters renamed or removed.** 5.0 breaks every public name, and these three
  were each lying in their own way.

  | before | after | why |
  |---|---|---|
  | `includeFreshWrites` | **gone — the scan always runs** | the name read as *exclude recent records*, which is not what it did and not something anybody wants. Measured: a plain recall answered `count: 0` for **three seconds** after a write, then found the record. The cost of always scanning, on a space with 220 records inside the window: 91–101 ms against 159–167 ms, and nothing at all on a quiet space. Owner: *"if checking the parameter takes >10ms remove the parameter and just always do it."* A flag whose only function is to let a caller opt into a blind spot is not a performance feature |
  | `includeContent` | `includeFileContent` | it gates one field on one record kind — a file chunk's `content` — and nothing else. Read as a general switch it looked like the way to trim a large answer; that is `projection` |
  | `charsPerToken` | **gone — the ratio is fixed at 3.5** | it did nothing unless `maxTokens` was also set, and what the override bought was the ability to make an estimate differently wrong. A caller who needs the ceiling exact states `maxChars`, which is the unit the budget is applied in |

  All three are unknown fields now, so a caller still sending one gets a `400` rather than silence.

- **BREAKING — every tool is `POST /api/<tool-name>`, and both doors call ONE function.** Owner,
  2026-09-16: *"create modules that are used by both doors"*, then *"this shared module concept for both
  doors should be applied to each and every tool"*.

  ```http
  POST /api/recall
  { "space": ["work", "research"], "query": "quarterly targets", "limit": 5 }
  ```

  The body is the tool's arguments exactly — the same JSON you would send over MCP, `space` included. One
  envelope comes back for every tool: `{ok: true, text, data}` on success, `{ok: false, error, data}` on a
  refusal, with `error` word-for-word what MCP puts in `content`.

  **Two real defects fell out of the extraction**, both the same shape — one rule, two implementations,
  the weaker one deciding:

  - **The rung was checked against the FIRST named space.** Since space lists landed, a three-space
    `recall` over MCP was authorised against one of the three and read all three. The REST body-scoped
    guard checked every one. The check is inside the per-space loop now.
  - **The destructive-call throttle only existed on REST.** `bulkWipeRateLimit` was express middleware, so
    a browser was held to five wipes a minute and an agent to none. It is declared by the tool
    (`heavy: true`) and enforced in the shared function, before the gates — a caller getting it wrong in a
    loop is slowed down too.

  **`ythril_mcp_tool_calls_total` is renamed `ythril_tool_calls_total` and gains a `door` label** (`mcp` or
  `rest`). It was about to start counting browser traffic under a name that says MCP, which an operator
  reading a dashboard has no way to notice. `door="mcp"` is the old question, still answerable.

  The older REST routes are unchanged and still work. They are the shapes this replaces.

- **`help()` told every caller the two doors reach the same things, and that was false in twenty-two
  places.** `REST_ONLY_CAPABILITIES` was empty, its own comment called the emptiness *"the finished state
  rather than an oversight"*, and the gate guarding it asserted both halves of every row — so with zero
  rows it asserted nothing, for ever.

  The list now names what is actually missing: **network governance** (create, join, fork, invite, manage
  members, read the sync history, and cast a **vote** — an agent can belong to a governance process it
  cannot take part in), **a file's original bytes** (`read_file` returns extracted text, which is right for
  a document and wrong for a PNG), **the media embedding queue** (`retry_embed_media` can retry what no
  tool can list), **the per-type schema write**, and **the rights catalogue**.

  **What replaces the empty list is a derivation.** The build enumerates all 222 mounted routes and fails
  unless each is answered by a named tool, declared here, or classified as something an agent would never
  call — with the reason. A route in none of the three fails, so "I did not think about MCP" is no longer
  expressible, and the published capability table is generated from the same classification a gate holds
  true.

- **BREAKING — the knowledge type `memory` is now `fact`, everywhere, and 5.0 does not accept the old word.**

  | was | is |
  |---|---|
  | `remember`, `update_memory`, `delete_memory` | `save_fact`, `update_fact`, `delete_fact` |
  | `POST /api/brain/spaces/:id/memories` | `POST /api/brain/spaces/:id/facts` |
  | `<space>_memories` | `<space>_facts` |
  | `recordTtlDays: { memory }`, `memory.created` | `recordTtlDays: { fact }`, `fact.created` |
  | `ythril_memories_total` | `ythril_facts_total` |

  **The six array fields keep their spelling.** `memoryIds`, `includeMemories` and `chrono.memoryIds` are
  replicated and merkle-hashed, so renaming them is a wire break this release did not take. A link's synthetic
  edge LABEL does move, because its first half is the kind: `memory.entityIds` is now `fact.entityIds`.

  **Three boot migrations run once, automatically, and there is nothing for an operator to do** — but read
  what they cover, because every failure they prevent is SILENT and none of them would appear in a log:

  | migration | what it moves | what happens without it |
  |---|---|---|
  | `db/rename-memories-to-facts.ts` | `<space>_memories` → `<space>_facts`, and `memory.*` webhook subscriptions | a space reports zero facts while holding thousands, because reading a collection that does not exist is an empty result |
  | `config/migrate-memory-to-fact.ts` | `recordTtlDays: { memory }` → `{ fact }` | the retention window is unread, so those records are kept for ever |
  | `db/rekey-memory-kind-to-fact.ts` | the `_id` of every edge and link, plus tombstone types and queued embed jobs | a fact's connections match no query; a peer hits the unique index; a deletion is never served; a record never enters search |

  Each is idempotent, and each REPORTS a conflict rather than guessing: two collections with the same name,
  or an id another row already holds, are logged and left for a human. Watch the boot log once on the first
  5.0 start — a `WARN` there is the only case that needs you.

- **BREAKING — three tools fold into others, and the MCP surface is 45 rather than 48.**

  | gone | use instead |
  |---|---|
  | `er_model`, `GET /api/brain/spaces/:id/er-model` | `space_meta` / `GET /api/spaces/:id/meta` — the same answer arrives as `actualSchema` |
  | `find_entities_by_name`, `GET …/entities/by-name` | `filter` with `collection: 'entities'`, `filter: { name }` |
  | `list_chrono` | `filter` with `collection: 'chrono'`. `GET …/chrono` is UNCHANGED |

  **The `er_model` fold gains something neither half had.** `actualSchema` comes back in the DECLARED
  schema’s own format, so a type a space really holds can be **promoted into its declared schema** without
  the JSON being written by hand. They were always two answers to one question — a space can declare twenty
  types and hold three, or hold records of a type nobody declared — and a caller needed both to know either.

  **`list_chrono` was the only list TOOL any record type had**, while every type has a REST listing. Removing
  it makes the surface consistent rather than poorer, and its REST route is untouched. Every parameter it
  took is expressible — `status`/`type` as equality, `tagsAny` as `$in`, `after`/`before` as
  `startsAt: {$gte,$lt}`, and `search` as `$or` of two case-insensitive `$regex` — verified against the
  operator allowlist rather than assumed. The cost is four lines of predicate where there was one word.

- **BREAKING — every remaining MCP tool is renamed to the verb-first scheme.** 22 of them, on top of the
  search family that moved with its routes. No aliases: the old names are gone.

  | | |
  |---|---|
  | create or update a record | `save_fact`, `save_entity`, `save_edge`, `save_link`, `save_chrono`, `save_space`, `save_bulk` |
  | edit one by id | `update_fact` (was `update_memory`) |
  | delete | `delete_fact`, `delete_entity_preview` (was `entity_cascade_preview`), `delete_space_data` (was `wipe_space`) |
  | graph actions | `graph_traverse`, `graph_merge` |
  | the space | `space_stats`, `space_meta`, `space_reindex` |
  | schema, federation, embedding | `schema_update`, `network_peers`, `network_sync`, `retry_embed_record`, `retry_embed_media`, `retry_embed_file` |

  **What a caller changes: the tool name, nothing else.** No parameter, default, cap or refusal moved.
  `delete_space_data` is the one worth reading twice — it was `wipe_space`, and the new name says what it
  removes rather than what it does.

  **Three names were NOT swept, deliberately.** `remember` is also a brain function, `traverse` is also
  recall's `traverse` BODY FIELD — including its entry in the allowlist — and `reindex` is also a route
  segment. A blanket rename would have removed a documented parameter from `RECALL_BODY_FIELDS`, so every
  caller sending `traverse` would get a 400 naming a key the guide tells them to send. Measured before
  applying: of seven `'traverse'` sites in the server, two are the tool.

- **BREAKING — the search family is renamed and drops the space from its path.**

  | was | is |
  |---|---|
  | `query` — `POST /api/brain/spaces/:spaceId/query` | **`filter`** — `POST /api/brain/filter` |
  | `find_similar` — `…/find-similar` | **`similar`** — `POST /api/brain/similar` |
  | `recall` — `…/recall` | `recall` — `POST /api/brain/recall` |

  **The space is a body field on all three, and you may omit it.**

  Omit it and the search runs across every space the token holds `knowledge: read` in, ranked together. A
  `traverse` keeps its path deliberately: it walks FROM an entity, and an entity lives in exactly one
  space, so there is nothing to omit.

  **What a caller changes:** move the space out of the URL and into the body as `space`, or leave it out.
  A space you cannot read is skipped, not an error; a space you NAME and cannot read is a 403.

#### `filter` is the one read path

- **Every Brain tab reads through `filter` now, which is what the nine per-collection list routes were
  waiting on.** Facts, Entities, Edges and Chrono all issue one `POST /api/brain/filter`; the service
  re-keys `results` to the key each tab already destructures, so **not one caller changed** and deleting
  those routes becomes a server-only change.

  **What the client sends is arguments, not rules.** The fuzzy things — `tag`, `search`, `description`,
  `properties` — go as conveniences the server assembles; the exact ones — an entity's `name`, a fact's
  `entityIds`, a chrono tag set or date range — go as plain predicates. The line matters: a RULE written
  twice drifts, and a second copy of the substring-and-scan logic in the browser is the thing this whole
  row exists to avoid.

- **`filter` silently returned 100 rows to a caller who asked for 200.** `limit` was clamped, not
  defaulted — so a page came back short and `total` with `truncated` made it read as a correct short
  page. It matters because `filter` is replacing the nine per-collection list routes, which serve 200
  (`edges`, `files`) and 500 (`facts`, `entities`, `chrono`): the replacement returned LESS than every
  door it replaces, and those three did not agree with each other either.

  Owner, 2026-09-17: *"cap should be a parameter and default to 200"*. `limit` is that parameter on both
  doors, it defaults to **200**, and there is no maximum. The MCP schema carries no `maximum` for the
  same reason `windowDays` carries none: the dispatcher enforces the schema before the handler, so one
  would refuse a page the REST door serves.

  **What bounds an answer now that a row count does not** — and none of it is new, which is why the
  clamp was never the protection:

  | | |
  |---|---|
  | the byte budget | `maxChars` / `maxBytes` trims the page, says `truncated`, and hands back `nextSkip` |
  | `maxTimeMS` | hard-capped at 10 000, so an absurd `limit` is bounded in time |
  | a PROXY space | `skip + limit` past the merge ceiling is an explicit `400` naming the limit |

- **BREAKING — the fresh-write scan honours `filter` and `tags`, and it did not.** The scan adds records
  the vector index has not ingested yet, and it added them without applying the caller's predicate: a
  recall with `filter: {"type": "note"}` could return a record whose type is not `note`, at `200`. It was
  survivable while the scan was opt-in behind `includeFreshWrites`, because combining that flag with a
  filter was rare; making the scan unconditional made it the common case, which is how it was found. A
  filtered recall now excludes non-matching fresh records, as it always claimed to.

- **The filter sanitizer is its own module.** Owner: *"add the sanitizer and make it a real module."* The
  operator refusals and the ReDoS guard lived in `brain/query.ts` beside the query builder that happened to
  be their first caller, while the key-shape guard for the other filter grammar lived in `brain/filter.ts`
  — one rule, two files, each grammar protected by a different subset of it. `brain/filter-sanitizer.ts`
  answers the whole question for every door, and is where value coercion will go when it arrives.

- **`space` takes a LIST on `recall`, `filter` and `similar` — both doors.** Naming three of your twelve
  spaces used to mean three calls and a merge, or reading all twelve and paying for the nine you did not
  want. The byte budget is spent before a client-side merge, so that second option dropped results it never
  showed you.

  | you send | you get |
  |---|---|
  | `"space": "a"` | that space, as before |
  | `"space": ["a", "b"]` | exactly those, proxies expanded, deduplicated |
  | `"space"` omitted | every space the token can read |
  | `"space": []` | **refused** — an empty list is not "all" |

  **One named space you cannot reach refuses the whole call**, and the message names which. Filtering it
  away would answer with fewer results, and a caller cannot tell a filtered answer from a small one: "three
  matches" reads as *there are three* rather than as *you may not see the rest*. Omitting `space` still
  filters, because a caller who named nothing asked for whatever they can see.

  **Only the search family takes a list.** Every other tool acts on one space, and is handed a list it
  refuses rather than using the first entry — being told a write succeeded in a space you did not mean is
  worse than being told the tool takes one space.

#### Recall, expansion and the byte budget

- **BREAKING — a recall's expansion now brings the ATTRIBUTED claims of what it reached, unasked.** A claim
  an AI assistant originated is stored with no vector, so nothing can rank it. That is half a decision: it
  has to ARRIVE, or it is merely hidden by a different mechanism. So with `includeMemories` unsaid, a walk
  brings those claims — and no other fact.

  **A narrowing, not the whole class.** Admitting linked facts wholesale is what the flag's `false` default
  existed to prevent: *"a match is counted with its whole `_graph` subtree, so every record admitted by
  default is paid for in matches that no longer fit."* Measured on a live instance against a control space
  holding ten ordinary linked facts and one attributed claim:

  | call | bytes | graph nodes | attributed | ordinary |
  |---|---|---|---|---|
  | default | 2 894 | 1 | yes | 0 |
  | `includeMemories: false` | 2 332 | 0 | no | 0 |
  | `includeMemories: true` | 6 485 | 7 | yes | 6 |

  **`false` still means false.** An explicit refusal brings nothing, attributed included — a default that
  overrode it would make the flag stop meaning what its own description says. Absent and `false` were
  already kept apart by the parser, which is what made this expressible.

  **The standalone `graph_traverse` is unchanged**: its `includeMemories` is a real `false`, because its
  caller is explicitly exploring a graph and says what it wants.

- **BREAKING — `POST /api/brain/recall` returns the same result SHAPE as the MCP tool.** A hit is
  `{score, spaceId, type, record: {…}}` — the ranking beside the record rather than mixed into it. REST
  returned one FLAT object until now.

  ```json
  { "score": 0.86, "spaceId": "work", "type": "fact",
    "record": { "_id": "…", "fact": "…", "tags": ["…"] } }
  ```

  **What to change:** read `hit.record.<field>` where you read `hit.<field>`. `score`, `spaceId`, `type`,
  `_graph` and the per-stage scores stay where they were. Traversed neighbours under `_graph` are
  unchanged — they were already `{edge, node, paths}`.

  **`unrecognized_keys` is not on this route's 400 any more.** It came from `unknownBodyFields`, which a
  route uses when it parses its own body; the refusal now comes from the shared dispatcher, which names the
  offending key in `error` (`unexpected property 'topk'`). The other read routes are unchanged.

- **`POST /api/brain/recall` holds no implementation.** It was four hundred lines answering the same
  question as the `recall` tool, kept in step by somebody checking both every time either changed — and
  they had already drifted where nobody was looking (the byte budget, above). It hands its body to
  `callTool` now and translates the envelope back, which is what every door is supposed to be. The response
  shape is unchanged; `POST /api/recall` still returns the tool envelope.

- **A recall answer now spends the byte budget on what was remembered, not on where it is filed.**

  `maxChars` is a contract: it is how much of their context window a caller is willing to give to memory.
  Measured on a real corpus, **30% of what came back was content** — 3,314 characters of JSON carrying 986
  characters of remembered fact. The rest described the record's place in the store.

  Two rules, and only one of them is a choice. **An empty collection is never sent**: `"tags":[]` and
  `"properties":{}` say nothing their absence does not, and no caller can tell the difference — so that
  needs no flag and takes nothing away. **Storage bookkeeping is opt-in** through the new
  `includeRecordMeta`, default false on both doors: `createdAt`, `updatedAt` and the link-id arrays.
  Together they cut a response by about a third, and the space goes back to the caller as more evidence
  inside the same budget.

  `createdAt` is the one worth calling out: it is when the RECORD was written, not when the remembered
  thing happened. That lives in the record's own properties, put there by whoever stored it, and the two
  are routinely confused.

#### Spaces, tokens and the rights matrix

- **A token that reaches exactly ONE space no longer has to name it.** `space` is optional on every
  writing tool when the calling token's accessible-space list has one member — `save_fact({fact: "…"})`
  lands. With two or more it stays required, and the refusal lists the spaces you can choose between.

  **The schema you are SHOWN says so**, per token: `space` is absent from `required` for a single-space
  token and present for every other. Advertising and enforcement come from one materialisation, so a
  caller cannot be told to send something they need not, or told they may omit it and then refused.

  **A READ did not move.** `recall`, `filter` and `similar` treat an omitted `space` as *every space this
  token can reach* — an answer rather than a default — and folding the two would turn a cross-space
  search into a single-space one the day a token gained a second space.

- **BREAKING — emptying a space is `POST /api/delete_space_data`, and both doors call one module.**

  ```json
  { "space": "work", "confirm": true, "types": ["facts", "chrono"] }
  ```

  `confirm: true` is required on both doors now, and the route is named after the tool with `space` as a
  body parameter — the shape the rest of the REST surface moves to.

  **Two things the collapse changed that are worth knowing before you upgrade:**

  - **Emptying a collection no longer writes a tombstone per record.** The five routes did; the tool never
    has, because on a space belonging to a network it opens a governed round instead and every member
    wipes — so there is nothing for a peer to offer back. On a space in no network there is no peer. The
    tombstone-writing path had no caller left and is deleted rather than kept warm.
  - **Wiping entities unlabels every face, on both doors.** A face descriptor is a file-meta record
    carrying `faceEntityId`, and that cascade lived in the ROUTE — so the door being kept was the one
    without it, and `types: ["entities"]` would have left every labelled face pointing at a person who no
    longer exists. It is inside `wipeSpace` now, where neither door can drop it.

- **BREAKING — space administrator is a rung you GRANT, and four admin rungs are no longer it.**

  ```json
  { "spaceAdmin": { "floor": false, "spaces": ["work"] } }
  ```

  | | |
  |---|---|
  | `spaceAdmin` | ⟹ `admin` in all four areas of that space |
  | `admin` in all four | ⟹̸ `spaceAdmin` |

  **Two scopes, like everything else in the matrix.** `spaces` names them; `floor` reaches every space
  including ones created later. The floor form exists because a real configuration needs it: a token
  administering every space holds no per-space rows at all.

  **Nobody is stranded.** A boot migration writes the grant for every token that held all four — under the
  previous rule those tokens WERE administrators, and an upgrade is not the moment to reinterpret that. A
  floor of all-admin migrates to the floor form, never to a list of the spaces that happen to exist today.

- **`delete_space_data` asks what its REST routes ask.** It carried `admin: true` — instance admin — while
  the wipe routes need admin on the space in the path, so a space's administrator could empty it over REST
  and was refused over MCP.

- **A space's collection name is built in one place, and that place refuses an id it cannot vouch for.**

  Every per-space collection is `{spaceId}_{suffix}`, and 298 call sites built that string by hand. They now
  go through `spaceCollection(spaceId, part)`, which carries the check a template literal cannot: a space id
  must match `^[a-z0-9-]+$`, because `_` is the separator and three operations select a space's collections
  by that prefix — one of which DROPS them. An id containing `_` would make one space's collections carry
  another's prefix, so deleting `work` would take `work_archive`'s data with it.

  **Four collections turn out never to have been mapped at all** — `_file_tombstones`, `_media_jobs`,
  `_link_violations` and `_file_hashes` — alongside six more that were spelled out at every call. Nothing is
  renamed and no data moves; this is where the name comes from, not what it is.

#### Files

- **Removed: the metadata-only file delete.** `DELETE /api/brain/spaces/:spaceId/files?path=` purged a
  metadata record without touching disk. Every file has metadata and `deleteFileCascade` removes both, and
  the orphan case — a record whose bytes went missing out of band — is already handled by the file delete,
  which answers `204` when it finds one. It was a second door onto half of one act, and the half it could
  do alone left a file with no metadata.

#### Sync, peers and migrations

- **Two doors trigger a sync, and each one now says what it acts on.**

  `POST /api/networks/:id/sync` is the network door and has gained what the other route had: `?wait=true`
  and `?timeoutMs`. It also stops answering a bare `{ ok: true }` that said nothing about what happened —
  every door now answers `triggered`, `completed`, `timeout` or `error`, with `ok` kept as the one-bit
  summary so an existing reader is unaffected.

  `POST /api/networks/peers/:peerId/sync` is new, and syncs one peer across every network it belongs to.
  It sits on the networks COLLECTION rather than under one network's id because a peer is not a property
  of one network. The id is checked against the configured members and never treated as a URL.

  Both go through `sync/trigger.ts`, so a fourth door cannot invent a fourth set of semantics. The one
  asymmetry is deliberate and documented there: a network cycle races the timeout because it can span many
  peers, a peer cycle does not because it is already bounded by that peer's own request timeouts.

- **`POST /api/notify/trigger` is DEPRECATED.** Use the two routes above. It still works and delegates to the same code,
  so nothing breaks today.

#### Documentation, gates and internal structure

- **The graph guide's `Links` section is its own page, `04g-links-api.md`.** `04b-graph-api.md` sat on the
  900-line cap, and the last three changes to it each ended in compressing a paragraph to make room —
  which is the cap doing its job and being answered the wrong way. Links is a distinct capability with its
  own conversion story, its own pre-flight and its own lifecycle, so it is the boundary.

### Removed

#### The 4.x link arrays

- **BREAKING — the six link array fields are gone, on the wire, in storage and as input.** `fact.entityIds`,
  `chrono.entityIds`/`memoryIds` and `file.entityIds`/`memoryIds`/`chronoIds` were a record's connections
  written onto the record itself. A connection is a link RECORD and nothing else now, so an ordinary edit of
  a fact can no longer drop a link somebody else made, and one indexed lookup answers *"what points at
  this?"* where six collection scans used to.

  | you sent | send instead |
  |---|---|
  | `entityIds` | `linkEntities` |
  | `memoryIds` | `linkFacts` |
  | `chronoIds` | `linkChronos` |

  **The ids do not change.** A body still carrying an old name is REFUSED, with the new name in the message,
  on both doors — the whole call, so a record never lands without the connections it asked for. `[]` and
  `null` are refused too: the call that meant *detach everything* is the one that must not be read as *said
  nothing*.

  **They are no longer READ either.** A record comes back without them, `recall`'s `includeRecordMeta` no
  longer adds them, and a `filter` predicate over one matches nothing because no document has the key. To
  find what a record is connected to, walk it — `traverse`, or `recall`'s `traverse` object, both of which
  return the records rather than ids to look up one at a time — or filter the `links` collection directly.

  **Every space converts itself on the first 5.0 start, and a space whose conversion FAILED is refused
  rather than answered.** Every link read on it returns an error naming the space; answering "no links" for
  records that have plenty is the one outcome worse than an error. The failure is in the startup log.

- **The conversion pre-flight is gone with the arrays it watched** — `GET /api/brain/spaces/:spaceId/links/`
  `convert-preflight` and the `graph_link_preflight` tool. It answered *"who still writes the old lists to
  this space"* so an operator could convert with their eyes open; there is no shape left to write, so the
  question has no subject.

- **`completeLinkage` can no longer be turned off**, by anyone, an instance administrator included. It was a
  reversible setting while a space could be read either way. With one shape left, turning it off would mean
  *"read my links from a shape that does not exist"* — a working space that stops answering.

#### `filter` is the one read path

- **`POST /api/brain/filter` is gone, and with it the last second shape of any capability.** `B-9` step
  3c, which closes a row open since 2026-09-16. It was not a thin route over the `filter` tool — it was a
  SECOND IMPLEMENTATION of it: its own body validation, its own paging parse, its own proxy fan-out, its
  own budget resolution and its own error handling, four hundred lines beside a tool that already did all
  of it.

  Read a collection at `POST /api/filter` — the generic tool door, which has no per-tool code at all.

  **THE ENVELOPE CHANGES, and that is the port.** One shape for every tool, so a caller writes the
  response handling once:

  | | was | is |
  |---|---|---|
  | `200` | `{results, count, total, limit, skip, truncated, …}` | `{ok: true, text, data}` — all of that inside `data` |
  | a refusal | `{error}` | `{ok: false, error, data}`, with the same sentence the MCP door uses |

- **The five collection LIST routes are gone. Reading a collection is `filter`.** `B-9` step 3b, and a
  break: `GET /api/brain/spaces/:spaceId/{facts,entities,edges,chrono,files}` each answered what a
  predicate over one collection answers, with their own query grammar, their own page caps and their own
  response key.

  ```json
  POST /api/brain/filter
  { "space": "work", "collection": "facts", "limit": 100, "tag": "release" }
  ```

  | | the routes | `filter` |
  |---|---|---|
  | the rows | `{ facts }`, `{ entities }`, `{ edges }`, `{ chrono }`, `{ files }` | `{ results }`, whichever collection |
  | the page | default 50 or 100, hard max 200 or 500, and the five did not agree | `limit`, default 200, no maximum |
  | a fact by entity id | `?entity=<id>` | `filter: { entityIds: "<id>" }` |
  | an entity by exact name | `?name=` | `filter: { name: ... }` |
  | chrono tag sets and date ranges | `?tags=`, `?tagsAny=`, `?after=`, `?before=` | `$all`, `$in` and a `createdAt` range |
  | a file by path | `?path=` | `path`, an argument, normalised the same way |

  **THREE THINGS THE ROUTES DID THAT A CALLER NOW HAS TO ASK FOR**, and each is silent if you miss it:

  - **a chrono `status` derived on read** — send `deriveStatus: true`, or `active` means what is stored
    rather than what is true. The route always derived; `filter` defaults to the stored value because a
    predicate has to be able to match what is on disk.
  - **chunk records hidden from a file listing** — the route excluded them by default, `filter` does not.
    Send `filter: { parentFileId: { "$exists": false } }` or a converted document looks like the same
    file many times over.
  - **an unsupported paging name refused by name** — the routes answered `'offset' is not a parameter,
    use 'skip'`. `filter`'s body is strictly allowlisted so it is still a `400`, and it still names the
    parameter to use: the alias list moved onto the strict-body refusal rather than going with the routes.

  Nothing an operator does in the UI changed. `listFileMeta` went with them: it had no caller, because the
  file manager lists through the file STORE, which is a different question.

- **The five `GET` routes that read ONE brain record are gone. Read a record through `filter`.** `B-9`
  step 3a, and a break: `GET /api/brain/spaces/:spaceId/{facts,entities,edges,chrono}/:id` and
  `GET .../entities/by-ids` all answered what a predicate over one collection answers, with their own
  response shape, their own refusals and their own 404.

  ```json
  POST /api/brain/filter
  { "space": "work", "collection": "entities", "filter": { "_id": "8f3c…" }, "limit": 1 }
  ```

  A set of ids is the same call with `$in`, which is what `entities/by-ids` did; unknown ids are absent
  from `results` exactly as they were absent from `entities`.

  **The one behaviour that CHANGED, and it is the reason this is a `Removed` rather than a rename: a
  record that is not there is `200` with `results: []`, not `404`.** A predicate matching nothing and a
  record not existing are the same event to a filter, and pretending otherwise would mean `filter`
  answering 404 for an ordinary empty page. Branch on `results.length`.

  **Two things the routes DID after the query, which a straight swap drops silently.** Both are
  identical on most records and wrong on exactly the record somebody is looking at:

  | | the route | `filter` |
  |---|---|---|
  | a chrono `status` | derived on read | the STORED value unless `deriveStatus: true` |
  | `matchedText`, `embeddingModel` | returned by a by-id read, withheld by the list beside it | withheld unless `includeDiagnostics: true` |

  Send `deriveStatus: true` on a chrono read to get what the route gave you; it is refused on any other
  collection rather than ignored. The diagnostics default is now the same on both shapes, which the two
  routes never were.

  Nothing an operator does in the UI changed: the client was already reading everything else through
  `filter` and now reads these the same way.

#### Sync, peers and migrations

- **`POST /api/notify/trigger` is gone. Trigger a sync through the door that names its subject.** Deprecated
  in 4.5, removed here: `POST /api/networks/:id/sync` for a network and `POST /api/networks/peers/:peerId/sync`
  for one peer across every network it belongs to. The body goes into the path; `?wait=true` and `?timeoutMs`
  behave exactly as they did, and the answer shape is unchanged.

  **ONE BEHAVIOUR DOES CHANGE, and only a request shows it.** The removed route accepted any `networkId` and
  answered `200 {status:"triggered"}` for one that does not exist, because it fired and forgot before
  anything looked. **Both replacements validate their subject first and answer `404`.** A caller that
  fire-and-forgets a stale or mistyped id used to get a success it could not act on; it now gets a refusal
  naming the subject. Nothing else about the two doors differed.

  **It was removed rather than left working because the NAME was the defect.** A sync trigger sat on the peer
  notification channel, so the guard-coverage gate was told to look away by a router-wide exemption written for
  the notification endpoint beside it — and the route accepted any valid token, one with every area `none` and
  no spaces, until 4.4. With it gone the exemption's reason is finally true of every route on that router.

  **And the deletion moved something nothing would have reported.** `network_sync` was audited under
  `sync.trigger`, which was THIS route's operation, so removing the route would have left the tool writing a
  name no route records: an operator filtering the audit log by the REST operation would have seen no agent
  traffic, and the cross-door parity gate would have gone quiet rather than red, because an unpaired tool is
  skipped. A gate now refuses any tool whose operation no route records.

  **A tool may now name more than one REST operation**, because `network_sync` IS both routes — a full cycle or
  one named peer — and REST spells them apart only because a path has to name its subject. With a single name
  the parity gate compared the tool against half of itself and called `peerId` a parameter no route accepts.

### Fixed

#### The benchmark corpus and its extraction pipeline

- **A tracker row said the graded benchmark harness exists. It was deleted eight weeks ago** (`B-2`).
  The row opened *"it is a DECISION rather than a build: the harness exists (`benchmarks/harness/` —
  dataset, ingest, retrieve, grade, report, pins)"*, and there is no such directory: `#1282` removed 56
  files on the owner's instruction, because everything in them rested on one premise — that a
  conversation is a pile of transcript chunks — under which **multi-hop scored 0.0% across all twelve**
  strategies built on it, since those answers need two remarks from sessions weeks apart.

- **The extraction prompt opened by describing one corpus, and five sections now contradicted it**
  (`B-5`). Its first paragraph said *"a long conversation between people, recorded over many sessions
  spread across months"* — written against LoCoMo and true of it. By the time the second corpus had
  been read, the sections below covered a person and an assistant, a fortnight with six sessions in a
  day, sessions handed over out of time order, and a turn that is an entire pasted document. The
  opening paragraph is the first thing a model reads and it was telling it none of that applied.

  It now says the shape is not to be assumed and names the four that have their own section, because a
  rule written for one shape applied to another is the failure every one of those sections exists for.

- **A history's sessions are handed to extraction in TIME order, which the release is not** (`B-5`).
  Measured across the pinned corpus: **211 of 500 histories list their sessions out of chronological
  order**, 3,382 backward steps, the largest a full day. LoCoMo: **0 of 10** — so nothing in the harness had
  ever needed to think about it, and the array order was being read as time everywhere.

  That is worse than untidy. The extraction prompt's supersession rule is *"when a LATER session makes an
  earlier fact wrong"* and the parts protocol splits on *"a contiguous run of sessions"*; told to retire the
  earlier claim, a model reading position would retire the wrong one in nearly half the corpus — asserting
  the stale fact and marking the current one dead, which is the exact inverse of what supersession is for
  and appears in no count.

- **A day with more than one session no longer loses all but the last of them** (`B-5`). The writer named
  each transcript `transcripts/<date>.md` and filed each claim by `statedOn`. That is correct for a
  conversation with one session a day and silently destructive for one without — measured across both
  pinned corpora, LoCoMo has **0 of 272** sessions sharing a date and LongMemEval has **18,565 of 25,112,
  in 500 of 500 histories**. Six sessions on one day became one transcript, keeping the last, and all six
  sessions' claims were filed under whichever survived. Nothing failed: the space held most of the
  conversation, and a question about a lost session returned nothing, which reads as a retrieval result.

  A session now carries an optional `key` and a claim an optional `session`, both falling back to the date
  so none of the ten committed LoCoMo extractions changes. Two sessions resolving to one identity are
  REFUSED by the validator, before the first record is written — a key that merely defaults to the date is
  a fix a caller can forget, and forgetting it restores the overwrite exactly. The writer holds no second
  copy of that check: `writeSpace` validates first, so a copy there could not be reached, and an
  unreachable guard is a claim about safety rather than safety.

- **A product rule was justified by a benchmark corpus, in the text every ingest reads.** The assistant-turn
  rules shipped citing *"54 of the 896 evidence turns"* and *"842 of the 896"* in the extraction prompt —
  and there is one ingester, so those sentences are read when somebody ingests a support history, a
  transcript or an agent's own conversation. The rules were right on product grounds and said so nowhere.

  **Tuning does not arrive as a decision, it arrives as a justification.** A rule that cites a corpus
  teaches the next reader it exists for the benchmark, and the day the corpus changes somebody deletes it.
  The rules now stand on what is true of any conversation; the measurements stay in the changelog and the
  tracker, where a number about a corpus belongs.

  A gate holds it: no product-facing instruction may name a pinned corpus, with the names derived from the
  pin files rather than listed, because a corpus is added by dropping a `pin.json` in — which is exactly
  the moment nobody edits a gate.

#### One API, two doors: the 5.0 renames

- **Another seventeen schema descriptions told a caller to use `query`, a tool 5.0 renamed `filter`** —
  *"sortable by `query`"*, *"filterable by `query` on the `files` collection"*, *"as `recall` and `query`
  report it"* — plus a dozen more naming `traverse` where they meant `graph_traverse`. All of them sit in
  the text a caller reads while constructing a call.

- **Twenty-four sentences still sent a caller to a tool 5.0 had removed.** A rename is the one change that
  passes the compiler while leaving the writing wrong, and these were in the writing a caller reads while
  constructing a call: `save_entity` told them to look an entity up with a tool that is gone, `space_meta`
  told them to read the shape with `er_model` — which it had absorbed — ten chrono sentences named
  `list_chrono` after `filter` replaced it, and the integrator's MCP page described what `merge_entities`
  carries over the webhook. Each now names the live tool.

  **Nobody would have reported any of them.** A caller sent to a tool that is not there does not file a bug
  about the sentence; they conclude the capability is missing. So the fix comes with a gate that derives the
  retired set from the previous major's last release tag rather than a list, and holds every tool
  description, every guide page and every use-case example to naming only tools that exist — unless the
  sentence is saying the old one is gone, which is the most useful sentence a migration note has.

#### `filter` is the one read path

- **`filter` finds one file by `path`, and forgives how you spell it.** *(files only, both doors.)* The
  file-metadata list route always did — it ran the path through the same normalisation the store uses, so
  a Windows-style spelling and a leading slash both find `notes/a.md`. `filter` did not, and
  `filter: { path }` is a bare equality: a caller holding a path from their own filesystem got an empty
  page and a `200`, which reads exactly like "no such file".

  It is EXACT after the normalisation — not a prefix, not a substring. For those there is `search`, which
  also spans the description.

  **Sending both spellings is a `400` rather than one of them quietly winning.** `path` and
  `filter: { path }` are two ways to ask one question and only the argument is normalised, so together
  they would disagree — the same call `recall` made about its two filter grammars.

- **`filter` returned an edge as two bare UUIDs, and a file with no job progress.** Two of the nine
  per-collection list routes do work on their rows AFTER the query, and the one call meant to replace all
  nine did neither: `GET .../edges` resolves both endpoints' display names — batched by endpoint KIND,
  because an entity's name is `name`, a chrono entry's is `title` and a fact's is `fact` — and
  `GET .../files` joins the embedding job's step progress for rows still in flight. `filter` now does
  both, on the tool and on `POST /api/brain/filter`, through one module.

  **A decoration is not a parameter, which is why nothing had reported this.** It appears in no body
  allowlist, no `inputSchema` and no capability map, so the two doors were never compared. The retirement
  of those routes would have taken both with them silently — an agent reading edges would have started
  getting ids where a browser gets names, and the Files tab would have shown a stage indicator that never
  resolves.

  **`includeDiagnostics` was the third, and it was refused rather than ignored.** Four list routes honour
  it; `filter` accepted it nowhere — a `400` on the route, an `additionalProperties` refusal on the tool.
  It is accepted and APPLIED on both doors now, defaulting false on each. Admitting it without wiring the
  projection would have been the worse half: a `200` with the flag doing nothing.

- **An agent could not ask for "facts tagged release", and a browser could.** `filter` took a MongoDB
  predicate and knew nothing else, while the nine per-collection list routes it is meant to replace have
  always accepted five conveniences: `tag` (a case-insensitive SUBSTRING over the tag array, so `rel`
  finds `release`), `type`, `description` (that column only), `properties` (a value scan) and `search`
  (freetext over the collection's own text fields). Both doors were present and one accepted less, which
  is the half of the parity rule that hides — and it hid here for as long as the capability map paired
  the tool with the routes and called the pair answered.

  All five are arguments of `filter` now, on the tool and on `POST /api/brain/filter`, in the same
  change. `filter` itself is no longer REQUIRED: narrowing by tag alone used to mean sending
  `filter: {}` to say "and no predicate", which is a shape you have to be told about.

  **`links` refuses rather than ignoring.** It is a pair of ids, with no tags, type, description or text
  of its own, so `search` there would have matched every link in the space — and a filter that matched
  everything is indistinguishable from a filter that was ignored. Both doors answer with the same
  refusal naming the collection. Same shape as the `links` sort crash fixed earlier this release: the
  answer lives in the function that RECEIVES the collection, not at a call site.

- **`filter` takes `entityName`, `fromName` and `toName`.** They were REST-only, so an agent could not ask
  for “facts about Alice” by name — it had to filter entities, take the ids, then filter facts, and on a
  proxy space the ids differ per member. They are a JOIN rather than a predicate, which is why no Mongo
  filter a caller writes can express them. Refused on a collection they cannot mean rather than ignored.

- **`filter` refused a bad `skip` and quietly ignored a bad `limit`.** One endpoint, one question — where
  does this page start and how big is it — and two answers to a value it cannot use. `skip: "abc"` was a
  `400`; `limit: "abc"`, `limit: -5` and `limit: 0` were accepted and silently answered with the default,
  which is a page nobody asked for with a `200` on it.

  Both refuse now, through one parser. The per-collection list routes had to coerce — a query string has
  no types, so `?limit=abc` is indistinguishable from a caller who meant something. A JSON body does, so
  there is no guess left to make, and this only became visible when the last list callers moved across.

- **The filter nesting cap counted the SERVER's clauses against the CALLER's budget.** `MAX_FILTER_DEPTH`
  bounds what a caller may ask for, and it was enforced at the last moment before the database — by which
  point the caller's filter had the server's own composition wrapped around it.

  That budget was already spent. A derived chrono `overdue` clause is itself depth 8 — an `$or` over an
  `$expr` over a `$toDate` over an `$ifNull` — so `deriveStatus: true` plus ANY convenience reached 9 and
  was refused with `Filter too deeply nested`, about a filter the caller had written one level deep. The
  combination it refused is `?status=overdue&search=…`, an ordinary query on the list route being removed
  in the same release: the capability would have gone quietly with it.

- **`filter` matched a chrono `status` against the STORED value while the list route matched the DERIVED
  one, so the same question returned different records.** `deriveStatus` made the displayed status
  askable; this is the half that changes which rows come back. `status: "active"` returned a fortnight-old
  episode through `filter` and not through the list route, and `status: "overdue"` found derived ones
  through the route and only hand-typed ones through `filter`.

  `deriveStatus: true` now means the whole call speaks in derived terms, predicate included — through the
  same clause builder the route uses, extracted rather than copied, because `whenDuePasses` makes "what a
  passed due moment means" a per-TYPE decision and a second copy would be a second answer to it. A
  `status` nested inside `$or`/`$and` is REFUSED rather than rewritten: the derived clause is itself a
  disjunction in two of the three cases, so folding it into a caller's would change what theirs means.

- **The filter sanitiser silently turned a `Date` into `{}`.** Found by the above: it walks a filter and
  rebuilds each object key by key, and `Object.entries(new Date())` is empty — so a date value came out
  as an empty object, the comparison it was part of stopped meaning anything, and the query answered
  `200` over the wrong set.

- **BREAKING — `filter: {"type": "note"}` was accepted and silently DROPPED.** A bare scalar value was read
  as a malformed operator object — the grammar where a value is spelled `{"eq": "note"}` — so the
  translation produced no predicate and the recall answered `200` with the **unfiltered** ranking.
  `{"type": "NOT-A-REAL-TYPE"}` returned every record. It is the defect the fleet integrator reported on
  `/query` (*"it cost us a fabricated number"*), on the spelling the schema description now recommends, and
  it went unbounded the moment the filter key allowlist was removed.

  Which grammar a filter is in is now decided by the shape of its VALUES rather than by whether a `$`
  appears anywhere: the operator-object form is every value being an object whose keys all come from the
  eight names it has, and everything else — a scalar, an array, a `$`-operator, a sub-document — is
  ordinary MongoDB. A filter that mixes the two is still refused rather than guessed at.

- **`{"$where": {"eq": "x"}}` reached the database.** The operator-object path has no sanitizer between it
  and Mongo, and the key check that had been incidentally blocking `$`-prefixed keys went with the field
  allowlist. Anything `$`-prefixed now routes to the raw path where the sanitizer lives, with a floor under
  it so a change to the classifier cannot reopen the hole. `__proto__`, `constructor` and `prototype` as
  filter keys are refused on both grammars for a related reason: `out[key] = …` on a plain object would set
  the prototype and add no key, so the constraint vanished from the filter and the query answered `200`
  unfiltered.

- **A raw Mongo filter was always exhaustive, including when the index could serve it.** `{"type": "note"}`
  is an equality on a declared field and pushes into `$vectorSearch` natively; it was taking the full scan
  on the note that *"a raw filter is never declarable"* — true of `$or`, false of the common case, and
  newly expensive because raw Mongo is now the recommended grammar. `$or`, `$not`, `$exists`, `$regex` and
  anything nested still go exhaustive as a whole: half a filter pushed natively would restrict the
  candidate set before scoring and silently change which records `topK` is filled from.

- **`entityName` could not see a record linked the recommended way.** A fact or chrono entry attached with
  `linkEntities` — the form the integration guide leads with — was invisible to `?entityName=`, on both
  doors, and the filter said so by answering `{facts: [], total: 0}`. Not an error: it reads as *there are
  none*.

  | written with | `entityIds` array | link record | found before |
  |---|---|---|---|
  | `entityIds: [id]` | populated | written | yes |
  | `linkEntities: [id]` | **empty** | written | **no** |

  Both shapes are read now, through one predicate. **Neither side is complete on its own** — the arrays
  miss what `linkEntities` wrote, the link records miss what predates the upgrade — and both coexist on
  every space written to since. If you have been filtering by entity name and getting short answers, this
  is why.

- **The `filter` MCP tool required a space while its route did not — one rule, two doors, the MCP one
  narrower.** Introduced by the change that moved the search family off the space path: `POST
  /api/brain/filter` took an optional space and read across spaces, and the tool kept demanding one. An
  agent asking the obvious question — *what do I have about X, anywhere* — got a validation error through
  one door and an answer through the other.

#### Recall, expansion and the byte budget

- **`POST /api/recall` answered to HALF the byte budget of `POST /api/brain/recall`.** 25 000 characters
  against 50 000, same server, same capability, same transport — because the tool module picked MCP's
  default itself, which was correct while MCP was the only door it had and stopped being correct when
  `B-9` gave every tool an HTTP one. The lower default belongs to the TRANSPORT that received the call, not
  to the module that answers it: `defaultBudgetChars(transport)` is the one place that is decided.

- **The recall guide said `includeDiagnostics` hides the per-stage scores. It does not, deliberately, and
  has not for some time.**

  `lexicalScore`, `fusedScore` and `rerankScore` are returned unconditionally on both doors — the reasoning
  is in the code and it is sound: the number that DECIDED a result's position must not be the one a caller
  cannot read, and three floats are not a cost worth a flag. The flag governs `matchedText`,
  `embeddingModel` and `seq`, which is three fields rather than six.

- **The guides now say which cross-encoder to pick, because the wrong one is a regression rather than a
  no-op.** Same instance, same questions, same budget, only the model changed: no reranker 45.7% first
  answers right, `bge-reranker-base` **27.4%**, `ms-marco-MiniLM-L-6-v2` **53.8%**.

  A cross-encoder replaces the retrieval ordering, which is right when it knows better and catastrophic
  when it does not. The failing model saturated — 0.9958 for the right passage against 0.9969 for a wrong
  one — so a difference of 0.001 overturned a vector margin of 0.100, confidently, on every query. Nothing
  in the API can say a reranker is making things worse: from outside, a worse ordering looks exactly like
  an ordering. So the advice is to pick a model trained for question-to-passage relevance, and to measure
  it against no reranker on your own corpus before leaving it on.

#### Links, edges and entity merges

- **A traversal answered per NODE while its response promised per EDGE, so a self-loop and a second edge
  between one pair were silently dropped** (`Q-24`). Reported from outside against a live instance and
  reproduced through both graph-reading doors. `truncated` stayed `false` throughout — which the product
  documents as *"nothing was cut for size reasons"* — so the one signal a caller had for an incomplete
  answer was actively saying the answer was complete.

  **So the answer is the subgraph: the nodes reached, and every relationship among them.** `traverse`
  already returned a flat `edges` list and its shape is unchanged — it now holds every edge among the
  returned nodes rather than one per node, and an edge to a record that is not in `nodes` is still left out.
  **`recall(traverse: n)`'s `_graph` entries carry `edges` (plural) in place of `edge`**, whole documents as
  before, and a record that loops back on itself appears as its own neighbour. Both doors, same commit, plus
  the two schema descriptions, the recall and graph API guides, and the sentence in the graph guide that
  said the list held *"only the edges actually traversed"*.

  **The endpoint ids go, and the answer gets SMALLER rather than larger.** Every edge in one `_graph` entry
  joins the same pair — this node and the one it is nested under — so `from` and `to` were two UUIDs per
  edge restating what `node._id` and `paths[0]` already say. They are replaced by `direction`:
  `outbound`, `inbound`, or `self` for a record joined to itself. The far end is
  `paths[0][paths[0].length - 2]`. The flat `edges` list on `POST /traverse` is unaffected — it has no entry
  around it to state the ends — so this is one shape changing, not two.

- **The recorder-start stamp could be skipped by an unrelated failure five statements earlier.** The
  conversion pre-flight clamps its `since` to when this instance began recording, so an unstamped
  instance reports the full retention window over a recorder it cannot vouch for — the defect `B-13`
  was filed for, where a space of 270 chronos answered `count: 1`.

- **A record's links and edges can be changed after it is created.** `linkEntities`, `linkFacts`,
  `linkChronos`, `linkFiles` and `edges` are now accepted on the UPDATE verb of every door that accepts
  them on create — `facts`, `chrono` and `entities`, on both surfaces — with the same meaning they have
  there: links REPLACE per class (`[]` detaches, a kind you do not name is untouched) and edges UPSERT.

  **Until now they were create-only, and on a converted space that left no way at all.** `entityIds` and
  its siblings were the workaround, and `array-write-refusal` refuses those outright once a space has
  been through the link conversion — so a record's relationships were settled the moment it was written,
  by either door, and the gap grew as spaces converted. The only way round was to delete and re-create
  the record, which costs its id and its history.

  **`edges` rides in the same body**, so an edge can be drawn or adjusted through the record it hangs
  off, on an update as well as a create.

- **Merging two entities left every LINK RECORD pointing at the entity it had just deleted.** `merge.ts`
  relinks edges, facts, chrono entries and file metadata by rewriting their `entityIds` arrays, and had
  no reference to the `links` collection at all. On a space that has been through the link conversion —
  which every space becomes at the boot after it is created — the links therefore survived the merge
  unchanged, pointing at an id phase 5 then removed.

  **A link is RE-KEYED rather than updated.** Its `_id` is derived from both endpoints, so moving the
  `to` changes its identity — the same reason edges have a re-key path. The old id gets a tombstone, or
  the next pull from a peer still holding it would re-create the dangling link and undo the repair.

  **Deleting an entity was never exposed to this**: the delete guard reads link records and refuses with
  a `409`. A merge deletes the absorbed entity directly rather than passing that guard, which is why it
  was the one path that could do it.

- **The link conversion DELETED links that existed only as records, and its own log said it removed
  nothing.** The 5.0 migration walks each record and reconciles its links from the legacy ARRAY fields.
  A link written through `linkEntities` before that spelling was fixed exists as a link RECORD with an
  empty array beside it — so the desired set said "this record links to nothing" and the reconcile
  deleted it. **With a tombstone**, so the loss replicated to every peer and a re-run could not repair
  it.

  The operator was told the opposite in the same breath: *"It is additive: nothing is removed, the
  arrays keep being read until a space is marked."*

  The conversion no longer deletes, and it reports the creation count `reconcileLinks` already returns
  rather than measuring around it. **An ordinary write still deletes** — `linkEntities: []` means
  detach, and that is the whole point of it — so the exception is pinned by a gate to the one module
  entitled to it: a sync ingest that became additive would stop honouring a peer's detach and the link
  would return on every pull.

  **If you converted a space while holding record-only links, those links are gone and the tombstones
  are with them.** They can be re-created; nothing else was touched.

- **A test wrote the retired link arrays to the built-in `general` space, and failed whenever the stack
  had restarted.** Every boot converts every space that is not yet marked, so `general` becomes
  `completeLinkage` and then refuses `entityIds` / `memoryIds` — correctly. A rebuild wipes the config,
  so the first-run boot converts nothing and CI never saw it; any restart that preserves the config did.
  The failure named the link migration, which the test had nothing to do with.

  A new gate refuses an array-link field aimed at a space a test did not create.

- **A walk did not return the node it started from, so an isolated record and a bad id looked the same.**
  `graph_traverse`'s own schema has always described *"`startId` itself at depth 0, so a walk that finds
  nothing still comes back with one node rather than empty — an empty `nodes` means the id resolved to
  nothing, which is a different answer from 'it has no neighbours'."* It never sent that node.

  The start node counts against `limit`, because it is a node: `limit: 1` answers the start alone, which
  is also the cheapest way to ask whether an id exists. **An id that resolves to nothing is still empty**,
  which is the other half — the promise is only useful while a bad id is actually empty.

  A walk started from a fact or chrono entry returns that record, with its `kind`, resolved exactly as a
  neighbour is.

- **`linkEntities` and its three siblings were accepted with a `201` and the link was reached by
  nothing** — on any space created since the instance last restarted.

  A link is stored in two shapes during the 4.x transition: a record in the space's `links` collection,
  and the array on the record itself. `usesLinkRecords` picks which shape a space is READ through, and
  `link-adjacency.ts` calls it *"the ONLY place that decides"* — which was true of readers and of nothing
  else. The writer wrote a link record and stopped, so on a space still read through the arrays it wrote
  a row every reader looks away from: not `traverse`, not a graph-augmented `recall`, not the delete
  guard.

  **The conversion that flips a space runs at BOOT**, so a space created afterwards keeps the array path
  until the next restart. The same call therefore worked or silently lost the link depending on when the
  instance was last rebooted — which is why it went unreported: a reporter could not reproduce it and a
  responder could.

  The writer now resolves the shape through the same selector every reader uses. **Nothing about the
  request changed**, and a caller who worked around this with `entityIds` is unaffected.

- **An edge you drew to a fact, chrono entry or file was stored and reached by nothing.** An edge declares
  the kind at each end, the writer REFUSES a kind that does not match the record, and the edge is then
  validated, stored, hashed and replicated — so `supersedes` between two claims is a real edge that
  everything accepted. The walk resolved every neighbour against the entities collection alone and dropped
  whatever was not there: no flag, no `truncated`, no error. On the Graph tab such an edge was saved, listed
  on the Edges table, and never drawn.

  **No include flag governs it, and the asymmetry is deliberate.** `includeMemories` and `includeFiles` are
  opt-in because they follow IMPLICIT links — a record that happens to name this one — of which a busy node
  has thousands. An edge exists only because somebody drew it, so there are exactly as many as were meant.
  A record reached through an edge also EXPANDS, unlike one reached through a mention: an edge chains, and a
  chain of `supersedes` stopped at one hop would answer a fragment and call it the neighbourhood.

  **A walk may now start from a fact or a chrono entry**, not only an entity.

- **A declared edge end could not be REMOVED once its entity type was deleted.** Owner-reported. The
  ends picker listed one checkbox per entity type the space currently declares, so a name stored on the
  edge and no longer declared had no checkbox at all — nothing to untick, still enforced, invisible on a
  control that looked complete. It lists the union of the vocabulary and what is already picked now, and
  marks the strays, so an operator meeting a name they do not recognise can tell what it is.

- **The conversion pre-flight claimed ninety days on an instance that had been recording for thirty
  minutes.** Reported by the canary operator 2026-09-15 with a controlled measurement: the endpoint caught
  a single `entityIds` write within two seconds and named the token and the field — it works — but the
  space holds 270 chronos already carrying `entityIds`, `count` was 1, and `since` reported ninety days
  back because that is `retentionDays`.

  `since` is clamped to when this instance began recording, and the new `recorderStartedAt` says why a
  ninety-day request came back as half an hour. The stamp is written once when the instance's services start —
  the path a first-run install goes through too, not only a restart — and it is **the oldest existing
  note rather than `now`** — a note from sixty days ago is proof the recorder was running sixty
  days ago, and stamping `now` would make an instance that has recorded for a year claim it started
  today. `null` means it has not started since this shipped, so nothing can be clamped.

- **Sorting `links` crashed instead of sorting, and on the REST door it crashed as a RETRYABLE 500.**
  Reported by the canary operator 2026-09-15 against the tool door, which answers
  `Cannot read properties of undefined (reading 'has')`. Measured here, the REST door is the worse half
  and was not in the report: `500 {"error":"Internal server error","retryable":true}` — telling a caller
  to retry a request that can never succeed.

  `SORTABLE_FIELDS` declared five collections while the `collection` enum offered six, so the lookup was
  `undefined` and `allowed.has()` threw where the tool's own text promises the field "is refused and
  names the allowed ones". `links` now sorts by `createdAt`, `updatedAt`, `from` and `to` — a link has no
  name, title or type of its own, it IS a pair of endpoints.

- **The link conversion runs itself at boot, because the documented way to run it could not be run.**
  The canary operator, 2026-09-15: `npm run links:convert` on a deployed instance answers

  ```
  Error: Cannot find module '/app/scripts/convert-links.mjs'
  ```

  Every start now converts each space not yet marked `completeLinkage` and marks the ones whose walk
  finished cleanly. It is additive — links are created, no array is removed, a space reads correctly
  before, during and after — so an interrupted run is fixed by the next boot, and an already-marked space
  is skipped outright. Owner: *"make the script autorun at startup … remove that on 6.0"*, recorded as
  `_DEPRECATIONS.md` row 6.1.

  **A boot migration over synced data is normally forbidden, and the peer floor is what suspends it.**
  `MIN_PEER_VERSION` derives from our own major, so a 5.0 instance refuses every 4.x peer at the
  handshake and no peer can write the arrays back. `renameMemoriesToFacts` runs at boot in the same
  release on the same argument.

#### Claims, chrono, supersession and contradictions

- **A claim an AI assistant originated is marked, so the graph records that it was SAID rather than that it
  is SO.** Ingesting a chat log is not ingesting a conversation between people: an assistant's turn may
  state a fact about the world, hand back one the user just gave it, or invent one — and until now nothing
  told the extractor which, so a model's guess would land beside the user's own words and rank the same.

  Three rules, and the middle one carries most of the weight. An assistant turn is CONTEXT first, read to
  resolve the user's (*"Yes."* means nothing alone). A fact is attributed to whoever ORIGINATED it, not to
  the turn it was read in — most of what an assistant appears to state is the user's own fact echoed back.
  What is left, where the assistant really is the origin, is written with `attributed: true`.

  The mark is a declared boolean on the claim type, so a filter on it is a native index pre-filter on both
  doors rather than an exhaustive scan, and the validator refuses a file in BOTH directions — an unmarked
  assistant claim, and a person's claim wearing the mark. The second is the quiet one: it retires a real
  fact from every reader that filters, and nothing contradicts it.

- **A chrono entry's `status` meant two different things, and which one you got was decided by the DOOR
  you read through.** The chrono list route returns the DERIVED status — `overdue` where a due moment has
  passed, unless the type's `whenDuePasses` says otherwise — while `filter` and sync return the value the
  collection holds. Both are correct, and a predicate read must see the stored one or it cannot be used
  to repair anything. What was wrong is that the two were indistinguishable from outside.

  Reported in substance by the canary operator, 2026-09-15, after a fortnight-old episode read `active`
  through one door and `overdue` through the other: *"'I checked the status' is not a claim anyone can
  evaluate without the door being named"*. Every attempt they made to confirm the suspicion queried the
  collection, got `active`, and read as a clean bill of health. It degrades rather than breaking, too —
  a record read shortly after it is written still says `active`, so code built against the stored literal
  works the day it ships and starts failing only as records outlive their due moment.

  `filter` takes `deriveStatus` now, on both doors, **defaulting false** — so every existing caller sees
  exactly what it saw before, and the client asks for `true`, so the Brain page is unchanged too. Nothing
  moves for anybody who does not ask. Sending it on any collection but `chrono` is refused rather than
  ignored: a silently dropped flag is a caller who believes they asked for something.

  **And the operator page now says the status it shows is worked out rather than stored**, because that
  is the half an operator meets: a backup or an export reads what was stored, so an entry the page calls
  overdue reads as active there.

- **A derived chrono status could not be combined with a convenience.** The status rewrite ran AFTER the
  conveniences, which accumulate under `$and` — so a caller's top-level `status` was buried in one by the
  server, and the rewrite's refusal (written for a `status` the CALLER nested inside `$or`) fired on the
  server's own transformation. The error told the caller to put `status` at the top level, which is
  exactly where they had put it. The rewrite reads the caller's filter first now.

#### Schemas and the space editor

- **A suppressed record being REACHABLE had never been tested, only its being stored.** Three schema descriptions promise that
  a suppressed record cannot be ranked but is still reached — the behaviour the field was renamed for in
  August, after *"i want entries to be findable via traversal even if they are not embedded themselves"*.
  The suite proved suppression is STORED, that `false` is stored rather than dropped, and that a re-embed
  sweep skips it. That it is still REACHED was asserted nowhere: a promise living in three descriptions and
  no gate, which is the shape nobody reports, because nobody reports a capability they were told they had.

  Now an integration test, run against a live instance, with an unsuppressed control on every assertion —
  without one, *"recall did not return it"* is equally good evidence that recall returned nothing at all.

- **A schema type and each of its properties can now say what they are FOR, in prose.** `description` on
  a type schema (4000 characters) and on any property (2000) — stored, returned by `get_space_meta` and
  the space listing, editable in the Schema tab, and **never parsed**. The type already says a value is a
  number; the property note is where you say it is the retry BUDGET rather than the retry count, or that
  one record means one deployed instance rather than one repository.

  **It is deliberately prose rather than an ontology, and that is the whole decision.** Owner,
  2026-09-17, asking whether `F-24`'s semantic layer could be satisfied this way: the answer splits by
  who READS it. Everything whose reader is a model — what a type is for, which property carries meaning,
  whether two types in different spaces are the same thing — is satisfied by a sentence, and better,
  because it needs no vocabulary and cannot be wrong-but-parseable. Nothing whose reader is the ENGINE is
  satisfied by it at all: a query cannot widen to subtypes it cannot parse.

  So the engine-facing half — inverse pairs, transitivity, subtyping — is not built, and will not be
  until a named consumer changes behaviour because of it. **A vocabulary that nothing enforces looks
  machine-readable and is not**, which is worse than prose rather than a lesser version of it: shipping
  `transitive: true` while `traverse` ignores it is the documented-but-inert defect at the scale of a
  feature.

- **The space editor could reach a state where saving was IMPOSSIBLE, and the only way out read as
  discard.** Owner-reported, and it was two defects that made each other worse.

  The footer swapped **Save changes** for the close-and-finish button whenever any notice was set. That
  was written for the vote-pending path, where it is right — a networked space answers `202`, the change
  IS submitted, and a button still offering to submit invites a second proposal for the same change. But
  the same signal carries *"nothing to save"*, which is not a submission. One Save that reported doing
  nothing retired the Save button for the rest of the session: the form stayed editable and the only
  control left closed the dialog.

  And *"nothing to save"* was easy to reach by accident, because **the diff could not see a key being
  removed**. It walked the keys of the CURRENT payload, while `strictLinkage` is emitted only when true
  and `purpose`/`usageNotes` only when non-empty — so turning strict linkage off, or clearing the
  purpose, produced an empty diff. The unsaved-changes guard said there were changes and the save said
  there were none; both were right about their own question, which is why neither looked wrong.

  The diff walks the union of both key sets now and sends a vanished key as its cleared value, and a
  finished state ends the moment there is another edit. **The server was never wrong** — its merge
  guards on "present", so `''` and `false` always cleared correctly; only the client failed to send
  them. It had bitten once before and been fixed for `typeSchemas` alone, which is why the rule now
  lives in the diff rather than in each key's emission.

- **A property `default` kept its string type after the property became a number.** Owner-reported. The
  detail pane binds the default to a text input, so it is always text; change the type afterwards and
  the schema was saved with `default: "5"` for a numeric property. That is not cosmetic — the default is
  written into records that omit the property, so a strict space starts refusing records it created
  itself. The emitted schema carries a default of the DECLARED type now, or omits it when the text
  cannot be one: a default that cannot be honoured is worse than none.

- **A schema type can be RENAMED, on every knowledge type.** Owner-reported: *"i created an entity with
  full property definitions but made a spelling mistake in the entity name — had to redo all"*. A type's
  name is a map key and the editor offered add and delete and nothing between. The rename keeps every
  property and the type's position in the list, and follows the name into every edge-endpoint list that
  named it — leaving those behind would break the declaration exactly the way a deletion did. Records
  already written keep the old type: a schema rename does not migrate them, and the case this is for is
  a type built minutes ago.

#### Spaces, tokens and the rights matrix

- **`space_reembed` — the embedding backfill now has a tool.** `POST /api/spaces/:id/reembed` has queued
  embeddings for records with no vector since 4.4, and had no MCP counterpart. It is also
  `POST /api/space_reembed`, takes `kinds` and `limit`, and returns the same counts the route does.

- **A route was attributed to a path nothing serves, in every gate that reads the route list.** The MCP
  OAuth consent screen is served at `/mcp-oauth/consent`; the mount graph resolved its router by bare name,
  another file's function parameter is also called `router`, and that one is mounted under `/api/files` —
  so the route was reported at `/api/files/mcp-oauth/consent`. A guard gate checking a path that does not
  exist is checking nothing, and the real path went unchecked.

  The graph now scopes a parameter alias to the file that binds it, keeps a direct mount authoritative
  everywhere (a first attempt at this dropped all five space routes), and learned the fourth mount form —
  a router BUILT by a function and mounted through the value it returns.

  It reads the shared list and the imported map now, accounts explicitly for the routes only one side can
  see, and **runs in preflight**. A check nobody runs is a claim.

- **Two more gates were asking their question of two thirds of the API.** The rights-row gate and the
  route-parameter reader each kept their own copy of the route scan — the same pattern, with the same two
  blind spots: it cannot match a route declared straight on the express app, and it walks `server/src/api`,
  which does not contain `app.ts`. Between them that hid fifteen routes, including every one of the five
  heaviest admin operations and all three MCP transport routes.

  Nothing was wrong behind them; what was wrong is that neither gate had looked. Both read the shared route
  list now, which gained the ability to hand back the source that registers each route — that window was
  the reason the second copy existed.

- **A backfill could report records as suppressed when nothing was suppressed.** `space_reembed`'s
  `skippedSuppressed` is the number that tells an operator *"the setting is still on"*, and it was
  computed as `count(vectorless) - count(vectorless AND allowed)` — two separate reads of a collection
  the embed worker is actively DRAINING. Every record the worker finishes gains a vector and leaves the
  first population, so a worker landing between the two reads shrinks the second count for a reason that
  has nothing to do with suppression, and the difference goes positive.

  Both counts now come from one `$facet` pass, so they describe the same instant and their difference is
  what the exclusion removed rather than what the worker happened to finish in between. `remaining` came
  from a third live read and now shares the same snapshot.

#### Files

- **An AI assistant can save a picture, a PDF or anything else that is not text.** `write_file` takes
  `encoding: "base64"` alongside its existing UTF-8 default, which the REST upload had accepted throughout.
  Reported by the canary operator after one of their coding sessions was asked to put a photograph of a
  whiteboard on a record and could not: `write_file` is the only file-writing tool a write-capable token is
  offered, so a session reached through MCP could create a text file and could never create a byte file.

  **The ceiling is the request rather than the file store, and the schema says so.** A tool call arrives as
  one JSON body capped at 10 MB and base64 costs a third more than the bytes it carries, so about 7 MB of
  file fits; anything larger goes through `POST /api/files/{path}`, which takes a raw body and supports
  chunked upload.

  **Base64 that is not base64 is now refused on BOTH doors.** `Buffer.from` skips characters outside the
  alphabet rather than failing, so a `data:image/png;base64,…` URL used to be stored as a short, corrupt
  file under a `201` — with a plausible sha256 and a plausible size, and nothing downstream able to tell.
  The decode, the encoding vocabulary and that refusal are one module behind both doors.

- **A file keeps its description, tags and properties across a move, and across a rewrite that does not
  mention them.** Both already held; neither was written down, and the cost of that landed on somebody
  else. A file is the one record type with no id of its own — its `_id` IS its path — so an integrator
  mapping an external reference onto a file measured the two behaviours from outside, found them correct,
  and then re-asserted their key after every single write **because they were undocumented**, paying a
  round trip per write to insure against a promise we were keeping.

  `05-files-api.md` now states both as guarantees, says why a file is path-keyed rather than UUID-keyed
  (a delete writes a tombstone per path and a file's link records hang off the same id, so a second
  identity is a second thing to reconcile), and shows the stable-handle pattern. Two tests hold it: a
  source gate on the two shapes that make it structural, and a live round trip through move and rewrite.

- **Upgrading stopped quietly rewriting file records that every peer also holds.** Giving a file uploaded
  before 4.0 its position in a space's history is a one-time change to a record that replicates, and it rode
  inside the link conversion — which was an operator-run script until 5.0 taught the instance to run it at
  every startup. From then on every instance in a network stamped the same records with its own counter at
  whatever moment it happened to restart, and each overwrote the others in turn. The stamp is back on
  `npm run links:convert`, which now prints how many records it stamped per space; the boot conversion does
  links only.

  **A container deployment cannot run that script, so its pre-4.0 file descriptions stay local** until the
  record is next written — which is what they did before 5.0, and is the smaller of the two problems.

#### Sync, peers and migrations

- **The gate that refuses boot migrations over synced data can follow a call.** It read one function's own
  body, so a migration that did its writing three calls away was invisible to it — which is how the case
  above went unnoticed for eleven days. It now resolves each call through the importing module's own import
  list, keyed `path:name` rather than by bare name, and walks the real startup graph to exhaustion. Its list
  of which collections replicate is read out of `sync/replicated-families.ts` rather than kept by hand,
  which is how `links` came to be missing from it.

#### Documentation, gates and internal structure

- **An entry that breaks a caller can no longer fall off the end of an abridged GitHub Release.** Lifting
  those entries ahead of everything else was the fix after an operator read the 4.0.0 notes and missed the
  link system. It stops being enough once they no longer fit BETWEEN THEM: this release has twenty of them
  totalling some 26 000 characters, so a tighter budget dropped whole entries off the end of the lifted
  block — the same failure one level in, and with the reader's guard down, because the notes now promise
  those entries come first.

  Each of their headlines is charged to the budget before anything else is spent; what is left upgrades
  entries to their full text in order, and the notice says how many were cut to one line. Twenty headlines
  beat fifteen full entries because of what a reader can DO with them — a headline sends you to the full
  notes, and an entry that is not there cannot.

  **It never reached a reader.** At the real ceiling all twenty fit; the gate squeezing to 20 000
  characters is what found it, which is what that squeeze is for.

- **The gate holding the never-embed rename asked the wrong file, and a correct release process made it
  red.** It read `CHANGELOG.md` for both spellings of the suppression mark on the rule that an upgrader
  searching the old one must find it. Archiving the 4.x notes at this release moved both into
  `changelog/CHANGELOG-4.x.md`, so the gate reported a documentation hole where the release process had
  done exactly what it is supposed to. **Its own comment had predicted the day** — *"when this file is
  archived, the gate goes red and asks to be revisited"*.

  It reads the whole series now, derived from `changelog/` with a floor, and asserts the file holding the
  answer is linked from the current notes — because a word documented in a file nobody opens is not
  documented. That is the third time this assertion's window has decayed at a release; a window measured
  in releases always will.

- **Two feature ids were reused for different work, so grepping either one misled in both directions.**
  `#1262` shipped as `F-25` — *"find out who still writes the arrays before converting a space"* — and
  `#1265` as `F-26`, *"a passed date means what the schema says"*. Seven source files cite `F-25` and
  three cite `F-26` meaning exactly those. The tracker then reused both ids in September for new
  owner-directed asks: a skill endpoint and aggregation pipelines.

  So a reader of the skill-endpoint row who greps the code finds writer-attribution plumbing and
  concludes it is half built; a reader of `request-actor.ts` who looks up `F-25` finds a skill endpoint
  that has nothing to do with it. I made the first mistake myself while checking the queue.

  The UNSTARTED rows move — to `F-27` and `F-28` — because the shipped side is quoted in source
  comments and in merged PR titles that cannot be corrected. Both rows record why.

- **A client method called a route the server has never served.** `updateSyncSchedule` PATCHed
  `/api/networks/{id}/members/{memberId}`; that collection takes a `POST`, a `PUT` on the signing key and a
  `DELETE`, and nothing else. Nothing in the client called the method, so nobody had seen the 404 yet — it
  is deleted rather than pointed somewhere, because a method with no caller and no route is not a feature
  waiting to be wired up.

- **The gate that checks every mutating route is guarded could not see the five most destructive ones.**
  Wiping a space, importing one, exporting one, reloading the config and rotating the signing key are
  declared straight on the express app rather than on a router, and both halves of the analysis missed
  them: the pattern matched only names containing "router", and the file scan never read `app.ts` at all.
  They were not reported as unguarded — they were **absent**.

  **All five turned out to be correctly guarded and correctly audited**, so nothing was exposed; what was
  missing was the check. Proven by mutation: stripping the admin guard off `POST /api/admin/reload-config`
  left the suite green before this change and names the route after it.

- **Every path the client calls is now checked against a route the server mounts.** There is no type
  between a template string and a router, so a renamed route is a runtime 404 rather than a build error —
  and what an operator sees is an empty panel, not an error naming the call. Nothing was broken when the
  check was added; 5.0 renames almost every public name, which is why it exists now.

- **One refusal, written out by hand in three places, is built from the vocabulary instead.**
  `Invalid knowledgeType … Must be one of: entity, fact, edge, chrono` sat beside a check that reads the
  same list from the code. They agree today; the rename from `memory` to `fact` had to find all three, and
  nothing would have failed had it missed one.

  These three close the pre-5.0 audit (`Q-22`).

- **Almost every tool answered with no structured half, so `data` was `null` over HTTP and
  `structuredContent` was absent over MCP.** Thirty-three successful returns across eleven tool files put
  the whole answer in the text half and nothing beside it. A client that surfaces the structured form —
  several do — got `null` and had to parse prose to recover a result it had just asked for.

  **This is the defect the canary operator reported against `query`, answered on the tool they named.**
  Nothing swept the siblings, and the sweep is where the cost was.

  **What a tool carries now is the record it wrote, or the identity of what it acted on** — one rule, not
  a decision per tool. A delete answers `{"_id": …, "deleted": true}`; a merge answers the survivor and
  the absorbed id; `move_file` answers `{"from": …, "to": …}`.

  Where the answer is naturally an array the structured half NAMES it, because `structuredContent` must
  be an object: `list_spaces` carries `{"spaces": […]}` and `network_peers` carries `{"peers": […]}`.
  **The text half of both is still the bare array**, so a caller that indexes it is unaffected —
  `network_peers` has a recorded refusal of an envelope on exactly that ground, and it governs the text
  half only.

- **A gate had claimed this rule and could not see it.** `mcp-structured-content-carries-its-payload`
  refuses a `structuredContent` built from metadata alone; its subject is every `structuredContent: { … }`
  literal, so a return carrying none matched nothing and sat outside the sweep. It was green throughout
  while refusing the *lesser* form of the same defect — metadata with no answer — and blind to the greater
  one. Its replacement asserts presence instead, and **the parity test was wrong in the same direction**:
  it compared `data` across the two doors with `deepEqual`, which passes for two nulls, so it reported
  agreement about an answer neither door gave.

### Internal

#### The benchmark corpus and its extraction pipeline

- **The benchmark fetcher could not fetch the corpus it was written to pin, and every LongMemEval URL
  404d.** Two independent failures on the same step.

  The pinned URLs append `.json`; the publisher's files have no extension. They were recorded from the
  dataset page rather than from a fetch, so nothing ever proved they resolved — which is the one thing
  pinning by URL is supposed to make impossible. Corrected against the HuggingFace file listing.

  And `fetchPinned` read `await res.arrayBuffer()`, holding the body twice. `longmemeval_s` is 278 MB
  against LoCoMo's 2.8 MB, so the process died with `JavaScript heap out of memory` before it could
  print a hash. It now hashes the response as it streams, writes to a `.partial`, and renames into the
  cache only after the digest verifies — so an unverified corpus never appears where a reader expects a
  pinned one.

  `longmemeval_s` is now pinned at `08d8dad4be43…`, 278,025,796 bytes. `_m` and `_oracle` remain
  recorded and unpinned, which the fetcher refuses exactly as it refuses a mismatch.

- **`benchmarks/` now holds a folder per benchmark: LoCoMo, LongMemEval and MemoryArena.** LongMemEval is
  recorded and not yet fetched, MemoryArena is not released by its authors, and a dataset whose hash is
  missing is now refused rather than read as nothing to check.

- **The LoCoMo benchmark was rebuilt around the conversation schema.** Storing resolved facts instead of
  transcript lines, with provenance and cross-session synthesis, took first-result accuracy from 33.0% to
  55.3% and evidence delivery to 91.4% on the first conversation. The measurements, the dead ends and the
  ceiling that method has are in `benchmarks/DEVELOPMENT-LOG.md`.

#### `filter` is the one read path

- **The `filter` tool moved out of `search.ts` into `mcp/tools/filter.ts`.** Not a tidy-up: the size gate
  refused the two lines the `path` argument added, and the file was at its ceiling. The three tools there
  were never one responsibility — `recall` and `similar` RANK, and `filter` is the one that does not,
  which is what its own description already calls it.

  **Six gates named `server/src/mcp/tools/search.ts` as "the MCP door for `filter`" and all six went red
  at once.** Each would have been fixed by editing a literal, and six literals is six chances for the next
  move to leave one pointing at a file that no longer holds what the gate reads. They derive it now, from
  `testing/_shared/search-doors.mjs`, which also asserts that each file still declares the handler that
  makes it a door — a gate handed a file that moved concludes whatever its regex says about the wrong text.

#### Recall, expansion and the byte budget

- **A cross-door budget fixture was sized from the larger door, and only luck made it bind on the other.**

  A REST result flattens the record into the ranking envelope; an MCP result nests it under `record` with a
  narrower envelope, so the same corpus is a different number of bytes through each door and MCP’s has
  always been the smaller. The spill test budgeted at 80% of REST’s full answer and asserted that MCP
  truncates too — which held by a margin nobody had measured.

#### Documentation, gates and internal structure

- **Graph-augmented recall is its own page, and the gates that named the page it used to be on now find it
  by its heading** (`Q-26`). `docs/integration-guide/04a-recall-api.md` stood at exactly 900 lines, which is
  the cap every tracked document is held to, so the next change to it was blocked — the previous one had
  already been squeezed to net zero lines to fit. The `traverse`-on-recall section is now
  `04h-graph-augmented-recall.md`, registered in `HELP_DOCS` and the index in numbered order. Moved by
  `split-part.mjs` and checked by `verify-part.mjs`: 746 prose lines before, 747 after, nothing lost.

  **The interesting half is what a split does to the gates around it.** Two named `04a-recall-api.md` as
  "the integrator's recall page" and both went red the moment the section left it — the lucky outcome. The
  unlucky one is a gate that asserts an ABSENCE, or greps a spelling the remaining page happens to keep: it
  goes on passing about a document that no longer contains its subject, and nothing ever contradicts it. So
  the page is resolved by DERIVATION now, from headings rather than from a filename, in
  `testing/_shared/integration-guide-parts.mjs`. Headings and not whole files, because `04a` still refers to
  graph-augmented recall twice by name — a file search answers with the page the section moved out of. It
  throws on no match and on more than one, so a reworded heading cannot arrive as `undefined` and be read as
  "nothing to check here".

  **And a split silently breaks every "above" and "below" that now points at another file.** Nothing
  mechanical sees those: the link resolves, the anchor exists, the sentence is simply about a page the reader
  is not on. Two here, both rewritten to name what they mean.

- **The offline standalone tests run in parallel, and the split is one module instead of two copies.**
  Measured on 591 offline files: **191.0s serialised, 46.6s at default concurrency**, both green.
  `npm run test:standalone` goes 257s → 160s, and preflight's own offline pass — which was serialised
  too — drops by the same three and a half minutes, so the set is no longer paid for twice per cycle.

  **`--test-concurrency=1` is right where it came from and wrong here.** `testing/integration` shares
  ONE live instance: run concurrently it latches maintenance mode and reports 314 false failures. The
  offline files have no instance to share, which is what `@needs-instance` declares — and the 16 files
  that do declare it still run one at a time.

  **And the runner REFUSES a stale `server/dist`.** These files import from it; preflight builds it
  first and `test:all:core` never has, so running the suite straight after a branch switch tested
  whatever was compiled last. That cost two confused diagnoses in one evening — a fix that was already
  merged looked broken, and a build from two branches ago looked like a regression in the change under
  test. A check rather than a build, deliberately: building would hide the mistake and add a minute to
  every run, while refusing costs milliseconds and says what to do. `--allow-stale` is the escape hatch.

- **Six gates asserted a SITE rather than a rule, and every one of them went red on a change that improved
  the code.**

  All six now assert the rule: the guard list is DERIVED from the middleware that reaches `resolveAuthOrFail`
  with a floor under it, the extractor knows both route shapes, the wrapper is checked per route, and the
  reach rule is checked in the module it moved to. This is the argument for doing the whole rename at once
  rather than a name at a time — it moves every identifier together, so it finds these as a batch instead of
  one false alarm a year that somebody talks themselves past.

## Earlier releases

- [4.x](changelog/CHANGELOG-4.x.md) — 6 releases
- [3.x](changelog/CHANGELOG-3.x.md) — 6 releases
- [2.x](changelog/CHANGELOG-2.x.md) — 17 releases
- [1.x](changelog/CHANGELOG-1.x.md) — 10 releases
- [0.x](changelog/CHANGELOG-0.x.md) — 18 releases
