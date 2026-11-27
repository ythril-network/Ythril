/**
 * The SPARQL limits of the scratch instance (Q-759): read from its config the way the server reads them (an absent key
 * is its default), raised to named values inside the server's own ceilings, and recorded with the run.
 *
 * Run: node --test testing/standalone/bsbm-harness-sparql-limits.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CEILINGS, DEFAULTS, limitsOf, withLimits } from '../../benchmarks/rdf/sparql-limits.mjs';

test('an absent sparql block, or an absent key, reads as the server default', () => {
  assert.deepEqual(limitsOf({}), { timeoutMs: 30000, maxRecordsRead: 200000, maxResults: 10000 });
  assert.deepEqual(limitsOf({ sparql: { timeoutMs: 60000 } }), { timeoutMs: 60000, maxRecordsRead: 200000, maxResults: 10000 });
  assert.deepEqual({ ...DEFAULTS }, { timeoutMs: 30000, maxRecordsRead: 200000, maxResults: 10000 });
});

test('the ceilings are the server\'s: five minutes, ten million records, a million results', () => {
  assert.deepEqual({ ...CEILINGS }, { timeoutMs: 300000, maxRecordsRead: 10000000, maxResults: 1000000 });
});

test('a limit that is no whole number, or past its ceiling, is refused naming the key', () => {
  assert.throws(() => limitsOf({ sparql: { timeoutMs: '30000' } }), /timeoutMs/);
  assert.throws(() => withLimits({}, { timeoutMs: 300001, maxRecordsRead: 1000000, maxResults: 100000 }), /timeoutMs/);
  assert.throws(() => withLimits({}, { timeoutMs: 1000, maxRecordsRead: 10000001, maxResults: 100000 }), /maxRecordsRead/);
  assert.throws(() => withLimits({}, { timeoutMs: 1000, maxRecordsRead: 1000000, maxResults: 1000001 }), /maxResults/);
  assert.throws(() => withLimits({}, { timeoutMs: 1000, maxRecordsRead: 1000000, maxResults: 1.5 }), /maxResults/);
});

test('raising the limits changes the sparql block and nothing else in the config', () => {
  const cfg = { instanceId: 'x', sparql: { timeoutMs: 30000, maxRecordsRead: 200000, maxResults: 10000 }, other: { a: 1 } };
  const next = withLimits(cfg, { timeoutMs: 300000, maxRecordsRead: 10000000, maxResults: 100000 });
  assert.deepEqual(next, { instanceId: 'x', sparql: { timeoutMs: 300000, maxRecordsRead: 10000000, maxResults: 100000 }, other: { a: 1 } });
  assert.equal(cfg.sparql.timeoutMs, 30000, 'the input is not changed');
  assert.deepEqual(limitsOf(next), { timeoutMs: 300000, maxRecordsRead: 10000000, maxResults: 100000 });
});

test('raising the limits keeps every other key of the sparql block (Q-942 fix round, H1)', () => {
  const cfg = { sparql: { timeoutMs: 30000, maxRecordsRead: 200000, maxResults: 10000, someFutureKey: 'kept', nested: { a: 1 } } };
  const next = withLimits(cfg, { timeoutMs: 60000, maxRecordsRead: 300000, maxResults: 20000 });
  assert.deepEqual(next.sparql, { timeoutMs: 60000, maxRecordsRead: 300000, maxResults: 20000, someFutureKey: 'kept', nested: { a: 1 } });
  assert.equal(cfg.sparql.timeoutMs, 30000, 'the input is not changed');
});

test('a config with no sparql block gets one with all three keys', () => {
  assert.deepEqual(withLimits({ a: 1 }, { timeoutMs: 1000, maxRecordsRead: 1000, maxResults: 1 }), { a: 1, sparql: { timeoutMs: 1000, maxRecordsRead: 1000, maxResults: 1 } });
});
