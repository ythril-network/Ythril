/**
 * Every record this instance stores from a peer carries WHO DELIVERED THAT VERSION — `deliveredBy`, a record-tier
 * local field the one arrival writer stamps (bundle-51, D-14 = C).
 *
 * ## Why a stored fact, and not a live rule
 *
 * "May the upstream delete this record" cannot be answered from the record's `author`: the author is the sender's
 * text, and a record a third party wrote reaches a subscriber through its publisher, through a lateral peer or through
 * an admin's push alike. What separates them is who DELIVERED the version held here, and that is known once, at the
 * write, by the one writer (`writeArrivals`) — so it is stored there, and the deletion authority reads the stored fact
 * (`a-tombstone-from-the-upstream-deletes-what-it-relayed-db`).
 *
 * ## The rules, per replicated family (derived from `FAMILIES`, cross-checked against `REPLICATED_FAMILIES`; floor 6)
 *
 *  1. **Every door that writes an arrival stamps it**: a push by batch, a push of one document (where the family has
 *     the route), and a pull — `deliveredBy` is the delivering peer's instance id.
 *  2. **No peer, no peer id**: an admin or local-token push stores the empty string, written out, so "an admin wrote
 *     it" is distinguishable from "nobody ever stamped it" (the back-fill's one case).
 *  3. **A later delivery replaces it** — the stamp is part of the version, so a newer copy from another peer is that
 *     peer's; an OLDER copy that is skipped changes nothing, the stamp included.
 *  4. **It is classified on purpose**: a record-tier local field (in `LOCAL_ONLY_FIELDS` and `RESTORED_LOCAL_FIELDS`, so
 *     unhashed, dropped from every arrival and kept by a restore of this instance's own backup), NOT in the derived half
 *     (`UNSET_DERIVED` would erase it with every embed), never served to a peer, and withheld from reads like the other
 *     system fields — it names a peer.
 *  5. **A local write keeps it** (an edit of a relayed record stays the publisher's to delete) **unless it makes a NEW
 *     record id out of another** (an edge re-key): that record was written here, so it is stamped `''`.
 *
 * The restore half is in `a-restore-keeps-the-backups-stamps-db`, the replace-keeps-local-fields half in
 * `a-push-keeps-the-receivers-own-fields-db`; both name this field.
 *
 * ## Seen red
 *
 * On the base (abc4cc57) no arrival stores anything, so every stamp row fails on `undefined`; the classification rows
 * fail on the set membership; the served and read rows fail where the stored field leaks.
 *
 * Run: node --test testing/standalone/an-arrival-stores-who-delivered-it-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, FAMILIES, familiesCarriedByBatch, peerToken, ADMIN_TOKEN } from './_push-door.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';
import { openByteDoor } from './_byte-door.mjs';
import { UPLOAD_DOORS } from './_byte-door-uploads.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'tsdeliv';
const DELIVERER = 'an-instance-that-pushes';
const OTHER = 'another-instance-that-pushes';
const KIND = { facts: 'fact', entities: 'entity', edges: 'edge', chrono: 'chrono', links: 'link', filemeta: 'filemeta' };
const THIRD = { instanceId: 'third-party-author', instanceLabel: 'Third' };

let door, LOCAL, bytes;

const idFor = (key, tag) => (key === 'filemeta' ? `docs/${tag}.md` : `${key}-${tag}`);
const make = (key, id, seq, extra = {}) => build[KIND[key]](S, id, seq, { author: THIRD, ...extra });
const families = () => Object.entries(FAMILIES).map(([key, f]) => ({ key, ...f }));
const stamp = async (fam, id) => (await door.coll(S, fam.coll).findOne({ _id: id }))?.deliveredBy;
/**
 * bundle-89 (Q-280): an ARRIVAL stores the version and the author the SENDER wrote, never this instance's own — a receiver seq
 * outranks the publisher's next edit, and a receiver author makes the file this instance's to delete. Asked of every arrival
 * door below, beside the stamp it already asks for. The doors it covers are ARRIVAL doors only (see section 6).
 */
const sentVersionOnly = async (fam, id, seq, who = THIRD) => {
  const d = await door.coll(S, fam.coll).findOne({ _id: id });
  assert.ok(d, `${fam.key}: ${id} did not land`);
  assert.equal(d.seq, seq, `${fam.key}: an arrival stored seq ${d.seq}, not the sender's ${seq}`);
  assert.equal(d.author?.instanceId, who.instanceId, `${fam.key}: an arrival stored author ${d.author?.instanceId}, not the sender's ${who.instanceId}`);
};

describe('an arrival stores who delivered it', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'tsdeliv', spaces: [S] });
    bytes = await openByteDoor();
    LOCAL = await import('../../server/dist/sync/local-only-fields.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  it('the families are derived, so an empty set cannot pass', () => {
    assert.ok(families().length >= 6, `only ${families().length} families`);
    assert.deepEqual(families().map(f => f.key).sort(), [...familiesCarriedByBatch()].sort(),
      'the fixture table and the families batch-upsert carries have drifted');
  });

  describe('4. it is classified on purpose', () => {
    it('a record-tier local field: local-only, restored, and not derived', () => {
      assert.ok(LOCAL.LOCAL_ONLY_FIELDS.has('deliveredBy'), 'deliveredBy is not in LOCAL_ONLY_FIELDS: it would be hashed, replicated and taken from a peer');
      assert.ok(LOCAL.RESTORED_LOCAL_FIELDS.has('deliveredBy'), 'deliveredBy is not in RESTORED_LOCAL_FIELDS: a restore of this instance\'s own backup would drop who delivered every record');
      assert.ok(!LOCAL.DERIVED_LOCAL_FIELDS.has('deliveredBy'), 'deliveredBy is in the derived half: every re-embed would erase it');
      assert.ok(!('deliveredBy' in LOCAL.UNSET_DERIVED) && !('deliveredBy' in LOCAL.UNSET_VECTOR), 'an embed\'s $unset reaches deliveredBy');
      assert.equal(LOCAL.LOCAL_ONLY_EXCLUSION.deliveredBy, 0, 'a sender\'s read projection would put deliveredBy on the wire');
      assert.equal('deliveredBy' in LOCAL.stripLocalOnly({ _id: 'x', deliveredBy: 'a-peer' }), false, 'an arriving deliveredBy is not dropped');
    });

    for (const fam of families()) {
      it(`${fam.key}: no peer is ever served it`, async () => {
        const id = idFor(fam.key, 'served');
        await door.coll(S, fam.coll).insertOne({ ...make(fam.key, id, 3), deliveredBy: 'a-stamp-no-peer-may-see' });
        await door.bumpSeq(S, 10);
        const body = await door.pull(`/${fam.key}`, { spaceId: S, sinceSeq: '0' });
        const served = body.items.filter(d => d._id === id);
        assert.equal(served.length, 1, `${fam.key}: the page did not serve the record, so the check proves nothing: ${JSON.stringify(body).slice(0, 200)}`);
        assert.equal('deliveredBy' in served[0], false, `${fam.key}: the push-side read serves deliveredBy to the peer — it names this instance's own peers`);
      });
    }

    it('entities and edges are read without it (it names a peer: withheld with the other system fields)', async () => {
      const { getEntityById, listEntities } = await import('../../server/dist/brain/entities.js');
      const { getEdgeById } = await import('../../server/dist/brain/edges.js');
      await door.coll(S, 'entities').insertOne({ ...make('entities', 'ent-read', 3), deliveredBy: DELIVERER });
      await door.coll(S, 'edges').insertOne({ ...make('edges', 'edge-read', 3), deliveredBy: DELIVERER });
      const one = await getEntityById(S, 'ent-read');
      const edge = await getEdgeById(S, 'edge-read');
      const listed = (await listEntities(S, {})).find(e => e._id === 'ent-read');
      assert.ok(one && edge && listed, 'fixture: the records are not readable');
      assert.equal('deliveredBy' in one, false, 'getEntityById returns deliveredBy');
      assert.equal('deliveredBy' in edge, false, 'getEdgeById returns deliveredBy');
      assert.equal('deliveredBy' in listed, false, 'listEntities returns deliveredBy');
    });
  });

  describe('1. every door that writes an arrival stamps it', () => {
    for (const fam of families()) {
      it(`push batch ${fam.key}: the delivering peer`, async () => {
        const id = idFor(fam.key, 'batch');
        const r = await door.push('/batch-upsert', { [fam.key]: [make(fam.key, id, 5)] }, { spaceId: S, token: peerToken(DELIVERER) });
        assert.equal(r.code, 200, JSON.stringify(r.body));
        assert.equal(await stamp(fam, id), DELIVERER, `${fam.key}: a batch push did not store who pushed it`);
        await sentVersionOnly(fam, id, 5);
      });

      if (fam.single) {
        it(`push single ${fam.key}: the delivering peer`, async () => {
          const id = idFor(fam.key, 'single');
          const r = await door.push(fam.single, make(fam.key, id, 5), { spaceId: S, token: peerToken(DELIVERER) });
          assert.equal(r.code, 200, JSON.stringify(r.body));
          assert.equal(await stamp(fam, id), DELIVERER, `${fam.key}: a single push did not store who pushed it`);
          await sentVersionOnly(fam, id, 5);
        });
      }

      it(`pull ${fam.key}: the member the cycle pulled from`, async () => {
        const id = idFor(fam.key, 'pulled');
        door.state.records[S] = { [fam.key]: [make(fam.key, id, 5)] };
        await door.sync();
        assert.equal(await stamp(fam, id), PEER, `${fam.key}: a pulled record did not store the member it came from`);
        await sentVersionOnly(fam, id, 5);
      });
    }
  });

  describe('2. no peer, no peer id: an admin push stores the empty string, written out', () => {
    for (const fam of families()) {
      it(`push batch ${fam.key}`, async () => {
        const id = idFor(fam.key, 'admin-batch');
        const r = await door.push('/batch-upsert', { [fam.key]: [make(fam.key, id, 5)] }, { spaceId: S, token: ADMIN_TOKEN });
        assert.equal(r.code, 200, JSON.stringify(r.body));
        const doc = await door.coll(S, fam.coll).findOne({ _id: id });
        assert.ok(doc, 'fixture: the admin push did not land');
        assert.ok('deliveredBy' in doc && doc.deliveredBy === '', `${fam.key}: an admin push stored ${JSON.stringify(doc.deliveredBy)}, want the empty string`);
      });

      if (fam.single) {
        it(`push single ${fam.key}`, async () => {
          const id = idFor(fam.key, 'admin-single');
          const r = await door.push(fam.single, make(fam.key, id, 5), { spaceId: S, token: ADMIN_TOKEN });
          assert.equal(r.code, 200, JSON.stringify(r.body));
          assert.equal(await stamp(fam, id), '', `${fam.key}: an admin single push stored ${JSON.stringify(await stamp(fam, id))}`);
        });
      }
    }
  });

  describe('3. a later delivery replaces it; a skipped older one changes nothing', () => {
    for (const fam of families()) {
      it(`${fam.key}: a newer copy from another peer is that peer's, by push and by pull`, async () => {
        const id = idFor(fam.key, 'newer');
        await door.coll(S, fam.coll).insertOne({ ...make(fam.key, id, 5), deliveredBy: 'the-first-deliverer' });
        const r = await door.push('/batch-upsert', { [fam.key]: [make(fam.key, id, 6)] }, { spaceId: S, token: peerToken(OTHER) });
        assert.equal(r.code, 200, JSON.stringify(r.body));
        assert.equal(await stamp(fam, id), OTHER, `${fam.key}: a newer copy delivered by '${OTHER}' kept the first deliverer's stamp`);

        door.state.records[S] = { [fam.key]: [make(fam.key, id, 7)] };
        await door.sync();
        assert.equal(await stamp(fam, id), PEER, `${fam.key}: a newer copy PULLED from '${PEER}' kept the earlier deliverer's stamp`);
      });

      it(`${fam.key}: an older copy is skipped and the stored stamp stays`, async () => {
        const id = idFor(fam.key, 'older');
        await door.coll(S, fam.coll).insertOne({ ...make(fam.key, id, 9), deliveredBy: 'the-first-deliverer' });
        await door.push('/batch-upsert', { [fam.key]: [make(fam.key, id, 4)] }, { spaceId: S, token: peerToken(OTHER) });
        assert.equal(await stamp(fam, id), 'the-first-deliverer', `${fam.key}: a copy that was skipped rewrote who delivered the stored version`);
      });
    }
  });

  describe('5. a local write keeps it, except where it makes a new record id', () => {
    it('an edit of a relayed entity keeps the publisher\'s stamp', async () => {
      const { updateEntityById } = await import('../../server/dist/brain/entities.js');
      await door.coll(S, 'entities').insertOne({ ...make('entities', 'ent-local-edit', 3), deliveredBy: PEER });
      const out = await updateEntityById(S, 'ent-local-edit', { description: 'edited here' });
      assert.ok(out, 'fixture: the local edit did not run');
      assert.equal(await stamp(FAMILIES.entities, 'ent-local-edit'), PEER,
        'a local edit of a relayed record dropped who delivered it: the publisher could no longer retire it');
    });

    it('an edge re-key (a new id from another) is stamped with the empty string: it was written here', async () => {
      const { updateEdgeById } = await import('../../server/dist/brain/edges.js');
      const { instanceId } = door.config();
      const old = { ...make('edges', 'edge-rekey', 3, { from: 'ent-a', to: 'ent-b', label: 'knows', author: { instanceId, instanceLabel: 'me' } }), deliveredBy: PEER };
      const { edgeIdFor } = await import('../../server/dist/brain/edge-id.js');
      old._id = edgeIdFor(old.from, old.to, old.label, undefined, undefined);
      await door.coll(S, 'edges').insertOne(old);
      const out = await updateEdgeById(S, old._id, { label: 'knew' });
      assert.ok(out && out._id !== old._id, `fixture: the label change did not re-key the edge (${out?._id})`);
      assert.equal(await stamp(FAMILIES.edges, out._id), '', 'a re-keyed edge carried the old row\'s stamp: it is a new record written here');
    });
  });

  /*
   * 6. bundle-89 (Q-280): NO ARRIVAL DOOR stamps this instance's seq or author onto a file row.
   *
   * THIS COVERS ARRIVAL DOORS ONLY, and says so on purpose. The doors: push batch and pull (sections 1 and 3 above, every family;
   * a file's metadata has no single route), the byte doors (a peer's upload, one request or chunked — `UPLOAD_DOORS`, which
   * rev 2 of the plan omitted although they are the doors that CREATE a row from bytes), and the admin import. Three writers
   * outside it DO stamp, and a pin that read "no door stamps" would be believed about them too:
   *   - `renameFileMeta` / `renameFileMetaByPrefix` (`files/file-meta.ts`): a move keeps the old seq and author under a new
   *     `updatedAt` — held by `a-move-of-a-peers-file-keeps-its-updatedat-db`, and fixed by E3's forward half;
   *   - `upsertFileMeta`'s existing-row branch (`files/file-meta.ts`): a LOCAL re-upload of a peer-authored row stamps a local seq
   *     — not pinned here, because pinning it would pin the behaviour Q-280 reports;
   *   - `stampFileMetaSeqs` (`brain/links-conversion.ts`): operator-invoked, stamps this instance's seq on any seq-less row.
   * The person doors of `UPLOAD_DOORS` are run as the CONTROL: a person's upload to a new path IS authored here, so a pin that
   * passed them too would be asserting nothing about arrivals.
   */
  describe('6. an arrival door stamps no receiver seq or author on a file row (arrival doors only)', () => {
    const DELIVERED_BY = 'byte-door-peer';
    const rowOf = (rel) => door.coll(S, 'files').findOne({ _id: rel });

    it('the doors are derived: both arrival and person shapes, single and chunked', () => {
      assert.ok(UPLOAD_DOORS.filter(u => u.arrival).length >= 2 && UPLOAD_DOORS.filter(u => !u.arrival).length >= 2,
        'UPLOAD_DOORS lost an arrival or a person shape');
      assert.ok(UPLOAD_DOORS.some(u => u.chunked) && UPLOAD_DOORS.some(u => !u.chunked), 'UPLOAD_DOORS lost a shape');
    });

    for (const upload of UPLOAD_DOORS) {
      const tag = upload.name.replace(/\W+/g, '-');
      if (upload.arrival) {
        it(`byte door, ${upload.name}: bytes for a path whose row a peer authored leave its seq and author`, async () => {
          const rel = `bytes/${tag}-held.txt`;
          await door.coll(S, 'files').insertOne(make('filemeta', rel, 7, { sizeBytes: 3, sha256: 'a'.repeat(64) }));
          const r = await upload.send(bytes, { space: S, path: rel, content: `bytes of ${upload.name} over a held row`, peer: DELIVERED_BY });
          assert.ok([200, 201, 202].includes(r.code), `fixture: the upload was refused: ${JSON.stringify(r)}`);
          const row = await rowOf(rel);
          assert.equal(row.seq, 7, `${upload.name}: the byte door stamped seq ${row.seq} on a row the peer authored at 7`);
          assert.equal(row.author?.instanceId, THIRD.instanceId, `${upload.name}: the byte door re-authored the row as ${row.author?.instanceId}`);
        });

        it(`byte door, ${upload.name}: bytes for a path with no row make a placeholder at seq 0, authored by the peer that sent them`, async () => {
          const rel = `bytes/${tag}-new.txt`;
          const r = await upload.send(bytes, { space: S, path: rel, content: `bytes of ${upload.name} for a new path`, peer: DELIVERED_BY });
          assert.ok([200, 201, 202].includes(r.code), `fixture: the upload was refused: ${JSON.stringify(r)}`);
          const row = await rowOf(rel);
          assert.ok(row, 'fixture: no row was made for the arriving bytes');
          assert.equal(row.seq, 0, `${upload.name}: a placeholder at seq ${row.seq} would outrank the publisher's first metadata`);
          assert.equal(row.author?.instanceId, DELIVERED_BY, `${upload.name}: the placeholder is authored by ${row.author?.instanceId}, not the peer that sent the bytes`);
          assert.notEqual(row.author?.instanceId, door.instanceId, `${upload.name}: this instance authored a file a peer sent`);
        });
      } else {
        it(`control — byte door, ${upload.name}: a person's upload to a new path IS authored here (the pin is about arrivals)`, async () => {
          const rel = `bytes/${tag}-person.txt`;
          const r = await upload.send(bytes, { space: S, path: rel, content: `bytes of ${upload.name}` });
          assert.ok([200, 201, 202].includes(r.code), `fixture: the upload was refused: ${JSON.stringify(r)}`);
          const row = await rowOf(rel);
          assert.equal(row?.author?.instanceId, door.instanceId, 'a person\'s upload was not authored by this instance, so the arrival cases prove nothing about who stamps');
          assert.ok(row.seq > 0, 'a person\'s upload carries no seq of its own');
        });
      }
    }

    it('admin import: a restored row keeps the export\'s seq and author, over a row this instance held', async () => {
      const { writeArrivals } = await import('../../server/dist/sync/arrivals.js');
      const rel = 'import/held.md';
      await door.coll(S, 'files').insertOne(make('filemeta', rel, 3, { author: { instanceId: door.instanceId, instanceLabel: 'me' } }));
      const out = await writeArrivals(S, 'files', 'file', [make('filemeta', rel, 7)], { restore: true });
      await out.enqueue();
      const row = await rowOf(rel);
      assert.equal(row.seq, 7, `the import stored seq ${row.seq}, not the export's 7`);
      assert.equal(row.author?.instanceId, THIRD.instanceId, `the import stored author ${row.author?.instanceId}, not the export's`);
    });
  });
});
