/**
 * Unit tests: $regex ReDoS bound in the structured query tool (H5)
 *
 * The shared heuristic (util/redos.ts) must reject catastrophic-backtracking
 * patterns, and queryBrain's filter sanitizer must refuse them (plus
 * non-string and oversized patterns) BEFORE any database work happens.
 *
 * Pure in-process logic — no MongoDB needed: sanitizeFilter runs before the
 * collection handle is acquired, so a rejected filter never touches the db.
 *
 * Run: node --test testing/standalone/query-regex-redos.test.js
 * (build the server first: npm run build:server)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hasReDoSRisk, MAX_PATTERN_LENGTH } from '../../server/dist/util/redos.js';
import { queryBrain } from '../../server/dist/brain/query.js';

describe('hasReDoSRisk — shared heuristic', () => {
  const risky = [
    '(a+)+$',
    '(a*)*b',
    '(a|a)+',
    '(.*)*x',
    '(?:x+)+y',
    '(a|ab)*c',
  ];
  // Known miss: patterns whose inner quantifier is mid-group with a trailing
  // optional, e.g. (\w+\s?)*$ — the conservative heuristic doesn't flag these;
  // the 500-char pattern cap and the 10s maxTimeMS ceiling bound the damage.
  for (const p of risky) {
    it(`flags catastrophic pattern: ${p}`, () => {
      assert.equal(hasReDoSRisk(p), true);
    });
  }

  const safe = [
    'hello',
    '^user-[0-9]+$',
    'a+b*c?',
    '(-[a-z0-9]+)+',      // separator-anchored group — documented safe exception
    '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$',
  ];
  for (const p of safe) {
    it(`allows benign pattern: ${p}`, () => {
      assert.equal(hasReDoSRisk(p), false);
    });
  }
});

describe('queryBrain — $regex sanitisation (rejected before any db access)', () => {
  it('rejects a catastrophic $regex pattern', async () => {
    await assert.rejects(
      queryBrain('anyspace', 'facts', { fact: { $regex: '(a+)+$' } }),
      /catastrophic backtracking/,
    );
  });

  it('rejects a catastrophic $regex nested under $and', async () => {
    await assert.rejects(
      queryBrain('anyspace', 'facts', { $and: [{ fact: { $regex: '(x*)*y' } }] }),
      /catastrophic backtracking/,
    );
  });

  it('rejects a non-string $regex', async () => {
    await assert.rejects(
      queryBrain('anyspace', 'facts', { fact: { $regex: { $gt: '' } } }),
      /must be a string/,
    );
  });

  it(`rejects a $regex pattern longer than ${MAX_PATTERN_LENGTH} chars`, async () => {
    await assert.rejects(
      queryBrain('anyspace', 'facts', { fact: { $regex: 'a'.repeat(MAX_PATTERN_LENGTH + 1) } }),
      /exceeds/,
    );
  });

  it('still rejects disallowed operators (regression)', async () => {
    await assert.rejects(
      queryBrain('anyspace', 'facts', { $where: 'sleep(1000)' }),
      /not allowed/,
    );
  });
});

// The $options sanitiser was previously verified against a hand-copied
// re-implementation in schema-validation.test.js (drift-blind). These cases run
// the REAL compiled sanitizer via queryBrain; each rejects before any db access.
describe('queryBrain — $options sanitisation (compiled path, S8.9)', () => {
  it('rejects $options without an accompanying $regex', async () => {
    await assert.rejects(
      queryBrain('anyspace', 'facts', { fact: { $options: 'i' } }),
      /only allowed alongside/,
    );
  });

  it('rejects $options with invalid regex flags', async () => {
    await assert.rejects(
      queryBrain('anyspace', 'facts', { fact: { $regex: 'test', $options: 'ig' } }),
      /valid regex flags/,
    );
  });

  it('rejects a non-string $options value', async () => {
    await assert.rejects(
      queryBrain('anyspace', 'facts', { fact: { $regex: 'test', $options: 42 } }),
      /valid regex flags/,
    );
  });

  it('rejects an empty-string $options value', async () => {
    await assert.rejects(
      queryBrain('anyspace', 'facts', { fact: { $regex: 'test', $options: '' } }),
      /valid regex flags/,
    );
  });

  it('rejects $options carrying a null byte', async () => {
    await assert.rejects(
      queryBrain('anyspace', 'facts', { fact: { $regex: 'test', $options: 'i\x00' } }),
      /valid regex flags/,
    );
  });
});
