/**
 * A key a publisher REMOVED from a file's metadata is removed on every instance that receives the file — by push and by
 * pull, through a relay, and on a restore — and an older peer is neither sent what it would refuse nor erased by what
 * it does not know (bundle-48, `Q-256`; plan D3).
 *
 * ## The defect
 *
 * A file's metadata arrives as a `$set` of the keys it carries and never an `$unset` (`sync/file-meta-write.ts`: "an
 * older peer cannot erase a field it does not know"). So an operator who edits a generated description (which unsets
 * `descriptionSource`), or removes a description, the properties or the tags (`deleteFields`), changes the publisher
 * and nobody else: the subscribers keep the old text for ever, and the space hashes (`description`, `descriptionSource`,
 * `properties` and `tags` are all hashed) disagree for ever. Worse for the tags: the row a `deleteFields: ['tags']`
 * leaves has NO `tags` key, and `IncomingFileMetaDoc` requires one, so the file's push is refused whole and the
 * file's other edits never arrive either.
 *
 * ## The rule, over every door, and what is asserted
 *
 * The design is an explicit wire key: every SENDER lists the authored keys its version knows (`authoredKeys`), at push
 * AND at serve time, relays included; a receiver unsets exactly the keys that are in that list, are in its own authored
 * set, and are absent from the document. Everything below is stated over the doors:
 *
 *  1. **Pull**: the publisher is the fake peer serving its row through the REAL page handler, so the wire is whatever
 *     the sender's code makes of it. The receiver's row loses the removed keys, keeps what it derived from its own
 *     bytes, and its space hash equals the publisher's.
 *  2. **Push**: this instance is the publisher, pushing to a fake peer that records the wire; the recorded wire is then
 *     handed to a real receiver (a second space on the same door), which loses the removed keys. A file whose `tags`
 *     were removed is pushed successfully — to an old peer too.
 *  3. **The receiver's rule**, on both doors (`push` = `POST /batch-upsert`, `pull` = the engine against a canned page):
 *     only a key the sender LISTS is removed; names that are not authored keys (`sha256`, `sizeBytes`, `deletedAt`,
 *     `seq`, …) are never unset whatever the list says; a stale copy loses; no list means no removal (an older sender).
 *  4. **A relay** A -> B -> C: B serves what it holds, and C loses the key too.
 *  5. **A restore** applies removal (an export is a full record) and keeps the flag a soft delete left.
 *  6. **An older peer** (no known version, or 5.6.9) is sent today's wire: no new key, and `tags` present — validated
 *     against a FROZEN literal copy of v5.6.9's `IncomingFileMetaDoc` (`_fixtures/`). A peer that claims a newer version
 *     and still refuses is offered the same documents again on the old wire, so a rollback never loses an edit.
 *
 * ## Seen red on the base (2693450b)
 *
 * Every removal case: the receiver keeps the description, source and properties (the merge never unsets), and a row with
 * no `tags` is refused by the schema. The old-peer wire for a row without `tags` fails the frozen schema (no `tags`).
 * The pins (`PIN`) are green on the base and stay green: they are the rules a fix must not break.
 *
 * Run: node --test testing/standalone/a-removed-file-key-crosses-the-wire-db.test.js
 * (requires a prior `npm run build` in server/, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { IncomingFileMetaDocV569 } from './_fixtures/incoming-file-meta-doc-v5.6.9.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

/** B, the instance under test as a receiver and a relay; C, the instance behind it (a second space on the one door). */
const S = 'rmkey';
const C = 'rmkey-c';
const FILE = 'notes/spec.md';
const T_OLD = '2026-09-01T00:00:00.000Z';
const T_NEW = '2026-10-01T00:00:00.000Z';
const SEQ_OLD = 5;
const SEQ_NEW = 9;
/** A version above every release: a peer this new takes the new wire. A peer on 5.6.9 or reporting none takes today's. */
const NEWER = '99.0.0';
const OLD_VERSIONS = [undefined, '5.6.9'];

/** What is wired and never an authored key: the identity and the order of a record (plan D3). */
const NOT_AUTHORED = ['_id', 'spaceId', 'path', 'author', 'createdAt', 'updatedAt', 'seq', 'parentFileId'];
/** What the receiver derived from its own bytes, and a removal must never touch. */
const LOCAL = { sizeBytes: 4242, sha256: 'f'.repeat(64) };
/** Everything authored a publisher's first version carried. */
const FIRST = { description: 'as the publisher first described it', descriptionSource: 'generated', tags: ['spec'], properties: { version: '1' } };

let door, shared, importMod, merkleMod, ME;

const rowIn = (space) => door.coll(space, 'files').findOne({ _id: FILE });
const held = () => rowIn(S);

/** The copy a receiver holds before the removal arrives: everything authored, plus what it derived itself. */
const oldCopy = (space, extra = {}) => build.filemeta(space, FILE, SEQ_OLD, { author: { ...PEER_AUTHOR }, updatedAt: T_OLD, ...FIRST, ...LOCAL, ...extra });

/**
 * The publisher's row AFTER an operator removed keys: only what was kept. `build.filemeta` carries `tags: []`, which a
 * removal of the tags must not, so this builds the row from nothing.
 */
const removed = (space, keep = {}, extra = {}) => ({
  _id: FILE, spaceId: space, path: FILE, author: { ...PEER_AUTHOR }, createdAt: T_OLD, updatedAt: T_NEW, seq: SEQ_NEW, ...keep, ...extra,
});

/** What a publisher KEEPS when it removes the description, its source and the properties: the tags only. */
const KEEPS_TAGS = { tags: FIRST.tags };

const plant = (space, doc) => door.coll(space, 'files').insertOne({ ...doc });

/** The authored set as THIS build knows it: the optional keys of the wire schema minus identity and order (plan D3). */
function authoredSet() {
  const shape = shared.IncomingFileMetaDoc.shape;
  const keys = Object.keys(shape).filter(k => !NOT_AUTHORED.includes(k) && shape[k].safeParse(undefined).success);
  return keys.sort();
}

/** The doors a receiver can be handed a page through — the same page, the same expectations. */
const DOORS = {
  async push(docs, space = S) {
    const res = await door.push('/batch-upsert', { filemeta: docs }, { spaceId: space });
    assert.equal(res.code, 200, `the push door answered ${res.code}: ${JSON.stringify(res.body)}`);
  },
  async pull(docs) {
    door.state.records[S] = { filemeta: docs };
    await door.sync();
  },
};

/**
 * What the engine pushed to the fake peer for the files family of THE PUBLISHER'S space, as documents (the body `key`
 * taken off). The door carries two spaces and a publisher relays what it holds, so a copy planted in the other one is
 * pushed as well and is not what a case asks about.
 */
const wireOfFiles = () => door.state.pushedRecords
  .filter(r => r.key === 'filemeta' && r.spaceId === S).map(({ key: _key, ...doc }) => doc);

/** This instance as the PUBLISHER: its row is stored, the peer is a subscriber of `version`, and one cycle runs. */
async function publish(row, { version } = {}) {
  door.configure({ direction: 'push', ...(version === undefined ? {} : { memberExtra: { version } }) });
  await door.mongo.col(`${S}_files`).insertOne({ ...row, author: { ...ME } });
  await door.bumpSeq(S, row.seq);
  await door.sync();
  return wireOfFiles().filter(d => d._id === row._id);
}

describe('a key removed from a file\'s metadata is removed everywhere it was received', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'rmkey', spaces: [S, C], files: true });
    shared = await import('../../server/dist/api/sync/_shared.js');
    importMod = await import('../../server/dist/api/admin-import.js');
    merkleMod = await import('../../server/dist/brain/merkle.js');
    ME = { instanceId: door.instanceId, instanceLabel: 'Receiver' };
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  it('the authored set and the frozen v5.6.9 wire are what the cases below assume (a floor on the derivation)', () => {
    const authored = authoredSet();
    for (const k of ['description', 'descriptionSource', 'properties', 'suppressEmbeddings']) {
      assert.ok(authored.includes(k), `${k} is not in the authored set ${JSON.stringify(authored)} — the derivation from IncomingFileMetaDoc is broken`);
    }
    assert.ok(authored.length >= 4, `only ${authored.length} authored key(s): ${authored}`);
    for (const k of NOT_AUTHORED) assert.ok(!authored.includes(k), `${k} is identity or order, not authored`);
    // The fixture discriminates: it takes today's wire and refuses what a newer sender would add.
    const plain = { ...removed(S, { tags: [] }) };
    assert.equal(IncomingFileMetaDocV569.safeParse(plain).success, true, 'the frozen schema refuses a plain document — the fixture is broken');
    assert.equal(IncomingFileMetaDocV569.safeParse({ ...plain, authoredKeys: ['description'] }).success, false, 'the frozen schema accepts an unknown key — the fixture is not the v5.6.9 one');
    assert.equal(IncomingFileMetaDocV569.safeParse(removed(S)).success, false, 'the frozen schema accepts a document with no tags — the fixture is not the v5.6.9 one');
  });

  describe('PULL: the publisher serves its row through the real page handler', () => {
    const serve = async (...docs) => { await door.seedPeerRecords(S, 'filemeta', docs); door.state.family = door.serveFamily; };

    it('a description, its source and the properties the publisher removed are removed here; what this instance derived stays', async () => {
      await plant(S, oldCopy(S));
      await serve(removed(S, KEEPS_TAGS));
      await door.sync();
      const now = await held();
      assert.equal(now?.seq, SEQ_NEW, `the publisher's newer copy did not land (stored: ${JSON.stringify(now)})`);
      assert.deepEqual(['description', 'descriptionSource', 'properties'].filter(k => k in now), [],
        `the publisher removed these and this instance still holds them: the merge only ever sets (stored: ${JSON.stringify(now)})`);
      assert.deepEqual(now.tags, ['spec'], 'a key the publisher kept was touched');
      for (const [k, v] of Object.entries(LOCAL)) assert.equal(now[k], v, `${k} describes bytes this instance holds and was lost to the removal`);
    });

    it('tags the publisher removed are removed here — and a row with NO tags key is not refused by the schema', async () => {
      await plant(S, oldCopy(S));
      await serve(removed(S));
      await door.sync();
      const now = await held();
      assert.equal(now?.seq, SEQ_NEW, `a published row with no tags was refused whole, so none of its edits arrive (stored: ${JSON.stringify(now)})`);
      assert.deepEqual(['description', 'descriptionSource', 'properties', 'tags'].filter(k => k in now), [], `the removed keys survived: ${JSON.stringify(now)}`);
    });

    it('the two instances then hash the same: nothing hashed was left behind', async () => {
      await plant(S, oldCopy(S));
      await serve(removed(S, KEEPS_TAGS));
      await door.sync();
      assert.equal((await held())?.seq, SEQ_NEW, 'the removal did not arrive, so the roots cannot agree');
      const mine = await merkleMod.computeMerkleRoot(S);
      const theirs = await merkleMod.computeMerkleRoot(door.peerSide(S));
      assert.equal(mine.root, theirs.root, 'the publisher and its subscriber hold the same authored data and report a divergence for ever');
    });
  });

  it('PIN — the comparison above is sound: a space that holds the publisher\'s row as it is has the publisher\'s root', async () => {
    await plant(S, { ...removed(S, KEEPS_TAGS), ...LOCAL });
    await plant(door.peerSide(S), removed(door.peerSide(S), KEEPS_TAGS));
    assert.equal((await merkleMod.computeMerkleRoot(S)).root, (await merkleMod.computeMerkleRoot(door.peerSide(S))).root,
      'two spaces holding the same authored row hash differently: the hash-agreement case above would never go green');
  });

  describe('PUSH: this instance is the publisher, and what it sends is applied by a real receiver', () => {
    it('the recorded wire of a removal, applied to a receiver that holds the old copy, removes the keys', async () => {
      const wire = await publish(removed(S, KEEPS_TAGS), { version: NEWER });
      assert.equal(wire.length, 1, `the publisher offered ${wire.length} copies of the file to a peer that takes the new wire`);
      await plant(C, oldCopy(C));
      await DOORS.push(wire, C);
      const now = await rowIn(C);
      assert.equal(now?.seq, SEQ_NEW, `the removal did not land on the receiver (stored: ${JSON.stringify(now)}; wire: ${JSON.stringify(wire)})`);
      assert.deepEqual(['description', 'descriptionSource', 'properties'].filter(k => k in now), [],
        `the push carried the file's new state but not what was removed from it (wire: ${JSON.stringify(wire)})`);
      for (const [k, v] of Object.entries(LOCAL)) assert.equal(now[k], v, `${k} was lost to the removal`);
    });

    it('a file whose tags were removed is pushed, and lands: a row with no tags is not a refusal', async () => {
      const wire = await publish(removed(S), { version: NEWER });
      await plant(C, oldCopy(C));
      await DOORS.push(wire, C);
      const now = await rowIn(C);
      assert.equal(now?.seq, SEQ_NEW, `the file with no tags did not land (wire: ${JSON.stringify(wire)}, stored: ${JSON.stringify(now)})`);
      assert.equal('tags' in now, false, 'the removed tags survive on the receiver');
    });

    it('the wire of a peer that takes the new keys names every authored key its version knows', async () => {
      const [doc] = await publish(removed(S, KEEPS_TAGS), { version: NEWER });
      assert.ok(doc, 'nothing was pushed');
      assert.ok(Array.isArray(doc.authoredKeys), `a peer on ${NEWER} was sent no authoredKeys (wire: ${JSON.stringify(doc)})`);
      assert.deepEqual([...doc.authoredKeys].sort(), authoredSet(), 'authoredKeys is not the authored set of the schema this build declares');
      for (const k of ['description', 'descriptionSource', 'properties']) {
        assert.ok(doc.authoredKeys.includes(k) && !(k in doc), `${k} was removed: it must be listed and absent (wire: ${JSON.stringify(doc)})`);
      }
    });
  });

  describe('the receiver\'s rule, on both doors', () => {
    for (const via of Object.keys(DOORS)) {
      it(`${via}: a key the sender lists and the document lacks is removed; a key it does not list is never touched`, async () => {
        await plant(S, oldCopy(S, { suppressEmbeddings: true }));
        // An older sender's authored set: it knows description and tags, and has never heard of the rest.
        await DOORS[via]([removed(S, { tags: ['spec'] }, { authoredKeys: ['description', 'tags'] })]);
        const now = await held();
        assert.equal(now?.seq, SEQ_NEW, `${via}: the arrival did not land (stored: ${JSON.stringify(now)})`);
        assert.equal('description' in now, false, `${via}: a listed, absent key was not removed`);
        assert.deepEqual(now.properties, FIRST.properties, `${via}: properties is not in the sender's list and was erased`);
        assert.equal(now.suppressEmbeddings, true, `${via}: suppressEmbeddings is not in the sender's list and was erased`);
        assert.equal(now.descriptionSource, FIRST.descriptionSource, `${via}: descriptionSource is not in the sender's list and was erased`);
      });

      it(`${via}: a name in the list that is not an authored key is never unset, whatever the sender says`, async () => {
        await plant(S, oldCopy(S, { deletedAt: T_OLD }));
        const everything = ['description', 'sha256', 'sizeBytes', 'deletedAt', 'embedding', 'embeddingStatus', '_id', 'seq', 'author', 'spaceId', 'createdAt', 'syncBase', '$where'];
        await DOORS[via]([removed(S, { tags: ['spec'] }, { authoredKeys: everything })]);
        const now = await held();
        assert.equal(now?.seq, SEQ_NEW, `${via}: the arrival did not land (stored: ${JSON.stringify(now)})`);
        assert.equal('description' in now, false, `${via}: the one authored key in the list was not removed, so the case proves nothing about the others`);
        assert.equal(now.sha256, LOCAL.sha256, `${via}: a peer's list unset the hash of the bytes this instance holds`);
        assert.equal(now.sizeBytes, LOCAL.sizeBytes, `${via}: a peer's list unset the size of the bytes this instance holds`);
        assert.equal(now.deletedAt, T_OLD, `${via}: a peer's list unset the flag a soft delete left here`);
        assert.equal(now.author?.instanceId, PEER, `${via}: a peer's list unset the author`);
        assert.equal(now.createdAt, T_OLD, `${via}: a peer's list unset createdAt`);
      });

      it(`${via}: PIN — a copy older than the stored one removes nothing`, async () => {
        await plant(S, oldCopy(S, { seq: 20 }));
        await DOORS[via]([removed(S, { tags: ['spec'] }, { seq: 12, authoredKeys: ['description', 'properties'] })]);
        const now = await held();
        assert.equal(now?.seq, 20, `${via}: a stale copy replaced the stored one`);
        assert.equal(now?.description, FIRST.description, `${via}: a stale copy removed a key`);
        assert.deepEqual(now?.properties, FIRST.properties, `${via}: a stale copy removed a key`);
      });

      it(`${via}: PIN — a sender that sends no list (an older version) removes nothing, whatever its document lacks`, async () => {
        await plant(S, oldCopy(S));
        await DOORS[via]([removed(S, { tags: ['spec'] })]);
        const now = await held();
        assert.equal(now?.seq, SEQ_NEW, `${via}: the arrival did not land (stored: ${JSON.stringify(now)})`);
        assert.equal(now.description, FIRST.description, `${via}: an older peer erased a description it never mentioned`);
        assert.deepEqual(now.properties, FIRST.properties, `${via}: an older peer erased properties it never mentioned`);
        assert.equal(now.descriptionSource, FIRST.descriptionSource, `${via}: an older peer erased a source it never mentioned`);
      });
    }

    it('push: a document with no tags key lands (the key is optional on the wire)', async () => {
      await DOORS.push([removed(S)]);
      const now = await held();
      assert.equal(now?.seq, SEQ_NEW, `a file with no tags is refused by the push door (stored: ${JSON.stringify(now)})`);
    });
  });

  describe('a RELAY: A -> B -> C', () => {
    it('B serves what it holds with the list its version knows, and C loses the key too', async () => {
      // B holds the file as A last published it, with the removal already applied (as B's own copy of A's row).
      await plant(S, { ...removed(S, KEEPS_TAGS), author: { ...PEER_AUTHOR }, ...LOCAL });
      await plant(C, oldCopy(C));
      const page = await door.pull('/filemeta', { spaceId: S });
      const served = page.items.find(d => d._id === FILE);
      assert.ok(served, `B did not serve its copy of the file: ${JSON.stringify(page)}`);
      await DOORS.push([served], C);
      const now = await rowIn(C);
      assert.equal(now?.seq, SEQ_NEW, `C did not take B's copy (stored: ${JSON.stringify(now)}; served: ${JSON.stringify(served)})`);
      assert.deepEqual(['description', 'descriptionSource', 'properties'].filter(k => k in now), [],
        `B relayed a file with keys missing and no word that they were removed, so C kept them (served: ${JSON.stringify(served)})`);
    });

    it('the whole chain: A removes, B pulls it, C takes what B then serves', async () => {
      await plant(S, oldCopy(S));
      await plant(C, oldCopy(C));
      await door.seedPeerRecords(S, 'filemeta', [removed(S, KEEPS_TAGS)]);
      door.state.family = door.serveFamily;
      await door.sync();
      assert.equal((await held())?.seq, SEQ_NEW, 'A\'s removal never reached B');
      const page = await door.pull('/filemeta', { spaceId: S });
      await DOORS.push([page.items.find(d => d._id === FILE)], C);
      const now = await rowIn(C);
      assert.equal(now?.seq, SEQ_NEW, 'B\'s copy never reached C');
      assert.deepEqual(['description', 'descriptionSource', 'properties'].filter(k => k in now), [],
        'A\'s removal stopped at B: C still holds what A removed');
    });
  });

  describe('a RESTORE', () => {
    it('applies the removal an export is (a backup row without the key), keeps what this instance derived and the flag a soft delete left', async () => {
      await plant(S, oldCopy(S, { suppressEmbeddings: true, deletedAt: T_OLD }));
      const out = await importMod.importDocuments(S, { files: [removed(S, KEEPS_TAGS)] });
      assert.equal(out.results.files.errors, 0, `the restore refused the row: ${JSON.stringify(out.results.files)}`);
      const now = await held();
      assert.equal(now?.seq, SEQ_NEW, `the backup row did not replace the stored one (stored: ${JSON.stringify(now)})`);
      assert.deepEqual(['description', 'descriptionSource', 'properties', 'suppressEmbeddings'].filter(k => k in now), [],
        `the restore only sets: keys the backup lacks survive from the copy it replaced (stored: ${JSON.stringify(now)})`);
      assert.equal(now.deletedAt, T_OLD, 'the restore dropped the flag a soft delete left on the row it replaced');
      assert.equal(now.sha256, LOCAL.sha256, 'the restore dropped the hash of the bytes this instance holds');
    });

    it('PIN — a backup row with NO tags key is restored (not refused for lacking one)', async () => {
      const out = await importMod.importDocuments(S, { files: [removed(S)] });
      assert.equal(out.results.files.errors, 0, `the restore refused it: ${JSON.stringify(out.results.files)}`);
      assert.equal((await held())?.seq, SEQ_NEW);
    });
  });

  describe('an OLDER peer is sent the wire it understands', () => {
    for (const version of OLD_VERSIONS) {
      it(`a peer reporting ${version ?? 'no version'}: the pushed document passes the frozen v5.6.9 schema, tags and all`, async () => {
        const wire = await publish(removed(S), { version });
        assert.equal(wire.length, 1, `the file was offered ${wire.length} time(s)`);
        const verdict = IncomingFileMetaDocV569.safeParse(wire[0]);
        assert.equal(verdict.success, true,
          `a v5.6.9 receiver refuses this document (${JSON.stringify(verdict.error?.issues ?? [])}): it would drop the file's edit, `
          + `and the push counts it refused once and never offers it again (wire: ${JSON.stringify(wire[0])})`);
        assert.equal('authoredKeys' in wire[0], false, 'a key the peer\'s schema does not declare was sent to it');
        assert.deepEqual(wire[0].tags, [], 'a file with no tags goes to an older peer as an empty list, the only shape it accepts');
      });

      it(`a peer reporting ${version ?? 'no version'}: a file that keeps its tags is sent them untouched, and nothing it did not know`, async () => {
        const wire = await publish(removed(S, { tags: ['spec'], description: 'kept' }), { version });
        const verdict = IncomingFileMetaDocV569.safeParse(wire[0]);
        assert.equal(verdict.success, true, `refused by v5.6.9: ${JSON.stringify(verdict.error?.issues ?? [])}`);
        assert.deepEqual(wire[0].tags, ['spec']);
        assert.equal(wire[0].description, 'kept');
      });
    }

    it('a peer on a newer version is sent the new wire, which the frozen schema REFUSES — the gate is what separates them', async () => {
      const wire = await publish(removed(S, KEEPS_TAGS), { version: NEWER });
      assert.ok(wire[0], 'nothing was pushed');
      assert.equal(IncomingFileMetaDocV569.safeParse(wire[0]).success, false,
        'the wire a newer peer gets is acceptable to v5.6.9: either it carries no removal at all, or the gate that keeps new keys from old peers is not what is deciding');
    });

    it('a peer that claims a newer version and refuses the new wire is offered the file again on the old one', async () => {
      const heldByPeer = new Map();
      // A strict v5.6.9 server behind a newer self-report: it answers 200 and discards every document its schema refuses.
      door.state.batchUpsert = (key, items) => {
        if (key !== 'filemeta') return undefined;
        const refused = items.filter(d => !IncomingFileMetaDocV569.safeParse(d).success);
        for (const d of items) if (IncomingFileMetaDocV569.safeParse(d).success) heldByPeer.set(d._id, d);
        return { body: { filemeta: { rejected: refused.length } } };
      };
      // The tags were removed, so the new wire omits them and the strict peer refuses the document for lacking them.
      await publish(removed(S), { version: NEWER });
      await door.sync();
      await door.sync();
      const landed = [...heldByPeer.values()].find(d => d._id === FILE && d.spaceId === S);
      assert.ok(landed, 'the peer never held the file: its refusal was counted and the edit was never offered in a shape it accepts, so a rollback of the peer loses it');
      assert.equal(landed.updatedAt, T_NEW, 'the peer holds an older version of the file than the one published');
      assert.deepEqual(landed.tags, [], 'a file with no tags goes to a peer that refuses the new wire as an empty list');
    });
  });
});
