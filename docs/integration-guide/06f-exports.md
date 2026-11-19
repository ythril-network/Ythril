# Exports

> Part of the [Ythril Integration Guide](../integration-guide.md).

An export gives a space's records, or its schema, in a standard format another tool reads without knowing Ythril. Each export is one capability on two doors: a REST route and an MCP tool that take the same parameters and answer the same bytes. This page has one section per format family; RDF is the first.

A space must have RDF switched on (`meta.rdf`, see [Space Schemas and Validation](06a-schema-api.md)) before its records have addresses to export.

## RDF records export

`GET /api/brain/spaces/:spaceId/export/rdf` and MCP `export_rdf` give the records of a space as **Turtle**, **TriG**, **N-Quads** or **JSON-LD**: every entity, fact, chrono entry, edge, link and file under its RDF address, built from standard vocabularies (Dublin Core, PROV, schema.org, OWL-Time) and the [Ythril vocabulary](../rdf/ythril-vocabulary.md).

```bash
# The default for one space: Turtle
curl -H "Authorization: Bearer $TOKEN" https://ythril.example/api/brain/spaces/research/export/rdf

# The same, chosen by the Accept header
curl -H "Authorization: Bearer $TOKEN" -H "Accept: application/n-quads" https://ythril.example/api/brain/spaces/research/export/rdf
```

### Parameters

| Parameter | REST | MCP | Meaning |
|---|---|---|---|
| `format` | query | argument | `turtle`, `trig`, `nquads` or `jsonld`. It wins over `Accept`. Default: Turtle for one space, TriG for a view of several |
| `Accept` | header | none | Read when no `format` is given, with its q-values: `text/turtle`, `application/trig`, `application/n-quads`, `application/ld+json`. `*/*` or none takes the default |
| `edgeDetails` | query | argument | `rdf12` (the default for the text formats) states an edge's own details on an RDF 1.2 reifier; `reification` uses the classic `rdf:Statement` form, which every reader takes and the only form JSON-LD carries |
| `after` | query | argument | The `nextAfter` of the previous page |
| `limit` | query | argument | The most records in a page, 1 to 10 000 |
| `maxChars`, `maxBytes`, `maxTokens` | query | argument | The size ceiling of a page. The default is the one the doors differ on: 50 000 characters on REST, 25 000 on MCP. Raise `maxChars` (up to 5 000 000) for bigger pages |

Over a view of several spaces Turtle cannot hold the graphs: an `Accept` that prefers it gets the best format that fits (TriG, then N-Quads, then JSON-LD), and `format=turtle` is `406 rdf_format_not_acceptable`, which lists the formats that fit. So does an `Accept` naming none of them.

### What a page holds and how it ends

A page ends at `limit` records or at the size ceiling, whichever comes first; the first record is always whole. Pages follow each other by a keyset: a record written while you page is either wholly in or wholly out, and none comes twice.

- **REST** says what is left before the body: `Link: </api/brain/spaces/research/export/rdf?format=turtle&after=...>; rel="next"` while records are left, and no `Link` on the last page. The budget used is in `Ythril-Budget-Chars` (and `Ythril-Budget-Bytes` when you stated one).
- **MCP** answers the document once, in the first text block. The second text block and `structuredContent` hold the summary: `members`, `format`, `mediaType`, `edgeDetails`, `version`, `records`, `counts` per kind, `complete`, `nextAfter`, `skippedValues`, `fileTriplesWithheld` and the budget fields. The tool declares this shape as its `outputSchema`.

The Content-Type is the format's registered media type. An RDF 1.2 document says so twice: it starts with `VERSION "1.2"` and its Content-Type carries `; version=1.2`. A reader older than RDF 1.2 cannot parse a triple term: ask for `edgeDetails=reification`. Every answer says `Vary: Accept` and comes as an attachment named for the space or view (`research.ttl`, `research.trig`, `research.nq`, `research.jsonld`).

A page is built whole before the first byte is sent. A store that does not answer is `503 rdf_export_incomplete` with `Retry-After` and nothing sent; try again from the same `after`. A document always ends with its own ending (the closing comment, and in TriG, N-Quads and JSON-LD the report node below): one that stops before it was cut off on the way.

### The description graph

TriG, N-Quads and JSON-LD end with a small graph that says what the file holds, in standard terms. A node of class `ythril:ExportReport` has each record graph of the page as a part (`dcterms:hasPart`, and each graph `dcterms:isPartOf` it), and each record graph names the shapes that check it with SHACL's `sh:shapesGraph`: the space's schema at the exported version, the same address every record names in `dcterms:conformsTo` and the [schema export](#rdf-schema-export) writes. The report also says how the page ended.

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

A property holds one plain value; structure is edges and links ([decision record 23](../decisions/23-a-property-holds-one-plain-value-and-structure-is-an-edge-or-a-link.md)). A value a direct database write left as a list or an object, or one that does not fit its declared type, gives no statement; the rest of its record is exported. It is never dropped silently: the page counts it and names the first 100 (`recordId`, `key`, the reason in words) in the closing comment, in the report node (`ythril:leftOutCount`, `ythril:leftOutValue`), in MCP `skippedValues`, in the REST trailers `Ythril-Skipped-Values` and `Ythril-Skipped-Records` (declared up front in `Trailer:`; a browser or proxy may drop trailers, the document keeps the count), and in the audit row.

### Several spaces at once: a personal view

Name your own [personal view](06d-personal-views.md) as the space to export several spaces in one file, one named graph each. A view exports what you could read by naming each member: a member you may not read is not in the answer at all (no graph, no name, no count), exactly as `recall` and `filter` over the view answer. `Ythril-View-Members` (REST, exposed to browsers) and `members` (MCP) name the spaces covered. A member you read whose RDF is off is left out and named in `membersWithoutRdf`; a view none of whose read members has RDF on is `409 rdf_not_enabled`.

### Rights

The export needs `knowledge: read`. File statements need `files: read` on their space as well: without it they are left out, and the answer says only that some were withheld (`Ythril-File-Triples: withheld`, `fileTriplesWithheld: true`), never how many or which. An edge or a link is written with its ends as [`filter`](04-brain-api.md) shows them at `knowledge: read`. Every export is audited as `rdf.export`, with its scope, format, counts and the values it left out, whether or not reads are logged.

### Limits and refusals

At most two exports run at once on the instance, one per token; another answers `429 rdf_export_busy` with `Retry-After`.

| Status | Code | When |
|---|---|---|
| 400 | `rdf_bad_format` | A `format` that is not one of the four |
| 400 | `rdf_bad_edge_details` | Another `edgeDetails`, or `rdf12` with JSON-LD |
| 400 | `rdf_bad_after` | An `after` this export did not give |
| 400 | `rdf_bad_limit`, `rdf_bad_budget` | A `limit` or a size ceiling out of its range |
| 403 | `rdf_export_rung` | No `knowledge: read` on the space |
| 406 | `rdf_format_not_acceptable` | Turtle over several spaces, or an `Accept` naming nothing that fits |
| 409 | `rdf_not_enabled` | The space has RDF off |
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

MCP answers the document in its first text block and the summary (`ontology`, `version`, `fingerprint`, `leftOut`) in the second and in `structuredContent`. The export needs `schema: read`; a personal view has no schema and is answered as every schema door answers a view. It refuses `rdf_bad_format`, `rdf_format_not_acceptable`, `rdf_schema_rung` (403), `rdf_not_enabled` and `rdf_base_conflict` (409), and is audited as `schema.rdf.export` when reads are logged.

## Record addresses

Every address an export writes is a name under the space's base, by default `<public url>/ld/<space>/`. Ythril does not resolve these addresses yet: a request for one answers `404` with a problem body (`application/problem+json`) that says where the export is, never the web app. Choose a persistent base (a w3id.org or purl.org address, or a domain of your own) when you first switch RDF on, because others keep the addresses an export gives out.
