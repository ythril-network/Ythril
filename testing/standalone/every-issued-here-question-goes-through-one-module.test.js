/**
 * "Did this instance issue this tombstone?" is asked through ONE module, `sync/issued-here.ts`, and answered by a LOCAL mark
 * (`issuedHere: true`), never by the wire text `instanceId` (bundle-81, design rev 8 §6e, decision 1).
 *
 * ## The finding this holds
 *
 * A tombstone's `instanceId` is the sender's text. A peer could store a tombstone naming this instance as issuer, which the mesh
 * push would forward as this instance's own deletion; at the next hop the deliverer equals the issuer, so it reads as proven
 * (`deletion-authority.ts:152-153`, security S1). The question is therefore asked of a mark only the local tombstone writer
 * stamps, through one module with one reader (push selection). A comparison of a tombstone's `instanceId` with this instance's
 * id anywhere else is the second implementation, and it is the weaker one.
 *
 * ## What is derived
 *
 * - **Files that read tombstones:** every tracked `server/src` file (comments blanked) that names the tombstones collection or its
 *   document type: `'tombstones'`, `TombstoneDoc`, `tombstoneDoc(` or `listTombstones(`.
 * - **The comparisons:** in those files, every `instanceId` `===` / `!==` / `:` against `self`, `selfId`, `cfg.instanceId` or
 *   `getConfig().instanceId` (the plan's grep). Floor: at least one, `brain/tombstones.ts`'s own stamp of the issuer field.
 * - **Allowed:** `sync/issued-here.ts`, `sync/deletion-authority.ts` (whose deletion governs: another question) and the stamp in
 *   `brain/tombstones.ts` (the issuer field itself, an object property, never a comparison).
 *
 * ## The second half: the reader
 *
 * The module is not a rule until something reads it. The mesh tombstone push (`sync/tombstone-transfer.ts`) sends every stored
 * tombstone today; the plan makes it read `issuedHereFilter()` through `sync/push-selection.ts` on closed, democratic and club
 * networks. The case below holds that the push path names the module's filter and no other spelling of the mark.
 *
 * ## Seen red
 *
 * Red on 9a7ab3f7: `sync/issued-here.ts` does not exist, and `tombstone-transfer.ts` selects tombstones with no `issuedHere`
 * question (it "sends every tombstone"). Mutation for the newly covered part: write `instanceId: self` into
 * `sync/push-selection.ts` (the plan's) and the comparison case names it.
 *
 * Run: node --test testing/standalone/every-issued-here-question-goes-through-one-module.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const MODULE = 'server/src/sync/issued-here.ts';
const AUTHORITY = 'server/src/sync/deletion-authority.ts';
const STAMP = 'server/src/brain/tombstones.ts';
const PUSH_SELECTION = 'server/src/sync/push-selection.ts';
const TOMBSTONE_PUSH = 'server/src/sync/tombstone-transfer.ts';

/** A file reads tombstones when it names the collection or the document type. */
const READS_TOMBSTONES = /['"`]tombstones['"`]|\bTombstoneDoc\b|\btombstoneDoc\s*\(|\blistTombstones\s*\(/;
/** The plan's comparison: a tombstone's `instanceId` against this instance's id. */
const COMPARISON = /\binstanceId\s*(?:===|!==|:)\s*(?:self\b|selfId\b|cfg\.instanceId\b|getConfig\(\)\.instanceId\b)/g;

const sources = trackedSources('server/src', { floor: 200 });
const codeOf = (file) => blankComments(readFileSync(join(REPO_ROOT, file), 'utf8'));

function comparisonsIn(text) {
  return [...text.matchAll(COMPARISON)].map(m => {
    const line = text.slice(0, m.index).split('\n').length;
    return { line, text: text.split('\n')[line - 1].trim() };
  });
}

describe('the detector finds the plan\'s comparison and nothing a comment says', () => {
  it('flags each of the four spellings of this instance\'s id', () => {
    for (const src of ['instanceId === self', 'instanceId !== selfId', 'x = { instanceId: cfg.instanceId }', 'if (t.instanceId === getConfig().instanceId) {}']) {
      assert.equal(comparisonsIn(blankComments(src)).length, 1, src);
    }
  });
  it('does not flag a comment, or an id compared with a peer', () => {
    assert.deepEqual(comparisonsIn(blankComments('// instanceId === self\nconst x = 1;')), []);
    assert.deepEqual(comparisonsIn(blankComments('if (t.instanceId === peer.instanceId) {}')), []);
  });
});

describe('"issued here" is asked through sync/issued-here.ts', () => {
  it('the module exists and exports the filter and the row predicate, and the filter asks the local mark', () => {
    assert.ok(existsSync(join(REPO_ROOT, MODULE)),
      `${MODULE} does not exist: "issued here" is still read off the wire text \`instanceId\`, which a peer chooses`);
    const code = codeOf(MODULE);
    assert.match(code, /export\s+(?:function|const)\s+issuedHereFilter\b/, 'the module exports no issuedHereFilter');
    assert.match(code, /export\s+(?:function|const)\s+isIssuedHere\b/, 'the module exports no isIssuedHere');
    assert.match(code, /\bissuedHere\s*:\s*true\b/, 'the filter does not ask the local mark `issuedHere: true`');
    assert.doesNotMatch(code, /\binstanceId\b/, 'the module reads `instanceId`: the mark is local, so it must not ask the wire text');
  });

  it('the files that read tombstones are derived, and the comparisons stand only where the plan allows them', () => {
    const readers = sources.filter(f => READS_TOMBSTONES.test(codeOf(f)));
    assert.ok(readers.length >= 5, `only ${readers.length} file(s) read tombstones: the derivation is broken`);
    const found = readers.flatMap(file => comparisonsIn(codeOf(file)).map(c => ({ file, ...c })));
    assert.ok(found.length >= 1, 'no comparison found at all: the stamp of the issuer field in brain/tombstones.ts is the floor, so the pattern is broken');
    assert.ok(found.some(f => f.file === STAMP), `${STAMP} no longer stamps \`instanceId\` from this instance: the floor's own subject moved`);
    const offending = found
      .filter(f => f.file !== MODULE && f.file !== AUTHORITY && f.file !== STAMP)
      .map(f => `${f.file}:${f.line} ${f.text}`);
    assert.deepEqual(offending, [],
      'a tombstone\'s `instanceId` compared with this instance\'s id outside sync/issued-here.ts: ask `isIssuedHere` (the local mark)\n  ' + offending.join('\n  '));
    const stampComparisons = found.filter(f => f.file === STAMP);
    for (const s of stampComparisons) {
      assert.match(s.text, /^instanceId\s*:/, `${STAMP}:${s.line} compares rather than stamps: ${s.text}`);
    }
  });

  it('push selection reads the module filter for brain tombstones on closed, democratic and club networks', () => {
    assert.ok(existsSync(join(REPO_ROOT, PUSH_SELECTION)), `${PUSH_SELECTION} does not exist: the push selection is not one module yet`);
    assert.match(codeOf(PUSH_SELECTION), /\bissuedHereFilter\b/,
      `${PUSH_SELECTION} does not read issuedHereFilter for brain tombstones on closed, democratic and club networks`);
  });

  it('the mesh tombstone push asks the question (it sends every stored tombstone today, relayed ones included)', () => {
    const transfer = codeOf(TOMBSTONE_PUSH);
    assert.match(transfer, /\bissuedHereFilter\b|\bpushSelection\b|\bselectForPush\b|push-selection/,
      `${TOMBSTONE_PUSH} selects tombstones to push with no issued-here question: a relayed tombstone is forwarded as if this instance issued it`);
  });

  it('the mark is spelled `issuedHere: true` nowhere but the module and the one local stamp (`tombstoneDoc`)', () => {
    const spellers = sources.filter(f => f !== MODULE && /\bissuedHere\s*:\s*true\b/.test(codeOf(f)));
    assert.deepEqual(spellers.filter(f => f !== STAMP), [], 'the mark is spelled outside the module and the local stamp');
    assert.ok(spellers.includes(STAMP), `${STAMP} does not stamp \`issuedHere: true\` on a locally issued tombstone (\`tombstoneDoc\`): the mark has no writer`);
  });
});
