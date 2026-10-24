/**
 * Every writer of a member's `lastSyncAt` stamps `lastSyncAtBy6` with it, through `stampLastSync` (bundle-81, design rev 8 §3
 * "Re-upgrade", P24, P40).
 *
 * ## The finding this holds
 *
 * The re-upgrade detector reads one thing about a member: `lastSyncAt != lastSyncAtBy6` means "a 5.6 build synced with this member",
 * because a 5.6 build writes `lastSyncAt` and has never heard of `lastSyncAtBy6`. That only works if EVERY 6.0 writer of
 * `lastSyncAt` writes the pair. A 6.0 writer that writes `lastSyncAt` alone makes every healthy member look as though 5.6 had been
 * running, and the detector repairs every space on every boot: the false trip the plan's "no false trip" case exists to catch
 * (observability S4). The member's announce door (`api/sync/members.ts`) is the writer 5.6 also has (P24), so it is the one most
 * likely to be forgotten. The two stamps are written by one function, `stampLastSync(member, at)` in `sync/member-status.ts`.
 *
 * ## What is derived, with a floor
 *
 * - **The writers:** every hit of `lastSyncAt\s*[:=]` in `server/src` (the plan's grep, comments blanked). `lastSyncAtBy6` is not a
 *   hit: the pattern needs the name to end where the `:` or `=` begins. Floor: 3. The plan says the grep gives three writers; at
 *   9a7ab3f7 it gives four hits, the fourth a READ (`mcp/tools/sync.ts`, `lastSyncAt: m.lastSyncAt ?? null` in an answer), which is
 *   the one named exemption.
 * - **The rule:** a hit is in `sync/member-status.ts`, or is the named read, or is the clear in `api/invite.ts` (a new member starts
 *   with neither) and clears `lastSyncAtBy6` beside it; every other hit is a writer that bypasses `stampLastSync`.
 * - **The behaviour:** `stampLastSync(member, at)` sets both fields to the SAME instant, and does not touch the rest of the member.
 *
 * ## Seen red
 *
 * Red on 9a7ab3f7: `sync/member-status.ts` does not exist, `sync/engine.ts` and `api/sync/members.ts` write `lastSyncAt` alone,
 * and the invite's clear does not name `lastSyncAtBy6`. Mutation for the newly covered part: write `m.lastSyncAt = now` into a new
 * file and the sweep names it. Restore by hand.
 *
 * Note on the name: the plan names this `-db`; the rule reads source and one pure function, so it opens no database.
 *
 * Run: node --test testing/standalone/every-last-sync-writer-stamps-both-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

const MODULE = 'server/src/sync/member-status.ts';
const WRITER_FLOOR = 3;
const SPELLING = /\blastSyncAt\s*[:=]/g;

/** Hits that are not writers, each with its reason. A fragment of the line, read again so a stale entry fails. */
const READS = [['server/src/mcp/tools/sync.ts', 'lastSyncAt: m.lastSyncAt ?? null', 'an answer field: a read of the stamp']];
/** The clear: a new member starts with no stamp, and clears both. */
const CLEARS = [['server/src/api/invite.ts', 'lastSyncAt: undefined']];

const sources = trackedSources('server/src', { floor: 200 });
const codeOf = (file) => blankComments(readFileSync(join(REPO_ROOT, file), 'utf8'));

function hitsIn(text) {
  return [...text.matchAll(SPELLING)].map(m => {
    const line = text.slice(0, m.index).split('\n').length;
    return { line, text: text.split('\n')[line - 1].trim(), near: text.split('\n').slice(Math.max(0, line - 4), line + 3).join('\n') };
  });
}

describe('the detector finds a lastSyncAt write and not lastSyncAtBy6', () => {
  it('flags `lastSyncAt =` and `lastSyncAt:`, not the By6 stamp, not a comment', () => {
    assert.equal(hitsIn('m.lastSyncAt = now;').length, 1);
    assert.equal(hitsIn('{ lastSyncAt: x }').length, 1);
    assert.equal(hitsIn('{ lastSyncAtBy6: x }').length, 0);
    assert.equal(hitsIn(blankComments('// m.lastSyncAt = now\nconst a = 1;')).length, 0);
  });
});

describe('every writer of lastSyncAt stamps both', () => {
  it('the writers are derived, at least three', () => {
    const hits = sources.flatMap(f => hitsIn(codeOf(f)).map(h => ({ file: f, ...h })));
    assert.ok(hits.length >= WRITER_FLOOR, `only ${hits.length} hit(s): the derivation is broken`);
    for (const must of ['server/src/sync/engine.ts', 'server/src/api/sync/members.ts', 'server/src/api/invite.ts']) {
      assert.ok(hits.some(h => h.file === must) || existsSync(join(REPO_ROOT, MODULE)),
        `${must} no longer spells lastSyncAt and the module that replaces it does not exist: the sweep lost a writer`);
    }
    for (const [file, frag] of READS) assert.ok(hits.some(h => h.file === file && h.text.includes(frag)), `the read exemption ${file}: ${frag} is stale`);
  });

  it('sync/member-status.ts exists and exports stampLastSync', () => {
    assert.ok(existsSync(join(REPO_ROOT, MODULE)), `${MODULE} does not exist: no function writes the pair, so each writer writes what it remembers`);
    assert.match(codeOf(MODULE), /export\s+(?:async\s+)?function\s+stampLastSync\b/, 'the module exports no stampLastSync');
  });

  it('every hit is the module, a named read, or a clear that clears both: no writer bypasses stampLastSync', () => {
    const offending = [];
    for (const file of sources) {
      if (file === MODULE) continue;
      for (const h of hitsIn(codeOf(file))) {
        if (READS.some(([f, frag]) => f === file && h.text.includes(frag))) continue;
        if (CLEARS.some(([f, frag]) => f === file && h.text.includes(frag)) && /\blastSyncAtBy6\b/.test(h.near)) continue;
        offending.push(`${file}:${h.line} ${h.text}`);
      }
    }
    assert.deepEqual(offending, [],
      'a writer of lastSyncAt that does not stamp lastSyncAtBy6 with it: every healthy member then looks as if a 5.6 build had synced, and every space is repaired on every boot. Call stampLastSync(member, at)\n  '
      + offending.join('\n  '));
  });

  describe('stampLastSync', () => {
    let loaded;
    before(async () => { loaded = await loadDistModule('../../server/dist/sync/member-status.js', import.meta.url); });

    it('sets both stamps to the same instant and touches nothing else', () => {
      const { stampLastSync } = needModule(loaded, ['stampLastSync'], 'the last-sync stamp');
      const member = { instanceId: 'm1', label: 'M', consecutiveFailures: 2, lastSyncAt: '2026-01-01T00:00:00.000Z', lastSyncAtBy6: '2026-01-01T00:00:00.000Z' };
      const at = '2026-10-24T12:00:00.000Z';
      const returned = stampLastSync(member, at);
      const out = returned ?? member;
      assert.equal(out.lastSyncAt, at);
      assert.equal(out.lastSyncAtBy6, at, 'the By6 stamp was not written with it');
      assert.equal(out.instanceId, 'm1');
      assert.equal(out.consecutiveFailures, 2, 'the stamp changed another field of the member');
    });

    it('a stamp after a 5.6 write is a trip no longer: after stamping, the two are equal', () => {
      const { stampLastSync } = needModule(loaded, ['stampLastSync'], 'the last-sync stamp');
      const member = { instanceId: 'm1', lastSyncAt: '2026-10-01T00:00:00.000Z', lastSyncAtBy6: '2026-09-01T00:00:00.000Z' };
      const out = stampLastSync(member, '2026-10-24T00:00:00.000Z') ?? member;
      assert.equal(out.lastSyncAt, out.lastSyncAtBy6);
    });
  });
});
