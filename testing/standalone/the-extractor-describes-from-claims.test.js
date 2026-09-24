/**
 * Phase 4.10 of the conversation extractor — an entity's description, written from its own claims (`F-31`).
 *
 * Rewritten ONCE per entity at the end, from the claims that name it — not built up incrementally, so it reads
 * as one account rather than a pile of amendments. The writer is handed only those claims. The text is linted
 * like a claim (no turn or session references); a failure gets one rewrite, and a second falls back to the
 * entity's first claim, because the format requires every entity to be described and an invented description
 * is worse than a plain one.
 *
 * Run: node --test testing/standalone/the-extractor-describes-from-claims.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let describeEntities;
before(async () => { ({ describeEntities } = await import('../../server/dist/extractor/conversation/describe-entities.js')); });

const luna = { id: 'run:0', name: 'Luna', type: 'animal' };
const claims = [
  { text: 'Ada adopted a cat named Luna on 9 May 2023.', entityIds: ['run:0', 'p1'] },
  { text: 'Luna chewed Ada\'s shoes on 12 May 2023.', entityIds: ['run:0'] },
  { text: 'Bo moved to Paris.', entityIds: ['p2'] },
];
const writer = (...texts) => { const calls = []; return { calls, write: async (p) => { calls.push(p); return texts.shift(); } }; };

describe('4.10 descriptions', () => {
  it('the writer sees only the entity\'s own claims', async () => {
    const w = writer('Luna is a cat Ada adopted in May 2023, who chews shoes.');
    const r = await describeEntities([luna], claims, w.write);
    assert.equal(r.get('run:0'), 'Luna is a cat Ada adopted in May 2023, who chews shoes.');
    assert.match(w.calls[0].user, /adopted a cat named Luna/);
    assert.match(w.calls[0].user, /chewed/);
    assert.doesNotMatch(w.calls[0].user, /Paris/, 'another entity\'s claim is not handed over');
  });
  it('a description carrying conversation structure is rewritten once, then falls back to the first claim', async () => {
    const r1 = await describeEntities([luna], claims, writer('In session 2 Luna chewed shoes.', 'Luna is a cat who chews shoes.').write);
    assert.equal(r1.get('run:0'), 'Luna is a cat who chews shoes.');
    const r2 = await describeEntities([luna], claims, writer('In session 2 Luna chewed shoes.', 'At turn 4 Luna slept.').write);
    assert.equal(r2.get('run:0'), 'Ada adopted a cat named Luna on 9 May 2023.');
  });
  it('an entity no claim names is described by its name and type, and the writer is not asked', async () => {
    const w = writer();
    const r = await describeEntities([{ id: 'run:9', name: 'Oslo', type: 'place' }], claims, w.write);
    assert.equal(w.calls.length, 0);
    assert.equal(r.get('run:9'), 'Oslo (place).');
  });
});
