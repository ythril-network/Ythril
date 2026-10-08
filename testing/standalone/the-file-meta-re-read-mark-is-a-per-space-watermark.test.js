/**
 * The re-read of file rows has its own per-space mark, and it is declared where every rule about per-space marks reads it
 * (bundle-89, Q-419, plan rev 3 §E3 item 5).
 *
 * ## What the plan says, and what this file holds of it
 *
 * `fileMetaRereadAt` is a member field keyed by space, on the precedent of `tombstoneRereadAt` (`sync/tombstone-reread.ts`). It
 * cannot reuse `lastSeqReceived` (one number across six families: a one-family re-read from 0 would restart every cycle and
 * livelock a larger space), so it holds its OWN cursor and completes only when a read finishes (`!truncated`). It is
 * the repair's bookkeeping about a peer, not network state, so it must not appear in `GET /api/networks`.
 *
 * Three things about it are decidable from the declarations alone, and are held here:
 *
 *  1. it is in `PER_SPACE_WATERMARKS`, the list a space rename carries across and a counter wipe re-owes
 *     (`util/seq.ts` derives its wipe list from it, so one entry covers both);
 *  2. it is declared on `NetworkMember` as `Record<string, string>` — ONE string (a cursor or `'done'`) — so
 *     `testing/_shared/member-watermarks.mjs` still derives it, and the two lists (the type's and the constant's) agree;
 *  3. `networkView` (`networks/network-acts.ts`) removes it from every member it renders, as it removes `tombstoneRereadAt`.
 *
 * ## What is NOT held here, and why that is stated rather than hidden
 *
 * The cursor and the "completes only on `!truncated`" behaviour have no seam yet: the plan names no function for the fold, and
 * the re-arm trigger it waits for (`checkMerkleWithPeer` answering match / mismatch / unknown, `sync/engine.ts`) does not exist.
 * Writing a test against a guessed name would assert the guess. When the seam exists, its fold is held the way
 * `a-tombstone-reread-is-owed-until-it-completes` holds `nextRereadState`.
 *
 * ## Seen red
 *
 * On the base (429e6d25) all three fail: the name is in neither list, and `networkView` renders the field. The `tombstoneRereadAt`
 * rows are the controls (green on base): they show the leak check looks at the field the existing mark is stripped by.
 * These are FORWARD GUARDS: they go red against the base for the reason above, and were not observed failing against any
 * other wrong implementation.
 *
 * Run: node --test testing/standalone/the-file-meta-re-read-mark-is-a-per-space-watermark.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { memberWatermarks } from '../_shared/member-watermarks.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

const MARK = 'fileMetaRereadAt';
/** Repair bookkeeping about a peer: the marks `networkView` keeps out of the body. The existing one is the control. */
const BOOKKEEPING = ['tombstoneRereadAt', MARK];

let types, acts;
before(async () => {
  types = await loadDistModule('../../server/dist/config/types-networks.js', import.meta.url);
  acts = await loadDistModule('../../server/dist/networks/network-acts.js', import.meta.url);
});

describe('the file-row re-read mark', () => {
  it('is in PER_SPACE_WATERMARKS, so a rename carries it and a counter wipe re-owes it', () => {
    const { PER_SPACE_WATERMARKS } = needModule(types, ['PER_SPACE_WATERMARKS'], 'the per-space marks');
    assert.ok(PER_SPACE_WATERMARKS.includes('tombstoneRereadAt'), 'control: the existing re-read mark is not on the list either — re-anchor');
    assert.ok(PER_SPACE_WATERMARKS.includes(MARK), `PER_SPACE_WATERMARKS is [${PER_SPACE_WATERMARKS}]: ${MARK} is missing, so a space rename drops it and a counter wipe never re-owes it`);
  });

  it('is declared on NetworkMember as one string per space, so the derived list holds it and agrees with the constant', async () => {
    const { PER_SPACE_WATERMARKS } = needModule(types, ['PER_SPACE_WATERMARKS'], 'the per-space marks');
    const declared = memberWatermarks();
    assert.ok(declared.includes(MARK), `NetworkMember declares ${declared.join(', ')}: no ${MARK}: Record<string, string>`);
    // One list, two spellings: a field on the type and not the constant (or the reverse) is a mark one rule carries and another forgets.
    assert.deepEqual([...declared].sort(), [...PER_SPACE_WATERMARKS].sort(),
      'the per-space maps declared on NetworkMember and PER_SPACE_WATERMARKS are different sets');
  });

  for (const field of BOOKKEEPING) {
    it(`${field} is not in a network's member view (GET /api/networks)${field === MARK ? '' : ' — control'}`, () => {
      const { networkView } = needModule(acts, ['networkView'], 'the network body');
      const member = {
        instanceId: 'm-1', label: 'Member', url: 'http://192.0.2.1:3200', tokenHash: 'x', direction: 'both',
        lastSeqReceived: { s: 1 }, [field]: { s: 'a-cursor-or-done' },
      };
      const view = networkView({
        id: 'n-1', label: 'N', type: 'club', origin: 'created', spaces: ['s'], votes: [], votingDeadlineHours: 24, members: [member],
      });
      assert.equal(view.members.length, 1, 'fixture: the member is not in the view');
      assert.equal(field in view.members[0], false, `${field} reached the response body of GET /api/networks`);
      assert.ok('instanceId' in view.members[0], 'fixture: the view lost the member\'s own fields too, so the absence above proves nothing');
    });
  }
});
