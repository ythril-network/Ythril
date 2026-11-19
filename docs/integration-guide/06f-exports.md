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

A request that names no `limit`, `after` or size ceiling gets the **whole** export of the space or view in one answer, streamed a store page at a time: Jena, RDF4J, rdflib and curl read it as it is, over HTTP/1.1 or HTTP/1.0. There is no `Link` on it, because there is no next page. The largest export this serves has no fixed size: the stream holds only one store page in memory and keeps no database cursor open, and what bounds it is time. While the export waits on its reader, the reader must take at least 16 KiB a second on average over each 60 seconds of such waiting, or the export ends in the incomplete form below, which the reader still receives after what its connection already holds, and its slot is freed at once. What the server can measure is what the operating system accepted from it, which runs ahead of what the reader has received by the connection's send buffer (often a few MiB): the export waits, and so is measured, only once that buffer is full, so a slow reader is judged from then on and a slow store never counts against it. A reader that takes nothing at all for 60 seconds is cut without an ending. Each store page must be read within 30 seconds, and only two exports run on the instance at once.

`HEAD` on the route answers the headers a `GET` would (`Content-Type`, `Content-Disposition`, `Vary`, the view headers) after the same rights check and the same refusals, with no content; it reads no record and takes no export slot.

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
- **Reader too slow** (the rate above). The same ending as a store failure: `INCOMPLETE ... too slowly`, then the line no parser accepts. The text goes out a 16 KiB slice at a time, so the ending follows at most about two slices above what the connection holds; the connection stays only while the reader still takes something.
- **Reader gone or idle.** No ending can be written to a socket that takes nothing. The answer is cut: its chunked body lacks the final chunk (RFC 9112 §7.1), which every HTTP client reports as a broken transfer. An HTTP/1.0 client, or a proxy that removes the chunking, cannot see that. If the cut falls between two store pages, a Turtle or N-Quads file can then look whole, so such a reader should check that the file ends with the `# ythril-export:` comment line.
- **An address no document can carry.** A stored base, vocab or `iri` an RDF writer cannot spell (`rdf_unwritable`, below) is found before the first byte, so it is a refusal, never a stream that stops.
- **Store failure before the first byte.** A clean `503 rdf_export_incomplete`.

- **REST** says what is left before the body: `Link: </api/brain/spaces/research/export/rdf?format=turtle&after=...>; rel="next"` while records are left, and no `Link` on the last page. The budget used is in `Ythril-Budget-Chars` (and `Ythril-Budget-Bytes` when you stated one).
- **MCP** answers the document once, in the first text block. The second text block and `structuredContent` hold the summary: `members`, `format`, `mediaType`, `edgeDetails`, `version`, `records`, `counts` per kind, `complete`, `nextAfter`, `skippedValues`, `fileTriplesWithheld` and the budget fields. The tool declares this shape as its `outputSchema`.

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
| 409 | `rdf_base_shared` | Another space of this instance holds the same base, so the addresses are not the space's own (`<base>schema` would name two ontologies): one of them needs another base. The other space is named only to a caller who may read its schema. The save doors refuse to make such a pair with the same code ([06a](06a-schema-api.md#rdf-names-metardf-and-iri)); a pair that already exists is refused here |
| 409 | `rdf_base_conflict` | A network the space is shared in contests its base. The network, member and offered base are named only to a caller who may read that network |
| 429 | `rdf_export_busy` | Two exports run, or one of yours |
| 503 | `rdf_export_incomplete` | The store did not answer a page |

## RDF schema export

`GET /api/spaces/:id/schema-rdf` and MCP `space_schema_rdf` give a space's schema as an OWL ontology (what its own types and properties mean) and SHACL shapes (what its records may hold), in **Turtle** (the default) or **JSON-LD**, by `format` or by `Accept` (`text/turtle`, `application/ld+json`).

```bash
curl -H "Authorization: Bearer $TOKEN" https://ythril.example/api/spaces/research/schema-rdf
curl -H "Authorization: Bearer $TOKEN" -H "Accept: application/ld+json" https://ythril.example/api/spaces/research/schema-rdf
```

The ontology is `<base>schema` with `owl:versionIRI <base>schema/<fingerprint>`: the address each records export names as its shapes graph, so a consumer fetches the shapes here and validates the export with any SHACL validator. Everything the schema says about a type or a property reaches the export: descriptions as `sh:description` (and `rdfs:comment` on the space's own terms), names as `sh:name`, value rules as SHACL constraints, the rest as `ythril:` annotations; the space's purpose is the ontology's `rdfs:comment`. Every text is a plain literal with no language tag. A type or property mapped to an outside vocabulary (`schema:Person`) gets no statement of its own; the space's words about it sit on its shape. A library namespace no term of the space uses is not mentioned.

MCP answers the document in its first text block and the summary (`ontology`, `version`, `fingerprint`, `leftOut`) in the second and in `structuredContent`. The export needs `schema: read`; a personal view has no schema and is answered as every schema door answers a view. It refuses `rdf_bad_format`, `rdf_format_not_acceptable`, `rdf_not_enabled`, `rdf_base_conflict`, `rdf_base_shared`, `rdf_term_clash` and `rdf_unwritable` (409, naming the setting, type or property whose stored address cannot be written), the rights guard's 403 without `schema: read`, and is audited as `schema.rdf.export` when reads are logged. `HEAD` answers its headers after the same rights check, unaudited.

The shapes carry no `sh:message`: a SHACL validator words its own results, and the product's own words for a rule travel as `ythril:ruleMessage` on the ontology (a rule is a CEL expression, not a shape). To canonicalise the JSON-LD with RDF Dataset Canonicalization (RDFC-1.0, formerly URDNA2015), allow a work factor of 2 (`maxWorkFactor: 2` in `rdf-canonize`, which `jsonld` uses): the shapes repeat blank-node structures that look alike from property to property (the lists and helper shapes of a value rule), which the default factor of 1 refuses as a possible poison graph; with 2 a space's schema canonicalises in milliseconds.

## Record addresses

Every address an export writes is a name under the space's base, by default `<public url>/ld/<space>/`. Ythril does not resolve these addresses yet: a request for one answers `404` with a problem body (`application/problem+json`) that says where the export is, never the web app. Choose a persistent base (a w3id.org or purl.org address, or a domain of your own) when you first switch RDF on, because others keep the addresses an export gives out.
