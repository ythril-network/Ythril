/**
 * A change note travels with a DOWNWARD sync, to the members below this instance, and nowhere else (`F-42`).
 *
 * Owner, 2026-09-26: *"it should be a flag on a directed sync (also braintree i guess) and not a scrape on files.
 * that way anyone can add notes when syncing downwards. in ui as well as on rest/mcp"*.
 *
 * The rules are pure functions in `server/src/sync/change-notes.ts`, so they are tested here without a stack:
 * who is "below" on each network type, when a note is refused rather than dropped, the one body both doors parse,
 * and the strict wire shape a receiver accepts. The delivery itself is driven end to end in
 * `testing/sync/a-change-note-rides-the-sync-down.test.js`.
 *
 * Run: node --test testing/standalone/a-change-note-travels-only-downward.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let M;
before(async () => { M = await import('../../server/dist/sync/change-notes.js'); });

const SELF = 'self-id';
const net = (over = {}) => ({ id: 'n1', label: 'net one', type: 'pubsub', spaces: ['alpha', 'beta'], members: [], ...over });
const member = (instanceId, over = {}) => ({ instanceId, label: instanceId, url: `http://${instanceId}`, ...over });

describe('who is below this instance', () => {
  it('a publisher sends to its subscribers; a subscriber has nobody below', () => {
    const publisher = net({ members: [member('sub-1', { direction: 'push' }), member('sub-2', { direction: 'push' })] });
    assert.deepEqual(M.downwardMembers(publisher, SELF).map(m => m.instanceId), ['sub-1', 'sub-2']);
    const subscriber = net({ members: [member('pub', { direction: 'pull' })] });
    assert.deepEqual(M.downwardMembers(subscriber, SELF), []);
  });

  it('a braintree node sends to its children, never to its parent', () => {
    const tree = net({ type: 'braintree', myParentInstanceId: 'parent', members: [
      member('parent', { direction: 'pull' }), member('child', { parentInstanceId: SELF, direction: 'both' }), member('cousin', { parentInstanceId: 'parent' }),
      // A temporary reparent stores the NEW parent with `push`; it is above this node, never below it.
      member('new-parent', { direction: 'push' }),
    ] });
    assert.deepEqual(M.downwardMembers(tree, SELF).map(m => m.instanceId), ['child']);
  });

  it('club, closed and democratic networks have no below, whatever their members say', () => {
    for (const type of ['club', 'closed', 'democratic']) {
      assert.deepEqual(M.downwardMembers(net({ type, members: [member('x', { direction: 'push' })] }), SELF), [], type);
    }
  });
});

describe('a note that cannot travel is refused, never dropped', () => {
  it('names why: the network type, or nobody below', () => {
    assert.match(M.changeNoteRefusal(net({ type: 'club', members: [member('x')] })), /club network has none/);
    assert.match(M.changeNoteRefusal(net({ members: [member('pub', { direction: 'pull' })] })), /no member below/);
  });

  it('the sync body is strict, and `spaces` alone is refused rather than ignored', async () => {
    const pub = net({ members: [member('sub', { direction: 'push' })] });
    assert.equal(await M.attachSyncNote(pub, undefined, 'op'), null, 'no note, nothing to attach');
    assert.equal((await M.attachSyncNote(pub, { spaces: ['alpha'] }, 'op')).status, 400);
    assert.equal((await M.attachSyncNote(pub, { note: 'x', colour: 'red' }, 'op')).status, 400, 'an undeclared key is refused');
    assert.equal((await M.attachSyncNote(pub, { note: 'x'.repeat(M.MAX_NOTE_CHARS + 1) }, 'op')).status, 400);
  });

  it('a note on a network with nobody below is 409 on the sync door', async () => {
    const r = await M.attachSyncNote(net({ members: [member('pub', { direction: 'pull' })] }), { note: 'hello' }, 'op');
    assert.equal(r.status, 409);
  });
});

describe('the wire shape a receiver accepts', () => {
  const ok = { id: '5f0c4b1e-8d2a-4c3b-9e7f-1a2b3c4d5e6f', note: 'n', spaces: ['alpha'], author: 'op', generated: false, createdAt: '2026-09-26T00:00:00Z' };
  it('accepts a well-formed batch and refuses an undeclared key', () => {
    assert.ok(M.IncomingChangeNotes.safeParse({ notes: [ok] }).success);
    assert.ok(!M.IncomingChangeNotes.safeParse({ notes: [{ ...ok, from: 'someone-else' }] }).success, 'the sender is the token, never a body field');
  });
});

describe('the doors go through the one parser', () => {
  it('REST POST /:id/sync and MCP network_sync both call attachSyncNote before the cycle', () => {
    const rest = stripComments(readFileSync('server/src/api/networks/crud.ts', 'utf8'));
    const mcp = stripComments(readFileSync('server/src/mcp/tools/sync.ts', 'utf8'));
    for (const [name, src] of [['crud.ts', rest], ['sync.ts', mcp]]) {
      const at = src.indexOf('attachSyncNote(');
      assert.ok(at > -1, `${name} does not attach the note through attachSyncNote`);
      const run = src.search(/triggerNetworkSync\(|runSyncForNetwork\(net\.id\)/);
      assert.ok(run > at, `${name} must queue the note BEFORE the cycle, so this cycle carries it`);
    }
  });
  it('one malformed note cannot hold the queue behind it: a 400 falls back to one by one and drops only that note', () => {
    const src = stripComments(readFileSync('server/src/sync/change-notes.ts', 'utf8'));
    assert.match(src, /if \(status !== 400\)/);
    assert.match(src, /for \(const n of due\) \{\s*const one = await send\(\[n\]\)/);
    assert.match(src, /\$addToSet: \{ refusedBy: member\.instanceId \}/);
  });
  it('the engine delivers in the member exchange', () => {
    assert.match(stripComments(readFileSync('server/src/sync/engine.ts', 'utf8')), /await deliverChangeNotes\(net, member, fetchOpts\)/);
  });
});
