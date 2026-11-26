# RDF and SPARQL: BSBM against Oxigraph

This measures Ythril's SPARQL endpoint (`POST /api/brain/spaces/:spaceId/sparql`) against
[Oxigraph](https://github.com/oxigraph/oxigraph) on the Berlin SPARQL Benchmark (BSBM), so a decision about
a triple cache rests on numbers. Q-759.

- **Data**: BSBM Tools v0.2, generated at 1 000, 5 000 and 20 000 products **without forward chaining**, then
  turned into one Ythril-loadable variant that both engines load (see [The dataset variant](#the-dataset-variant)).
  Ythril runs only the sizes its import takes: 1 000, and the largest product count whose generated data stays under
  the import's 200 types per kind (found by `typecap-search.mjs`, 4 641 products with 135 types; at 4 642 the
  hierarchy grows to 263). 5 000 and 20 000 are Oxigraph-only: Ythril refuses them (`schema_rdf_refused`, 200 types
  per kind; 20 000 would also exceed the 1 GiB import body bound).
- **Queries**: the 11 Explore queries, Q1-Q5 and Q7-Q12. BSBM removed Q6 from the mix, so the "12" in the
  ticket is 11. Their text is read from the pinned archive, never retyped here.
- **Parameters**: chosen by BSBM's own test driver under its seed. Run `k` of a query uses parameter set `k`
  on both engines, so both are asked the same questions.
- **Runs**: 3 warm-up and 20 measured per query, per size, per engine. Median and p95 (nearest rank).
- **Pinned**: the BSBM archive by sha256, the images by digest, both seeds; all in [`pin.json`](pin.json).

Everything the harness fetches, generates or records goes to a work folder **outside** the repository
(`E:/TMP/Ythril/data/b271-bench/` by default, `--work <dir>` to move it). Nothing generated is committed.

## One command per step

Needs Node 24 and Docker. Every container is started through the machine's docker booking script when one
exists (`DOCKER_BOOKING`, else `~/.claude/hooks/docker-booking.js`).

| Step | Command | Leaves |
|---|---|---|
| 1. Generate | `node benchmarks/rdf/generate.mjs --sizes 1000` | `<work>/data/1000/{dataset.nt,variant.nt,td_data/,manifest.json,params.json}`: the raw generator output, the variant both engines load, and the manifest with both digests |
| 2a. Oxigraph | `node benchmarks/rdf/load.mjs oxigraph-up --size 1000` | a store loaded by `oxigraph load` from `variant.nt`, served on loopback; `<work>/state/oxigraph-1000.json` with the load time and the variant's sha256 |
| 2b. Ythril | `node benchmarks/rdf/load.mjs ythril-up --ythril-image <image>` then `node benchmarks/rdf/load.mjs ythril --size 1000 --import-query "schema=generate&from=data&inferMinSupport=1"` | a scratch instance with its own database, a strict space with RDF on, `variant.nt` sent through the RDF import door; `<work>/state/ythril-1000.json` with the load time, or the refusal, its code and its reason counts |
| 3. Run | `node benchmarks/rdf/run.mjs --engine oxigraph --size 1000`, then `--engine ythril --against <the oxigraph record>` | `<results>/<UTC stamp>-<engine>-<size>.json` and a markdown table on stdout; refused unless the store was loaded from the variant in the manifest. A Ythril run first maps every parameter address to the record Ythril minted (see [Binding the parameters](#binding-the-parameters)) and is judged against the Oxigraph record |
| 4. Compare | `node benchmarks/rdf/compare.mjs <oxigraph record> <ythril record> [--show-invalid]` | a side-by-side markdown table (median and p95 per query, Ythril over Oxigraph, rows on both sides) with a ratio only for comparable queries, each other query naming its reason, every comparable query more than 10x slower on the median marked, and the SPARQL limits and embed-queue wait in the header; refused unless both records name one size, one variant and one variant sha256, and refused for a record with a `rows-differ` query unless `--show-invalid` (the table then opens with an `INVALID` line) |
| 5. Clean up | `node benchmarks/rdf/load.mjs oxigraph-down --size 1000` and `node benchmarks/rdf/load.mjs ythril-down` | no container, volume or network left |

`--results <dir>` on `run.mjs` names the results folder (default `<work>/results/`). The committed
[`results/`](results/) folder holds only what a person chose to keep.

### The Ythril image

The RDF import door and `meta.rdf` are newer than the published image, so the scratch instance runs an image
built from the checkout under test (`docker build -t b271-ythril:<sha> .` at the repository root, booked). A tag
that is a commit hash is recorded as the commit under test; `--ythril-commit <sha>` names it otherwise.
`ythril-up` never touches an instance it did not start.

### What a Ythril run needs from the server

`run.mjs --engine ythril` calls `POST /api/brain/spaces/:spaceId/sparql` with `Content-Type:
application/sparql-query`, `Accept: application/sparql-results+json` (`text/turtle` for Q9, a DESCRIBE, and Q12, a
CONSTRUCT: the endpoint answers a graph as Turtle, N-Quads or JSON-LD, never N-Triples; Oxigraph is asked for
`application/n-triples`) and the scratch instance's Bearer token. A graph answer is counted by parsing it with `n3`
(distinct statements, both engines, `answer-rows.mjs`); an answer that does not parse is that query's error. Where
the endpoint does not exist the answer is `404` and the record holds that code per query; the run does not stop.
`n3` comes with the server workspace (`npm ci` at the repository root).

### Binding the parameters

The BSBM parameters name the generator's addresses (`.../dataFromProducer6/Product272`); the RDF import mints a new
address per record (`<base>entity/<uuid>`) and keeps the original nowhere, so the first Ythril run asked about
records that did not exist and answered 0 rows. The variant therefore ends with one statement per subject,
`<s> rdfs:seeAlso "<s>"` (the address as a plain string; an IRI object would be read as a link and answer the minted
address back). After the load, `run.mjs --engine ythril` asks the endpoint for the records carrying the parameter
addresses (one query per class: Product, ProductFeature, Review, Offer; product types are classes and keep their own
address), maps every parameter and prints how many it mapped. An address that maps to nothing stops the run; it is
never recorded as a 0-row answer. Oxigraph keeps the generator's addresses.

### Comparable queries

Run `k` of a query asks both engines the same question, so a query whose row count differs on any run means one
engine answered something else, and its time is not a time for the same work. Each Ythril query is judged on its own
(`comparability.mjs`) against the Oxigraph record, on every run:

- **comparable**: its row count is Oxigraph's on every run. Only these get a ratio.
- **not comparable**, with one reason of a fixed list, derived and never typed per query:
  - `data-not-held`: the query names a predicate the import does not keep and Ythril answered fewer rows on every
    differing run. The record names the predicates. They are found by counting: `run.mjs` counts, per predicate some
    query names, the statements the variant holds (`not-taken.mjs`) and asks the instance for its count of that
    predicate; a predicate the instance holds fewer statements of is not taken (`notTaken` in the record, with both
    counts). The import's own report gives only a count per reason, not the predicates.
  - `system-statements`: the query reads a whole record (a DESCRIBE, or a pattern with a variable predicate on a bound
    subject or object, read from its text by `query-shape.mjs`) and Ythril answered more rows on every differing run:
    the statements the server adds to every record are counted.
  - `rows-differ`: any other mismatch, a query that errored included. This is a finding about the engine, not about
    the data shape, and is reported.

Every query of a Ythril record carries `comparable` and, when it is not, its `reason` (`predicates` for
`data-not-held`, `differing` for `rows-differ`). The record's `valid` stays, defined as: every query comparable or
named `data-not-held` or `system-statements`. It is false exactly when a query is `rows-differ`; `invalidQueries`
names each, and `compare.mjs` refuses such a record unless `--show-invalid`. The Oxigraph record is the reference and
is valid. A query that is comparable but empty on every run (nothing in the variant matches) is marked in the table:
its time is the time of an empty answer.

### Limits and the embed queue

The instance's SPARQL limits (`sparql.timeoutMs`, `sparql.maxRecordsRead`, `sparql.maxResults`, read live) bound what
a query may do, and the defaults (30 s, 200 000 records, 10 000 results) stop the 4 641-product parameter lookup.
`load.mjs ythril-limits --timeout-ms 300000 --max-records-read 10000000 --max-results 100000` sets them on the scratch
instance (the server's own ceilings for the first two; refused past them). A Ythril run reads the limits in effect
from the instance and records all three (`sparqlLimits`); the table header prints them.

A freshly imported space is embedded in the background and that competes with the queries. A Ythril run waits until
the space's embed queue reports nothing pending or processing, at most `--embed-wait-minutes` (30), then measures
anyway; the record's `embedQueue` holds the wait in ms, the jobs left and whether it drained.

### Sizes over the import body bound

A variant over the door's 1 GiB body bound (`rdf_bound_exceeded`) is imported as subject-complete chunks in order
(`chunk.mjs`, `load.mjs ythril`): every statement of a subject in one chunk, a subject never before an end it points
at, each chunk under 768 MiB, the count recorded as `loadChunks`. No size the benchmark runs needs it, and a later
chunk names an earlier chunk's record by the generator's address, which the import does not keep, so an edge across
chunks is expected to be refused as an unknown end: the chunker has not been exercised against the door.

## The result record

One JSON file per run (design R10): `outcome` (`ok`, `partial`, `failed`), `engine`, `size`, `ythrilCommit`,
`oxigraphDigest`, `bsbmSeed` (generator and driver), `dataset` (`variant`, triples and sha256 of the variant both
engines load), `loadMs` or `loadRefusal`,
`valid` (and `invalidQueries` when false), `mappedParameters` and `loadChunks` for a Ythril run,
`warmups`, `runs`, and per query `median`, `p95`, `min`, `max`, `n`, `rows` (rows or statements of the first measured
answer), `rowsPerRun` (the count of every run, by parameter set), `errors` and the first `error` (`code`, `status`,
`message`). The last key is
`end: "END-OF-RECORD"`. A file is never overwritten: a second write to the same name is an error.

## Reading a refused Ythril load

BSBM data is not Ythril-shaped. On 2026-11-25 the import of the raw 1 000-product file (with forward chaining)
into a strict space with RDF on was refused `409 rdf_import_refused` after about 11 s with nothing written:
`no-kind` for 36 433 subjects (the BSBM classes are not Ythril kinds) and `class-without-term` for 40 433
statements. With `schema=generate&from=data`
(`load.mjs ythril --import-query "schema=generate&from=data&inferMinSupport=1"`) the kinds resolved and the refusal
became `several-types-of-one-kind` for 4 000 products and `language-tagged-literal` for 10 000 review texts. The
variant below removes exactly those two. The harness records the refusal it gets (the door's code and its reason
codes with their counts) and does not change the server.

The variant of 1 000 products, loaded the same way, is still refused: `rdf_import_refused` with `plan_refused`
30 503 times (one per Offer, Review and Person subject: 20 000 + 10 000 + 503) and `schema_violation` 60 000
times, nothing written. The result record of that run holds the codes.

## The dataset variant

`prepare.mjs` turns the raw generator output into `variant.nt`, and both engines load that file, so a difference
in timing is not a difference in triples. The rules, decided for the benchmark (language tags on values are an
open idea awaiting the owner, I-41):

- **One `rdf:type` per subject.** Without forward chaining the generator still gives each product two types
  (`bsbm:Product` and its `ProductTypeN`). A subject keeps its most specific class: one that is not above another
  of its classes in the data's own `rdfs:subClassOf` statements (followed transitively). Of two unrelated classes
  the one in the data's subclass hierarchy stays (`ProductTypeN`, not the vocabulary class `bsbm:Product`), else
  the first stated. The `rdfs:subClassOf` statements are all kept.
- **No language tags.** `"x"@en` becomes `"x"`, the same lexical form as a plain string.
- **The address statement.** Every subject that is an IRI ends the file with `<s> rdfs:seeAlso "<s>"` (see
  [Binding the parameters](#binding-the-parameters)), in order of first appearance.
- Nothing else changes: every other line leaves byte for byte, and the output has no stamp, so its sha256 is the
  same on every run. The result record names the variant (`ythril-loadable-2`) and that sha256.

Consequences for the queries, the same for both engines: Q8 filters `langMatches(lang(?text), "EN")`, so on the
variant it answers no rows; and Q1 and Q4, which match `rdf:type` against a product type, find only the products
of exactly that type, since nothing is forward-chained.

## What Ythril does not answer like Oxigraph (measured on the 1 000-product run, 2026-11-25)

With the parameters bound, Q1, Q3, Q4, Q5, Q7 and Q8 answered Oxigraph's row counts on every run. The others differ, for
reasons in the data model and not in the harness; they are the `data-not-held` and `system-statements` queries of the
section above (the first valid-data run judged them as one whole-record `valid: false`):

- **Statements the import does not hold** (`notTaken: not-inferred`): a literal with a custom datatype
  (`bsbm:price`, `"7956.65"^^bsbm:USD`), an IRI object that is no subject of the file (`bsbm:offerWebpage`,
  `foaf:homepage`, `bsbm:country`), `dc:publisher` and `rdfs:subClassOf`. Q2 needs `dc:publisher`, Q10 `dc:publisher`,
  `bsbm:country` and `bsbm:price`, Q12 `bsbm:price`, `bsbm:offerWebpage` and `foaf:homepage`: all answer 0 rows on Ythril.
- **Statements Ythril adds to every record** (`rdf:type ythril:Entity`, `dcterms:created`, `dcterms:modified`,
  `dcterms:conformsTo`, `prov:wasAttributedTo`, and the name as `rdfs:label` for an unlabelled subject): Q9 (DESCRIBE of
  a reviewer) and Q11 (every property of an offer) count them, so they answer more rows than Oxigraph.

These queries are not comparable and say why; a variant rule that makes the data representable is for the owner of the
benchmark.

## A label's meaning in the edge text (Q-763)

`embed-meaning.mjs` asks whether appending a label's meaning to an edge's embedding text improves edge recall. It runs on
the space `load.mjs ythril --size 1000` leaves, on the same scratch instance and model, with a reembed between the arms:

- **Arm A** is the text `edgeEmbedText` builds today (`server/src/brain/embed-text.ts`).
- **Arm B** appends the label's meaning: the `description` of the label's declaration in the space schema
  (`meta.typeSchemas.edge[<label>].description`), else the `rdfs:comment` the data states on the label's vocabulary term
  (the declaration's `iri`). The RDF import gives the six BSBM labels an `iri` and no description, and the data states no
  comment on a BSBM predicate, so `prepare` writes a pinned meaning per label (`MEANINGS`) into each declaration. Arm B
  needs no server change: `meaning` sets each edge's description to its label's meaning (BSBM edges have no description,
  tags, type or properties, so `edgeEmbedText` then ends with exactly the meaning), reembeds the edges, and checks a sample
  of stored texts against arm A's text plus the meaning.
- **Only edges are embedded.** `prepare` suppresses embeddings in the space and releases each edge label, since every
  query asks for edges only (`types: ['edge']`).
- **Queries**: fixed templates per label (`TEMPLATES`) that leave the label's words out (a template holding one is
  refused), filled with the endpoints' names; an edge is asked about only when the filled slots name it alone among its
  label's edges, so the target edge is the one relevant answer. Per seed, about 200 queries: the same number per label,
  drawn by a seeded generator. Their sha256 is recorded per seed, and arm B is refused unless it asks arm A's queries.
- **Metrics**: recall@10 and MRR@10 from `POST /api/brain/recall` (`topK: 10`, hybrid vector and lexical ranking), per
  arm and seed (1, 2, 3), and their means. The flag `embedVocabularyMeaning` ships only when arm B gains at least 3
  points of recall@10 and its MRR does not fall.

```text
node benchmarks/rdf/embed-meaning.mjs prepare --size 1000
node benchmarks/rdf/embed-meaning.mjs arm --arm A --size 1000
node benchmarks/rdf/embed-meaning.mjs meaning --size 1000
node benchmarks/rdf/embed-meaning.mjs arm --arm B --size 1000
node benchmarks/rdf/embed-meaning.mjs report --size 1000
```

Everything goes to `<work>/embed-meaning/`: each arm's record, the queries with their ranks per seed, and the results
file of `report`. The meanings and the templates were written by one author, which can favour arm B; a template never
holds the label's words, but the entity names can (`Review17`).

## Tests

`stats`, `params`, `queries`, `result-record`, `prepare`, `compare`, `ythril` (the refusal wording), `ythril-params`,
`chunk`, `answer-rows`, `validity`, `typecap`, `comparability`, `query-shape`, `not-taken`, `sparql-limits`,
`embed-wait` and `embed-meaning` (its pure parts) have `node:test` files in `testing/standalone/bsbm-harness-<module>.test.js`, so the standalone runner (and the
pure standalone part of CI) runs them with the repository's tests, and no workflow or script names them. Run one in a container, not on
the host, with `node_modules` of an `npm ci` (for `n3`) at the root of what is mounted:

```text
docker run --rm -v <checkout>:/w:ro -w /w node:24 node --test testing/standalone/bsbm-harness-stats.test.js
```

## Files

| File | What it is |
|---|---|
| `pin.json` | URLs, hashes, image digests, seeds, sizes |
| `generate.mjs` | download and verify BSBM Tools, generate datasets (no forward chaining), make the variant (again when its rules changed), capture the driver's parameters |
| `typecap-search.mjs` | the largest product count under the import's type cap, from the generator's output |
| `load.mjs` | `oxigraph-up/down`, `ythril-up/down`, `ythril` |
| `run.mjs` | runs the queries, maps Ythril's parameters, judges validity, writes the record and the table |
| `compare.mjs` | two records side by side, the queries more than 10x slower marked, invalid records refused |
| `embed-meaning.mjs` | Q-763: edge recall with and without the label's meaning in the embedding text (see [A label's meaning in the edge text](#a-labels-meaning-in-the-edge-text-q-763)) |
| `env.mjs`, `oxigraph.mjs`, `ythril.mjs`, `unzip.mjs` | plumbing: booked docker, the two engines, a zip reader |
| `comparability.mjs`, `query-shape.mjs`, `not-taken.mjs` | the per-query judge, what a query's text needs, and the predicates the import does not keep (counted) |
| `sparql-limits.mjs`, `embed-wait.mjs` | the instance's SPARQL limits (read, raised within the server's ceilings) and the bounded wait for the embed queue |
| `stats.mjs`, `params.mjs`, `queries.mjs`, `result-record.mjs`, `prepare.mjs`, `ythril-params.mjs`, `chunk.mjs`, `answer-rows.mjs`, `validity.mjs`, `typecap.mjs` | the pure parts, each with a test |
