# SPARQL API — querying the records as RDF

> Part of the [Ythril Integration Guide](../integration-guide.md).

A space with RDF switched on ([Exports](06f-exports.md)) answers SPARQL 1.1 queries over its records, read at query time: the statements a
query sees are exactly the ones the [RDF records export](06f-exports.md) writes, under the same addresses. There is no copy to load or
keep in step. The same capability on both doors:

| | REST | MCP | rights |
|---|---|---|---|
| ask a query | `GET /api/brain/spaces/:spaceId/sparql?query=...`, `POST /api/brain/spaces/:spaceId/sparql` | `sparql_query` | `knowledge: read` |
| change records ([SPARQL Update](#sparql-update)) | `POST /api/brain/spaces/:spaceId/sparql/update` | `sparql_update` | `knowledge: write` |

## The protocol

The REST door is the [SPARQL 1.1 Protocol](https://www.w3.org/TR/sparql11-protocol/#query-operation) query operation:

- `GET ...?query=<text>`: the query in the URL. A URL is bounded by the server's header size, and a reverse proxy may log it with the
  query in it: prefer POST.
- `POST` with `Content-Type: application/sparql-query`: the query is the body; the other parameters go in the URL.
- `POST` with `Content-Type: application/x-www-form-urlencoded`: every parameter in the body (`query=...`).
- `HEAD`: the `GET`'s status and headers; the query is parsed and checked, nothing is run.

Parameters, on both doors:

| Parameter | Meaning |
|---|---|
| `query` | The SPARQL 1.1 query: SELECT, ASK, CONSTRUCT or DESCRIBE. At most 64 KiB. |
| `limit` | The most rows (or statements) the answer may hold, at most `sparql.maxResults`. An answer over it is refused, never cut: to cut, write `LIMIT` in the query. |
| `default-graph-uri`, `named-graph-uri` | The protocol's dataset (repeatable), replacing the query's `FROM` and `FROM NAMED`. |
| `maxChars`, `maxBytes`, `maxTokens` | MCP only: size ceilings on the tool's answer, which admit whole rows only (below). |

`:spaceId` (MCP `space`) may be your own [personal view](06d-personal-views.md): the query then reads every member you read.

## What a query sees

- **The default graph is the union of the members**; each member space is also a named graph, its graph address being the space's RDF base
  (`GRAPH ?g { ... }` binds `?g` to it).
- **The records only.** The export's description graph (the report node) is not served.
- **Your rights.** A member you cannot read is not there at all. Without `files: read` on a member its file statements are left out; the
  answer says so (below).
- **FROM, FROM NAMED and `default-graph-uri`** naming a graph that is not one of your members hold nothing: the answer is empty, never a
  refusal, so no answer says which other graphs exist.
- **Edges in RDF 1.2 form:** an edge is `<from> <label> <to>`, and its details (weight, type, properties) are on its reifier,
  `?r rdf:reifies <<( <from> <label> <to> )>>`. The annotation syntax `<< <from> <label> <to> >> ythril:weight ?w` reads them.

## Answers

| Query form | Media types, by `Accept` | Default |
|---|---|---|
| SELECT, ASK | `application/sparql-results+json` (also for `application/json`), `text/csv`, `text/tab-separated-values` | JSON |
| CONSTRUCT, DESCRIBE | `text/turtle`, `application/n-quads`, `application/ld+json` | Turtle |

- An ASK in CSV or TSV is a header row `_askResult` and `true` or `false`.
- A graph answer holding a triple term is RDF 1.2: the document opens with `VERSION "1.2"` and its Content-Type says `; version=1.2`.
  JSON-LD has no triple term, so such an answer is refused in JSON-LD (`409 rdf_unwritable`).
- Every answer says `Vary: Accept` and `Cache-Control: no-store`.
- **What was left out is said beside the answer**, never inside the results body a SPARQL client parses:
  - `X-Ythril-Members-Left-Out: <members>`: view members with RDF off, a contested base or a term clash; they were not read.
  - `X-Ythril-File-Triples-Withheld: <members>`: members whose file statements need `files: read`.

  Member ids are percent-encoded and comma-separated. MCP says the same in the summary's `warnings`:
  `[{ "code": "members_left_out", "members": [...] }, { "code": "file_triples_withheld", "members": [...] }]`.

**MCP** answers the body in the first text block, once: SPARQL results JSON for a SELECT or ASK, the admitted statements as N-Quads (one per
line, `mediaType: application/n-quads`) for a CONSTRUCT or DESCRIBE. The summary (`form`, `rows`, `returned`, `truncated`, the budget used,
`warnings`, `remainder`) is in the second block and in `structuredContent`, which does not repeat the rows. `charsReturned` and `bytesReturned`
measure the text returned. The size ceilings admit whole rows (or statements) only; what they cut is kept for a day as a [read spill](04a-recall-api.md), read with `read_spill`
(`remainder.spillId`). Each spilled item is `{ "spaceId", "members", "row" }`; deleting any of those spaces deletes the spill.

## Bounds

A query is answered whole or refused: the answer is collected in full before its status line, so a refusal is always a clean status and
never a short `200`.

| Config key | Default | What it bounds |
|---|---|---|
| `sparql.timeoutMs` | 30 000 | How long a query may run. |
| `sparql.maxRecordsRead` | 200 000 | Records one query may read, every pattern together. |
| `sparql.maxResults` | 10 000 | Rows (or statements) one answer may hold. |
| `sparql.maxResultBytes` | 67 108 864 (64 MiB) | Bytes of values (every term of every row or statement) one answer may hold, from 1 MiB to 1 GiB. |

An answer is read while the records change: it is not a point-in-time snapshot, so a record written while the query runs may or may not be in it.

The keys are read live. At most two queries run at once on an instance and one per token (`503 sparql_busy` with `Retry-After`).
`SERVICE` (federation), `LOAD` and SPARQL Update are refused: this endpoint reads this server's own records and never reaches the network.
An Update has its own address ([SPARQL Update](#sparql-update)).
`REGEX` and `REPLACE` take their pattern and flags as literals, and a pattern that can take exponential time is refused.

## Refusals

Every refusal is `{ "error", "code" }` ([Error Format](03-auth-and-limits.md)); a parse error adds `line` and `column`, never the query's
text, and a `503` adds `retryAfterSeconds` and `Retry-After`.

| Status | Code | When |
|---|---|---|
| 400 | `sparql_no_query` | No `query`, an empty one, or more than one. |
| 400 | `sparql_malformed` | The text does not parse as SPARQL 1.1 (`line`, `column`). |
| 400 | `sparql_update_not_here` | An update: `update=`, `application/sparql-update`, or an update operation in `query`. Send it to `POST .../sparql/update` ([SPARQL Update](#sparql-update)). |
| 400 | `sparql_federation_refused` | A `SERVICE` anywhere in the query. |
| 400 | `sparql_pattern_refused` | A `REGEX` or `REPLACE` pattern or flags that are no literal, too long, or with nested quantifiers. |
| 400 | `sparql_bad_limit` | `limit` is no whole number from 1 to `sparql.maxResults`. |
| 400 | `sparql_bad_dataset` | `default-graph-uri` or `named-graph-uri` is no text. |
| 406 | `sparql_not_acceptable` | `Accept` names no format a SELECT or ASK answers in. |
| 406 | `rdf_format_not_acceptable` | `Accept` names no format a CONSTRUCT or DESCRIBE answers in. |
| 409 | `rdf_not_enabled`, `rdf_base_conflict`, `rdf_base_shared`, `rdf_base_nested`, `rdf_term_clash` | A space read alone has RDF off or unsettled names (the export's own refusals; a view leaves such a member out and names it). |
| 409 | `rdf_unwritable` | The answer holds a term no document of the format can carry (an IRI with a character an IRI cannot hold, a triple term in JSON-LD). |
| 413 | `sparql_query_too_large` | The text is over 64 KiB, or a form holds more parameters than a query takes. |
| 413 | `sparql_too_many_results` | The answer holds more than `sparql.maxResults` rows, or more than `limit`. |
| 413 | `sparql_answer_too_large` | The answer holds more than `sparql.maxResultBytes` bytes of values, however few rows: a record may be 10 MB. |
| 413 | `sparql_too_much_read` | The query reads more than `sparql.maxRecordsRead` records. |
| 415 | `sparql_unsupported_media_type` | A POST that is neither `application/sparql-query` nor a form, or whose charset or `Content-Encoding` is not read. |
| 503 | `sparql_timeout` | The query ran past `sparql.timeoutMs`. |
| 503 | `sparql_store_unavailable` | The store did not answer a read. |
| 503 | `sparql_busy` | No query slot is free for you. |

## Audit

Every query is recorded as `brain.sparql_query` ([Audit Log API](13-audit-log-api.md)), whatever `logReads` says: its form, the text's
length, the members read, the records read, the rows and the outcome, never the text. A query refused after it ran is recorded by the same counts
(`rows` 0) with the refusal's code as the outcome; an answered one has the outcome `answered`. An engine error no code names is answered `500` and
logged by its class only, never its message, which may hold the query.

## SPARQL Update

A [SPARQL 1.1 Update](https://www.w3.org/TR/sparql11-update/) changes the records of one space through the same write rules every other
write door keeps (the schema, strict linkage, the functional rule, the delete guard), and lands whole or not at all.

| | REST | MCP | rights |
|---|---|---|---|
| change records | `POST /api/brain/spaces/:spaceId/sparql/update` | `sparql_update` (also `POST /api/sparql_update`) | `knowledge: write` |

- `POST` with `Content-Type: application/sparql-update`: the Update is the body; `using-graph-uri` and `using-named-graph-uri` go in the URL.
- `POST` with `Content-Type: application/x-www-form-urlencoded`: every parameter in the body (`update=...`).
- MCP and `POST /api/sparql_update` take `{ space, update, using-graph-uri, using-named-graph-uri }`.
- The text is at most 64 KiB. `:spaceId` is a space: a view id is answered as a space that does not exist. The `schema` rung is never asked
  and never implied.

**What it takes.** `INSERT DATA`, `DELETE DATA`, `DELETE/INSERT ... WHERE` and `DELETE WHERE`, several joined by `;`. Each part reads the
space as you read it plus what the parts before it changed. A record is named by its address under the space's RDF base, as the export and
the query write it. A new subject under an address of the space is inserted under an id the server makes; the address's own id is not used,
and the answer's `ids` give the new ids. An edge's details are statements about its reifier (see [What a query sees](#what-a-query-sees)).
An Update that deletes every statement of a record deletes the record, behind its tombstone.

**What it refuses.** Graph management (`CLEAR`, `DROP`, `CREATE`, `ADD`, `MOVE`, `COPY`) and `LOAD`, and any `GRAPH`, `USING`, `WITH` or
`using-graph-uri` naming a graph other than the space's own, are `400 sparql_graph_management_refused`. `SERVICE` is
`400 sparql_federation_refused`. A query sent here is `400 sparql_not_an_update`.

**The answer** (`200`): `inserted`, `converged` and `deleted`, each counted by kind (`entity`, `fact`, `chrono`, `edge`); `recordsChanged`;
`attempts`; `ids`, the ids of the records it inserted, by kind; `statements`, the statements it removed and inserted. MCP gives the same object
in `structuredContent` and in the second text block.

### Whole or nothing, and its exceptions

Every statement becomes a planned record write first. If any statement is refused, nothing is written: `422 sparql_update_refused` names each
refused statement by its subject and predicate (its value only by kind and length) with the rule (`reasons`), and each refused record by
kind, id and address with the planner's reason (`refusals`). Then every write lands in one transaction, or none does.

Three answers say that something landed and not all that follows it did. Each body carries the counts of what landed:

| Status | Code | What landed |
|---|---|---|
| 409 | `endpoint_removed` | The Update landed, then rows it wrote were taken back because an entity they name was removed by another write meanwhile (`takenBack`). Read the graph again. |
| 500 | `sparql_update_cascade_incomplete` | The Update landed, and an effect owed after it did not complete (`failedEffects`, each `{ effect, count }`: `removal`, a deleted record's cascade; `embed`, the embed jobs of written records; `edge-take-back` or `link-take-back`, the check for rows naming a removed entity). The records are stored. |
| 503 | `write_group_outcome_unknown` | The commit's reply was lost and could not be read back: the Update may have landed, or not. |

A removal's embed jobs are retired on a best-effort basis: a failure there is logged and is no failed effect.

**Retry after an unknown outcome.** Read the records back before you send the Update again. Sent again, a statement about a stored record
converges and changes nothing more, and a `DELETE` finds nothing left to remove; but a new subject is inserted again under another new id.
Look the new record up (by its label, say) before you send an `INSERT DATA` of a new subject a second time.

### Isolation

The writes are atomic: one transaction, all or none. The reads are not a snapshot. The evaluation reads each record with its version; a
record it meets at two versions, or a record the Update changes that another write changed before the commit, is a lost race, and the
**whole Update runs again**, evaluation included, at most 3 times within `sparql.timeoutMs`. A run starts only while the time left covers the
last run, and never while the server shuts down (`503 shutting_down`). After the last run the answer is `409 sparql_update_conflict`,
naming the record that kept changing (`record`: `{ kind, id }`). A record the `WHERE` read and the Update does not change is not checked at the
commit: two Updates that each read what the other writes can both land.

### Deletes

An Update that deletes an entity that something still names (an edge, a link, another record's reference) is refused
`409 sparql_update_referenced`, its blockers in `backlinks`; nothing is cascaded. Delete or relink them in the same Update. An Update that
deletes counts as a destructive call, at most 5 a minute per token (`429 sparql_update_rate_limited`, `Retry-After`).

### Bounds

| Config key | Default | What it bounds |
|---|---|---|
| `sparql.maxRecordsChanged` | 1 000 | Records one Update may change (insert, converge or delete), from 1 to 5 000 (a write group's ceiling). More is `413 sparql_too_many_changes`, naming the cap (`cap`); nothing lands. |

The query's `sparql.timeoutMs` and `sparql.maxRecordsRead` bound the evaluation too. A change set holds at most 50 000 statements and
32 MiB of values (`413 sparql_too_many_changes`); a write group holds at most 5 000 records, 50 000 writes and 32 MiB
(`413 write_group_too_large`). One Update runs at a time per token, two per instance (`503 sparql_busy`, `Retry-After`).

### Update refusals

Every refusal is `{ "error", "code" }` plus the fields named; none repeats the Update's text. The query's codes for the text apply as
well: `sparql_malformed` (`line`, `column`), `sparql_query_too_large`, `sparql_unsupported_media_type`, `sparql_federation_refused`,
`sparql_pattern_refused`, `sparql_too_much_read`, `sparql_timeout`, `sparql_store_unavailable`, `sparql_busy`.

| Status | Code | When |
|---|---|---|
| 400 | `sparql_no_update` | No `update`, an empty one, or a body that is no Update; `using-graph-uri` or `using-named-graph-uri` that is no text, or a list of more than 8 addresses. |
| 400 | `sparql_not_an_update` | A query (SELECT, ASK, CONSTRUCT, DESCRIBE) sent to the update address: ask it at the query endpoint. |
| 400 | `sparql_graph_management_refused` | CLEAR, DROP, CREATE, ADD, MOVE, COPY or LOAD, or a graph other than the space's own named anywhere. |
| 409 | `sparql_update_referenced` | It deletes an entity something still names (`backlinks`). |
| 409 | `sparql_update_conflict` | Another write changed a record it reads on each of its 3 runs (`record`). Send it again. |
| 409 | `record_version_at_ceiling` | A record it changes is at the highest version sync accepts. |
| 409 | `endpoint_removed` | Landed, then rows were taken back (above). |
| 413 | `sparql_too_many_changes` | More records than `sparql.maxRecordsChanged`, or a change set past its statement or byte cap. |
| 413 | `write_group_too_large` | The writes pass a write group's ceiling. |
| 422 | `sparql_update_refused` | A statement or a record the write rules refuse (`reasons`, `refusals`). |
| 429 | `sparql_update_rate_limited` | A sixth destructive call within a minute. |
| 500 | `sparql_update_cascade_incomplete` | Landed, and an effect after it failed (above). |
| 503 | `write_group_outcome_unknown` | Landed or not, unknown (above). |
| 503 | `shutting_down` | The server is shutting down; nothing was written. |

### Update audit, events and metrics

Every Update is recorded as `brain.sparql_update` ([Audit Log API](13-audit-log-api.md)) on every door, also when the caller went away: the
text's length, the records `inserted`, `converged` and `deleted`, `recordsChanged`, the `attempts` and the `outcome` (`landed`, or the code it
was answered with), never the text. A refused Update is recorded with 0 changed. An Update that landed anything sends one `bulk.write`
webhook with `source: "sparql.update"` ([Webhooks](14-duplicates-and-webhooks.md)), and each record it deleted its own `<kind>.deleted`.
The counter `ythril_sparql_update_total{outcome}` counts Updates by the same outcome ([Setup API](11-setup-api.md)).
