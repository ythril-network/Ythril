/**
 * "Was this path RE-CREATED since the tombstone erased it" is ONE question, asked by the file's own bytes and by its sidecars
 * (bundle-71, Q-407). This file is the pure half; the byte door's answers are in
 * `a-path-recreated-since-its-tombstone-is-one-question-db.test.js`.
 *
 * ## The defect
 *
 * Two rules answered it. The sidecar rule (`parentShadows`, `files/tombstone-shadow.ts`) said: a live row whose bytes hash
 * differently from what the tombstone erased, or a newer version BY THE TOMBSTONE'S ISSUER (two instances' seq counters are not
 * one clock). The file's own byte decision (`shadowedAgainst` in `files/tombstones.ts`) said: a live row whose `seq` is above the
 * tombstone's `rowSeq`, by whoever wrote it. So the same path, the same tombstone and the same live row were "re-created" for the
 * sidecar and "not re-created" for the file: another instance's high-numbered row let the erased bytes back in, and a re-creation
 * with other bytes at a LOWER number was refused as if nothing had changed.
 *
 * ## The rule (`recreatedSince`, `files/tombstone-shadow.ts`)
 *
 *   A tombstone's path has been re-created when a LIVE row at it (a soft-deleted one is the deletion itself) has bytes whose hash
 *   differs from the tombstone's `contentHash`, or is a newer version by the tombstone's issuer (`isNewerVersionByTheIssuer`,
 *   seq compared only through `isNewerCopy`). Never the seq alone, across authors.
 *
 * ## What this file holds
 *
 *   1. the pure table of `recreatedSince`;
 *   2. that BOTH sites ask the one function: neither compares a row's seq with a tombstone's by hand.
 *
 * Run: node --test testing/standalone/a-path-recreated-since-its-tombstone-is-one-question.test.js   (requires a prior `npm run build:server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { loadDistModule, needModule } from './_load-dist-module.mjs';
import { stripComments } from './_strip-comments.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const HASH = sha('the bytes the tombstone erased');
const OTHER = sha('other bytes');
const ISSUER = { instanceId: 'the-issuer' };
const STRANGER = { instanceId: 'another-instance' };

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

let loaded;
before(async () => { loaded = await loadDistModule('../../server/dist/files/tombstone-shadow.js', import.meta.url); });
const recreated = (rule) => needModule(loaded, ['recreatedSince'], rule).recreatedSince;

describe('recreatedSince, the pure answer', () => {
  const t = { contentHash: HASH, issuer: 'the-issuer', rowSeq: 5 };

  it('no live row: not re-created', () => {
    assert.equal(recreated('no row')(t, undefined), false);
  });

  it('a live row with other bytes IS a re-creation, by whoever wrote it and at whatever version', () => {
    for (const author of [ISSUER, STRANGER, undefined]) for (const seq of [1, 5, 6, 900]) {
      assert.equal(recreated('other bytes')(t, { seq, sha256: OTHER, ...(author ? { author } : {}) }), true, `author ${author?.instanceId} seq ${seq}`);
    }
  });

  it('a live row with the erased bytes is a re-creation only as a newer version BY THE ISSUER', () => {
    const r = recreated('same bytes');
    assert.equal(r(t, { seq: 6, sha256: HASH, author: ISSUER }), true, 'the issuer, newer');
    assert.equal(r(t, { seq: 5, sha256: HASH, author: ISSUER }), false, 'the issuer, the same version (isNewerCopy is strict)');
    assert.equal(r(t, { seq: 4, sha256: HASH, author: ISSUER }), false, 'the issuer, older');
    assert.equal(r(t, { seq: 999, sha256: HASH, author: STRANGER }), false, 'another author, however high: two counters are not one clock');
    assert.equal(r(t, { seq: 999, sha256: HASH }), false, 'no author names nobody to compare with');
  });

  it('a tombstone with no issuer or no version names nothing to compare, so the answer for the erased bytes is no', () => {
    const r = recreated('nothing to compare');
    assert.equal(r({ contentHash: HASH, rowSeq: 5 }, { seq: 99, sha256: HASH, author: ISSUER }), false);
    assert.equal(r({ contentHash: HASH, issuer: 'the-issuer' }, { seq: 99, sha256: HASH, author: ISSUER }), false);
  });

  it('a soft-deleted row is the deletion itself, never a re-creation', () => {
    const r = recreated('soft deleted');
    assert.equal(r(t, { seq: 99, sha256: OTHER, author: ISSUER, deletedAt: '2026-01-01T00:00:00.000Z' }), false);
    assert.equal(r(t, { seq: 99, sha256: HASH, author: ISSUER, deletedAt: '2026-01-01T00:00:00.000Z' }), false);
  });

  it('a row with no hash says nothing about the bytes', () => {
    assert.equal(recreated('no hash')(t, { seq: 3, author: STRANGER }), false);
  });
});

describe('both sites ask the one function', () => {
  const files = ['server/src/files/tombstones.ts', 'server/src/files/tombstone-shadow.ts'];
  const code = Object.fromEntries(files.map(f => [f, stripComments(read(f))]));

  it('the bytes decision and the sidecar decision each call recreatedSince', () => {
    assert.match(code[files[0]], /\brecreatedSince\(/, 'tombstones.ts (the file\'s own bytes) does not ask recreatedSince');
    const shadow = code[files[1]];
    const mentions = [...shadow.matchAll(/\brecreatedSince\(/g)].length;
    assert.ok(mentions >= 2, `tombstone-shadow.ts holds the definition and the sidecar rule's call; found ${mentions} mention(s)`);
    assert.match(shadow, /export function recreatedSince\(/);
  });

  it('neither compares a live row\'s seq with a tombstone\'s by hand', () => {
    for (const f of files) {
      const hits = code[f].split('\n').map((l, i) => ({ l: l.trim(), n: i + 1 }))
        .filter(({ l }) => /\brow\.seq\s*[<>]/.test(l) || /\.seq\s*>\s*erased\b/.test(l));
      assert.deepEqual(hits, [], `${f} compares a seq by hand: the cross-author rule is back`);
    }
  });
});
