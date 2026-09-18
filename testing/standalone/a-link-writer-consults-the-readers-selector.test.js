/**
 * A function that STORES a caller's links decides the storage shape the way every READER decides it.
 *
 * ## The defect
 *
 * A link lives in two shapes during the 4.x→5.0 transition: the ARRAY on the record and a LINK RECORD in
 * the space's `links` collection. `usesLinkRecords` picks which a space is read through, and
 * `link-adjacency.ts` says of it, in as many words: *"the ONLY place that decides. A reader choosing for
 * itself is how five readers came to follow five different subsets in the first place."*
 *
 * **That sentence was true of readers and of nothing else.** `reconcileLinks` wrote a link record and
 * stopped, so on a space whose readers were still on the array path it wrote a row every reader looks
 * away from: `linkEntities: [id]` answered `201` and the link was reached by nothing.
 *
 * `completeLinkage` is set by the BOOT conversion, so a space created since the last restart is on the
 * array path — which made the same call succeed or silently lose the link depending on when the instance
 * last rebooted. A reporter could not reproduce it; a responder could.
 *
 * ## The rule, and why it is not "`reconcileLinks` calls `usesLinkRecords`"
 *
 * A case naming one function is satisfied by that function and says nothing about the next one somebody
 * writes — and the two read identically in a diff, which is why that is the part talked past in review.
 *
 * The subject is DERIVED: every exported function that takes a `DesiredLinks`, which is the type a
 * caller's `link*` fields become. Whatever turns that into storage has to ask which shape this space
 * stores, or it is writing into one of two places on a guess.
 *
 * **What is deliberately NOT the subject.** Sync ingest and the conversion itself write links without
 * asking, and correctly: sync replays what a peer sent, and the conversion's whole job is to move a space
 * from one shape to the other. Neither ever sees a `DesiredLinks`, which is what makes the derivation the
 * right one rather than a list of exemptions.
 *
 * ## Seen red
 *
 * Written before the fix, against a `reconcileLinks` that never mentioned the selector, and mutation-
 * tested afterwards by removing the call.
 *
 * Run: node --test testing/standalone/a-link-writer-consults-the-readers-selector.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

/** The selector every reader resolves through, and now every caller-facing writer too. */
const SELECTOR = 'usesLinkRecords';

/**
 * Every EXPORTED function whose signature takes a `DesiredLinks` — the caller's `link*` fields, typed.
 *
 * Derived rather than listed. A corrected list is the same defect with a later expiry date, and this is
 * the exact shape `Q-5` found four times in one sweep.
 *
 * **Exported, and that line is the rule rather than convenience.** An exported writer can be reached by a
 * caller that has not asked which shape the space stores; a module-private helper is reached only THROUGH
 * one that has, so requiring it to ask again would demand the question be answered twice.
 * `writeLinkArrays` is exactly that — it is the array branch, and it exists because the selector already
 * said so.
 *
 * The body comes from `bodyOf`, bounded by the next top-level declaration. A hand-rolled brace match took
 * the first `{` after the signature, which on `reconcileLinks` is the RETURN TYPE — so the first version
 * of this scan read `{ added: number; removed: number }` as the function body and reported the one writer
 * that does ask.
 */
function linkStoringFunctions() {
  const found = [];
  for (const { file, text } of readTrackedSources('server/src', { floor: 100 })) {
    const src = stripComments(text);
    for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)[^;{]*?:\s*DesiredLinks[,)]/gs)) {
      found.push({ file: file.split('/').pop(), name: m[1], body: bodyOf(src, m[1]) });
    }
  }
  return found;
}

describe('a link writer asks the same question its readers ask', () => {
  it('the derivation finds real functions, so an empty set cannot pass', () => {
    // An empty scan passes every loop written over it and reports a green tick about nothing.
    const fns = linkStoringFunctions();
    assert.ok(fns.length >= 1,
      'no exported function taking a DesiredLinks was found — the derivation is broken, not the code. '
      + 'If the type was renamed, re-anchor this gate rather than deleting it.');
    assert.ok(fns.some(f => f.name === 'reconcileLinks'),
      `the known writer is missing from the derivation: ${JSON.stringify(fns.map(f => f.name))}`);
  });

  it('every one of them resolves the storage shape through the selector', () => {
    const offenders = linkStoringFunctions()
      .filter(f => !f.body.includes(SELECTOR))
      .map(f => `${f.file}:${f.name}`);
    assert.deepEqual(offenders, [],
      'these functions turn a caller\'s links into storage without asking which shape this space stores:\n'
      + offenders.map(o => `  ${o}`).join('\n')
      + '\n\n      On an unconverted space the readers are on the ARRAY path, so a writer that only writes'
      + '\n      a link record answers 201 and the link is reached by nothing — for as long as the instance'
      + '\n      has not rebooted since the space was created. `usesLinkRecords` is the one place that'
      + '\n      decides, for readers and writers alike.');
  });

  it('the selector is still the single decider for readers, which is what makes it one rule', () => {
    // If a reader ever grew its own opinion, "writers agree with readers" would stop meaning anything.
    const adj = readTrackedSources('server/src/brain', { floor: 10 })
      .find(f => f.file.endsWith('link-adjacency.ts'));
    assert.ok(adj, 'link-adjacency.ts is where the selector lives — re-anchor this gate');
    assert.match(adj.text, new RegExp(`export function ${SELECTOR}`),
      'the selector must be exported from one place, or agreeing with it means nothing');
  });
});

/**
 * ADDITIVE is the conversion's exception, and nobody else's.
 *
 * `reconcileLinks` normally deletes a link record the desired set does not name — that is what
 * `linkEntities: []` MEANS, and an ordinary write is authoritative about its own links. The link
 * CONVERSION is not: it builds its desired set from the legacy ARRAYS, so a link that already exists as
 * a record is named by nothing, and deleting on that basis destroyed it — with a tombstone, so the loss
 * replicated to every peer. Measured on a live instance, which reported `-1 link(s) created`.
 *
 * The flag that fixes that is a loaded gun pointed the other way: a SYNC ingest that became additive
 * would stop honouring a peer's detach, and the link would come back on the next pull for ever. So the
 * exception is pinned to the one module entitled to it.
 */
describe('only the conversion may be additive', () => {
  it('every `additive: true` call site is in the conversion', () => {
    const offenders = [];
    for (const { file, text } of readTrackedSources('server/src', { floor: 100 })) {
      const src = stripComments(text);
      if (!/additive:\s*true/.test(src)) continue;
      if (!file.endsWith('links-conversion.ts')) offenders.push(file);
    }
    assert.deepEqual(offenders, [],
      'these modules ask the link writer NOT to delete:\n  ' + offenders.join('\n  ')
      + '\n\n      Only the link conversion is entitled to that: it reads its desired set out of the'
      + '\n      legacy arrays, where a record-only link is named by nothing. Anywhere else — a sync'
      + '\n      ingest above all — additive means a detach is never honoured and the link returns on'
      + '\n      the next pull, permanently.');
  });

  it('and the conversion actually asks for it, so the exception is not just unused', () => {
    // A rule about who may use a flag says nothing if nobody uses it: the gate above would pass just as
    // happily on a build where the conversion had quietly gone back to deleting.
    const conv = readTrackedSources('server/src/brain', { floor: 10 })
      .find(f => f.file.endsWith('links-conversion.ts'));
    assert.ok(conv, 'links-conversion.ts is where the exception lives — re-anchor this gate');
    assert.match(stripComments(conv.text), /additive:\s*true/,
      'the conversion must ask not to delete, or it destroys record-only links again');
  });
});
