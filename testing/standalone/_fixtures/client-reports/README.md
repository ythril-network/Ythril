# Real vitest JSON reports for the client-report tests

Every `*.json` here is the file vitest 3.2.7 wrote (`--reporter=json --outputFile.json=<path>`), unedited, from `npx vitest run <files> ...`
in `client/` with the project's own `vitest.config.ts`, over throwaway spec files that were deleted afterwards and never committed.
Nothing in a report was trimmed or rewritten by hand: a hand-written report only proves the reader against its author's reading of the
format, and these are what a run really produces (including that a failed hook leaves `message: ""`, and that a file which failed to
collect has no assertion results at all).

Two things are machine-specific and are rebased at USE, never in the file: the producing checkout's path (`C:/ythril-wt/b73-tA`, in
forward-slash and backslash spelling) and the clock (`startTime`, `endTime`). `testing/_shared/client-report-fixtures.mjs` does both;
its `PRODUCED_UNDER` is the one place the producing path is written.

| file | spec files run | what it shows |
|---|---|---|
| `passed.json` | two files, three passing tests (one in a nested describe) | a clean run |
| `failed.json` | one file: one passing, one failing assertion | a failure message is the first line of `failureMessages[0]`, the file is `failed` too |
| `skipped.json` | one file: `it.skip`, and a `describe.skip` | skipped tests carry status `skipped` and no `duration` |
| `todo.json` | one file: one passing test, one `it.todo` | status `todo` |
| `collection-failure.json` | one file importing a module that does not exist, one passing file | a file that never collected: no assertion results, file status `failed`, the reason in the file's `message`; the totals do not count it |
| `beforeall-failure.json` | one file whose `beforeAll` throws | its tests are `skipped`, the file is `failed`, `message` is `""`, `numFailedTests` is 0 and `success` is false |
| `all-collection-failure.json` | two files, both failing at collection | zero tests anywhere in the report, every file `failed` |
| `secret.json` | one file with a token-shaped test title and failure message | what must be masked before it is stored or published |

To make one again: write the spec files under `client/src/<throwaway folder>/`, run
`npx vitest run <those files> --reporter=json --outputFile.json=<path>` from `client/`, copy the output here, delete the specs,
and update `PRODUCED_UNDER` if the producing checkout is elsewhere.
