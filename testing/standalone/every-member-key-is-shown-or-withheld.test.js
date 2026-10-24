/**
 * Every key of a network member is SHOWN to some audience or WITHHELD, by name, in `networks/member-view.ts` (bundle-81, design rev 8 §3b, decision 17).
 *
 * ## The finding this holds
 *
 * `safeMemberList` (`api/networks/_shared.ts`) removes two keys and hands a joining instance every other member key, every
 * per-space mark included. `networkView` (`networks/network-acts.ts`) removes the two re-read cursors by name, so any key added
 * to `NetworkMember` goes out on `GET /api/networks[/:id]` and MCP `network_get` until somebody remembers to destructure it.
 * Rev 8 adds `lastPos*`, the frozen `lastSeq*`, `lastSyncAtBy6` and the re-read owed marker. A new member key is invisible until
 * someone adds it to a list, and the gate is what makes that someone decide.
 *
 * ## What is derived
 *
 * - **The keys:** the property names of `interface NetworkMember` in `config/types-networks.ts`, read from the syntax tree.
 *   Floor 10.
 * - **Shown:** the keys of `MEMBER_VIEW_KEYS`, an allow list per audience (`admin`, `joiner`).
 * - **Withheld:** `PER_SPACE_WATERMARKS` and `ROLLBACK_MARKS` (`config/types-networks.ts`) and `WITHHELD_MEMBER_KEYS`
 *   (`tokenHash`, `skipTlsVerify`, `lastSyncAtBy6`, named in the module with its reason).
 * - **The rule:** every key is shown to some audience or withheld, and nothing is both: a key in an allow list and in a withheld
 *   class is the leak the module exists to close.
 *
 * ## The same behaviour on today's code
 *
 * The module does not exist on 9a7ab3f7, so the first cases fail on the missing module. The last case drives today's two views
 * (`safeMemberList`, `networkView`) over a member that carries a value under every key it can, and names every per-space mark
 * that comes back: that is the leak, shown on the code that has it.
 *
 * ## Seen red
 *
 * Red on 9a7ab3f7: the module is missing, and `safeMemberList` returns all six per-space marks while `networkView` returns four.
 * Mutation for the newly covered part: add a key to `NetworkMember` without listing it in the module, and the key-by-key case
 * names it. Restore by hand.
 *
 * Run: node --test testing/standalone/every-member-key-is-shown-or-withheld.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';
import { parseSource, ts } from '../_shared/syntax-tree.mjs';

const KEY_FLOOR = 10;
const TYPES = 'server/src/config/types-networks.ts';

/** The property names of `interface NetworkMember`, read from the syntax tree. */
function memberKeys() {
  const sf = parseSource(TYPES, readFileSync(join(REPO_ROOT, TYPES), 'utf8'));
  const keys = [];
  sf.forEachChild(node => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'NetworkMember') {
      for (const m of node.members) if (ts.isPropertySignature(m) && m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) keys.push(m.name.text);
    }
  });
  return keys;
}

let view, types;
before(async () => {
  view = await loadDistModule('../../server/dist/networks/member-view.js', import.meta.url);
  types = await loadDistModule('../../server/dist/config/types-networks.js', import.meta.url);
});

/** `MEMBER_VIEW_KEYS` as `{ audience: Set<key> }`, whatever iterable each audience's list is. */
function shownByAudience(mod) {
  const all = mod.MEMBER_VIEW_KEYS;
  assert.ok(all && typeof all === 'object', '`MEMBER_VIEW_KEYS` is not an object of allow lists per audience');
  const audiences = Object.keys(all);
  assert.ok(audiences.includes('admin') && audiences.includes('joiner'), `MEMBER_VIEW_KEYS names ${audiences}, not both \`admin\` and \`joiner\``);
  return Object.fromEntries(audiences.map(a => [a, new Set(all[a])]));
}

describe('every member key is shown to an audience or withheld, by name', () => {
  it('the keys of NetworkMember are derived from the type, and there are enough of them', () => {
    const keys = memberKeys();
    assert.ok(keys.length >= KEY_FLOOR, `only ${keys.length} member key(s) read from ${TYPES}: the derivation is broken`);
    assert.ok(keys.includes('tokenHash') && keys.includes('lastSeqReceived'), 'the derivation missed keys it must find');
  });

  it('networks/member-view.ts exports MEMBER_VIEW_KEYS, WITHHELD_MEMBER_KEYS and memberView', () => {
    const mod = needModule(view, ['MEMBER_VIEW_KEYS', 'WITHHELD_MEMBER_KEYS', 'memberView'], 'the member views');
    const withheld = new Set(mod.WITHHELD_MEMBER_KEYS);
    for (const k of ['tokenHash', 'skipTlsVerify', 'lastSyncAtBy6']) assert.ok(withheld.has(k), `WITHHELD_MEMBER_KEYS does not name \`${k}\``);
  });

  it('every key of NetworkMember is in an allow list or in a withheld class, and none is in both', () => {
    const mod = needModule(view, ['MEMBER_VIEW_KEYS', 'WITHHELD_MEMBER_KEYS'], 'the member views');
    const t = needModule(types, ['PER_SPACE_WATERMARKS', 'ROLLBACK_MARKS'], 'the withheld classes');
    const shown = shownByAudience(mod);
    const withheld = new Set([...t.PER_SPACE_WATERMARKS, ...t.ROLLBACK_MARKS, ...mod.WITHHELD_MEMBER_KEYS]);
    assert.ok(withheld.size >= 8, `only ${withheld.size} withheld key(s): the classes are empty or the derivation is broken`);
    const keys = memberKeys();
    const undecided = keys.filter(k => !withheld.has(k) && !Object.values(shown).some(s => s.has(k)));
    assert.deepEqual(undecided, [],
      'a member key nobody decided about: it is returned by the views until it is listed in MEMBER_VIEW_KEYS or withheld by name');
    const both = keys.filter(k => withheld.has(k) && Object.values(shown).some(s => s.has(k)));
    assert.deepEqual(both, [], 'a key both shown and withheld: the leak this module exists to close');
    const strangers = [...new Set(Object.values(shown).flatMap(s => [...s]))].filter(k => !keys.includes(k));
    assert.deepEqual(strangers, [], 'an allow list names a key NetworkMember does not have');
  });

  it('no audience is shown a per-space mark, a frozen rollback mark or lastSyncAtBy6', () => {
    const mod = needModule(view, ['MEMBER_VIEW_KEYS'], 'the member views');
    const t = needModule(types, ['PER_SPACE_WATERMARKS', 'ROLLBACK_MARKS'], 'the withheld classes');
    const never = new Set([...t.PER_SPACE_WATERMARKS, ...t.ROLLBACK_MARKS, 'lastSyncAtBy6']);
    for (const [audience, keys] of Object.entries(shownByAudience(mod))) {
      assert.deepEqual([...keys].filter(k => never.has(k)), [], `the ${audience} view shows a mark`);
    }
  });

  it('today\'s two views return no per-space mark for a member carrying every one (the leak, on the code that has it)', async () => {
    const { PER_SPACE_WATERMARKS } = await import('../../server/dist/config/types-networks.js');
    assert.ok(PER_SPACE_WATERMARKS.length >= 6, 'fixture: the per-space marks are fewer than the six this instance carries');
    const member = {
      instanceId: 'm1', label: 'M', url: 'https://m1.example', tokenHash: 'h', direction: 'both',
      ...Object.fromEntries(PER_SPACE_WATERMARKS.map(k => [k, { general: 'sentinel' }])),
    };
    const net = { id: 'n1', name: 'N', type: 'closed', members: [member, { ...member, instanceId: 'self', label: 'S' }], spaces: [] };
    const { safeMemberList } = await import('../../server/dist/api/networks/_shared.js');
    const { networkView } = await import('../../server/dist/networks/network-acts.js');
    const joiner = safeMemberList(net, 'self')[0];
    const admin = networkView(net).members.find(m => m.instanceId === 'm1');
    assert.deepEqual(PER_SPACE_WATERMARKS.filter(k => k in joiner), [], 'safeMemberList (the join answer) returns per-space marks');
    assert.deepEqual(PER_SPACE_WATERMARKS.filter(k => k in admin), [], 'networkView (GET /api/networks, network_get) returns per-space marks');
  });
});
