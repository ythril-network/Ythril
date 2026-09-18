/**
 * Unit tests: $regex ReDoS bound in the structured query tool (H5)
 *
 * The shared heuristic (util/redos.ts) must reject catastrophic-backtracking patterns, and the filter
 * check must refuse them — plus non-string and oversized patterns — BEFORE any database work happens.
 *
 * ## WHERE that check runs moved, and these cases moved with it
 *
 * They called `queryBrain`, because the sanitiser ran there: the last moment before Mongo, which is the
 * safest-looking place. `B-9` step 3b moved it to `checkCallerFilter`, called from `resolvePredicate`,
 * because by the time a predicate reaches `queryBrain` it is the caller's filter with the SERVER's own
 * clauses composed around it — and the depth cap was counting both against one budget.
 *
 * The RULE is unchanged and is what these assert: a catastrophic pattern never reaches the database.
 * Calling `queryBrain` now would assert nothing, because its parameter is typed as already-checked.
 *
 * Pure in-process logic — no MongoDB needed: the check runs before any collection handle exists.
 *
 * Run: node --test testing/standalone/query-regex-redos.test.js
 * (build the server first: npm run build:server)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hasReDoSRisk, MAX_PATTERN_LENGTH } from '../../server/dist/util/redos.js';
import { checkCallerFilter } from '../../server/dist/brain/filter-sanitizer.js';

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

describe('the caller filter check — $regex (rejected before any db access)', () => {
  it('rejects a catastrophic $regex pattern', async () => {
    const r = checkCallerFilter({ fact: { $regex: '(a+)+$' } });
    assert.ok('error' in r, 'the filter was accepted');
    assert.match(r.error, /catastrophic backtracking/);
  });

  it('rejects a catastrophic $regex nested under $and', async () => {
    const r = checkCallerFilter({ $and: [{ fact: { $regex: '(x*)*y' } }] });
    assert.ok('error' in r, 'the filter was accepted');
    assert.match(r.error, /catastrophic backtracking/);
  });

  it('rejects a non-string $regex', async () => {
    const r = checkCallerFilter({ fact: { $regex: { $gt: '' } } });
    assert.ok('error' in r, 'the filter was accepted');
    assert.match(r.error, /must be a string/);
  });

  it(`rejects a $regex pattern longer than ${MAX_PATTERN_LENGTH} chars`, async () => {
    const r = checkCallerFilter({ fact: { $regex: 'a'.repeat(MAX_PATTERN_LENGTH + 1) } });
    assert.ok('error' in r, 'the filter was accepted');
    assert.match(r.error, /exceeds/);
  });

  it('still rejects disallowed operators (regression)', async () => {
    const r = checkCallerFilter({ $where: 'sleep(1000)' });
    assert.ok('error' in r, 'the filter was accepted');
    assert.match(r.error, /not allowed/);
  });
});

// The $options sanitiser was previously verified against a hand-copied
// re-implementation in schema-validation.test.js (drift-blind). These cases run the REAL compiled
// sanitiser through `checkCallerFilter`; each rejects before any db access.
describe('the caller filter check — $options (compiled path, S8.9)', () => {
  it('rejects $options without an accompanying $regex', async () => {
    const r = checkCallerFilter({ fact: { $options: 'i' } });
    assert.ok('error' in r, 'the filter was accepted');
    assert.match(r.error, /only allowed alongside/);
  });

  it('rejects $options with invalid regex flags', async () => {
    const r = checkCallerFilter({ fact: { $regex: 'test', $options: 'ig' } });
    assert.ok('error' in r, 'the filter was accepted');
    assert.match(r.error, /valid regex flags/);
  });

  it('rejects a non-string $options value', async () => {
    const r = checkCallerFilter({ fact: { $regex: 'test', $options: 42 } });
    assert.ok('error' in r, 'the filter was accepted');
    assert.match(r.error, /valid regex flags/);
  });

  it('rejects an empty-string $options value', async () => {
    const r = checkCallerFilter({ fact: { $regex: 'test', $options: '' } });
    assert.ok('error' in r, 'the filter was accepted');
    assert.match(r.error, /valid regex flags/);
  });

  it('rejects $options carrying a null byte', async () => {
    const r = checkCallerFilter({ fact: { $regex: 'test', $options: 'i\x00' } });
    assert.ok('error' in r, 'the filter was accepted');
    assert.match(r.error, /valid regex flags/);
  });
});
