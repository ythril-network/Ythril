/**
 * Every copier of a record to a new id goes through `rekeyedRow` (bundle-81, design rev 8 §2 "rekeyedRow drops the class",
 * amendment decision 29, P50).
 *
 * ## The finding this holds
 *
 * A row copied to a new id by `{ ...row, _id: newId }` carries every field the old row held, and with positions that is two local
 * stamps the new row must NOT have: `pos` sits below peers' marks, so the re-keyed row would never be pushed; `writtenHere`,
 * `deliveredBy` and `syncBase` describe the OLD row's provenance. `rekeyedRow` (`sync/local-only-fields.ts`) is the one place that
 * drops them (and the write guard), and the writer's `withLandingStamp` patch puts fresh ones on. P50 found a second copier,
 * `db/rekey-memory-kind-to-fact.ts:140` (a boot step), that spreads the row by hand. The plan moves it to `rekeyedRow`.
 *
 * ## What is derived
 *
 * - **The copiers:** every object literal in `server/src` (comments blanked) that spreads a value and names `_id:` after it. That
 *   is the plan's `{...<row>, _id:` spread, taken in any key order. Floor: the plan's spelling alone finds the ten sites below.
 * - **The rule:** a hit is `rekeyedRow` (the module itself), or it sits in a named exemption that is not a record (an answer row,
 *   a filter, a queue or cache row, the scanner cursor), or it is the fork in `sync/upsert-plan.ts` (a wire document the landing
 *   stamps). Each exemption is a (file, fragment) read again, so one that no longer matches fails as stale.
 * - **The behaviour, on the code that has it:** \`rekeyedRow\` drops \`POSITION_FIELDS\` and \`writtenHere\` itself, as it already drops the
 *   delivery stamp and the write guard.
 *
 * ## Seen red
 *
 * Red on 9a7ab3f7: \`db/rekey-memory-kind-to-fact.ts:140\` copies by hand, and \`rekeyedRow\` returns \`pos\`, \`posAtSeq\` and \`writtenHere\`
 * of the old row. Mutation for the newly covered part: write \`{ ...link, _id: newId }\` into \`brain/merge.ts\` in place of its
 * \`rekeyedRow\` call and the sweep names it. Restore by hand.
 *
 * Run: node --test testing/standalone/a-record-copied-to-a-new-id-goes-through-rekeyed-row.test.js
 * (requires a prior \`npm run build\` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

/** An object literal that spreads a value and then names `_id:`, or the plan's exact `{ ...x, _id:` form. */
const COPIER = /\{[^{}]*?\.\.\.[\w.?[\]]+\s*,[^{}]*?\b_id\s*:|\{\s*\.\.\.[\w.?]+\s*,\s*_id\s*:/g;
const SITE_FLOOR = 8;

/** Spreads that copy something that is not a record to a new id, each with its reason. */
const NOT_A_RECORD = [
  ['server/src/api/admin-import.ts', 'result.refused =', 'an answer row of the import summary'],
  ['server/src/api/sync/docs.ts', 'asFilter<T>({ ...extraFilter', 'a filter, not a copy'],
  ['server/src/brain/traverse-bodies.ts', 'return { ...body, _id: n._id', 'an answer node'],
  ['server/src/brain/traverse-bodies.ts', 'return { ...body, _id: e._id', 'an answer edge'],
  ['server/src/db/rekey-memory-kind-to-fact.ts', '{ ...job, _id: newId, recordType', 'an embed-queue row, not a record'],
  ['server/src/files/media/job-queue.ts', 'rebuild: (j, to)', 'a media job row'],
  ['server/src/files/path-keyed-cache.ts', 'rebuild: (entry, to)', 'a cache entry'],
  ['server/src/metrics/space-activity-store.ts', 'document: { ...row, _id: activityDocId', 'an activity bucket row'],
  ['server/src/brain/scan-cursor.ts', 'const moved = { ...doc, _id:', 'the duplicate-scanner cursor, keyed by space and type (moved with a renamed space: `moveScanCursors`)'],
  ['server/src/sync/positions-owed.ts', 'const moved: SpaceCounterDoc = { ...old, _id: newId, seq };', 'a space\'s counter document, moved whole with its marker fields on a rename (`moveCounterDoc`): not a record'],
  ['server/src/sync/upsert-plan.ts', 'plan.forks.push', 'a wire doc: the landing stamps it (decision 29)'],
];

const sources = trackedSources('server/src', { floor: 200 });
const codeOf = (file) => blankComments(readFileSync(join(REPO_ROOT, file), 'utf8'));

function copiersIn(text) {
  return [...text.matchAll(COPIER)].map(m => {
    const line = text.slice(0, m.index).split('\n').length;
    return { line, text: text.split('\n')[line - 1].trim() };
  });
}

describe('the detector finds a copy to a new id in any key order and nothing a comment says', () => {
  it('flags the spread forms, not a comment, not a spread with no _id', () => {
    assert.equal(copiersIn('x({ ...row, _id: newId, a: 1 })').length, 1);
    assert.equal(copiersIn('x({ ...row, from, _id: newId })').length, 1);
    assert.equal(copiersIn(blankComments('// { ...row, _id: newId }\nconst y = { ...row, seq };')).length, 0);
  });
});

describe('a record copied to a new id goes through rekeyedRow', () => {
  it('every copier is the module, a named non-record, or goes through rekeyedRow', () => {
    const found = sources.flatMap(file => copiersIn(codeOf(file)).map(c => ({ file, ...c })));
    assert.ok(found.length >= SITE_FLOOR, `only ${found.length} copier(s) found: the derivation is broken`);
    const stale = NOT_A_RECORD.filter(([file, frag]) => !found.some(f => f.file === file && f.text.includes(frag)))
      .map(([file, frag]) => `${file}: ${frag}`);
    assert.deepEqual(stale, [], 'these exemptions no longer match a copier: stale');
    const offending = found
      .filter(f => !NOT_A_RECORD.some(([file, frag]) => file === f.file && f.text.includes(frag)))
      .filter(f => f.file !== 'server/src/sync/local-only-fields.ts')
      .map(f => `${f.file}:${f.line} ${f.text.slice(0, 120)}`);
    assert.deepEqual(offending, [],
      'a record copied to a new id by hand carries `pos`, `posAtSeq`, `writtenHere`, `deliveredBy` and `syncBase` of the OLD row: use `rekeyedRow(old, patch)`\n  '
      + offending.join('\n  '));
  });

  it('every file that moves a record to a new id and is not an exemption imports rekeyedRow', () => {
    const importers = sources.filter(f => /\brekeyedRow\s*\(/.test(codeOf(f)) && f !== 'server/src/sync/local-only-fields.ts');
    assert.ok(importers.length >= 3, `only ${importers.length} caller(s) of rekeyedRow (${importers}): the derivation is broken`);
    assert.ok(importers.includes('server/src/db/rekey-memory-kind-to-fact.ts'),
      'db/rekey-memory-kind-to-fact.ts (a boot step) does not call rekeyedRow: it copies the row by hand, so it keeps `pos`, `posAtSeq`, `writtenHere`, `deliveredBy` and `syncBase`');
  });

  describe('rekeyedRow drops the local stamps itself', () => {
    let loaded;
    before(async () => { loaded = await loadDistModule('../../server/dist/sync/local-only-fields.js', import.meta.url); });
    const old = {
      _id: 'old', name: 'x', seq: 7, pos: 1_790_000_000_000_000, posAtSeq: 7, writtenHere: true,
      deliveredBy: 'peer-1', syncBase: { name: 'x' }, _functionalGuard: 'g', embedding: [1, 2],
    };

    it('the class POSITION_FIELDS and writtenHere are gone from the copy; the content and the vector stay', () => {
      const { rekeyedRow, POSITION_FIELDS } = needModule(loaded, ['rekeyedRow', 'POSITION_FIELDS'], 'the re-keyed row');
      assert.ok(POSITION_FIELDS.size >= 2, 'POSITION_FIELDS is empty: a loop over it checks nothing');
      const out = rekeyedRow(old, { _id: 'new', seq: 9 });
      for (const f of [...POSITION_FIELDS, 'writtenHere']) assert.ok(!(f in out), `the copy carries \`${f}\` of the old row`);
      assert.equal(out.deliveredBy, '', 'the copy is nobody\'s delivery');
      assert.ok(!('syncBase' in out) && !('_functionalGuard' in out));
      assert.deepEqual(out.embedding, [1, 2], 'the vector describes the content and stays');
      assert.equal(out._id, 'new');
    });

    it('the same behaviour, spelled on today\'s names: `pos`, `posAtSeq`, `writtenHere` do not ride along', () => {
      const { rekeyedRow } = needModule(loaded, ['rekeyedRow'], 'the re-keyed row');
      const out = rekeyedRow(old, { _id: 'new', seq: 9 });
      assert.deepEqual(['pos', 'posAtSeq', 'writtenHere'].filter(f => f in out), [],
        'a record written here under a new id carries the old row\'s position and provenance');
    });
  });
});
