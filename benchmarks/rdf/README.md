# RDF and SPARQL: BSBM against Oxigraph

This measures Ythril's SPARQL endpoint (`POST /api/brain/spaces/:spaceId/sparql`) against
[Oxigraph](https://github.com/oxigraph/oxigraph) on the Berlin SPARQL Benchmark (BSBM), so a decision about
a triple cache rests on numbers. Q-759.

- **Data**: BSBM Tools v0.2, generated at 1 000, 5 000 and 20 000 products **without forward chaining**, then
  turned into one Ythril-loadable variant that both engines load (see [The dataset variant](#the-dataset-variant)).
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
| 3. Run | `node benchmarks/rdf/run.mjs --engine oxigraph --size 1000` (and `--engine ythril`) | `<results>/<UTC stamp>-<engine>-<size>.json` and a markdown table on stdout; refused unless the store was loaded from the variant in the manifest |
| 4. Compare | `node benchmarks/rdf/compare.mjs <oxigraph record> <ythril record>` | a side-by-side markdown table (median and p95 per query, Ythril over Oxigraph) marking every query more than 10x slower on the median; refused unless both records name one size, one variant and one variant sha256 |
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
`application/n-triples`) and the scratch instance's Bearer token. A Turtle answer has no cheap triple count, so
its `rows` is `null` and `bytes` is the size of the first measured answer. Where the endpoint does not exist the answer is
`404` and the record holds that code per query; the run does not stop.

## The result record

One JSON file per run (design R10): `outcome` (`ok`, `partial`, `failed`), `engine`, `size`, `ythrilCommit`,
`oxigraphDigest`, `bsbmSeed` (generator and driver), `dataset` (`variant`, triples and sha256 of the variant both
engines load), `loadMs` or `loadRefusal`,
`warmups`, `runs`, and per query `median`, `p95`, `min`, `max`, `n`, `rows` (rows or triples of the first measured
answer, to compare engines' answers), `errors` and the first `error` (`code`, `status`, `message`). The last key is
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
- Nothing else changes: every other line leaves byte for byte, and the output has no stamp, so its sha256 is the
  same on every run. The result record names the variant (`ythril-loadable-1`) and that sha256.

Consequences for the queries, the same for both engines: Q8 filters `langMatches(lang(?text), "EN")`, so on the
variant it answers no rows; and Q1 and Q4, which match `rdf:type` against a product type, find only the products
of exactly that type, since nothing is forward-chained.

## Tests

`stats`, `params`, `queries`, `result-record`, `prepare`, `compare` and `ythril` (the refusal wording) have
`node:test` files next to them. Run them in a container, not on the host:

```text
docker run --rm -v <checkout>:/w:ro -w /w node:24 sh -c 'node --test benchmarks/rdf/*.test.mjs'
```

## Files

| File | What it is |
|---|---|
| `pin.json` | URLs, hashes, image digests, seeds, sizes |
| `generate.mjs` | download and verify BSBM Tools, generate datasets (no forward chaining), make the variant, capture the driver's parameters |
| `load.mjs` | `oxigraph-up/down`, `ythril-up/down`, `ythril` |
| `run.mjs` | runs the queries, writes the record and the table |
| `compare.mjs` | two records side by side, the queries more than 10x slower marked |
| `env.mjs`, `oxigraph.mjs`, `ythril.mjs`, `unzip.mjs` | plumbing: booked docker, the two engines, a zip reader |
| `stats.mjs`, `params.mjs`, `queries.mjs`, `result-record.mjs`, `prepare.mjs` | the pure parts, each with a test |
