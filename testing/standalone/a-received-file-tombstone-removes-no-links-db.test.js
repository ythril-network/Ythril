/**
 * A file tombstone this instance RECEIVES removes the file and what it left, and not a link row: the links a file delete removes are the
 * ones THIS instance's own delete takes (bundle-113 pre-ship sweep T2; Q-464, ADR 05).
 *
 * ## The rule, and why it is held from both ends
 *
 * `removeFileHere` is the one list of what a file leaves, shared by the local cascade, the media worker's reconcile and a PEER's file
 * tombstone, and its docblock says it stays link-free ON PURPOSE: a peer deleting its copy of a file is not this instance deciding that the
 * people, facts and chrono entries this instance's links name are no longer the file's. The link step belongs to the delete THIS instance
 * makes (`removeLinksOfDeletedFiles`, called around it by the cascade). A link step added inside `removeFileHere` would pass every
 * local-delete test (they all want the links gone) and would silently delete this instance's links when a peer deleted a file.
 *
 *  - **By behaviour:** a peer's tombstone delivered on each door (push and pull) removes the file's bytes and row, and every link FROM the
 *    file — this instance's and another's — is still there, with no link tombstone written.
 *  - **By structure:** neither `removeFileHere` nor `removeOneStoredFileHere` (the peer's removal) calls a link remover, followed through the
 *    functions of their own module.
 *
 * Run: node --test testing/standalone/a-received-file-tombstone-removes-no-links-db.test.js
 * (requires the harness Mongo and a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { callsIn, topLevelFunctions } from './_call-graph.mjs';
import { join } from 'node:path';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'tombnolinks';
const T0 = '2026-09-01T00:00:00.000Z';

let door, linkIdFor, SELF;
const tomb = (p) => ({ _id: `ft-${p}`, spaceId: S, path: p, deletedAt: '2026-09-01T00:00:05.000Z', issuer: PEER });
const DOORS = {
  push: { deliver: (tombstones) => door.push('/file-tombstones', { spaceId: S, tombstones }, { spaceId: S, token: peerToken(PEER) }) },
  pull: {
    async deliver(tombstones) {
      await door.seedPeerFileTombstones(S, tombstones.map(t => ({ ...t, spaceId: door.peerSide(S), positionAt: t.deletedAt })));
      return door.sync();
    },
  },
};

/** A link row FROM the file `from` to the entity `to`, written by `author` (an instance id). */
const linkRow = (from, to, author) => ({ _id: linkIdFor(from, 'file', to, 'entity'), spaceId: S, from, fromKind: 'file', to, toKind: 'entity',
  author: { instanceId: author, instanceLabel: author }, createdAt: T0, updatedAt: T0, seq: 5_000 + Math.floor(Math.random() * 1_000) });

describe('a received file tombstone removes no links (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'tombnolinks', spaces: [S], files: true });
    ({ linkIdFor } = await import('../../server/dist/brain/links.js'));
    SELF = (await import('../../server/dist/config/author.js')).authorRef().instanceId;
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); await door.coll(S, 'links').deleteMany({}); await door.coll(S, 'tombstones').deleteMany({}); });

  for (const [name, d] of Object.entries(DOORS)) {
    it(`${name} door: the peer's tombstone takes the file's bytes and row, and every link from it stays (this instance's and another's)`, async () => {
      const p = 'received.txt';
      door.writeLocalFile(S, p, 'bytes');
      await door.coll(S, 'files').insertOne(build.filemeta(S, p, 3, { author: PEER_AUTHOR, sizeBytes: 5 }));
      const rows = [linkRow(p, 'e-ours', SELF), linkRow(p, 'e-theirs', PEER), linkRow(`${p}#chunk0`, 'e-ours', SELF)];
      await door.coll(S, 'links').insertMany(rows);

      await d.deliver([tomb(p)]);

      assert.equal(await door.coll(S, 'files').findOne({ _id: p }), null, 'fixture: the peer\'s tombstone did not take the file\'s row');
      assert.equal(door.localFileExists(S, p), false, 'fixture: the peer\'s tombstone did not take the file\'s bytes');
      const left = (await door.coll(S, 'links').find({}).toArray()).map(l => String(l._id)).sort();
      assert.deepEqual(left, rows.map(r => r._id).sort(), 'a received file tombstone removed links: this instance did not delete the file, and its links are not the peer\'s to take');
      assert.deepEqual(await door.coll(S, 'tombstones').find({ type: 'link' }).toArray(), [], 'a link tombstone was written for a link a peer\'s delete took');
    });
  }

  it('neither removeFileHere nor the peer\'s removal calls a link remover, through the functions of their own module', () => {
    const src = stripComments(readFileSync(join(REPO_ROOT, 'server/src/files/remove-file-here.ts'), 'utf8').replaceAll('\r\n', '\n'));
    const functions = topLevelFunctions(src);
    const LINK_STEPS = ['removeLinksOfDeletedFiles', 'removeFileLinksThisInstanceWrote', 'removeLinksFromMany'];
    /** Every name a function calls, and what the functions of this module it calls call, to exhaustion. */
    const reached = (root, seen = new Set()) => {
      if (seen.has(root)) return seen;
      seen.add(root);
      for (const name of callsIn(functions.get(root) ?? '', { closures: true })) { seen.add(name); if (functions.has(name)) reached(name, seen); }
      return seen;
    };
    for (const root of ['removeFileHere', 'removeOneStoredFileHere']) {
      assert.ok(functions.has(root), `remove-file-here.ts has no ${root}: re-anchor this gate`);
      const calls = reached(root);
      assert.ok(calls.has('retireFileMeta') || calls.has('removeFileHere'), `${root}: the walk reached nothing the removal does: the matcher reads nothing`);
      assert.deepEqual(LINK_STEPS.filter(s => calls.has(s)), [], `${root} reaches a link remover: a peer's delete would take this instance's links`);
    }
  });
});
