/**
 * An upload's pace refusal is built in one place: the 408 for a stall or a trickle and the 429 for a cooled-down caller, each with its sentence
 * (bundle-270, Q-953, lens finding D1).
 *
 * ## What it holds
 *
 * - `util/upload-pace-refusal.ts` maps a pace outcome (stalled, too slow, cooled down) and the door's voice (what the door did not do, what the
 *   sender sends again, how the sentence ends) to the status and the sentence. The RDF doors say "the file" and end without a full stop, the admin
 *   import says "the body" and ends with one; the words between are the same, so the sentences of the three doors are pinned here, word for word.
 * - A stall or a trickle with no `what` is refused by the builder (a refusal that says nothing about what was not done is a defect of the
 *   door), never answered with an empty phrase.
 * - **No second copy.** The phrases of the three sentences are a string literal of that module and of no other server source: a door that
 *   spells one again fails here, whatever it says.
 *
 * Run: node --test testing/standalone/an-upload-pace-refusal-is-spelled-once.test.js (server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, SERVER_CODE_ROOTS, trackedSources } from './_sources.mjs';
import { parseSource, walkEveryNode, ts } from '../_shared/syntax-tree.mjs';

const built = await import('../../server/dist/util/upload-pace-refusal.js').catch(() => ({}));
const MODULE = 'server/src/util/upload-pace-refusal.ts';

/** The voices of the doors: the RDF doors' and the admin import's. */
const RDF = { sent: 'file', ending: '', what: 'nothing was imported' };
const ADMIN = { sent: 'body', ending: '.', what: 'nothing was written' };
const refusalOf = (outcome, voice) => {
  assert.equal(typeof built.uploadPaceRefusal, 'function', 'uploadPaceRefusal is not exported by server/src/util/upload-pace-refusal.ts');
  return built.uploadPaceRefusal(outcome, voice);
};

describe('an upload pace refusal is built once', () => {
  it('a stalled upload is 408 with the sentence each door has always sent', () => {
    const outcome = { kind: 'stalled', idleMs: 60_000 };
    assert.deepEqual(refusalOf(outcome, RDF),
      { status: 408, error: 'The upload sent nothing for 60 seconds and was cut off; nothing was imported: send the file again, without pauses' });
    assert.deepEqual(refusalOf(outcome, ADMIN),
      { status: 408, error: 'The upload sent nothing for 60 seconds and was cut off; nothing was written: send the body again, without pauses.' });
  });

  it('a trickling upload is 408 with the sentence each door has always sent', () => {
    const outcome = { kind: 'too-slow', minBytesPerSecond: 1024, windowMs: 90_000 };
    assert.deepEqual(refusalOf(outcome, RDF),
      { status: 408, error: 'The upload sent less than 1024 bytes a second over 90 seconds and was cut off; nothing was imported: send the file again over a faster link' });
    assert.deepEqual(refusalOf(outcome, ADMIN),
      { status: 408, error: 'The upload sent less than 1024 bytes a second over 90 seconds and was cut off; nothing was written: send the body again over a faster link.' });
  });

  it('a cooled-down caller is 429 with the wait, and the sentence names what the door did not do only when the door says it', () => {
    const outcome = { kind: 'cooldown', retryAfter: 42 };
    assert.deepEqual(refusalOf(outcome, RDF),
      { status: 429, error: 'Your last upload here was too slow or stalled; nothing was imported: send the file again in 42 seconds, without pauses', retryAfter: 42 });
    assert.deepEqual(refusalOf(outcome, { sent: 'body', ending: '.' }),
      { status: 429, error: 'Your last upload here was too slow or stalled: send the body again in 42 seconds, without pauses.', retryAfter: 42 });
  });

  it('a stall or a trickle with no `what` is refused by the builder', () => {
    assert.throws(() => refusalOf({ kind: 'stalled', idleMs: 60_000 }, { sent: 'file', ending: '' }), /what/);
    assert.throws(() => refusalOf({ kind: 'too-slow', minBytesPerSecond: 1, windowMs: 1_000 }, { sent: 'file', ending: '' }), /what/);
  });

  it('the three sentences are spelled in this module and in no other server source', () => {
    const PHRASES = ['and was cut off; ', 'too slow or stalled'];
    const holders = new Map();
    for (const file of trackedSources(SERVER_CODE_ROOTS)) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      if (!PHRASES.some(p => text.includes(p))) continue;
      const tree = parseSource(file, text);
      walkEveryNode(tree, (n) => {
        const literal = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n);
        if (!literal) return;
        for (const p of PHRASES) if (n.text.includes(p)) holders.set(p, [...(holders.get(p) ?? []), file]);
      });
    }
    for (const p of PHRASES) {
      assert.deepEqual([...new Set(holders.get(p) ?? [])], [MODULE], `"${p}" is a string literal of ${MODULE} and of no other source: ${JSON.stringify(holders.get(p))}`);
    }
  });
});
