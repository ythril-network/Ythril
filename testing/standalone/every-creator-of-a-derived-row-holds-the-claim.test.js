/**
 * Every code path that CREATES a row derived from a file does it under the claim of the job that is deriving it (bundle-44 D-29,
 * Q-436), and only `files/derived-fields.ts` creates one.
 *
 * ## The rule, and why it is a gate
 *
 * A derived row (a chunk, a caption, a face, a transcript segment, an extracted image's row) names its file in `parentFileId`. It is
 * only safe to create one if the run creating it still holds the file's claim, decided by the database in the transaction that also
 * reads the parent (`writeUnderClaim`): otherwise a delete that removes a file's derived rows and then flags the file leaves, behind
 * a parent that is gone, a row nothing removes. That is the forgettable part, so it lives INSIDE the writer — a caller that is
 * handed the fence cannot drop it — and the caller's one obligation is to hand over the claim. A new creator that forgets is the
 * defect again, and nothing about it shows in a diff.
 *
 * ## What is derived, never listed
 *
 *  - **The creators**: every write to a files collection that makes a document (`insertOne`, `insertMany`, `replaceOne`, `bulkWrite`,
 *    or an update with `upsert`) in a function whose body names `parentFileId`, read from the call graph of `server/src`
 *    (`_file-row-writers.mjs`), the one that resolves aliases and a computed collection name. A floor on what was found.
 *  - **The calls of a creator**: every call, in the whole tree, of the functions the first step found, read from the same graph.
 *
 * ## What is asserted
 *
 *  1. every creator is in `files/derived-fields.ts` (or a reasoned exemption: none today);
 *  2. every creator in it runs its write inside `writeUnderClaim` and takes the claim as its second argument, so the fence is not the
 *     caller's;
 *  3. every call of a creator outside that module hands over a claim as its second argument.
 *
 * ## Seen red
 *
 * On e82caa5e no creator takes a claim and `replaceDerivedFileRows` is wrapped by its one caller instead of fencing itself. Mutations
 * (put back by hand): drop the claim at the audio call site of `upsertDerivedFileRow`; add an `insertOne` of a document with
 * `parentFileId` in another module.
 *
 * Run: node --test testing/standalone/every-creator-of-a-derived-row-holds-the-claim.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileRowWritesOfTree, sourceTree, DERIVED_FIELDS } from './_file-row-writers.mjs';
import { argumentsOf } from './_structural-window.mjs';

const CREATING_OPS = new Set(['insertOne', 'insertMany', 'replaceOne', 'bulkWrite']);

/**
 * Writes outside the one module that make a document naming a parent, with the reason it is not a derived row of a media job.
 * Keyed `file:function`; a stale row fails below. Empty today: a creator outside the module is a finding.
 */
const EXEMPT = {};

const { INDEX, callersOf } = sourceTree();
const WRITES = fileRowWritesOfTree();
const creates = (w) => CREATING_OPS.has(w.op) || (/updateOne|updateMany|findOneAndUpdate/.test(w.op) && /\bupsert\s*:\s*true\b/.test(w.args));
const CREATORS = WRITES.filter(w => creates(w) && /\bparentFileId\b/.test(INDEX.bodies.get(w.key).body));
const creatorKeys = [...new Set(CREATORS.map(w => w.key))];
const fnKeyOf = (w) => `${w.file}:${w.fn}`;

describe('the creators of a derived row are found, so the rule cannot pass by finding none', () => {
  it('the derivation finds the creators in the module, and the file rows written at all', () => {
    assert.ok(WRITES.length >= 35, `only ${WRITES.length} write(s) to a files collection found`);
    assert.ok(creatorKeys.length >= 2, `only ${creatorKeys.length} creator(s) of a derived row found (${creatorKeys}) — the derivation is broken`);
    assert.ok(CREATORS.some(w => w.file === DERIVED_FIELDS && /upsertDerivedFileRow/.test(w.fn)), 'the single-row creator was not found');
    assert.ok(CREATORS.some(w => w.file === DERIVED_FIELDS && /replaceDerivedFileRows/.test(w.fn)), 'the conversion\'s whole-set creator was not found');
  });
  it('every exemption still names a function that creates a document naming a parent', () => {
    const live = new Set(CREATORS.map(fnKeyOf));
    assert.deepEqual(Object.keys(EXEMPT).filter(k => !live.has(k)), [], 'exemptions for functions that no longer create a derived row — delete them');
    for (const [k, why] of Object.entries(EXEMPT)) assert.ok(why.length > 40, `${k}: an exemption owes its reason`);
  });
});

describe('a derived row is created by one module, under a claim', () => {
  it('no function outside the module makes a document that names a parent', () => {
    const outside = CREATORS.filter(w => w.file !== DERIVED_FIELDS && !(fnKeyOf(w) in EXEMPT)).map(w => w.name);
    assert.deepEqual(outside, [],
      `these create a document naming a parent outside ${DERIVED_FIELDS}: a derived row made there is made without the claim fence, and a delete racing it leaves a row under a parent that is gone. `
      + 'Route it through the module, or add an EXEMPT entry saying why it is not a derived row of a media job');
  });

  it('each creator in the module takes the claim as its second argument and writes inside writeUnderClaim', () => {
    const src = INDEX.sources.get(DERIVED_FIELDS);
    const bad = [];
    for (const key of creatorKeys.filter(k => k.startsWith(`${DERIVED_FIELDS}:`))) {
      const { name, body } = INDEX.bodies.get(key);
      const header = new RegExp(`function\\s+${name}\\s*\\(\\s*spaceId\\s*:\\s*string\\s*,\\s*claim\\s*:\\s*JobClaim\\b`).test(src);
      if (!header) bad.push(`${name} does not take (spaceId, claim: JobClaim, ...)`);
      if (!/(?<![.\w$])writeUnderClaim\s*\(/.test(body)) bad.push(`${name} does not write inside writeUnderClaim`);
    }
    assert.deepEqual(bad, [], 'the fence is the writer\'s, not its caller\'s: a creator a caller can call without a claim, or that fences nothing, is the race again');
  });

  it('every call of a creator from outside the module hands over a claim as its second argument', () => {
    const calls = [];
    for (const key of creatorKeys) {
      for (const c of callersOf.get(key) ?? []) {
        if (c.from.startsWith(`${DERIVED_FIELDS}:`)) continue;
        const caller = INDEX.bodies.get(c.from);
        const paren = caller.body.indexOf('(', c.at);
        const args = argumentsOf(caller.body, paren, `${c.from} -> ${c.name}`);
        calls.push({ where: `${c.from} calls ${c.name}`, second: args[1] ?? '' });
      }
    }
    assert.ok(calls.length >= 4, `only ${calls.length} call(s) of a creator found outside the module — the call scan is broken, not the code`);
    const without = calls.filter(c => !/\bclaim\b/.test(c.second)).map(c => `${c.where}(…, ${c.second || '<no second argument>'}, …)`);
    assert.deepEqual(without, [], 'these create a derived row without handing the writer the claim of the job they run for');
  });
});
