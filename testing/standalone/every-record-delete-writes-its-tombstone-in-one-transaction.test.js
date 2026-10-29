/**
 * Every removal of a record and the tombstone that announces it commit together (Q-313) — the shape, held over the sources.
 *
 * ## What it holds, and why it derives
 *
 * `a-record-delete-and-its-tombstone-land-together-db` drives each path; this gate holds the paths it did not name. The defect was a delete followed by a
 * SEPARATE tombstone write, in three deleters and in the session-less form of `removeWithTombstones`. The rules, each over the set the source gives:
 *
 *  1. **A tombstone is written inside a transaction.** Every `writeTombstone(` / `writeTombstones(` outside `brain/tombstones.ts` passes a `session`; inside it,
 *     every one but `removeWithTombstones`' own does too. (File tombstones are another module, `files/tombstones.ts`, with its own writer and its own gate
 *     `a-delete-settles-its-tombstone-from-the-disk-and-stamps-before-its-rows-db`: the scan finds no call of these names there, and a call added there would have
 *     to pass a session as well.)
 *  2. **`removeWithTombstones` without a session opens its own transaction**, and the chunk's delete and its tombstones are both inside it. A caller that omits
 *     the session (the link reconcile, the file-link remover, the fork remover) is therefore safe, which is why rule 1 does not ask it for one.
 *  3. **Every record kind that has a remover is removed through `removeRecords`**: the kinds the deleters name (`removeRecords(spaceId, '<kind>'`) are exactly the
 *     kinds of `AFTER_REMOVAL`, so a fifth kind cannot be added to one and not the other, and a deleter cannot go back to a hand-written delete.
 *
 * The floor: the scan found enough call sites that an empty listing cannot pass, and the module's named parts exist.
 *
 * Run: node --test testing/standalone/every-record-delete-writes-its-tombstone-in-one-transaction.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callSitesOf, serverSources } from './_call-sites.mjs';
import { bodyOf } from './_structural-window.mjs';

const TOMBSTONES = 'server/src/brain/tombstones.ts';
const REMOVAL = 'server/src/brain/record-removal.ts';
const NAMES = ['writeTombstone', 'writeTombstones', 'removeWithTombstones'];
const sites = () => NAMES.flatMap(n => callSitesOf(n).map(s => ({ ...s, name: n })));

describe('a record delete and its tombstone are one transaction', () => {
  it('the scan found the call sites, and the pieces it points at exist', () => {
    const all = sites();
    assert.ok(all.length >= 10, `only ${all.length} call site(s) of ${NAMES.join(', ')} found: the derivation is broken`);
    const { raw } = serverSources();
    assert.match(raw.get(TOMBSTONES), /export async function removeWithTombstones\b/, `${TOMBSTONES} no longer defines removeWithTombstones: re-anchor`);
    assert.match(raw.get(REMOVAL), /export async function removeRecords\b/, `${REMOVAL} no longer defines removeRecords: re-anchor`);
  });

  it('a tombstone is written with the caller\'s session, outside removeWithTombstones\' own session-less branch', () => {
    const own = bodyOf(serverSources().raw.get(TOMBSTONES), 'removeWithTombstones');
    const offenders = sites()
      .filter(s => s.name !== 'removeWithTombstones')
      .filter(s => !(s.file === TOMBSTONES && own.includes(s.args)))
      .filter(s => !/\bsession\b/.test(s.args))
      .map(s => `${s.file}:${s.fn ?? '<module>'} ${s.name}(${s.args.replace(/\s+/g, ' ').slice(0, 80)})`);
    assert.deepEqual(offenders, [],
      'a tombstone is written outside a transaction: the record it buries was deleted by a separate write, and a tombstone the store refuses leaves the record gone here and alive on every peer');
  });

  it('removeWithTombstones, given no session, deletes and tombstones each chunk inside one held transaction', () => {
    const own = bodyOf(serverSources().raw.get(TOMBSTONES), 'removeWithTombstones');
    const at = own.indexOf('inHeldTransaction(');
    assert.ok(at > 0, 'removeWithTombstones opens no held transaction of its own: its session-less form deletes and tombstones in two writes again');
    const inside = own.slice(at);
    assert.match(inside, /deleteRows\(/, 'the chunk\'s delete is not inside the transaction');
    assert.match(inside, /writeTombstones\(/, 'the chunk\'s tombstones are not written inside the transaction');
  });

  it('every kind with a remover is removed through removeRecords', () => {
    const named = new Set(callSitesOf('removeRecords')
      .filter(s => s.file !== REMOVAL)
      .map(s => /^\s*\w+\s*,\s*'(\w+)'/.exec(s.args)?.[1])
      .filter(Boolean));
    const table = serverSources().raw.get(REMOVAL).match(/export const AFTER_REMOVAL[\s\S]*?\n\};/)?.[0] ?? '';
    const kinds = new Set([...table.matchAll(/^  (\w+): /gm)].map(m => m[1]));
    assert.ok(kinds.size >= 4, `AFTER_REMOVAL names ${kinds.size} kind(s): the derivation is broken`);
    assert.deepEqual([...named].sort(), [...kinds].sort(),
      'a record kind is removed through removeRecords by a different set of callers than AFTER_REMOVAL names: a kind was added to one, or a deleter went back to a hand-written delete');
  });
});
