# Results

Result records a person chose to keep land here, one JSON file per run, named
`<UTC stamp>-<engine>-<size>.json` (see [the record's fields](../README.md#the-result-record)). A record is never
overwritten, so a rerun adds a file.

`run.mjs` writes to `E:/TMP/Ythril/data/b271-bench/results/` by default, outside the repository; copy a record here
only to keep it with the repository, or pass `--results benchmarks/rdf/results` to write it here directly.
Datasets are never committed.
