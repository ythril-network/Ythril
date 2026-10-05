/**
 * An entity cascade that is refused removes NOTHING — not even the edges it was allowed to take
 * (Q-361 item 12, data integrity; `Q-107` part 3b on main).
 *
 * ## The defect
 *
 * `deleteEntityCascade` removes the BLOCKING EDGES and then the entity. A fact, a chrono entry or a file that links
 * to the entity also blocks the delete, and a cascade does not remove those — they are records of their own, not
 * relationships (the owner's ruling, `P-29`). So the cascade refuses when one is present. It refuses AFTER the
 * edges: it deletes every blocking edge, writes their tombstones, and only then reports that the entity cannot be
 * deleted. The caller is told "refused" about an operation that removed every relationship of the entity and
 * spread those removals to every peer.
 *
 * ## The rule
 *
 * The whole removal set is computed first, and a non-edge blocker refuses BEFORE anything is deleted: the edges,
 * the entity, the tombstones and the blocker are all exactly as they were. The blocker kinds are DERIVED from the
 * link classes that can point at an entity (`LINK_CLASSES`), so a fourth kind of record that can name an entity is
 * asked here the day it exists.
 *
 * The refusal answers with the preview it decided on — the SAME set the caller was shown, with every edge still in it,
 * not a fresh preview of a space the cascade has already changed.
 *
 * Seen red on 6eb5a333 (5.6.3): every blocking edge is deleted (and tombstoned) before the refusal.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-refused-cascade-removes-nothing-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { snapshotParts, changedParts, wipeParts, RECORD_PARTS } from './_space-snapshot.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-cascade-refused-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

const S = 'cascaderefused';
const AUTHOR = { instanceId: 'cascade-refused-test', instanceLabel: 'test' };
const T0 = '2026-09-01T00:00:00.000Z';

// Read at load, not in `before`: the cases below are one per kind, and a test runner declares cases synchronously.
const { LINK_CLASSES } = await import('../../server/dist/brain/link-adjacency.js');
/** The kinds of record that can name an entity, with the collection each lives in. */
const BLOCKER_CLASSES = LINK_CLASSES.filter(c => c.toKind === 'entity');

let mongo, cascade, linkIdFor, enqueueEmbedJob;
let seq = 0;
const coll = (n) => mongo.col(`${S}_${n}`);

/** A record of each kind that can name an entity — the smallest body each collection holds. */
const RECORD = {
  fact: (id) => ({ _id: id, spaceId: S, fact: 'a fact naming the hub', tags: [], author: AUTHOR, createdAt: T0, updatedAt: T0, seq: ++seq }),
  chrono: (id) => ({ _id: id, spaceId: S, title: 'an event naming the hub', type: 'event', startsAt: T0, status: 'upcoming',
    tags: [], author: AUTHOR, createdAt: T0, updatedAt: T0, seq: ++seq }),
  file: (id) => ({ _id: id, spaceId: S, path: id, tags: [], author: AUTHOR, createdAt: T0, updatedAt: T0, seq: ++seq }),
};

/** Every record part, the embed jobs a cascade cancels included, whole and in a stable order (`_space-snapshot.mjs`). */
const snapshot = () => snapshotParts(mongo, S, RECORD_PARTS);

describe('a refused cascade removes nothing', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('cascaderefused');
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'cascade-refused-test', instanceLabel: 'test', tokens: [], networks: [],
      // `strictLinkage` on: the guard refuses only under it, so only there does a cascade have anything to do.
      spaces: [{ id: S, label: 'Cascade', folders: [], completeLinkage: true, meta: { strictLinkage: true } }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    cascade = await import('../../server/dist/brain/entity-delete-cascade.js');
    ({ linkIdFor } = await import('../../server/dist/brain/links.js'));
    ({ enqueueEmbedJob } = await import('../../server/dist/brain/embed-queue.js'));
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  beforeEach(async () => { await wipeParts(mongo, S, RECORD_PARTS); });

  it('the blocker kinds are derived, and there is a record builder for each', () => {
    const kinds = BLOCKER_CLASSES.map(c => c.kind);
    assert.ok(kinds.length >= 3, `only ${kinds.length} link class(es) point at an entity — the derivation is broken: ${kinds}`);
    for (const k of kinds) assert.ok(RECORD[k], `no record builder for '${k}', so its refusal is never asked`);
  });

  it('a hub whose only blockers are edges is removed (the control)', async () => {
    const hub = randomUUID();
    await coll('entities').insertOne({ _id: hub, spaceId: S, name: 'Hub', type: 'thing', tags: [], author: AUTHOR, seq: ++seq });
    await coll('edges').insertOne({ _id: randomUUID(), spaceId: S, from: hub, to: randomUUID(), label: 'knows', tags: [], author: AUTHOR, seq: ++seq });
    const p = await cascade.previewEntityCascade(S, hub);
    const r = await cascade.deleteEntityCascade(S, hub, p.token);
    assert.equal(r.ok, true, `the control cascade was refused: ${JSON.stringify(r)}`);
  });

  for (const cls of BLOCKER_CLASSES) {
    const kind = cls.kind;
    it(`a cascade refused by a ${kind} that names the entity deletes nothing — edges included`, async () => {
      assert.ok(RECORD[kind], `no record builder for '${kind}'`);
      const hub = randomUUID();
      const other = randomUUID();
      await coll('entities').insertMany([
        { _id: hub, spaceId: S, name: 'Hub', type: 'thing', tags: [], author: AUTHOR, seq: ++seq },
        { _id: other, spaceId: S, name: 'Other', type: 'thing', tags: [], author: AUTHOR, seq: ++seq },
      ]);
      const edges = [
        { _id: randomUUID(), spaceId: S, from: hub, to: other, label: 'knows', tags: [], author: AUTHOR, seq: ++seq },
        { _id: randomUUID(), spaceId: S, from: other, to: hub, label: 'knows_back', tags: [], author: AUTHOR, seq: ++seq },
      ];
      await coll('edges').insertMany(edges);
      // The hub's embed job: a cascade that goes through retires it with the entity, so a refusal that retired it first
      // would leave the entity standing with nothing queued to embed it — `embed_jobs` is a part of the snapshot for this.
      await enqueueEmbedJob(S, 'entity', hub);
      const recordId = kind === 'file' ? `docs/${randomUUID()}.md` : randomUUID();
      await coll(cls.collection).insertOne(RECORD[kind](recordId));
      await coll('links').insertOne({ _id: linkIdFor(recordId, kind, hub, 'entity'), spaceId: S, from: recordId,
        fromKind: kind, to: hub, toKind: 'entity', author: AUTHOR, createdAt: T0, updatedAt: T0, seq: ++seq });

      const p = await cascade.previewEntityCascade(S, hub);
      assert.ok(p.removes.some(b => b.type === kind && b._id === recordId),
        `the preview does not list the ${kind} as blocking (${JSON.stringify(p.removes)}), so this case asks nothing`);
      assert.ok(edges.every(e => p.removes.some(b => b.type === 'edge' && b._id === e._id)), 'the preview does not list both edges');

      const before_ = await snapshot();
      assert.ok((before_.embed_jobs ?? []).length >= 1, 'the hub has no embed job, so the snapshot of embed_jobs asks nothing');
      const r = await cascade.deleteEntityCascade(S, hub, p.token);
      const after_ = await snapshot();

      assert.equal(r.ok, false, `a cascade with a ${kind} blocking it went through: ${JSON.stringify(r)}`);
      const goneEdges = edges.filter(e => !after_.edges.some(d => d._id === e._id)).map(e => e._id);
      assert.deepEqual(goneEdges, [],
        `the cascade was REFUSED by a ${kind}, and it had already deleted ${goneEdges.length} edge(s) — a refused cascade `
        + 'must remove nothing');
      const changed = changedParts(before_, after_);
      assert.deepEqual(changed, [], `a refused cascade changed ${changed.join(', ')}`);
      assert.deepEqual(r.preview, p, 'the refusal does not carry the preview it decided on (a re-read of a space the refusal had already changed?)');
    });
  }
});
