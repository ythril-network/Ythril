/**
 * Standalone tests for the contradiction scanner's cursor keys (F-REVIEW slice 3c).
 *
 * The sweep itself needs MongoDB and a vector index, so it belongs in the Docker integration suite. What
 * CAN be pinned here without either — and what the whole design turns on — is that the two passes keep
 * SEPARATE cursors.
 *
 * Why that matters, restated because it is the subtle part: the duplicate scanner advances one cursor per
 * record, which is safe because a cosine score always answers. `judgePair` can decline — an unreachable NLI
 * endpoint yields `judge-unavailable` — and `recordContradiction` correctly writes nothing for those. But
 * writing nothing is not enough: with a single shared cursor the sweep would still have moved past the
 * record, so the pair would not be revisited until one of its records happened to change. An NLI outage
 * during a nightly sweep would permanently skip everything it touched, and the Review tab would look clean.
 *
 * Hence: the structured pass (deterministic, always answers) advances freely and works with no NLI model at
 * all, while the NLI pass keeps its own cursor that parks when the judge is unavailable and resumes exactly
 * where it stopped. If these two keys ever collide, that separation is gone and the bug is invisible.
 *
 * Run: node --test testing/standalone/contradiction-scanner.test.js
 * (requires a prior `npm run build` in server/ so server/dist exists)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { balancedFrom } from './_structural-window.mjs';

let cursorKey, toJudgeable, DEFAULT_TYPES, unjudgedNeighbours;

describe('contradiction scanner — cursor separation', () => {
  before(async () => {
    ({ cursorKey, toJudgeable, DEFAULT_TYPES, unjudgedNeighbours } =
      await import('../../server/dist/brain/contradiction-scanner.js'));
  });

  it('gives the structured and NLI passes DIFFERENT cursors', () => {
    const structured = cursorKey('work', 'fact', 'structured');
    const nli = cursorKey('work', 'fact', 'nli');
    assert.notEqual(structured, nli,
      'one shared cursor would let an NLI outage permanently skip every pair the sweep touched');
  });

  it('scopes a cursor to its space and type, so spaces cannot advance each other', () => {
    assert.notEqual(cursorKey('work', 'fact', 'nli'), cursorKey('other', 'fact', 'nli'));
    assert.notEqual(cursorKey('work', 'fact', 'nli'), cursorKey('work', 'entity', 'nli'));
  });

  it('does not collide with the duplicate scanner\'s own cursors', () => {
    // The dupe scanner uses `${spaceId}:${type}` in the same collection. Colliding would make the two
    // scanners silently consume each other's progress.
    for (const pass of ['structured', 'nli']) {
      assert.notEqual(cursorKey('work', 'fact', pass), 'work:memory');
    }
  });

  it('is stable — the key is derived, not generated', () => {
    assert.equal(cursorKey('work', 'fact', 'nli'), cursorKey('work', 'fact', 'nli'));
  });
});

/**
 * Mapping a vector-search hit onto the judge's input.
 *
 * This is the shape of a bug that does not announce itself. A `RecallResult` carries `_id` (not `id`) and
 * keeps its free text under a per-type field — it has no `text` and no `summary`. When the mapping got both
 * wrong, nothing threw: every pair was written under the id `"undefined:undefined"`, so a whole space's
 * findings overwrote one another into a single row, and `judgePair` read the empty text as `no-text`, so the
 * NLI pass judged nothing at all while the sweep reported success.
 */
describe('contradiction scanner — recall hit → judgeable record', () => {
  const memoryHit = { _id: 'mem-1', type: 'fact', score: 0.97, fact: 'The server listens on 8080.' };

  it('carries the record ID across, so a pair is stored under the pair it is about', () => {
    assert.equal(toJudgeable(memoryHit).id, 'mem-1',
      'an undefined id collapses every finding in the space into one "undefined:undefined" row');
  });

  it('gives the judge non-empty text, or the NLI pass can never run', () => {
    const text = toJudgeable(memoryHit).text;
    assert.ok(text && text.trim().length > 0, 'empty text makes judgePair answer no-text for every pair');
    assert.match(text, /8080/, 'the text must be the record\'s own content, not a placeholder');
  });

  it('appends the description, which is what an entailment model has to work with', () => {
    const withDesc = toJudgeable({ ...memoryHit, description: 'Confirmed in the deploy log.' });
    assert.match(withDesc.text, /Confirmed in the deploy log\./);
  });

  it('attaches the claims it was given, and none when there are none', () => {
    assert.deepEqual(toJudgeable(memoryHit, { port: 8080 }).properties, { port: 8080 });
    assert.ok(!('properties' in toJudgeable(memoryHit)));
  });
});

describe('contradiction scanner — swept types', () => {
  it('sweeps chrono by default', () => {
    // Chrono was in neither scanner's defaults, so a calendar's contradictions were found by nothing.
    assert.ok(DEFAULT_TYPES.includes('chrono'));
    assert.ok(DEFAULT_TYPES.includes('fact') && DEFAULT_TYPES.includes('entity'));
  });
});

/**
 * One pair, one judgement per sweep.
 *
 * Reported by an operator: our scan said `judgedPairs: 6` while their own judge's request counter said 12.
 * Similarity is symmetric, so as the sweep walks by `seq` a mutually-near pair is met from BOTH sides, and
 * both judgements write the same row — the second one paid for a model call to overwrite the first.
 */
describe('contradiction scanner — a pair is judged once per sweep', () => {
  before(async () => {
    ({ unjudgedNeighbours } = await import('../../server/dist/brain/contradiction-scanner.js'));
  });
  const hit = (id) => ({ _id: id, type: 'fact', score: 0.97 });

  it('drops the neighbour whose pair was settled from the other side', () => {
    const seen = new Set(['mem-1:mem-2']);
    const out = unjudgedNeighbours('mem-2', [hit('mem-1'), hit('mem-3')], seen);
    assert.deepEqual(out.map(m => m._id), ['mem-3']);
  });

  it('matches regardless of which side seeded it — the id is order-independent', () => {
    // The pair key is canonical, so `mem-2` as the seed must recognise the row `mem-1:mem-2`. Keying on
    // `${seed}:${match}` instead would recognise nothing and the dedupe would be a no-op that still passed
    // a naive test seeded in the same direction.
    const seen = new Set(['mem-1:mem-2']);
    assert.equal(unjudgedNeighbours('mem-1', [hit('mem-2')], seen).length, 0);
    assert.equal(unjudgedNeighbours('mem-2', [hit('mem-1')], seen).length, 0);
  });

  it('keeps everything on the first visit', () => {
    const out = unjudgedNeighbours('mem-1', [hit('mem-2'), hit('mem-3')], new Set());
    assert.equal(out.length, 2);
  });

  it('is a no-op without a set, so a caller that does not dedupe behaves as before', () => {
    const matches = [hit('mem-2')];
    assert.equal(unjudgedNeighbours('mem-1', matches, undefined), matches);
  });
});

/**
 * The structured pass must reach NO endpoint.
 *
 * It used to enforce that with `minConfidence: 2` — an unreachable floor. But the floor is applied to the
 * RESPONSE: the request went out, the record text left the instance, the endpoint served and billed it, and
 * only then was the answer discarded. That is the other half of the operator's 2×, and it is invisible from
 * every angle except the call itself. `judgePair`'s own tests pin the behaviour (`structuredOnly` → zero
 * fetches, `minConfidence: 2` → one); this pins that the scanner is the caller that uses it.
 */
describe('contradiction scanner — the free pass is actually free', () => {
  const src = fs.readFileSync(new URL('../../server/src/brain/contradiction-scanner.ts', import.meta.url), 'utf8');
  // Comments explain the trap by name, so they must not satisfy the check that guards it.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

  it('asks the judge for the deterministic pass only', () => {
    // A WINDOW, converted to the ARGUMENT LIST of the call the structured branch makes. Not the enclosing
    // statement: the branch is a ternary, so the statement holds BOTH arms and the flag could sit on the NLI
    // one and still satisfy it — which is the opposite behaviour, and the whole point of the test.
    const at = code.indexOf("pass === 'structured'");
    const call = code.indexOf('judgePair(', at);
    assert.ok(at > -1 && call > at, 'the structured branch no longer calls judgePair — re-anchor this gate');
    const args = balancedFrom(code, code.indexOf('(', call), 'the structured-pass judgePair call');
    assert.match(args, /structuredOnly:\s*true/);
  });

  it('does not try to buy silence with an unreachable confidence floor', () => {
    assert.doesNotMatch(code, /minConfidence:\s*2/,
      'a threshold gates the ANSWER, not the request — the call is made and paid for either way');
  });

  it('bounds the per-run budget on calls served, not on pairs settled', () => {
    // A low-confidence answer is a served request that settles nothing. Gating on `judgedPairs` let a space
    // with weak verdicts run indefinitely past a budget whose whole purpose is to bound spend.
    assert.match(code, /maxJudgedPairs\s*>\s*0\s*&&\s*modelCalls\s*>=\s*tune\.maxJudgedPairs/);
  });
});
