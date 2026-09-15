/**
 * Every operation the audit middleware defines is classified on purpose, or excluded on purpose.
 *
 * ## Why this is enumerated from the source
 *
 * The per-space usefulness counters key off the operation name the audit middleware ALREADY computes for every
 * request. That reuse is the whole reason the feature is cheap — no second path-matcher, and the counts cannot
 * disagree with the audit log about which space a call touched.
 *
 * It also means a new route added to the audit table becomes **invisible** to the counters unless someone
 * thinks about it: `classifyOperation` returns `null` for anything it does not recognise, and `null` is
 * silent. This test reads the middleware's own table and fails on any operation that lands in `null` without
 * being one of the deliberately excluded admin domains — so "invisible" has to be a decision, not an
 * oversight.
 *
 * The same rule that made the media metrics undiscoverable for two releases: absence of evidence is not
 * evidence of absence, and a hand-written list is how the enumeration falls behind.
 *
 * Run: node --test testing/standalone/space-activity-classes.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let classifyOperation, recordSpaceCall, drainSpaceActivity, peekSpaceActivity, hourBucket, activityDocId,
  CALL_CLASSES;

/** Every `operation: '...'` the audit middleware declares — its table, not a copy of it. */
function auditOperations() {
  const src = readFileSync('server/src/audit/middleware.ts', 'utf8');
  const found = [...src.matchAll(/operation:\s*'([a-z0-9_.]+)'/g)].map(m => m[1]);
  return [...new Set(found)].sort();
}

/**
 * The two documented exclusion lists, read from the source so they cannot drift from this test.
 *
 * Both exist because "counts as nothing" has two legitimate reasons — operator work on the instance, and
 * transport plumbing — and neither is the same as "nobody thought about it", which is what this test catches.
 */
function excluded() {
  const src = readFileSync('server/src/metrics/space-activity.ts', 'utf8');
  const admin = src.match(/const ADMIN_DOMAINS = \[([^\]]+)\]/);
  const plumbing = src.match(/const NON_USAGE_SUFFIXES = \[([^\]]+)\]/);
  assert.ok(admin, 'ADMIN_DOMAINS is gone — the exclusion list is what makes `null` a decision');
  assert.ok(plumbing, 'NON_USAGE_SUFFIXES is gone');
  const read = m => [...m[1].matchAll(/'([a-z_.]+)'/g)].map(x => x[1]);
  return { prefixes: read(admin), suffixes: read(plumbing) };
}

describe('space activity — call classification', () => {
  before(async () => {
    ({ classifyOperation, recordSpaceCall, drainSpaceActivity, peekSpaceActivity, hourBucket, activityDocId,
      CALL_CLASSES } = await import('../../server/dist/metrics/space-activity.js'));
  });

  it('reads a meaningful number of operations from the middleware (the scan still works)', () => {
    const ops = auditOperations();
    assert.ok(ops.length > 60, `only found ${ops.length} operations in the audit table`);
  });

  it('classifies EVERY operation, or excludes it through a named list', () => {
    const { prefixes, suffixes } = excluded();
    const unexplained = auditOperations().filter(op => classifyOperation(op) === null
      && !prefixes.some(d => op.startsWith(d)) && !suffixes.some(s => op.endsWith(s)));
    assert.deepEqual(unexplained, [], 'these count as nothing and are in neither exclusion list:\n  '
      + `${unexplained.join('\n  ')}\n\n`
      + 'Either give it a class, or add it to ADMIN_DOMAINS / NON_USAGE_SUFFIXES with a reason. Silence is the\n'
      + 'failure mode this test exists for — an unclassified route is a space whose usage does not count.');
  });

  it('puts recall, filter and similar in the demand class', () => {
    for (const op of ['brain.recall', 'brain.filter', 'brain.similar']) {
      assert.equal(classifyOperation(op), 'recall', op);
    }
  });

  it('counts a file upload as a WRITE, not as file traffic', () => {
    // Verb before noun. Grouping all of `file.*` as file traffic hides "is anyone still adding to this space"
    // inside "is anyone reading its files" — and the first is the signal that says a space is alive.
    assert.equal(classifyOperation('file.create'), 'write');
    assert.equal(classifyOperation('file.update'), 'write');
    assert.equal(classifyOperation('file.delete'), 'write');
    assert.equal(classifyOperation('file.mkdir'), 'write');
    assert.equal(classifyOperation('file.retry_embedding'), 'write');
    // …and a file READ is file traffic.
    assert.equal(classifyOperation('file.read'), 'file');
    assert.equal(classifyOperation('file.list'), 'file');
  });

  it('counts curation as a write — someone tending a space is using it', () => {
    for (const op of ['conflict.resolve', 'duplicate.merge', 'contradiction.resolve', 'bulk.write']) {
      assert.equal(classifyOperation(op), 'write', op);
    }
  });

  it('counts NOTHING for operator work, even when it ends in a write verb', () => {
    // set-claim: OPERATOR operations, as inputs that must classify to null. A sample of instance-level
    // work rather than a copy of the operation table, which is far larger and lives in the middleware.
    // `space.create` and `network.vote` carry a spaceId. Counting them would credit a brand-new empty space
    // with activity it never had.
    for (const op of ['space.create', 'space.delete', 'space.rename', 'token.create', 'network.vote',
      'data.backup', 'config.reload', 'auth.failed', 'about.logs.ticket', 'sync.trigger']) {
      assert.equal(classifyOperation(op), null, op);
    }
  });

  it('classifies into the closed set and nothing else', () => {
    for (const op of auditOperations()) {
      const cls = classifyOperation(op);
      assert.ok(cls === null || CALL_CLASSES.includes(cls), `${op} -> ${cls}`);
    }
  });
});

describe('space activity — accumulation', () => {
  before(async () => {
    ({ classifyOperation, recordSpaceCall, drainSpaceActivity, peekSpaceActivity, hourBucket, activityDocId,
      CALL_CLASSES } = await import('../../server/dist/metrics/space-activity.js'));
    drainSpaceActivity();   // a previous suite in the same process may have left counts
  });

  it('accumulates demand AND payoff, because a count alone would mislead', () => {
    recordSpaceCall('busy', 'recall', { ms: 40, answered: true, topScore: 0.9 });
    recordSpaceCall('busy', 'recall', { ms: 60, answered: false });
    recordSpaceCall('busy', 'recall', { ms: 20, answered: true, topScore: 0.7 });
    const row = peekSpaceActivity().find(r => r.space === 'busy' && r.cls === 'recall');
    assert.equal(row.totals.n, 3);
    assert.equal(row.totals.answered, 2, 'two of three found something — this is the whole point');
    assert.equal(Number(row.totals.sumTopScore.toFixed(2)), 1.6);
    assert.equal(row.totals.sumMs, 120);
    assert.equal(row.totals.maxMs, 60);
  });

  it('ignores a score on an UNANSWERED call, or the mean leaves the 0..1 range', () => {
    // `sumTopScore` is divided by `answered`. Accumulating a score from a call that found nothing produced
    // means above 1.0 — a similarity score that cannot exist — and a caller with a score to hand will pass it
    // whether or not the call was answered.
    drainSpaceActivity();
    recordSpaceCall('mixed', 'recall', { ms: 10, answered: false, topScore: 0.3 });
    recordSpaceCall('mixed', 'recall', { ms: 10, answered: true, topScore: 0.8 });
    const row = peekSpaceActivity().find(r => r.space === 'mixed');
    assert.equal(row.totals.answered, 1);
    assert.equal(row.totals.sumTopScore, 0.8);
    assert.ok(row.totals.sumTopScore / row.totals.answered <= 1, 'a mean score must stay inside 0..1');
  });

  it('counts slow calls instead of pretending to store a percentile', () => {
    drainSpaceActivity();
    recordSpaceCall('slow', 'recall', { ms: 1_500 });
    recordSpaceCall('slow', 'recall', { ms: 999 });
    const row = peekSpaceActivity().find(r => r.space === 'slow');
    assert.equal(row.totals.over1s, 1);
    assert.equal(row.totals.maxMs, 1_500);
  });

  it('never lets a non-finite duration poison the bucket', () => {
    // `$inc` with NaN does not error — the field simply stops being a number, and the mean is gone for good.
    drainSpaceActivity();
    for (const ms of [NaN, Infinity, -5, undefined]) recordSpaceCall('odd', 'read', { ms });
    const row = peekSpaceActivity().find(r => r.space === 'odd');
    assert.equal(row.totals.n, 4);
    assert.ok(Number.isFinite(row.totals.sumMs), `sumMs is ${row.totals.sumMs}`);
    assert.equal(row.totals.sumMs, 0);
    assert.ok(Number.isFinite(row.totals.maxMs));
  });

  it('ignores a call with no space — a global recall belongs to nothing', () => {
    drainSpaceActivity();
    recordSpaceCall('', 'recall', { ms: 10 });
    assert.deepEqual(peekSpaceActivity(), []);
  });

  it('draining clears, so the next flush cannot double-count', () => {
    drainSpaceActivity();
    recordSpaceCall('a', 'write', { ms: 5 });
    assert.equal(drainSpaceActivity().length, 1);
    assert.deepEqual(drainSpaceActivity(), [], 'a second drain must be empty');
  });

  it('keeps spaces and classes separate', () => {
    drainSpaceActivity();
    recordSpaceCall('a', 'recall', { ms: 1 });
    recordSpaceCall('a', 'write', { ms: 1 });
    recordSpaceCall('b', 'recall', { ms: 1 });
    const rows = drainSpaceActivity();
    assert.equal(rows.length, 3);
    assert.equal(rows.filter(r => r.space === 'a').length, 2);
  });
});

describe('space activity — bucketing', () => {
  before(async () => {
    ({ hourBucket, activityDocId } = await import('../../server/dist/metrics/space-activity.js'));
  });

  it('buckets by the hour, in UTC', () => {
    // UTC because a fleet spans zones: a bucket that shifts with the server's offset makes two instances
    // disagree about which hour a call belongs to.
    assert.equal(hourBucket(Date.parse('2026-08-01T14:37:12.000Z')), '2026-08-01T14');
    assert.equal(hourBucket(Date.parse('2026-08-01T14:00:00.000Z')), '2026-08-01T14');
    assert.equal(hourBucket(Date.parse('2026-08-01T13:59:59.999Z')), '2026-08-01T13');
  });

  it('builds a document id that needs no lookup', () => {
    assert.equal(activityDocId('general', '2026-08-01T14'), 'general:2026-08-01T14');
  });

  it('hours sum into any window an operator asks for', () => {
    // The reason for hourly rather than daily: "this morning" is a question daily buckets cannot answer.
    const day = new Set();
    for (let h = 0; h < 24; h++) day.add(hourBucket(Date.parse(`2026-08-01T${String(h).padStart(2, '0')}:30:00Z`)));
    assert.equal(day.size, 24);
  });
});
