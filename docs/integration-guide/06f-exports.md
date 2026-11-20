# Exports

> Part of the [Ythril Integration Guide](../integration-guide.md).

An export gives a space's records, or its schema, in a standard format another tool reads without knowing Ythril. Each export is one capability on two doors: a REST route and an MCP tool that take the same parameters and answer the same bytes. This page has one section per format family; RDF is the first.

A space must have RDF switched on (`meta.rdf`, see [Space Schemas and Validation](06a-schema-api.md)) before its records have addresses to export.

## RDF records export

`GET /api/brain/spaces/:spaceId/export/rdf` and MCP `export_rdf` give the records of a space as **Turtle**, **TriG**, **N-Quads** or **JSON-LD**: every entity, fact, chrono entry, edge, link and file under its RDF address, built from standard vocabularies (Dublin Core, PROV, schema.org, OWL-Time) and the [Ythril vocabulary](../rdf/ythril-vocabulary.md).

```bash
# The whole space in one request (Turtle, the default for one space)
curl -H "Authorization: Bearer $TOKEN" https://ythril.example/api/brain/spaces/research/export/rdf > research.ttl

# The same, chosen by the Accept header
curl -H "Authorization: Bearer $TOKEN" -H "Accept: application/n-quads" https://ythril.example/api/brain/spaces/research/export/rdf > research.nq
```

A request that names no `limit`, `after` or size ceiling gets the **whole** export of the space or view in one answer, streamed a store page at a time: Jena, RDF4J and curl read it as it is, over HTTP/1.1 or HTTP/1.0. rdflib (7.6) reads it with `edgeDetails=reification`: it does not read RDF 1.2, so it refuses the default form's Turtle, TriG and N-Quads at their first line (`VERSION "1.2"`, which every document in that form starts with, edges or none). There is no `Link` on it, because there is no next page. The largest export this serves has no fixed size: the stream holds only one store page in memory and keeps no database cursor open, and what bounds it is time. While the export waits on its reader, the reader must take at least 16 KiB a second of the export's own text on average over each five minutes of such waiting (this stream is never compressed, whatever `Accept-Encoding` asks, so the bytes a reader takes are the export's bytes; a page is bounded and may be compressed), and must take something within every five minutes. A reader that does not is told: the export ends in the incomplete form below and its slot is freed at once. The connection's buffers (a few MiB) sit between the server and the reader, so the rate is measured only between moments those buffers are full: what they took at the start is not counted, and a slow store never counts against the reader. The ending arrives after what the buffers already hold, and the server keeps the connection up to 30 minutes for the reader to take it: a reader still taking about 1 KiB a second or more receives the ending as its last line; one taking less, or nothing, finds its transfer cut after those 30 minutes. The five minutes are that long because the server sees a reader's progress only in steps of about a third of the send buffer (about 1.4 MiB at Linux's default ceiling of 4 MiB); a host whose send buffer exceeds about 14 MiB can judge a reader at 16 KiB a second too slow. Each store page must be read within 30 seconds, and only two exports run on the instance at once.

`HEAD` on the route answers the headers a `GET` would (`Content-Type`, `Content-Disposition`, `Vary`, the view headers) after the same rights check and the same refusals, with no content; it reads no record and takes no export slot. It is audited as the `GET` is, an `rdf.export` entry with `method: "HEAD"` that counts nothing as sent.

A whole export is not a snapshot. A record written while it runs is either wholly in or wholly out, but the walk goes kind by kind, entities before edges, so an edge written after the entity pass can name an entity the file does not hold. The edge's object is that entity's address, which is enough to find it in a later export.

### Parameters

| Parameter | REST | MCP | Meaning |
|---|---|---|---|
| `format` | query | argument | `turtle`, `trig`, `nquads` or `jsonld`. It wins over `Accept`. Default: Turtle for one space, TriG for a view of several |
| `Accept` | header | none | Read when no `format` is given: `text/turtle`, `application/trig`, `application/n-quads`, `application/ld+json`. The client's q-values rank the formats that fit the scope first, the scope's order (below) breaks a tie. `*/*` or none takes the default |
| `edgeDetails` | query | argument | `rdf12` (the default for the text formats) states an edge's own details on an RDF 1.2 reifier; `reification` uses the classic `rdf:Statement` form, which every reader takes and the only form JSON-LD carries |
| `after` | query | argument | The `nextAfter` of the previous page |
| `limit` | query | argument | The most records in a page, 1 to 10 000. Naming it asks for a page |
| `maxChars`, `maxBytes`, `maxTokens` | query | argument | The size ceiling of a page; naming one asks for a page. On MCP the default is 25 000 characters; a REST page named by `limit` or `after` alone takes 50 000. Raise `maxChars` for bigger pages: a character ceiling is held between 1 000 and 5 000 000, as on every budgeted read, and the one used is said in `Ythril-Budget-Chars` (`budgetChars`) |

Over a view of several spaces Turtle cannot hold the graphs: an `Accept` that prefers it gets the best format that fits by the client's weights (TriG, then N-Quads, then JSON-LD at equal weight), and `format=turtle` is `406 rdf_format_not_acceptable`, which lists the formats that fit. So does an `Accept` naming none of them. Jena sends `text/turtle,application/n-triples;q=0.9,application/rdf+xml;q=0.7,application/trig,application/n-quads;q=0.9,application/ld+json;q=0.8,*/*;q=0.5`, so it gets Turtle for one space and TriG for a view; a header that names JSON-LD and reaches TriG only through `*/*` at a lower weight gets JSON-LD.

### Paging, and how an answer ends

Naming `limit`, `after` or a size ceiling asks for one bounded page instead, and MCP `export_rdf` always pages (a tool answer must stay bounded). A page ends at `limit` records or at the size ceiling, whichever comes first, its ending included. A record is never cut, so a page whose first record does not fit is that one record, sent whole with the document's start and ending: the only page that can exceed its ceiling. Pages follow each other by a keyset: a record written while you page is either wholly in or wholly out, and none comes twice.

A whole export that cannot finish is never mistaken for a whole file. None of the four formats defines an end-of-document mark or a checksum, so Ythril makes the end impossible to misread:

- **Store failure after the first byte.** Turtle, TriG and N-Quads end with a last line no grammar allows (`!ythril-export-incomplete`), after a comment saying why. Every parser then refuses the file. TriG and N-Quads still carry the report node with `ythril:complete false`. A JSON-LD document is left unterminated, which no JSON parser accepts. The trailer `Ythril-Export-Complete` says `false` (on an HTTP/1.1 answer, the only kind that carries trailers), and the audit row says `complete: false`.
- **Reader too slow** (the rate above, or nothing taken for five minutes). The same ending as a store failure: `INCOMPLETE ... too slowly`, then the line no parser accepts, and the trailer `Ythril-Export-Complete: false`. The text goes out a 16 KiB slice at a time, so the ending follows at most about two slices behind what the connection's buffers hold.
- **Reader gone, or the ending not taken in 30 minutes.** The answer is cut: its chunked body lacks the final chunk (RFC 9112 §7.1), which every HTTP client reports as a broken transfer. A bounded page whose reader takes nothing for five minutes is cut the same way. An HTTP/1.0 client, or a proxy that removes the chunking, cannot see that. If the cut falls between two store pages, a Turtle or N-Quads file can then look whole, so such a reader should check that the file ends with the `# ythril-export:` comment line.
- **An address no document can carry.** A stored base, vocab or `iri` an RDF writer cannot spell (`rdf_unwritable`, below) is found before the first byte, so it is a refusal, never a stream that stops.
- **Store failure before the first byte.** A clean `503 rdf_export_incomplete`.

- **REST** says what is left before the body: `Link: </api/brain/spaces/research/export/rdf?format=turtle&after=...>; rel="next"` while records are left, and no `Link` on the last page. The budget used is in `Ythril-Budget-Chars` (and `Ythril-Budget-Bytes` when you stated one).
- **MCP** answers the document once, in the first text block. The second text block and `structuredContent` hold the summary: `members`, `format`, `mediaType`, `edgeDetails`, `version`, `records`, `counts` per kind, `complete`, `nextAfter`, `skippedValues`, `fileTriplesWithheld` and the budget fields. `complete` is the document's own `ythril:complete`: whether this document is whole, so it is true on every page, one with more after it included; `nextAfter` is what says more is left, and the last page has none. The tool declares this shape as its `outputSchema`.

The Content-Type is the format's registered media type. An RDF 1.2 document says so twice: it starts with `VERSION "1.2"` and its Content-Type carries `; version=1.2`. A reader older than RDF 1.2 cannot parse a triple term: ask for `edgeDetails=reification`. Every answer, in every format, says `Vary: Accept, Accept-Encoding` and comes as an attachment named for the space or view (`research.ttl`, `research.trig`, `research.nq`, `research.jsonld`). In Turtle and TriG a subject can appear in more than one block (an edge's statement is written with the edge, under its from-record, as the export streams record by record); both grammars allow it and every reader merges the blocks.

A page is built whole before the first byte is sent. A store that does not answer is `503 rdf_export_incomplete` with `Retry-After` and nothing sent; try again from the same `after`. A document always ends with its own ending (the closing comment, and in TriG, N-Quads and JSON-LD the report node below): one that stops before it was cut off on the way.

### The description graph

TriG, N-Quads and JSON-LD end with a small graph that says what the file holds, in standard terms. A node of class `ythril:ExportReport` has each record graph of the page as a part (`dcterms:hasPart`, and each graph `dcterms:isPartOf` it), and each record graph names the shapes that check it with SHACL's `sh:shapesGraph`: the space's schema at the exported version, the same address every record names in `dcterms:conformsTo` and the [schema export](#rdf-schema-export) writes. The report also says how the page ended: `ythril:complete true` means the document is whole (`false` only on an export that could not finish), and a page with more after it says so with `ythril:nextAfter`. The report's address is derived from the scope, each member's schema version and the page's place in the walk, so one page has one report address in all four formats. A view none of whose members you read says why it holds nothing, in an `rdfs:comment` on the report and in the closing comment.

```trig
<urn:ythril:export-report:9c1e...> {
    <urn:ythril:export-report:9c1e...> a ythril:ExportReport ;
        dcterms:hasPart <https://ythril.example/ld/research/> ;
        ythril:complete true ;
        ythril:leftOutCount 0 ;
        ythril:recordCount 42 .
    <https://ythril.example/ld/research/> dcterms:isPartOf <urn:ythril:export-report:9c1e...> ;
        sh:shapesGraph <https://ythril.example/ld/research/schema/3f2a...> .
}
```

`dcterms:hasPart` and `dcterms:isPartOf` are Dublin Core's part relation, read by DCAT and most RDF stores; `sh:shapesGraph` is SHACL's link from a data graph to its shapes (SHACL §3.1.1). A Turtle document has one graph, the data the shapes check, so it says the same in its closing comment instead of mixing statements about the file into the records: `# ythril-export: 42 records on this page; complete, nothing is left; 0 property values left out; shapes: <...>`.

### Values left out

A property holds one plain value; structure is edges and links ([decision record 23](../decisions/23-a-property-holds-one-plain-value-and-structure-is-an-edge-or-a-link.md)). A value a direct database write left as a list or an object, or one that does not fit its declared type, gives no statement; the rest of its record is exported. It is never dropped silently: the page counts it and names the first 100 (`recordId`, `key`, the reason in words) in the closing comment, in the report node (`ythril:leftOutCount`, `ythril:leftOutValue`), in MCP `skippedValues`, in the REST trailers `Ythril-Skipped-Values` and `Ythril-Skipped-Records` (declared up front in `Trailer:` on an HTTP/1.1 answer, the only kind that can carry trailers; an HTTP/1.0 answer and a `HEAD` declare none, and a browser or proxy may drop them: the document keeps the count), and in the audit row. A value of a property declared `date` that is no calendar date or time in the XML Schema grammars (`yesterday`, `2026-04-05T10:00` without seconds) does not fit its declared type and is left out in the same way.

### Several spaces at once: a personal view

Name your own [personal view](06d-personal-views.md) as the space to export several spaces in one file, one named graph each. A view exports what you could read by naming each member: a member you may not read is not in the answer at all (no graph, no name, no count), exactly as `recall` and `filter` over the view answer. `Ythril-View-Members` (REST, exposed to browsers) and `members` (MCP) name the spaces covered. A member you read whose RDF is off is left out and named (`membersWithoutRdf` on MCP, `Ythril-View-Members-Without-Rdf` on REST, and the closing comment); one whose RDF names are not settled (a contested or shared base, a term clash, an address no document can carry) likewise (`membersInConflict`, `Ythril-View-Members-In-Conflict`). A view none of whose read members has RDF on is `409 rdf_not_enabled`; a view with no member you read answers an empty document that says why.

### Rights

The export needs `knowledge: read`. File statements need `files: read` on their space as well: without it they are left out, and the answer says only that some were withheld (`Ythril-File-Triples: withheld`, `fileTriplesWithheld: true`), never how many or which. An edge or a link is written with its ends as [`filter`](04-brain-api.md) shows them at `knowledge: read`. Every export is audited as `rdf.export`, with its scope, format, counts and the values it left out, whether or not reads are logged.

### Limits and refusals

At most two exports run at once on the instance, one per token; another answers `429 rdf_export_busy` with `Retry-After`.

| Status | Code | When |
|---|---|---|
| 400 | `rdf_bad_format` | A `format` that is not one of the four |
| 400 | `rdf_bad_edge_details` | Another `edgeDetails`, or `rdf12` with JSON-LD |
| 400 | `rdf_bad_after` | An `after` this export did not give |
| 400 | `rdf_bad_limit` | A `limit` that is not a whole number from 1 to 10 000 |
| 400 | `rdf_bad_budget` | A size ceiling that is not a positive whole number (one above or below the bounds is held to them, not refused) |
| 400 | (the tool door's) | MCP: an argument the tool does not take, as on every tool |
| 403 | (the rights guard's) | No `knowledge: read` on the space |
| 406 | `rdf_format_not_acceptable` | Turtle over several spaces, or an `Accept` naming nothing that fits |
| 409 | `rdf_not_enabled` | The space has RDF off |
| 409 | `rdf_unwritable` | A stored address no RDF document can carry (an older value with a control character or an unpaired surrogate): the refusal names what holds it (the base or vocab of the RDF setting, a type or property, a library namespace), before any byte is sent |
| 409 | `rdf_base_shared` | Another space of this instance holds the same base, so the addresses are not the space's own (`<base>schema` would name two ontologies): one of them needs another base. The other space is named only to a caller who may read its schema. The save doors refuse to make such a pair with the same code ([RDF names](#rdf-names-metardf-and-iri)); a pair that already exists is refused here |
| 409 | `rdf_base_conflict` | A network the space is shared in contests its base. The network, member and offered base are named only to a caller who may read that network |
| 429 | `rdf_export_busy` | Two exports run, or one of yours |
| 503 | `rdf_export_incomplete` | The store did not answer a page |

## RDF import

`POST /api/brain/spaces/:spaceId/import/rdf` and MCP `import_rdf` import an RDF document into a space: **Turtle**, **TriG**, **N-Quads** or **JSON-LD**, named by `Content-Type` (`text/turtle`, `application/trig`, `application/n-quads`, `application/ld+json`) or by `format`, plain or gzipped (`Content-Encoding: gzip`). MCP takes the document inline (`document`, up to the MCP body limit) and needs `format`; a larger file goes through the route.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/turtle" \
  --data-binary @people.ttl "https://ythril.example/api/brain/spaces/research/import/rdf?dryRun=true"
```

**All or nothing.** The whole file is read and sorted, every statement translated into records, and every record checked by the same planners an ordinary write goes through, before anything is written. A statement the space cannot hold is a reason, answered with its statements. In a **strict** space a reason refuses the whole import; so does, in every mode, a statement with no Ythril form (several values on one property, two kinds for one subject, an annotation on a triple the file does not assert) and any record a planner would refuse (a bound, a link, a reference). Nothing lands then, and the answer is `409 rdf_import_refused` with the report. In a **warn** or **off** space the reasons that mode records are answered and the import lands. Then the records are written kind by kind (facts, entities, chrono entries, edges), each an ordinary write: stamped with the schema it was judged by, synced, and queued for embedding.

**What becomes of a subject.** A subject under the space's own base whose record is stored is updated in place, and nothing is taken away: a field the file does not state keeps its stored value, tags and links are joined. Every other subject is a **new** record with an id this instance mints: importing the same foreign file twice makes its records twice, so run it with `dryRun` first. A file exported by another space keeps its records apart from yours: name that space's base as `sourceBase` (TriG, N-Quads and JSON-LD default to the file's one data graph). A file of several data graphs (a view's export) needs one `graphBase` per graph; a paged export imported page by page does not keep the links between pages. Files are never imported (their bytes are not in RDF); a file statement is counted as not taken.

**Large files.** The file is read as a stream and sorted on disk, so its size is bound by the import's own bounds and not by memory. The body is read as it arrives whatever its `Content-Type` says (curl's default form-data type and `application/json` too: the media type only names the format when `format` is not given), and a document the bounds refuse is answered by the import's own bound, never by a general body limit. The door only reads and sorts the file, counts its records from the sort and answers `413 rdf_bound_exceeded` for a file that cannot fit; it answers `202` with the `importId` before it has read one record of the space, and the translation, the plan and the commit run in the act, under its hold. One shape is the exception: the JSON-LD library holds a top-level `@graph` array whole, so a JSON-LD document whose top level is `@graph` (the shape of Ythril's own JSON-LD export) and that is longer than the reader holds as text that completes no statement is refused with `400 rdf_jsonld_not_streamable`, on both doors. Split such data into several documents, or send it as Turtle, TriG or N-Quads: Turtle, TriG and N-Quads have no such limit.

### Parameters

| Parameter | Values | Default |
|---|---|---|
| `format` | `turtle`, `trig`, `nquads`, `jsonld` | REST: from `Content-Type`; MCP: required |
| `dryRun` | `true`: read, translate and check everything, write nothing, register no act | `false` |
| `blankNodes` | `refuse`, `mint` (a blank subject becomes a new record) | `refuse` |
| `sourceBase`, `sourceVocab` | The base (and vocabulary, default `<sourceBase>vocab/`) of the space the file came from | the file's one data graph |
| `graphBase` | `"<graph address> <source base>"`, once per data graph (REST: repeat the parameter; MCP: an array) | none |
| `schema` | Not available yet: refused by name (`rdf_import_schema_not_available`) | |

### The answer and the report

`200` with the report when the import finished within the request, `202` with `importId`, `status: "running"` and `location` (also the `Location` header) while it runs on, and also when the act failed in a way it retries by itself (the store did not answer, say): it stays owed, lands in time, and the status answer then carries `retryAt`; never send the file again for a `202`, it would be imported twice. An import that cannot go on and never will is answered by its own status and code on both doors (`410 rdf_import_files_lost`, `422 rdf_import_state_unreadable`, the space's own `409` such as `rdf_not_enabled` when RDF was switched off before the act began, `413 rdf_bound_exceeded` for a file whose records pass the bound); the status answer says `failed` with the same. `409 rdf_import_refused` with the report when it was refused. `GET /api/brain/spaces/:spaceId/import/rdf/:importId` and MCP `import_rdf_status` (`importId`) answer the report for seven days. The report holds `status` (`running`, `completed`, `refused`, `failed`, `dry-run`), `quads` and `subjects`, per kind the records `inserted` and `converged`, the `reasons` (each its `code`, `outcome` `refused` or `recorded`, its message and up to 20 of its statements; the first 100 reasons are named, `reasonCount` and `reasonsByCode` count them all) and `notTaken` (the statements left out on purpose, by why: server-owned, derived, a file, the export's own description). A statement shows a literal by its datatype and length, never its text. A stored record the file names and that holds more link rows than an import reads (rows that arrived by sync are not held to the per-class cap) cannot be converged onto without taking links away: the import is refused with a reason coded `stored_record_links_over_bound`, naming the record's kind and id.

### While it runs

The import is a space act. From the moment it is registered until it ends, the space takes no other write (`409 space_being_rdf_imported`, the sentence naming the RDF import), no schema write a caller starts (the type routes, the whole schema, the validation mode, MCP `schema_update`: the same code) and no sync of its records. A schema a network decides meanwhile (a passed round, a layer that arrives) is stored as it always is and governs the writes after the import: the import is judged and stamped by the schema read when its act began, and once its first window is written nothing ends it but finishing (a space whose RDF is switched off meanwhile still gets the rest of the import). A token bound to a peer (a sync credential) is refused the import (`403`, the tool's error names the operator token): its request would be stopped by the act it registers. One RDF import body runs at a time on the instance; a large file holds its space for minutes. After a restart it resumes where it was, under the ids it minted the first time, so no record is written twice. A refused import ends the act, and the space takes writes again.

### Rights and audit

Both doors need `knowledge: write`, for a dry run and the status too: they answer which records are stored and which values break the schema. Any writer of the space reads another caller's report of that space (an id of another space's import is answered as not found), a report is not served after seven days, and deleting the space removes its reports. The import asks the brain's hard storage limit as the fact doors do (`507 storage_exceeded`, the tool an error result), a dry run excepted. Every import is audited as `rdf.import` with its counts (never a value of the file), and sends one `bulk.write` webhook summary.

| Status | Code | When |
|---|---|---|
| 400 | `rdf_import_bad_param` | A parameter that is not one the import takes, or a source base that is not an absolute address ending in `/` |
| 400 | `rdf_import_schema_not_available` | `schema` was sent |
| 400 | `rdf_import_several_graphs` | Several data graphs and one without its `graphBase` |
| 400 | `rdf_malformed` (and the reader's other codes) | The file is not well-formed: the answer names the line and column (`place`) |
| 400 | `rdf_jsonld_not_streamable` | A JSON-LD document longer than the reader holds unparsed whose top level is `@graph`, or one whose `@context`, `@id` or `@type` comes after the data it governs |
| 403 | (the rights guard's) | No `knowledge: write` on the space |
| 404 | `space_not_found` | A personal view: an import writes into a space |
| 409 | `rdf_import_refused` | The import was refused; nothing was written |
| 409 | `rdf_not_enabled` | The space has RDF off |
| 409 | `rdf_import_busy` | Another RDF import is being read in |
| 404 | `rdf_import_not_found` | The status door: no import of this space has that id, or its report is past seven days |
| 409 | `rdf_base_conflict`, `rdf_base_shared`, `rdf_term_clash`, `rdf_unwritable` | The space's RDF names are not settled (a contested or shared base, a term clash, an address no document can carry), as for the exports |
| 400 | `rdf_relative_iri`, `rdf_remote_context`, `rdf_gzip_invalid`, `rdf_unsupported`, `rdf_source_failed` | The reader's other refusals: a relative address with no base, a remote JSON-LD context, a gzip body that does not inflate, a construct the reader does not take, a source that failed while being read |
| 410 | `rdf_import_files_lost` | The act's files are gone (an act answered after its files were removed) |
| 422 | `rdf_import_state_unreadable` | The act's state can no longer be read |
| 503 | `shutting_down` | The instance is shutting down; the import resumes after the next start |
| 507 | `storage_exceeded` | The brain's hard storage limit is reached |
| 413 | `rdf_bound_exceeded` | Over a bound, named in `bound`: the statements, the subjects, the statements or characters of one subject, the records, a literal or token, the inflated size, the body |
| 415 | `rdf_unsupported_format`, `rdf_unsupported_encoding` | A media type or `Content-Encoding` the import does not read |

## RDF schema export

`GET /api/spaces/:id/schema-rdf` and MCP `space_schema_rdf` give a space's schema as an OWL ontology (what its own types and properties mean) and SHACL shapes (what its records may hold), in **Turtle** (the default) or **JSON-LD**, by `format` or by `Accept` (`text/turtle`, `application/ld+json`).

```bash
curl -H "Authorization: Bearer $TOKEN" https://ythril.example/api/spaces/research/schema-rdf
curl -H "Authorization: Bearer $TOKEN" -H "Accept: application/ld+json" https://ythril.example/api/spaces/research/schema-rdf
```

The ontology is `<base>schema` with `owl:versionIRI <base>schema/<fingerprint>`: the address each records export names as its shapes graph, so a consumer fetches the shapes here and validates the export with any SHACL validator. Everything the schema says about a type or a property reaches the export: descriptions as `sh:description` (and `rdfs:comment` on the space's own terms), names as `sh:name`, value rules as SHACL constraints, the rest as `ythril:` annotations; the space's purpose is the ontology's `rdfs:comment`. Every text is a plain literal with no language tag. A type or property mapped to an outside vocabulary (`schema:Person`) gets no statement of its own; the space's words about it sit on its shape. A library namespace no term of the space uses is not mentioned.

MCP answers the document in its first text block and the summary (`ontology`, `version`, `fingerprint`, `leftOut`) in the second and in `structuredContent`. The export needs `schema: read`; a personal view has no schema and is answered as every schema door answers a view. It refuses `rdf_bad_format`, `rdf_format_not_acceptable`, `rdf_not_enabled`, `rdf_base_conflict`, `rdf_base_shared`, `rdf_term_clash` and `rdf_unwritable` (409, naming the setting, type or property whose stored address cannot be written), the rights guard's 403 without `schema: read`, and is audited as `schema.rdf.export` when reads are logged. `HEAD` answers its headers after the same rights check, and is audited as the `GET` is, with `method: "HEAD"`.

The shapes carry no `sh:message`: a SHACL validator words its own results, and the product's own words for a rule travel as `ythril:ruleMessage` on the ontology (a rule is a CEL expression, not a shape). To canonicalise the JSON-LD with RDF Dataset Canonicalization (RDFC-1.0, formerly URDNA2015), allow a work factor of 2 (`maxWorkFactor: 2` in `rdf-canonize`, which `jsonld` uses): the shapes repeat blank-node structures that look alike from property to property (the lists and helper shapes of a value rule), which the default factor of 1 refuses as a possible poison graph; with 2 a space's schema canonicalises in milliseconds.

## RDF names: `meta.rdf` and `iri`

`meta.rdf` gives a space's records and schema terms web addresses (IRIs) for an RDF export: `{ "enabled": true, "base": "<IRI ending in />", "vocab": "<namespace>", "baseEpoch": <n> }`, set by `PATCH /api/spaces/:id` or MCP `schema_update` (`rdf`) at the schema `admin` rung ([Space Schemas](06a-schema-api.md)). It is off until `enabled: true`; a space without it names nothing and behaves as before. Every record's address is `<base><kind>/<id>`; `vocab` (default `<base>vocab/`) names the space's own types and properties, and moves only with the base. The first enable takes the base you send, or `<public URL>/ld/<space id>/` from the instance's `publicUrl` (or `PUBLIC_BASE_URL`); with neither it answers `400 rdf_base_needed`. Give a space a persistent base when you first switch RDF on: a w3id.org or purl.org address redirected to the space, or a domain of your own, rather than the instance's URL. Every address an export gives out is built from the base, and others keep those addresses: an instance's URL changes when the instance moves, while a base changes only by a rebase that retires every address the space gave out. Every write of `meta.rdf` names `enabled` (without it the write is `400`); a `base` or `vocab` it leaves out keeps the stored one, and `baseEpoch` is the server's own count of base changes.

The base is set once: a different `base` or `vocab` answers `409 rdf_base_frozen`, naming both. Send the new base with `rebase: true` (never stored) to change it on purpose, which changes every address the space gave out: on a space in no network at once, with `baseEpoch` one higher; on a space in a network it opens a `space_rebase` vote, answers `202 vote_pending` and lands at the vote's deadline ([the rebase vote](08-networks-api.md#the-rebase-vote-space_rebase)); send `rdf` alone then (`400 rdf_rebase_alone`). A base another space of this instance already holds with RDF on is refused at the save, `409 rdf_base_shared` and nothing stored: for an enable, a rebase (a networked one too, before the vote opens), an accepted offer, and a create (`POST /api/spaces`, MCP `save_space`, which leaves no space behind). The other space is named only to a caller with `schema: read` on it (or instance administration); a space with RDF off holds no address and does not count, and the default `<public URL>/ld/<space id>/` meets it only through another space's explicit base. A pair that already exists (a landed vote made it) does not refuse a write that leaves the base as it is: the exports refuse it (above). A settings vote, a network's layer and a precedence swap never change the base; a base a network offers at a higher epoch that no held vote explains (a member that missed the vote) is recorded on this instance beside that network, as a base conflict (it follows its space: gone when the space leaves the network, moved when it is renamed); sending that base with `rebase: true` accepts it here alone at its epoch, with the vocab it was offered with, and a rebase vote settles it too. `rdf` is refused with `targetNetwork` (`400 rdf_not_a_layer_field`). On MCP a refusal's `code` is in the structured content. A type and a property may name their own address with `iri` (`http://schema.org/Person`, `http://schema.org/email`: schema.org terms are written in `http://schema.org/`, the namespace its own JSON-LD context and existing data use); without one the vocab names them in the W3C Direct Mapping's shape: a type is `<vocab><kind>/<type>` and its property `<vocab><kind>/<type>#<property>` (an untyped record's or a file's property `<vocab><kind>#<property>`), each name percent-encoded only where IRI syntax needs it, and an empty name has none. A `vocab` ends in `/` and holds no `#`. `iri` is part of the schema: changing it changes the schema fingerprint and shows in a version diff as a change of shape. On a space with RDF on, a write that leaves two terms with one address answers `422 rdf_term_clash` (creating such a space too, and accepting an offered base that would leave one), naming both: two types, or a type and a property, with one `iri`; two properties with one and different declared types (agreeing types may share one); an `iri` under the space's own vocab, or anywhere under its base (where its records' addresses live, so `<base>entity/Person` could be the record `Person`); or one the export writes itself (such as `rdfs:label`, `dcterms:created`).

## Record addresses

Every address an export writes is a name under the space's base, by default `<public url>/ld/<space>/`. Ythril does not resolve these addresses yet: a request for one answers `404` with a problem body (`application/problem+json`) that says where the export is, never the web app. Choose a persistent base (a w3id.org or purl.org address, or a domain of your own) when you first switch RDF on, because others keep the addresses an export gives out.
