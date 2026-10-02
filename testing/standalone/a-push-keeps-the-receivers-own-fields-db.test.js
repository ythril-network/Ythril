/**
 * A pushed document is stored on THIS instance's terms: under this instance's space id, keeping what only this
 * instance knows about the record, and stamped with this instance's retention (`Q-107` part 1 §1, owner
 * decision `D-9`, 2026-10-01).
 *
 * ## 1. The receiver's local-only fields survive a peer's replace
 *
 * `LOCAL_ONLY_FIELDS` (`sync/local-only-fields.ts`) names what never crosses the wire: the vector, its model and
 * `matchedText` (derived by THIS instance's model), the two retention stamps (computed from THIS instance's
 * policy) and `syncBase` (what this instance agreed with whom). A push is a whole-document `replaceOne` of a
 * stripped document, so a peer's edit ERASED all of them: the record stopped expiring here, dropped out of vector
 * search until re-embedded, and was re-embedded even when its text had not changed. The set is read out of the
 * module, so a seventh local-only field is checked without editing this file.
 *
 * And the point of carrying the embed fields: with the vector, the model and `matchedText` carried, the embed
 * worker's fingerprint sees unchanged text and does not call the model (`embedStoredRecord` answers `unchanged`).
 *
 * ## 2. The receiver's space id
 *
 * A peer names a space by the NETWORK's id; under a `spaceMap` alias this instance carries it under another.
 * The alias middleware translates the query, and the pull path retags documents — but push stored each document
 * with the SENDER's `spaceId`, which every `spaceId`-filtered read on this instance then cannot see. A document
 * whose `_id` is not a string is refused on its own (counted `rejected`), never answered as a page 500.
 *
 * ## 3. Retention on 5.6.x: a stamp this instance holds is carried; an unstamped arrival stays unstamped
 *
 * A receiver stamp already on the stored copy is carried across a peer's update, never erased or recomputed
 * (the `F4` fix). Main's `D-9` — stamping an arrival with no receiver stamp from its own `createdAt` — is NOT in
 * 5.6.x (cut `C4` of the 5.6.2 plan): an arrival this instance holds no stamp for is stored with none, exactly as
 * 5.6.1 stored it. That cut is PINNED here, so a port of main's writer that brings `D-9` along fails this file.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-push-keeps-the-receivers-own-fields-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build, FAMILIES } from './_push-door.mjs';

const skip = await mongoSkipReason();

const S = 'pushlocal';
const ALIAS_LOCAL = 'pushalias';
const ALIAS_REMOTE = 'their-space';
const NET = 'net-alias';
const TTL = 'pushttl';
const DAY = 86_400_000;
const SPACE_DAYS = 30;
const TYPE_DAYS = 7;
const TYPE_KEY = { fact: 'type', entity: 'type', edge: 'label', chrono: 'type' };
const KIND = { facts: 'fact', entities: 'entity', edges: 'edge', chrono: 'chrono', links: 'link', filemeta: 'filemeta' };

/** One value per local-only field the store may hold — a fixture; the field SET is the module's. */
const LOCAL_VALUES = {
  embedding: [0.25, 0.5, 0.75],
  embeddingModel: 'receiver-model',
  matchedText: 'what this instance embedded',
  _expireAt: new Date('2099-01-01T00:00:00.000Z'),
  _contentExpireAt: new Date('2098-01-01T00:00:00.000Z'),
  syncBase: { 'some-peer': 'sha-agreed' },
};

/** The families a push REPLACES (file metadata merges with `$set` and keeps its own fields by construction). */
const REPLACED = Object.entries(FAMILIES).filter(([k]) => k !== 'filemeta').map(([key, f]) => ({ key, ...f }));

let door, LOCAL_ONLY;

describe('a push keeps the receiver\'s own fields, space id and retention', { skip }, () => {
  before(async () => {
    const retention = { retention: { days: TYPE_DAYS } };
    door = await openPushDoor({
      suite: 'pushlocal',
      spaces: [
        { id: S, label: 'Local', folders: [], meta: {} },
        { id: ALIAS_LOCAL, label: 'Aliased', folders: [], meta: {} },
        { id: TTL, label: 'Retained', folders: [], recordTtlDays: SPACE_DAYS, meta: { typeSchemas: {
          fact: { short: retention }, entity: { short: retention }, edge: { short: retention },
          chrono: { short: retention, event: {} },
        } } },
      ],
      networks: [{ id: NET, label: 'Aliased network', type: 'closed', spaces: [ALIAS_LOCAL],
        spaceMap: { [ALIAS_REMOTE]: ALIAS_LOCAL }, members: [], votingDeadlineHours: 24 }],
    });
    ({ LOCAL_ONLY_FIELDS: LOCAL_ONLY } = await import('../../server/dist/sync/local-only-fields.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { for (const s of [S, ALIAS_LOCAL, TTL]) await door.wipe(s); });

  describe('1. the receiver\'s local-only fields survive a peer\'s replace', () => {
    it('the field set is read from the module and every field has a fixture value', () => {
      assert.ok(LOCAL_ONLY.size >= 6, `LOCAL_ONLY_FIELDS: ${[...LOCAL_ONLY]}`);
      assert.deepEqual([...LOCAL_ONLY].filter(f => !(f in LOCAL_VALUES)), [], 'a local-only field with no fixture goes unchecked');
    });

    for (const fam of REPLACED) {
      for (const via of ['single', 'batch']) {
        if (via === 'single' && !fam.single) continue;
        it(`${via} ${fam.key}: a newer copy from a peer keeps every local-only field the stored copy had`, async () => {
          const id = `${fam.key}-kept`;
          const local = Object.fromEntries([...LOCAL_ONLY].map(f => [f, LOCAL_VALUES[f]]));
          await door.coll(S, fam.coll).insertOne({ ...build[KIND[fam.key]](S, id, 5), ...local });
          const incoming = build[KIND[fam.key]](S, id, 6);
          const r = via === 'single'
            ? await door.push(fam.single, incoming, { spaceId: S })
            : await door.push('/batch-upsert', { [fam.key]: [incoming] }, { spaceId: S });
          assert.equal(r.code, 200, JSON.stringify(r.body));
          const after = await door.coll(S, fam.coll).findOne({ _id: id });
          assert.equal(after.seq, 6, 'the newer copy did not land');
          const lost = [...LOCAL_ONLY].filter(f => JSON.stringify(after[f]) !== JSON.stringify(local[f]));
          assert.deepEqual(lost, [],
            `${via} ${fam.key}: a peer's edit erased the receiver's own ${lost.join(', ')}. The retention stamps stop `
            + 'the record expiring here; the vector drops it out of search until it is re-embedded');
        });
      }
    }

    it('unchanged text is not re-embedded: the fingerprint survives the replace', async () => {
      const { buildEmbedText, embedStoredRecord } = await import('../../server/dist/brain/embed-record.js');
      const { getEmbeddingConfig } = await import('../../server/dist/config/loader.js');
      const stored = build.fact(S, 'f-fp', 5, { fact: 'the text both copies share' });
      await door.coll(S, 'facts').insertOne({ ...stored, embedding: [0.1, 0.2, 0.3], embeddingModel: getEmbeddingConfig().model,
        matchedText: await buildEmbedText(S, 'fact', stored) });
      // A newer copy whose EMBEDDED text is the same: only `updatedAt` moves. (Tags are part of a fact's embed text
      // — `factEmbedText` — so a retag is new text and is rightly re-embedded; it cannot stand for "unchanged".)
      await door.push('/facts', build.fact(S, 'f-fp', 6, { fact: 'the text both copies share', updatedAt: '2026-09-02T00:00:00.000Z' }),
        { spaceId: S });
      const after = await door.coll(S, 'facts').findOne({ _id: 'f-fp' });
      // Checked before the embed call: a vectorless record would make it call the model, which this test never wants.
      assert.ok(Array.isArray(after.embedding) && after.embedding.length > 0,
        'the replace dropped the vector, so the embed worker must call the model again for text that did not change');
      assert.equal(await embedStoredRecord(S, 'fact', 'f-fp'), 'unchanged');
    });
  });

  describe('2. the receiver\'s space id', () => {
    for (const [key, fam] of Object.entries(FAMILIES)) {
      for (const via of ['single', 'batch']) {
        if (via === 'single' && !fam.single) continue;
        it(`${via} ${key}: a document pushed under a spaceMap alias is stored under the LOCAL space id`, async () => {
          const doc = build[KIND[key]](ALIAS_REMOTE, `${key}-aliased`, 9);
          const r = via === 'single'
            ? await door.push(fam.single, doc, { spaceId: ALIAS_REMOTE, networkId: NET })
            : await door.push('/batch-upsert', { [key]: [doc] }, { spaceId: ALIAS_REMOTE, networkId: NET });
          assert.equal(r.code, 200, JSON.stringify(r.body));
          const stored = await door.coll(ALIAS_LOCAL, fam.coll).findOne({ _id: doc._id });
          assert.ok(stored, `${via} ${key}: not stored in the local collection at all`);
          assert.equal(stored.spaceId, ALIAS_LOCAL,
            `${via} ${key}: stored with the sender's space id '${stored.spaceId}', so every spaceId-filtered read on this `
            + 'instance misses it');
        });
      }
    }

    it('a document whose _id is not a string is refused on its own, never a page 500', async () => {
      const bad = { ...build.fact(S, 'x', 3), _id: { $gt: '' } };
      const r = await door.push('/batch-upsert', { facts: [bad, build.fact(S, 'f-fine', 4)] }, { spaceId: S });
      assert.equal(r.code, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.facts.rejected, r.body.facts.inserted], [1, 1], JSON.stringify(r.body.facts));
      const single = await door.push('/facts', bad, { spaceId: S });
      assert.equal(single.code, 400, JSON.stringify(single.body));
      assert.equal(await door.coll(S, 'facts').countDocuments({}), 1);
    });
  });

  describe('3. retention: a held stamp is carried; an unstamped arrival stays unstamped (C4 pinned)', () => {
    const typed = Object.entries(FAMILIES).filter(([, f]) => f.single).map(([key, f]) => ({ key, ...f }));

    for (const fam of typed) {
      for (const via of ['single', 'batch']) {
        const send = (doc) => via === 'single'
          ? door.push(fam.single, doc, { spaceId: TTL })
          : door.push('/batch-upsert', { [fam.key]: [doc] }, { spaceId: TTL });

        it(`${via} ${fam.key}: C4 — a first arrival is stored with no retention stamp, whatever the windows (as 5.6.1)`, async () => {
          const plain = build[fam.type](TTL, `${fam.key}-plain`, 11, { createdAt: '2026-09-01T00:00:00.000Z' });
          const short = build[fam.type](TTL, `${fam.key}-short`, 12,
            { createdAt: '2026-09-01T00:00:00.000Z', [TYPE_KEY[fam.type]]: 'short' });
          const old = build[fam.type](TTL, `${fam.key}-old`, 13, { createdAt: '2025-01-01T00:00:00.000Z' });
          for (const d of [plain, short, old]) assert.equal((await send(d)).code, 200);
          for (const d of [plain, short, old]) {
            const stored = await door.coll(TTL, fam.coll).findOne({ _id: d._id });
            assert.ok(stored, `fixture check: ${via} ${fam.key} ${d._id} was not stored`);
            assert.deepEqual([stored._expireAt, stored._contentExpireAt], [undefined, undefined],
              `${via} ${fam.key}: ${d._id} arrived unstamped and was stamped here. Main's D-9 stamping is cut from 5.6.x `
              + '(C4): a 5.6.2 receiver must store an arrival with no stamp of its own exactly as 5.6.1 did');
          }
        });

        it(`${via} ${fam.key}: a receiver stamp already stored is carried, never recomputed`, async () => {
          const id = `${fam.key}-carried`;
          const sentinel = new Date('2099-06-01T00:00:00.000Z');
          await door.coll(TTL, fam.coll).insertOne({ ...build[fam.type](TTL, id, 5), _expireAt: sentinel });
          assert.equal((await send(build[fam.type](TTL, id, 6))).code, 200);
          assert.equal((await door.coll(TTL, fam.coll).findOne({ _id: id }))?._expireAt?.toISOString?.(), sentinel.toISOString());
        });
      }
    }
  });
});
