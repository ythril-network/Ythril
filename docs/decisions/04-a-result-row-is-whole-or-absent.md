# 04 — A search result row is whole or absent, and nothing is spilled unasked

**Status:** accepted, 2026-09-28 · **Supersedes:** the automatic graph spill of 2026-08-13 · **Scope:** `recall` and
`similar` with `traverse > 0`, on both doors, and every budget or ceiling on a read path

## Context

A traversing `recall` returns each match with the graph around it, nested under `_graph`. Until 5.6.0 the matches
were walked together and the merged neighbourhood was cut to an inline node cap. A match whose neighbourhood was
larger came back with **part** of its graph — whichever nodes the cut happened to keep — and the complete graph was
written to a spill behind `graphComplete`, on every such call, whether or not the caller had asked for it.

That was a ruling of 2026-08-13 (*"write the whole thing to the space's tmp files as JSON and hand back a download
link"*), and it was made to stop a short graph being silent. It stopped the silence and kept the short row. A
caller holding a match with a shortened `_graph` holds something it did not ask for: it has to notice the flag,
fetch a second document, and merge it. A short graph also reads as *"this record has few relationships"*, which is a
wrong conclusion about the data, and there is no `total` for a neighbourhood a caller could compare against.

The owner's ruling of 2026-09-28: *"i only want whole results and the rest gets truncated except if a flag is set
that says rest goes to a file"*; *"if the requested graph doesnt fit the whole resultrow including the root should
be not returned"*; *"if i get a result i want to be sure i get what i asked for"*; and, widening it, *"all budgets
and ceilings should work that way on all doors"*.

## Decision

- **A returned row is complete as requested** — the record and its whole `_graph` to the depth asked for — **or it
  is absent and named.** Each match is walked on its own. A match whose neighbourhood cannot be read whole (past the
  per-row node ceiling, a link scan past its bound, too many routes to one node, or out of time) is left out and
  named in `incompleteRows` with its reason.
- **Every bound ends an answer the way the byte budget does**: at the last whole row, with `truncated`, `nextSkip`
  and `truncatedBy`. The call has one walk budget and one deadline, and the first row of a page is always walked so
  every page makes progress.
- **Nothing is written unless `remainderDump: true` is sent**, and then only the rows the budget cut — whole, with
  the left-out ones named beside them. `graphComplete` is removed. The legacy `graph` spill kind stays readable until
  the spills already issued expire.

## Consequences

- An answer can hold fewer matches than before, because a match that used to arrive shortened is now absent. It is
  named, so it is not silent; narrowing `edgeLabels` or lowering `traverse` brings it back whole.
- `graphTruncated` changes meaning: it is `true` exactly when rows were left out, and never means a returned graph
  is short.
- Walking each match on its own costs more queries than one shared walk. It is the price of a row's completeness not
  depending on which other rows share its page; batching the walks with a seed-tagged frontier is a performance
  follow-up, not a change of rule.
- **This is the reversal to prevent:** re-introducing a node cap, a spill threshold or any other size rule below the
  byte budget that shortens a row "to keep more matches". That is the defect this record exists for, and it arrives
  looking like an optimisation. A bound belongs in `server/src/brain/search-bounds.ts` and must end the answer or
  leave a row out — never cut one.

## Where the detail lives

- `server/src/brain/row-graphs.ts` — one row's whole graph, or why it cannot have one (`whyRowIsShort`).
- `server/src/brain/traversed-answer.ts` — the one builder every traversing door answers through.
- `server/src/brain/result-budget.ts` — `budgetedRowsEnvelope`, the admission rule for rows built one at a time.
- `server/src/brain/search-bounds.ts` — the per-row and per-call walk bounds.
- `docs/integration-guide/04h-graph-augmented-recall.md` — the contract for integrators.
- `testing/integration/a-traversed-row-is-whole-or-absent.test.js` — the rule on all four doors against an oracle.
- `testing/standalone/a-row-is-whole-or-named.test.js` and `testing/standalone/graph-spill-is-not-content.test.js` —
  the bounds seen to bite, and the gate that no door writes a graph spill.
