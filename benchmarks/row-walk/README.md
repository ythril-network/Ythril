# Row walk — a page's graph expansion, per seed against in step

Not a memory benchmark like the folders beside it: this measures one piece of the server, the graph walk
behind `recall(traverse: n)` and `similar(traverse: n)`. `Q-136` changed it from walking each result row on its
own to walking a window of rows together (`server/src/brain/walk-in-step.ts`), with every row still exactly the
walk it makes alone — the differential that proves that is
`testing/standalone/a-batched-row-walk-is-the-per-seed-walk-db.test.js`.

`bench-row-walk.mjs` walks one page of 20 rows both ways on the same deterministic corpus (3 000 entities,
4 500 edges, 2 000 facts naming two entities each) and reports the database's own count of the queries it
received and the fastest of 15 runs. It refuses to report if the two ways return different rows.

```text
npm run build -w server
node benchmarks/row-walk/bench-row-walk.mjs      # BENCH_MONGO_URI to point elsewhere
```

## Measured — 2026-09-29, MongoDB 8.2.1 on the development machine, 20 rows, all whole

| depth | per seed: finds | per seed: getMores | per seed: ms | in step: finds | in step: getMores | in step: ms |
|---|---|---|---|---|---|---|
| 1 | 73 | 0 | 34.17 | 8 | 0 | 5.64 |
| 2 | 152 | 0 | 80.85 | 16 | 2 | 18.98 |
| 5 | 392 | 34 | 310.43 | 40 | 18 | 136.34 |

A second run the same day gave 37.08 / 6.01, 78.15 / 16.18 and 290.87 / 135.21 ms, with identical query counts.

What the numbers are: one window of 16 rows and one of 4, so at each hop the in-step walk sends one edge
read, one link read, one fact read and one entity read per window — 4 finds per hop per window — where the
per-seed walk sends those four per ROW. The depth-5 time gains less than the query count because the reads are
larger and the in-memory walk is the same work either way; `getMore`s are the batches a large read comes back
in.
