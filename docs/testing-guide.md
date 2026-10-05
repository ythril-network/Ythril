# Testing guide

How to run Ythril's tests, how to write one that CI will actually run, and how CI is put together. The
[contribution guide](contribution-guide.md) says what to run before you push; this page is the reference behind it.

Two rules run through everything below, because both were learned the expensive way:

- **A number written here is a number that will be wrong.** Where a figure matters, this page gives the command that prints it.
- **A test that does not run, or runs and proves nothing, looks exactly like a test that passes.** Most of what follows
  is the machinery that makes those two cases loud: skips that CI refuses, files CI must reach, waits that name what never held.

## Running the suites

Run `npm run preflight` first, always. It runs every structural check that needs no Docker, in one command, and
`scripts/preflight.mjs` is the list. Then run the suites your change reaches.

| Suite | Needs | Run |
|---|---|---|
| Client unit tests (Vitest + jsdom) | nothing | `npm run test:client`, and `npm run build:client` (it catches template errors in components that have no spec) |
| Standalone, all of it | `server/dist`, a test MongoDB, the test stack | `npm run build:server`, `npm run test:up`, `npm run test:standalone` |
| Standalone, the pure third | `server/dist` | `npm run test:standalone:pure` |
| Standalone, the database third | `server/dist`, the test MongoDB | `npm run test:standalone:db` |
| Standalone, the instance third | `server/dist`, the instances it drives | `npm run test:standalone:instance` |
| Integration | the test stack | `npm run test:up`, `npm run test:integration` |
| Sync | the test stack | `npm run test:up`, `npm run test:sync` |
| Red team | the test stack | `npm run test:up`, `npm run test:redteam` |

`npm run test:down` takes the stack down and wipes its volumes. `npm run test:all:core` runs the stack suites and then
standalone, never stops at the first failure, and prints one status line per suite; it does not run the client suite, so
run that beside it. `npm run test:all` is `test:all:core` plus the cleanup, and does **not** start the stack. CI runs
the same npm scripts, split across jobs.

To run one file: `node --test testing/<suite>/<file>.test.js`. To run part of a stack suite through its runner, pass
node's own flags after `--`, for example `npm run test:integration -- --test-name-pattern=<pattern>`. A run that is
narrowed like that is recorded as a subset, never as the whole suite.

### The thirds of standalone

`testing/standalone` is one folder and three kinds of file, and the kind decides what it needs and how it runs:

- **pure**: needs nothing but `server/dist`. Runs at node's default width.
- **database**: opens the test MongoDB through `testing/standalone/_mongo-harness.mjs`, directly or through a helper that
  does. Runs a few files at a time, because every one of them shares one database and the full width ran it out of memory.
  The kind is derived from the imports, never from the file's name.
- **instance**: declares `@needs-instance` in its header comment and drives a running Ythril. Runs one file at a time.

You do not choose the kind: write the file and the split reads it. `npm run test:standalone` refuses to start when
`server/dist` is older than the server source (`--allow-stale` overrides it when you know the build is what you meant),
because a test run against the build from two branches ago has cost real debugging time.

The database third finds its MongoDB through `YTHRIL_TEST_MONGO_HOST` and `YTHRIL_TEST_MONGO_PORT`; the defaults are the
loopback port the test stack publishes (see `testing/docker-compose.test.yml`).

To print how many files each kind holds, and how many files a stack suite selects:

```bash
node -e "import('./testing/_shared/standalone-split.mjs').then(m => { const s = m.splitStandalone(); for (const k of Object.keys(s)) console.log(k, s[k].length); })"
git ls-files 'testing/integration/*.test.js' | wc -l
```

### Document sidecars

The integration suite includes tests of the document sidecars. `doc-render` is in the default test stack. `doc-office`
(LibreOffice) is opt-in, behind the compose profile `office`:

```bash
docker compose -p ythril-test -f testing/docker-compose.test.yml --profile office up -d doc-office
```

Without it those tests skip on your machine. In CI the integration job starts it, so a skip there is an unexpected one
and fails the run (see [Skips](#skips)).

## Reading durations

A suite that got slower is a defect nobody reports, so every run leaves a record of how long each test took.

**On a pull request or a main run**, a contributor has three places, none of which needs any access beyond the repository:

1. **The job's own log.** Each job ends with node's usual summary (`# pass`, `# fail`, `# skipped`) because the console
   reporter stays on beside the recording one.
2. **The `test-results-<job>-<attempt>` artifacts** of the run, kept for 30 days. Each holds the JSONL files below.
3. **The step summary of the `CI advisory` job**, which downloads those artifacts and writes the run's timings. That job
   is not a required check and may fail without failing the run.

**On your machine**, the same JSONL lands in `test-results/` (gitignored). Every runner (`run-suite`, `run-standalone`,
preflight) clears its own suite's earlier files first, so what is there is only the last run's, one file per `node --test`
invocation: `test-results/<suite>-<batch>.jsonl`.

### The line shape

One JSON object per test, per `describe` block and per file, then one closing line that says the file is whole. The
fields and their meanings are one exported description, `TIMING_SCHEMA`, and the closing line's is `TIMING_END_SCHEMA`,
both in [`testing/_shared/timing-reporter.mjs`](../testing/_shared/timing-reporter.mjs). This page does not repeat them:
a second list is a list that drifts. A test builds a real line and diffs its keys against the schema.

Four things to know when you read a file:

- **A file without its closing line is incomplete**, and every reader treats it as a failed run, never as a short one.
  `readTimingLog` in the same module is the reader to use.
- **A skipped suite counts as a skip**, which node's own `skipped` total does not. Skips are counted from the events.
- **A failure is read from the failure events**, never from a count: a file whose `before` hook throws shows `fail 0` in
  node's tail and exit status 1.
- **A failure message is stored as its first line, capped, with token-shaped strings masked.** No stack, no diff.

The recording is attached to a `node --test` run only by `testing/_shared/timing-reporter-flags.mjs`. It makes the
destination directory first (node exits 7 when it is missing), names the default reporter beside ours so the console
output is unchanged, and never throws into the run. A reporter fault costs one warning on stderr; the exit status stays
the tests'. If you write a new runner, call that helper; a source gate finds runners by what they call.

### Where the time goes inside a file

A file's duration includes loading its module. When a file is slow, ask three questions: how long its hooks took, how
long it spent waiting, and how long it spent working. The hooks are in the suite records. The waits are recorded by the
shared wait helper when `YTHRIL_TEST_WAIT_TIMING_FILE` names a file to append them to (one `{"type":"wait",…}` line per
wait, held or timed out); nothing sets it for you, so set it for a run you want to break down. Work is what is left.

### Trends

```bash
node scripts/test-times.mjs --trend [--last N] [--flags]
```

`--trend` reads the recorded runs (branch `main`, whole-suite runs, passed) from the Ythril instance you point it at, not
from GitHub, so it needs the recording setup below. It prints the newest runs per suite, and states the day of the first
recorded run so a short history is not read as a long one. `--flags` also judges the newest run of each suite against the
ones before it and names a file or a suite that is slower than it has been. The thresholds are constants beside the
function that applies them in `scripts/test-times.mjs`; read them there.

### The summary of one run

```bash
node scripts/test-times.mjs --summary --results <folder of downloaded results>
```

This is what the `CI advisory` job runs over the artifacts it downloads (`test-results-*` of this attempt, merged into one
folder: every job's `*.jsonl` and the client's `client.json`). It prints, and writes to the run's step summary: a row per
suite (tests, passed, failed, skipped, files, test time, wall time, outcome, where `incomplete` means the results were cut
off and are not read as passed), the slowest files and tests, every skip with its reason (the ones CI does not expect are
marked), and the failures. With `GH_TOKEN` it also names the files and suites slower than the last ten runs of `main`, read
from their artifacts, so it needs no Ythril instance; a baseline GitHub will not give is a warning and the summary still
prints. It records nothing.

## Recording runs to a Ythril instance (optional)

This is for maintainers who want a long history of how long main takes. A contributor needs none of it, and the line
`test-times: not recorded: …` that a run may print is normal when it is not set up.

`scripts/test-times.mjs` turns the JSONL into one `Test-Run` chrono entry per suite and writes it to a Ythril instance you
point it at. The fields of an entry are one exported description, `TEST_RUN_SCHEMA` in the same script, and the recorder
builds its object from that list, so a field outside it is a bug. Its commands:

```bash
node scripts/test-times.mjs --record              # record the local run in test-results/
node scripts/test-times.mjs --record-ci           # record the completed CI runs not yet recorded
node scripts/test-times.mjs --rewrite <recordKey> # record one run again from its own results
node scripts/test-times.mjs --help                # every flag and variable, printed
```

| Variable | Meaning |
|---|---|
| `YTHRIL_TEST_RUNS_URL` | The Ythril instance to record to. `https`, or `http` to `127.0.0.1`, `localhost` or `[::1]`. |
| `YTHRIL_TEST_RUNS_TOKEN` | A token that may write chrono entries in the space the script records to. Never printed, never stored, never in a payload. |
| `GH_TOKEN` | A token that may read this repository's Actions runs and artifacts, for `--record-ci` and `--rewrite`. |
| `GITHUB_API_URL` | The Actions API base. Defaults to the public GitHub API. |

What the recorder guarantees, and why each is there:

- **A recording problem is never a test failure.** Unconfigured, unreachable or refused, it keeps the payload in
  `test-results/unrecorded/`, prints one line saying why, and exits 0. The next `--record` that can reach the instance
  sends what was kept.
- **One record per run.** The identity is `recordKey` (`source:runId:attempt:job:suite`). The recorder finds by it, then
  updates or inserts, under a lock so one machine has one writer, and collapses duplicates of a key to the newest.
- **Only trusted CI runs are read.** `--record-ci`, the baselines and `--trend` start from one function that admits a
  push to `main` of this repository through `ci.yml`, decided from the run object the Actions API returns and from nothing
  an artifact says about itself. A pull request, a fork or another workflow is never recorded. Artifact bytes are read as
  hostile input: size caps, no `..` or absolute names, nothing written to disk.
- **Incomplete is not passed.** A results set without its closing line, with a wrong count or a torn last line is recorded
  as `incomplete`. A baseline is drawn only from whole-suite, passed, `main` runs, and the run being judged is left out of
  its own baseline.
- **CI never holds the token.** Recording is refused when `GITHUB_ACTIONS` or `CI` is set, and `run-suite`,
  `run-standalone` and preflight strip the `YTHRIL_TEST_RUNS_` variables (and the marker variable `node --test` sets
  in its own children) from the environment of every test they start, so a test cannot read the recorder's
  credentials. Both are dropped in `testing/_shared/test-child-env.mjs`, which every test child's environment is built
  by.
- **The connection is guarded in one place**, `scripts/_shared/ythril-api.mjs`: a URL that is not `https` or loopback is
  refused at construction, redirects are errors, a request times out, and an error never contains the token or the URL's
  credentials. `benchmarks/` uses the same module.
- **Entries expire** under the retention the chrono type declares on the instance, so the history is bounded.

## Skips

A skipped test proved nothing, and a green run with skips in it is how an unbuilt client, a sidecar that never started and
an embedder that never loaded each read as "passing". So the rule is: **a skip is allowed on your machine for something you
can fix there, and refused in CI unless it is expected.**

- **Skip with `t.skip(reason)`** (or the `skip` option), always with a reason that tells the reader what to do. Never print
  a line and `return`: no reporter can tell that from a pass. A source gate refuses a test body that returns on an absent
  input without asserting anything (`a-test-that-finds-its-input-absent-says-so`).
- **An input that is absent locally and must be present in CI** goes through `testing/_shared/absent-input.mjs`.
  `requireInput(t, present, why)` skips off CI and **throws on CI**; `absentInputReason(why)` is the same for a `skip`
  option evaluated up front. The CI half lives inside them so a caller cannot forget it. CI means `CI` or
  `GITHUB_ACTIONS` is set to something other than `''`, `false` or `0`, which GitHub Actions always does; that one
  reading is `testing/_shared/running-under-ci.mjs`, and the recorder, the suite runner and the changelog check use it
  too.
- **`requireEmbedding(t, available)`** is that rule for the embedder, and is how every test that needs a model asks for it.
- **A skip that is expected in CI** carries the reason prefix `expected-in-ci:` followed by exactly one cause, for example
  `expected-in-ci: corpus not fetched`. Only the files on the list in `testing/_shared/expected-in-ci.mjs` may use it,
  each with the reason it is allowed and the causes it may name; the source gate
  (`a-skip-that-expects-ci-lives-in-a-listed-file`) checks the list both ways, and the CI gate reads the same list. Adding a row is a decision about what CI is
  allowed not to run, made in review, and it must be the absence of something CI never has, not of something it is
  supposed to bring up. One cause per skip: a message that joins two causes with `||` excuses the one that should fail.
- **CI fails on any other skip**, in the gate job, from the JSONL: `scripts/unexpected-skips.mjs`, which also reads the
  client's Vitest report (`client.json`, written by the client job). A skipped test fails the run unless its reason starts
  `expected-in-ci:` AND its file is on the list; the client suite has no expected skips at all, so anything it does not
  pass or fail is named. It exits 2, not 0, when the results cannot answer (a missing or cut-off file).
- **Locally**, Windows-only skips and the like stay skips; the refusal is CI's.

A test that needs a precondition (a session, a prior test's output) throws once in its `before` hook or in one assert
naming the cause, so one root cause is one red and not a cascade of "prior test failed".

## Waiting

A wait has four decisions in it that hand-written copies each got differently, and each has cost a red CI run: what is
said at the deadline, whether a thrown probe ends the wait, whether a probe that never answers can outlast the deadline,
and whether a timer is left armed. They are made once, in
[`testing/_shared/wait-for.mjs`](../testing/_shared/wait-for.mjs); read its header for the full contract.

| Need | Use |
|---|---|
| Wait until a condition holds; throw, naming what never held and the last value, if it does not | `waitFor(condition, timeout, interval, diagnose, { what, thinMargin, tolerate })` |
| The same wait, answering `true` or `false` at the deadline | `holdsWithin(…)` |
| The same wait, answering the value the condition held with | `waitForValue(…)` |
| Wait for one operation for at most a time, without abandoning it, and learn whether it finished | `settleWithin(promise, ms)` in `testing/standalone/_write-faults.mjs` |

Use `holdsWithin` in a `before` hook that lets the tests decide: a throw there cancels the whole file, where a verdict
reaches `requireEmbedding` and a skip. Use `tolerate` for a server that is restarting and refuses connections; a probe
that throws anything else propagates at once. `diagnose` may be a function that goes and looks at something, and it is
awaited. `waitFor` from `testing/sync/helpers.js` is this module with the thin-margin warning on, because a stack wait that
passes with little budget left is one slow runner from a timeout; a poll of something in-process leaves it off.

**A loop that asks a different question stays, with a marker** in the comment block directly above it:
`// waits-differently: <reason>`. The reason must say something (two words at least); a bare marker is the loop without
one. The client cannot import the `.mjs`, so a client spec is the usual case. The gate, `a-poll-is-written-once`, reads
the syntax tree for a loop that has a deadline read from the clock, an awaited sleep and a condition, outside the module
and without the marker, and refuses it.

## How a new test file reaches CI

A test file that no job runs is not a test. Two derived checks hold that, one on what CI selects and one on what actually
ran:

- **Selected.** `node scripts/unrun-tests.mjs` reads the commands of `.github/workflows/ci.yml`, follows the `npm run`
  chains, and subtracts what they select (the globs, the standalone split, the suite table in `testing/_init/run-suite.mjs`,
  the Vitest `include`) from the tracked test files. It exits 1 naming the files no selection reaches, and 2 when its own
  derivation is broken (no workflow, no selection, too few files), never 0. Preflight runs it.
- **Executed.** `node scripts/executed-tests.mjs --results test-results` subtracts the files with at least one test event in
  the JSONL from the tracked ones, which catches a file a glob matches that loads and registers nothing. It refuses an
  incomplete or empty results folder rather than reading it. The gate job runs it.

What that means when you add a file:

- Put it directly in `testing/standalone`, `testing/integration`, `testing/sync` or `testing/red-team-tests`. Those folders
  select `*.test.js` directly inside them; a nested test file is refused by name (helpers and fixtures may live in
  subfolders as `.mjs`).
- **`git add` it.** The runners take their files from `git ls-files`, because an untracked file would run on your machine
  and never in CI. A stack suite warns about an untracked test file locally and does not run it.
- A new test **folder**, or a new kind of runner, needs a job that runs it and a row in the suite table, or `unrun-tests`
  names every file in it.
- A new CI **job** that runs tests uploads `test-results-<job>-<attempt>` with `if: always()` and `if-no-files-found: error`,
  and is added to the gate job's `needs`; the workflow gate derives the jobs from the YAML and fails when one is missing.

## The CI job graph

The authoritative description is the comment at the top of `.github/workflows/ci.yml`; the workflow gates
(`ci-workflow-is-sound` and its siblings) read the parsed YAML. The shape:

- **Jobs that start at once** because they need nothing from the image: the client tests and build, the standalone files
  that need only `server/dist`, the standalone files that need only the test MongoDB, and `prepare`.
- **`prepare`** runs the changelog check (pull requests), the docs lint and the one build of the test image, written as an
  archive other jobs load. It is the only job that writes a cache.
- **Stack jobs** wait for `prepare`, load the image and start only the services their suite drives, with
  `--no-build --pull never` so compose can neither rebuild nor pull a different image: the standalone instance third,
  integration, sync and red team. Each ends by uploading its results and, on failure, dumping the containers' logs.
- **`Build & Test`** is the only required check and does no work. It waits for every other job and fails unless each
  succeeded. Its name is exact: the repository ruleset requires the context by that name and the merge monitor waits for
  it, so renaming it, or putting a matrix on it, silently removes the gate. GitHub creates the check only when the jobs it
  needs have finished, so while others still run there is no `Build & Test` yet, which means in progress and never passing.
- **`CI advisory`** is not required and may fail: timings and trends.

Every job has a `timeout-minutes` with its reason beside it. A concurrency group keeps one run per ref; a newer push to a
pull request supersedes the older run, and a push to `main` is never cancelled, because it is the run that fills the
caches. The workflow's token is `contents: read` and nothing wider; `CI advisory` alone adds `actions: read`.

**Release lines keep their single-job workflow.** A patch is cut from a `release/X.Y.x` branch whose `ci.yml` is one job
named `Build & Test` running everything in order. Ports of tests to a release line are adapted to that shape, and a patch
keeps the full local run.

## What is cached, and what is not

Caches are writes to a shared store with a size limit, so the rule is about who may write:

- **Only a push to `main` writes a cache, and only `prepare` does it.** Every run reads. A pull request that wrote would
  evict the layers every other run needs, and could poison what `main` reads. The cost is stated: a pull request that
  pushes again rebuilds layers its previous run built. A gate derives this from the workflow: cache writes carry the
  main-only condition.
- **What is cached:** the layers of the test image, and the layers of each document sidecar in a scope of its own, in the
  GitHub Actions layer cache; and npm's download cache, keyed on the lockfile, through `setup-node`. Keys are exact, with no
  fallback key.
- **What is not, and why, each by measurement:** the database image (pulling it takes as long as restoring and loading a
  cache of it), `node_modules` (`npm ci` takes as long as unpacking the tree), and Dockerfile cache mounts (a runner is
  fresh, so a mount cache is always empty).
- **The cache credential is exposed to one step**, pinned by commit, immediately before the image build and after the only
  install, so no install script runs while it is exposed.
- **What may be uploaded as an artifact is a short allowlist:** the results folders and the test image archive (which
  carries the same notices as the published image), kept one day. No database image and no sidecar image is ever an
  artifact; a gate refuses it.
- `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` is set for every `npm ci`, because that package's install script otherwise
  downloads GPU binaries from a GitHub release no runner here can use, and the build then depends on that download. A gate
  holds it for every install in every workflow.

To see what a run's cache did, read the build step's log in `prepare`: the layers it restored are marked cached.

## The stack's budget

The local stack is every service in `testing/docker-compose.test.yml`'s default set; a CI job starts a smaller one. Each
service has a CPU and memory ceiling, and the rule is that **the ceilings of every set one `compose up` starts must fit in
the machine**: the default set for a developer's machine, and each job's set for a runner.
`the-test-stack-leaves-the-machine-room` derives those sets, from the `up` lines of `ci.yml`, the services they name, their
`--profile` flags and the `depends_on` closure, so a job that starts more is caught without anyone editing the gate. When
it fails it prints the sum that did not fit. The same file holds the counterweight: a sidecar's test default is at least
half of production's, so a budget cut cannot leave a sidecar too small to work.

To list what a set holds: `docker compose -p ythril-test -f testing/docker-compose.test.yml config --services` (add
`--profile office` for the opt-in sidecar).

**The ceilings are for tests, not a sizing guide.** Raise one with its variable on a bigger machine, for a test that seeds
tens of thousands of records. The search process (mongot) is a JVM inside the database container; its heap is set
explicitly with `YTHRIL_TEST_MONGOT_A_HEAP` and must be raised together with the container's memory limit, because a heap
the container cannot hold stops the database cleanly mid-run and every later test is refused.

The test database frees a dropped collection within seconds only because the harness shortens MongoDB's snapshot window at
runtime (`tuneTestMongo`, called by `testing/sync/setup.js` and by every database-backed test file); a stack brought up
some other way gets it the first time a database-backed file opens the harness.

## Environment variables

Every variable the scripts and runners in `scripts/` and `testing/_init/` read is named here, and a derived gate
(`scripts-and-test-runners-document-their-env-vars`) fails when one is not. The product's own settings are in the
[integration guide](integration-guide.md); none of these is read by the server.

| Variable | Read by | Meaning |
|---|---|---|
| `YTHRIL_TEST_MONGO_HOST`, `YTHRIL_TEST_MONGO_PORT` | `scripts/preflight.mjs` | Where preflight finds the test MongoDB. Defaults are the test stack's loopback address and published port. |
| `YTHRIL_TEST_RUNS_URL`, `YTHRIL_TEST_RUNS_TOKEN` | `scripts/test-times.mjs` | The recorder's instance and token. See [recording](#recording-runs-to-a-ythril-instance-optional). Stripped from every test's environment. |
| `GH_TOKEN`, `GITHUB_API_URL` | `scripts/test-times.mjs` | Read access to this repository's Actions runs, and the API base. |
| `YTHRIL_TEST_WAIT_TIMING_FILE` | `testing/_shared/wait-for.mjs` | A file every wait appends one timing line to. Unset: nothing is recorded. |
| `YTHRIL_TEST_APP_CPUS`, `YTHRIL_TEST_APP_MEM`, `YTHRIL_TEST_APP_A_MEM` | `testing/docker-compose.test.yml` | CPU and memory ceilings of the Ythril instances; instance A has its own memory variable because it carries the heaviest suites. |
| `YTHRIL_TEST_MONGO_CPUS`, `YTHRIL_TEST_MONGO_MEM`, `YTHRIL_TEST_MONGO_A_MEM` | `testing/docker-compose.test.yml` | The same for the databases. |
| `YTHRIL_TEST_MONGOT_A_HEAP` | `testing/docker-compose.test.yml` | The search process's JVM heap in the first database. Raise it with `YTHRIL_TEST_MONGO_A_MEM`. |
| `YTHRIL_TEST_DOCRENDER_CPUS`, `YTHRIL_TEST_DOCRENDER_MEM`, `YTHRIL_TEST_DOCRENDER_PIDS` | `testing/docker-compose.test.yml` | The PDF renderer sidecar's ceilings. |
| `YTHRIL_TEST_DOCOFFICE_CPUS`, `YTHRIL_TEST_DOCOFFICE_MEM`, `YTHRIL_TEST_DOCOFFICE_PIDS` | `testing/docker-compose.test.yml` | The LibreOffice sidecar's ceilings. |
| `BENCH_REPEATS` | `scripts/bench-link-readers.mjs` | How many times the link-reader benchmark repeats. |
| `TODO_CHECK_DIR` | `scripts/todo-consistency.mjs` | Points the tracker consistency check at another folder. Its own tests use it. |

`CI`, `GITHUB_ACTIONS` and `GITHUB_STEP_SUMMARY` are the runner's, not settings: either of the first two (unless set to
`''`, `false` or `0`) makes absent inputs failures and stops the recorder, and the step summary is where the advisory job writes. The
`YTHRIL_TIMING_` variables are set by the flag helper for the reporter it attaches and are not for you to set.
