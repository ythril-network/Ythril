# RDF and SPARQL: BSBM against Oxigraph

This measures Ythril's SPARQL endpoint (`POST /api/brain/spaces/:spaceId/sparql`) against
[Oxigraph](https://github.com/oxigraph/oxigraph) on the Berlin SPARQL Benchmark (BSBM), so a decision about
a triple cache rests on numbers. Q-759.

- **Data**: BSBM Tools v0.2, generated at 1 000, 5 000 and 20 000 products (about 0.37 M, 1.9 M and 7.5 M
  triples, with forward chaining on as BSBM's own runs for stores without inference use it).
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
| 1. Generate | `node benchmarks/rdf/generate.mjs --sizes 1000` | `<work>/data/1000/{dataset.nt,td_data/,manifest.json,params.json}` |
| 2a. Oxigraph | `node benchmarks/rdf/load.mjs oxigraph-up --size 1000` | a store loaded by `oxigraph load`, served on loopback; `<work>/state/oxigraph-1000.json` with the load time |
| 2b. Ythril | `node benchmarks/rdf/load.mjs ythril-up --ythril-image <image>` then `node benchmarks/rdf/load.mjs ythril --size 1000` | a scratch instance with its own database, a space with RDF on, the file sent through the RDF import door; `<work>/state/ythril-1000.json` with the load time, or the refusal and its code |
| 3. Run | `node benchmarks/rdf/run.mjs --engine oxigraph --size 1000` (and `--engine ythril`) | `<results>/<UTC stamp>-<engine>-<size>.json` and a markdown table on stdout |
| 4. Clean up | `node benchmarks/rdf/load.mjs oxigraph-down --size 1000` and `node benchmarks/rdf/load.mjs ythril-down` | no container, volume or network left |

`--results <dir>` on `run.mjs` names the results folder (default `<work>/results/`). The committed
[`results/`](results/) folder holds only what a person chose to keep.

### The Ythril image

The RDF import door and `meta.rdf` are newer than the published image, so the scratch instance runs an image
built from the checkout under test (`docker build -t b271-ythril:<sha> .` at the repository root, booked). A tag
that is a commit hash is recorded as the commit under test; `--ythril-commit <sha>` names it otherwise.
`ythril-up` never touches an instance it did not start.

### What a Ythril run needs from the server

`run.mjs --engine ythril` calls `POST /api/brain/spaces/:spaceId/sparql` with `Content-Type:
application/sparql-query`, `Accept: application/sparql-results+json` (`application/n-triples` for Q9, a DESCRIBE,
and Q12, a CONSTRUCT) and the scratch instance's Bearer token. Where the endpoint does not exist the answer is
`404` and the record holds that code per query; the run does not stop.

## The result record

One JSON file per run (design R10): `outcome` (`ok`, `partial`, `failed`), `engine`, `size`, `ythrilCommit`,
`oxigraphDigest`, `bsbmSeed` (generator and driver), `dataset` (triples, sha256), `loadMs` or `loadRefusal`,
`warmups`, `runs`, and per query `median`, `p95`, `min`, `max`, `n`, `rows` (rows or triples of the first measured
answer, to compare engines' answers), `errors` and the first `error` (`code`, `status`, `message`). The last key is
`end: "END-OF-RECORD"`. A file is never overwritten: a second write to the same name is an error.

## Reading a refused Ythril load

BSBM data is not Ythril-shaped. On 2026-11-25 the import of the 1 000-product file into a strict space with RDF
on is refused `409 rdf_import_refused` after about 11 s with nothing written: `no-kind` for 36 433 subjects (the
BSBM classes are not Ythril kinds) and `class-without-term` for 40 433 statements. With `schema=generate&from=data`
(`load.mjs ythril --import-query "schema=generate&from=data&inferMinSupport=1"`) the kinds resolve and the refusal
becomes `several-types-of-one-kind` for 4 000 products (forward chaining gives each product its type and every
supertype) and `language-tagged-literal` for 10 000 review texts. Which of these the benchmark accepts (data
generated without forward chaining, a non-strict space, a mapping of BSBM onto Ythril kinds) is a decision for the
people who read the numbers; the harness records the refusal it gets and does not change the server.

## Tests

`stats`, `params`, `queries` and `result-record` have `node:test` files next to them. Run them in a container, not
on the host, with a temp folder outside the repository:

```text
docker run --rm -v <checkout>:/w:ro -w /w node:22 node --test benchmarks/rdf/stats.test.mjs benchmarks/rdf/params.test.mjs benchmarks/rdf/queries.test.mjs benchmarks/rdf/result-record.test.mjs
```

## Files

| File | What it is |
|---|---|
| `pin.json` | URLs, hashes, image digests, seeds, sizes |
| `generate.mjs` | download and verify BSBM Tools, generate datasets, capture the driver's parameters |
| `load.mjs` | `oxigraph-up/down`, `ythril-up/down`, `ythril` |
| `run.mjs` | runs the queries, writes the record and the table |
| `env.mjs`, `oxigraph.mjs`, `ythril.mjs`, `unzip.mjs` | plumbing: booked docker, the two engines, a zip reader |
| `stats.mjs`, `params.mjs`, `queries.mjs`, `result-record.mjs` | the pure parts, each with a test |
