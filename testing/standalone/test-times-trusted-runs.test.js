/**
 * `scripts/test-times.mjs` decides WHOSE data it records from the Actions API's run object, never from what a run
 * uploaded, and reads what a run uploaded as untrusted bytes.
 *
 * ## What this prevents
 *
 * `--record-ci`, the baselines the flags are judged against, `--trend` and any future shard balancing all start from
 * "the CI runs". Those runs live in a PUBLIC repository where anyone may open a pull request, push to a fork, or
 * run another workflow, and every one of them can upload an artifact called `test-results-…` full of timings. A
 * recorder that admits a run because its artifact says `branch: main`, or because its path ends in `ci.yml`, lets a
 * stranger write the numbers a maintainer then reads as "how long main takes" — and a flag that fires on those
 * numbers is a flag nobody believes afterwards. Two things stop it, each tested here as a TRUTH TABLE rather than
 * as the one case that was thought of:
 *
 * 1. **`trustedRuns(runs)`** is the one function that turns the API's list into the runs worth reading. It admits a
 *    run only if ALL of: `event` is `push`; `head_repository.full_name` AND `repository.full_name` are both
 *    `ythril-network/Ythril` (a fork's push has a different head repository); `path` is exactly
 *    `.github/workflows/ci.yml` (a pull request's run reports `…ci.yml@refs/pull/N/merge`; another workflow
 *    reports its own file); `head_branch` is exactly `main`. The table is built by taking one admitted run and
 *    breaking ONE field at a time, so a missing row cannot hide a field.
 * 2. **`parseArtifact(zip)`** reads an artifact as hostile input: an entry over 20 MB, a total over 200 MB, a
 *    header that lies about the size, a name with a `..` segment or an absolute path (POSIX, drive-letter or UNC) — each
 *    refuses the WHOLE archive, and nothing is written to disk by it (it returns buffers).
 *
 * And `recordKey` — `source:runId:attempt:job:suite` — is what makes a second recording of the same run find the
 * first instead of adding to it. It is tested for being the same string whether the run id arrives as the API's
 * number or as text, and for two different runs never sharing one.
 *
 * ## The interface this pins
 *
 * `trustedRuns(runs: object[]): object[]` (throws on a non-array — an absent list is an error, not "no runs");
 * `parseArtifact(zip: Buffer): Array<{name: string, data: Buffer}>` (throws on any refusal);
 * `recordKey({source, runId, attempt, job, suite}): string`. All exported from `scripts/test-times.mjs`.
 *
 * Run: node --test testing/standalone/test-times-trusted-runs.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { buildZip } from '../_shared/zip-builder.mjs';
import { REPO, githubRun } from '../_shared/test-times-harness.mjs';

const MODULE = pathToFileURL(resolve(import.meta.dirname, '..', '..', 'scripts', 'test-times.mjs')).href;
let loaded;
const load = () => (loaded ??= import(MODULE));

/** One admitted run: the shape the fake Actions API serves (`githubRun`), under a real run's id. */
const base = () => githubRun(36767121911);

/** One admitted run with ONE field broken, per row. The label says what was broken. */
const REFUSED = [
  ['a pull_request run', r => { r.event = 'pull_request'; }],
  ['a pull_request_target run', r => { r.event = 'pull_request_target'; }],
  ['a manual dispatch on main', r => { r.event = 'workflow_dispatch'; }],
  ['a scheduled run', r => { r.event = 'schedule'; }],
  ['a workflow_run-triggered run', r => { r.event = 'workflow_run'; }],
  ['no event', r => { delete r.event; }],
  ['a push to a fork (head repository differs)', r => { r.head_repository = { full_name: 'attacker/Ythril' }; }],
  ['a push whose head repository was deleted (null)', r => { r.head_repository = null; }],
  ['a push with no head repository field', r => { delete r.head_repository; }],
  ['a run of another repository (both fields)', r => { r.repository = { full_name: 'attacker/Ythril' }; r.head_repository = { full_name: 'attacker/Ythril' }; }],
  ['a run whose repository only starts like ours', r => { r.repository = { full_name: `${REPO}-fork` }; r.head_repository = { full_name: `${REPO}-fork` }; }],
  ['a run with a different base repository but our head repository', r => { r.repository = { full_name: 'attacker/Ythril' }; }],
  ['a run with no repository field', r => { delete r.repository; }],
  ['another workflow file', r => { r.path = '.github/workflows/release.yml'; }],
  ['the publish workflow', r => { r.path = '.github/workflows/publish.yml'; }],
  ['a pull-request ref of ci.yml', r => { r.path = '.github/workflows/ci.yml@refs/pull/9/merge'; }],
  ['a path that merely starts with ci.yml', r => { r.path = '.github/workflows/ci.yml.bak'; }],
  ['a path that merely ends with ci.yml', r => { r.path = 'fork/.github/workflows/ci.yml'; }],
  ['a different case of the path', r => { r.path = '.github/workflows/CI.yml'; }],
  ['no path', r => { delete r.path; }],
  ['a release branch', r => { r.head_branch = 'release/5.6.x'; }],
  ['a feature branch', r => { r.head_branch = 'feature/faster-ci'; }],
  ['a branch that merely starts with main', r => { r.head_branch = 'main-backdoor'; }],
  ['a ref spelling of main', r => { r.head_branch = 'refs/heads/main'; }],
  ['a different case of main', r => { r.head_branch = 'Main'; }],
  ['no branch (null)', r => { r.head_branch = null; }],
];

describe('trustedRuns — which Actions runs may be read at all', () => {
  it('admits the one run that is a push to main of this repository, from ci.yml', async () => {
    const { trustedRuns } = await load();
    const admitted = trustedRuns([base()]);
    assert.equal(admitted.length, 1);
    assert.equal(admitted[0].id, 36767121911);
  });

  it('admits a failed run too — identity is not outcome, and a failed main run still has timings to record', async () => {
    const { trustedRuns } = await load();
    const run = base();
    run.conclusion = 'failure';
    assert.equal(trustedRuns([run]).length, 1);
  });

  it('has a table worth its name', () => {
    // The floor on the derived set: a refactor that empties REFUSED would leave every `for` below vacuous.
    assert.ok(REFUSED.length >= 20, `the refusal table holds ${REFUSED.length} rows`);
    const fields = new Set();
    for (const [, mutate] of REFUSED) {
      const r = base();
      mutate(r);
      for (const k of ['event', 'head_repository', 'repository', 'path', 'head_branch']) if (JSON.stringify(r[k]) !== JSON.stringify(base()[k])) fields.add(k);
    }
    assert.deepEqual([...fields].sort(), ['event', 'head_branch', 'head_repository', 'path', 'repository'], 'every identity field has at least one row that breaks it');
  });

  for (const [what, mutate] of REFUSED) {
    it(`refuses ${what}`, async () => {
      const { trustedRuns } = await load();
      const run = base();
      mutate(run);
      assert.deepEqual(trustedRuns([run]), [], `${what} must not be admitted`);
    });
  }

  it('keeps the admitted runs of a mixed list, in order, and only those', async () => {
    const { trustedRuns } = await load();
    const list = [];
    list.push({ ...base(), id: 1 });
    for (const [, mutate] of REFUSED) { const r = base(); mutate(r); r.id = 100 + list.length; list.push(r); }
    list.push({ ...base(), id: 2 });
    assert.deepEqual(trustedRuns(list).map(r => r.id), [1, 2]);
  });

  it('judges the run object alone: a lookalike claim carried inside it does not change the verdict', async () => {
    const { trustedRuns } = await load();
    const run = base();
    run.event = 'pull_request';
    run.artifact = { branch: 'main', event: 'push', repository: REPO }; // what an uploaded file would say about itself
    run.display_title = 'push to main of ythril-network/Ythril';
    assert.deepEqual(trustedRuns([run]), []);
  });

  it('throws on a list that is not a list — an absent answer is not "no runs"', async () => {
    const { trustedRuns } = await load();
    for (const bad of [undefined, null, {}, 'runs', 7]) assert.throws(() => trustedRuns(bad), TypeError, `trustedRuns(${JSON.stringify(bad)})`);
  });
});

describe('parseArtifact — an artifact is hostile input', () => {
  const MB = 1_000_000;
  const GOOD = Buffer.from('{"type":"end","events":0}\n');

  it('returns the entries of a well-formed archive, stored and deflated alike', async () => {
    const { parseArtifact } = await load();
    const out = parseArtifact(buildZip([
      { name: 'standalone-pure.jsonl', data: GOOD },
      { name: 'nested/dir/redteam-all.jsonl', data: Buffer.from('x'.repeat(5000)), method: 'store' },
    ]));
    assert.deepEqual(out.map(e => e.name), ['standalone-pure.jsonl', 'nested/dir/redteam-all.jsonl']);
    assert.ok(Buffer.isBuffer(out[0].data));
    assert.equal(out[0].data.toString(), GOOD.toString());
    assert.equal(out[1].data.length, 5000);
  });

  it('accepts a name with dots INSIDE a segment — only a `..` segment is a traversal', async () => {
    const { parseArtifact } = await load();
    const out = parseArtifact(buildZip([{ name: 'timings..v2/file..name.jsonl', data: GOOD }]));
    assert.equal(out.length, 1);
  });

  const REFUSED_NAMES = [
    '../evil.jsonl',
    'a/../../evil.jsonl',
    'a/b/../../../evil.jsonl',
    '..\\evil.jsonl',
    'a\\..\\..\\evil.jsonl',
    '/etc/passwd',
    '\\windows\\system32\\x',
    'C:\\Windows\\x.jsonl',
    'C:/x.jsonl',
    '\\\\server\\share\\x.jsonl',
  ];
  it('has a table worth its name', () => { assert.ok(REFUSED_NAMES.length >= 8); });
  for (const name of REFUSED_NAMES) {
    it(`refuses the whole archive when one entry is named ${JSON.stringify(name)}`, async () => {
      const { parseArtifact } = await load();
      const zip = buildZip([{ name: 'fine.jsonl', data: GOOD }, { name, data: GOOD }]);
      assert.throws(() => parseArtifact(zip), Error, 'an archive with a traversing or absolute name is refused whole, not filtered');
    });
  }

  it('reads an entry under the 20 MB cap and refuses one over it', async () => {
    const { parseArtifact } = await load();
    const under = parseArtifact(buildZip([{ name: 'big.jsonl', data: Buffer.alloc(19 * MB) }]));
    assert.equal(under[0].data.length, 19 * MB);
    assert.throws(() => parseArtifact(buildZip([{ name: 'big.jsonl', data: Buffer.alloc(21_100_000) }])), Error);
  });

  it('refuses an entry whose header declares a small size over a stream that inflates past the cap', async () => {
    const { parseArtifact } = await load();
    const lying = buildZip([{ name: 'bomb.jsonl', data: Buffer.alloc(21_100_000), declaredSize: 10 }]);
    assert.throws(() => parseArtifact(lying), Error, 'the cap is on what is INFLATED, not on what the header says');
  });

  it('reads a total under the 200 MB cap and refuses one over it, though no entry reaches the entry cap', async () => {
    const { parseArtifact } = await load();
    const chunk = Buffer.alloc(19 * MB);
    const entries = (n) => Array.from({ length: n }, (_, i) => ({ name: `part-${i}.jsonl`, data: chunk }));
    assert.equal(parseArtifact(buildZip(entries(5))).length, 5);
    assert.throws(() => parseArtifact(buildZip(entries(12))), Error);
  });

  it('refuses bytes that are not an archive, and an empty buffer — never an empty list', async () => {
    const { parseArtifact } = await load();
    assert.throws(() => parseArtifact(Buffer.from('this is not a zip file at all')), Error);
    assert.throws(() => parseArtifact(Buffer.alloc(0)), Error);
    const zip = buildZip([{ name: 'a.jsonl', data: GOOD }]);
    assert.throws(() => parseArtifact(zip.subarray(0, zip.length - 30)), Error, 'a truncated archive is not a shorter one');
  });
});

describe('recordKey — the identity of one suite of one run', () => {
  const parts = { source: 'ci', runId: '36767121911', attempt: 1, job: 'standalone-pure', suite: 'standalone' };

  it('is source:runId:attempt:job:suite', async () => {
    const { recordKey } = await load();
    assert.equal(recordKey(parts), 'ci:36767121911:1:standalone-pure:standalone');
  });

  it('is one string whether the run id and attempt arrive as the API\'s numbers or as text', async () => {
    const { recordKey } = await load();
    assert.equal(recordKey({ ...parts, runId: 36767121911, attempt: 1 }), recordKey({ ...parts, runId: '36767121911', attempt: '1' }));
  });

  it('differs for every part that differs', async () => {
    const { recordKey } = await load();
    const seen = new Set([recordKey(parts)]);
    for (const change of [{ source: 'local' }, { runId: '36767121912' }, { attempt: 2 }, { job: 'standalone-db' }, { suite: 'redteam' }]) seen.add(recordKey({ ...parts, ...change }));
    assert.equal(seen.size, 6, 'a second attempt, another job or another suite is another record');
  });

  it('never gives two different runs one key, however the parts are cut', async () => {
    const { recordKey } = await load();
    const a = (() => { try { return recordKey({ ...parts, job: 'a:b', suite: 'c' }); } catch { return 'refused-a'; } })();
    const b = (() => { try { return recordKey({ ...parts, job: 'a', suite: 'b:c' }); } catch { return 'refused-b'; } })();
    assert.notEqual(a, b, 'a delimiter inside a part must be refused or escaped, not allowed to merge two keys');
  });

  it('throws on a missing part rather than minting a key with a hole in it', async () => {
    const { recordKey } = await load();
    for (const missing of Object.keys(parts)) {
      const p = { ...parts };
      delete p[missing];
      assert.throws(() => recordKey(p), Error, `recordKey without ${missing}`);
    }
    assert.throws(() => recordKey({ ...parts, source: 'somewhere-else' }), Error, 'source is ci or local');
  });
});
