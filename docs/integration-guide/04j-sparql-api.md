# SPARQL API — querying the records as RDF

> Part of the [Ythril Integration Guide](../integration-guide.md).

A space with RDF switched on ([Exports](06f-exports.md)) answers SPARQL 1.1 queries over its records, read at query time: the statements a
query sees are exactly the ones the [RDF records export](06f-exports.md) writes, under the same addresses. There is no copy to load or
keep in step. The same capability on both doors:

| | REST | MCP | rights |
|---|---|---|---|
| ask a query | `GET /api/brain/spaces/:spaceId/sparql?query=...`, `POST /api/brain/spaces/:spaceId/sparql` | `sparql_query` | `knowledge: read` |

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

**MCP** answers the body REST would give (SPARQL results JSON, or Turtle) in the first text block; the summary (`form`, `rows`,
`returned`, `truncated`, the budget used, `warnings`, `remainder`) in the second and in `structuredContent`. The size ceilings admit whole
rows (or statements) only; what they cut is kept for a day as a [read spill](04a-recall-api.md), read with `read_spill`
(`remainder.spillId`). Each spilled item is `{ "spaceId", "members", "row" }`; deleting any of those spaces deletes the spill.

## Bounds

A query is answered whole or refused: the answer is collected in full before its status line, so a refusal is always a clean status and
never a short `200`.

| Config key | Default | What it bounds |
|---|---|---|
| `sparql.timeoutMs` | 30 000 | How long a query may run. |
| `sparql.maxRecordsRead` | 200 000 | Records one query may read, every pattern together. |
| `sparql.maxResults` | 10 000 | Rows (or statements) one answer may hold. |

The keys are read live. At most two queries run at once on an instance and one per token (`503 sparql_busy` with `Retry-After`).
`SERVICE` (federation), `LOAD` and SPARQL Update are refused: this endpoint reads this server's own records and never reaches the network.
`REGEX` and `REPLACE` take their pattern and flags as literals, and a pattern that can take exponential time is refused.

## Refusals

Every refusal is `{ "error", "code" }` ([Error Format](03-auth-and-limits.md)); a parse error adds `line` and `column`, never the query's
text, and a `503` adds `retryAfterSeconds` and `Retry-After`.

| Status | Code | When |
|---|---|---|
| 400 | `sparql_no_query` | No `query`, an empty one, or more than one. |
| 400 | `sparql_malformed` | The text does not parse as SPARQL 1.1 (`line`, `column`). |
| 400 | `sparql_update_not_here` | An update: `update=`, `application/sparql-update`, or an update operation in `query`. |
| 400 | `sparql_federation_refused` | A `SERVICE` anywhere in the query. |
| 400 | `sparql_pattern_refused` | A `REGEX` or `REPLACE` pattern or flags that are no literal, too long, or with nested quantifiers. |
| 400 | `sparql_bad_limit` | `limit` is no whole number from 1 to `sparql.maxResults`. |
| 400 | `sparql_bad_dataset` | `default-graph-uri` or `named-graph-uri` is no text. |
| 406 | `sparql_not_acceptable` | `Accept` names no format a SELECT or ASK answers in. |
| 406 | `rdf_format_not_acceptable` | `Accept` names no format a CONSTRUCT or DESCRIBE answers in. |
| 409 | `rdf_not_enabled`, `rdf_base_conflict`, `rdf_base_shared`, `rdf_term_clash` | A space read alone has RDF off or unsettled names (the export's own refusals; a view leaves such a member out and names it). |
| 409 | `rdf_unwritable` | The answer holds a term no document of the format can carry (an IRI with a character an IRI cannot hold, a triple term in JSON-LD). |
| 413 | `sparql_query_too_large` | The text is over 64 KiB. |
| 413 | `sparql_too_many_results` | The answer holds more than `sparql.maxResults` rows, or more than `limit`. |
| 413 | `sparql_too_much_read` | The query reads more than `sparql.maxRecordsRead` records. |
| 415 | `sparql_unsupported_media_type` | A POST that is neither `application/sparql-query` nor a form. |
| 503 | `sparql_timeout` | The query ran past `sparql.timeoutMs`. |
| 503 | `sparql_store_unavailable` | The store did not answer a read. |
| 503 | `sparql_busy` | No query slot is free for you. |

## Audit

Every query is recorded as `brain.sparql_query` ([Audit Log API](13-audit-log-api.md)), whatever `logReads` says: its form, the text's
length, the members read, the records read, the rows and the outcome, never the text. A query refused after it ran is recorded by the same counts
(`rows` 0) with the refusal's code as the outcome; an answered one has the outcome `answered`. An engine error no code names is answered `500` and
logged by its class only, never its message, which may hold the query.
