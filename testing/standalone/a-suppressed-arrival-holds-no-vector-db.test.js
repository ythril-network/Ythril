/**
 * An arrival THIS instance suppresses holds no vector afterwards — on every door, at every tier (Q-230).
 *
 * ## The rule
 *
 * The writer carries the receiver's local-only fields across a peer's replace (`LOCAL_ONLY_FIELDS`), so a peer's
 * edit does not cost this instance its vector. That is right for a record this instance still embeds and wrong for
 * one it suppresses: the stored vector, its model and its `matchedText` were derived from the PREVIOUS content, and
 * carrying them keeps a record its author (record tier), its type (schema tier) or its space (space tier) retired
 * from meaning-ranked search findable by exactly that mechanism. `matchedText` is the lexical channel's text, so
 * carrying it also keeps REMOVED text searchable (the `Q-94` defect, arriving through sync). A suppressed arrival is
 * not queued for embedding either, so nothing ever cleans it up.
 *
 * So: when the receiver suppresses the arriving record (`record > schema > space` on THIS instance; a file has two
 * tiers), only the record-tier local fields (`RESTORED_LOCAL_FIELDS`) cross the replace — `embedding`,
 * `embeddingModel` and `matchedText` are dropped — and a file's chunk rows (`parentFileId`) lose their vectors too.
 * A record the receiver does NOT suppress keeps every local-only field (the existing pin, held here per door).
 *
 * ## The table
 *
 * Doors: `POST /batch-upsert`, the family's single route where it has one, the real engine's pull, and the admin
 * import (a restore). Families: every `REPLICATED_FAMILIES` member with a record type (a link has nothing to embed),
 * the record type read from `RECORD_TYPE_OF`. Tiers: record, type schema (not for a file: it has no type), space.
 * The import is in the suppressed rows only: a restore takes nothing from the replaced copy, suppressed or not,
 * which is `a-restore-keeps-the-backups-stamps-db`'s question.
 *
 * Seen red on the base (0b066822): every suppressed row keeps the stored vector, model and matchedText, and every
 * file's chunks keep theirs; the non-suppressed rows are green (pins).
 *
 * Run: node --test testing/standalone/a-suppressed-arrival-holds-no-vector-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, FAMILIES } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

/** Suppression stated by a type schema per knowledge type (`muted`), and nowhere at space level. */
const OPEN = 'sup-open';
/** Suppression stated at SPACE level. */
const QUIET = 'sup-quiet';
const MUTED = 'muted';
const TOKEN = Object.freeze({ rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } }, peerInstanceId: PEER });
const DERIVED = ['embedding', 'embeddingModel', 'matchedText'];

/** One value per local-only field the store may hold — a fixture; the field SET is the module's. */
const LOCAL_VALUES = {
  embedding: [0.25, 0.5, 0.75],
  embeddingModel: 'receiver-model',
  matchedText: 'what this instance embedded from the PREVIOUS content',
  _expireAt: new Date('2099-01-01T00:00:00.000Z'),
  _contentExpireAt: new Date('2098-01-01T00:00:00.000Z'),
  syncBase: { 'some-peer': 'sha-agreed' },
};
const KIND = { facts: 'fact', entities: 'entity', edges: 'edge', chrono: 'chrono', filemeta: 'filemeta' };

let door, importMod, families, TYPE_FIELD, LOCAL_ONLY;

/** Every replicated family that holds something to embed: `{ key, collection, recordType }`. */
const embeddable = () => families.filter(f => f.recordType !== null);

function arriving(fam, space, id, seq, tier) {
  const extra = { author: { ...PEER_AUTHOR } };
  if (tier === 'record') extra.suppressEmbeddings = true;
  if (tier === 'schema') extra[TYPE_FIELD[fam.recordType]] = MUTED;
  return build[KIND[fam.key]](space, id, seq, { ...extra, ...(fam.key === 'filemeta' ? {} : { [contentField(fam)]: 'the new content' }) });
}
const contentField = (fam) => ({ facts: 'fact', entities: 'name', edges: 'description', chrono: 'title' })[fam.key];

/** The stored copy before the arrival: the receiver's own local fields on it, and for a file, an embedded chunk. */
async function seedStored(fam, space, id, tier) {
  const stored = { ...build[KIND[fam.key]](space, id, 5, { author: { ...PEER_AUTHOR } }), ...LOCAL_VALUES };
  if (tier === 'schema') stored[TYPE_FIELD[fam.recordType]] = MUTED;
  await door.coll(space, fam.collection).insertOne(stored);
  if (fam.key === 'filemeta') {
    await door.coll(space, 'files').insertOne({ _id: `${id}#chunk0`, spaceId: space, path: `${id}#chunk0`, parentFileId: id,
      content: 'a passage', tags: [], embedding: [0.9, 0.1], embeddingModel: 'receiver-model', matchedText: 'a passage' });
  }
}

/** Deliver one document through one door. */
async function deliver(via, fam, space, doc) {
  const at = { spaceId: space, networkId: door.NET, token: TOKEN };
  if (via === 'batch') {
    const r = await door.push('/batch-upsert', { [fam.key]: [doc] }, at);
    assert.equal(r.code, 200, JSON.stringify(r.body));
  } else if (via === 'single') {
    const r = await door.push(FAMILIES[fam.key].single, doc, at);
    assert.equal(r.code, 200, JSON.stringify(r.body));
  } else if (via === 'pull') {
    door.state.records[space] = { [fam.key]: [doc] };
    await door.sync();
  } else {
    await importMod.importDocuments(space, { [fam.collection]: [doc] });
  }
  await door.settled();
}

const DOORS = ['batch', 'single', 'pull', 'import'];
const doorReaches = (via, fam) => via !== 'single' || Boolean(FAMILIES[fam.key]?.single);

describe('a suppressed arrival holds no vector (Q-230)', { skip }, () => {
  before(async () => {
    const muted = { [MUTED]: { suppressEmbeddings: true } };
    door = await openPullDoor({
      suite: 'suppressed-arrival', spaces: [OPEN, QUIET],
      meta: {
        [OPEN]: { typeSchemas: { fact: muted, entity: muted, edge: muted, chrono: { ...muted, event: {} } } },
        [QUIET]: { suppressEmbeddings: true },
      },
    });
    // After the door: it sets CONFIG_PATH, and these modules read the config they are loaded under.
    ({ TYPE_FIELD } = await import('../../server/dist/brain/ttl.js'));
    importMod = await import('../../server/dist/api/admin-import.js');
    const { REPLICATED_FAMILIES, RECORD_TYPE_OF } = await import('../../server/dist/sync/replicated-families.js');
    families = REPLICATED_FAMILIES.map(f => ({ key: f.payloadKey, collection: f.collection, recordType: RECORD_TYPE_OF[f.collection] }));
    ({ LOCAL_ONLY_FIELDS: LOCAL_ONLY } = await import('../../server/dist/sync/local-only-fields.js'));
  });
  after(async () => { await door?.close(); });

  it('the table is derived: families with a record type, every local-only field has a fixture value', () => {
    assert.ok(embeddable().length >= 5, `only ${embeddable().length} embeddable families: ${JSON.stringify(families)}`);
    assert.ok(embeddable().some(f => f.recordType === 'file'), 'file metadata is not among the embeddable families');
    assert.deepEqual([...LOCAL_ONLY].filter(f => !(f in LOCAL_VALUES)), [], 'a local-only field with no fixture goes unchecked');
    assert.ok(DERIVED.every(f => LOCAL_ONLY.has(f)), 'the derived embed fields are no longer local-only');
  });

  for (const via of DOORS) {
    for (const tier of ['record', 'schema', 'space']) {
      it(`${via}, ${tier} tier: the suppressed arrival holds no embedding, embeddingModel or matchedText; chunks hold no vector`, async () => {
        const wrong = [];
        for (const fam of embeddable()) {
          if (!doorReaches(via, fam)) continue;
          if (tier === 'schema' && fam.recordType === 'file') continue; // a file has no type, so no schema tier
          await door.reset();
          const space = tier === 'space' ? QUIET : OPEN;
          const id = fam.key === 'filemeta' ? `docs/${via}-${tier}.md` : `${fam.key}-${via}-${tier}`;
          await seedStored(fam, space, id, tier);
          await deliver(via, fam, space, arriving(fam, space, id, 6, tier));
          const after = await door.coll(space, fam.collection).findOne({ _id: id });
          if (after?.seq !== 6) { wrong.push(`${fam.key}: fixture check — the arrival did not land (${JSON.stringify(after)})`); continue; }
          const kept = DERIVED.filter(f => f in after);
          if (kept.length) wrong.push(`${fam.key}: kept ${kept.join(', ')} from the content it replaced`);
          if (fam.key === 'filemeta') {
            const chunks = await door.coll(space, 'files').find({ parentFileId: id }).toArray();
            const vectored = chunks.filter(c => 'embedding' in c || 'embeddingModel' in c).map(c => c._id);
            if (vectored.length) wrong.push(`${fam.key}: chunk row(s) ${vectored.join(', ')} still hold a vector`);
          }
        }
        assert.deepEqual(wrong, [], `${via}, ${tier} tier: a record this instance suppresses stays findable by the `
          + 'vector and the lexical text of content it no longer has');
      });
    }
  }

  for (const via of DOORS.filter(d => d !== 'import')) {
    it(`PIN ${via}: an arrival the receiver does NOT suppress keeps every local-only field`, async () => {
      const wrong = [];
      for (const fam of embeddable()) {
        if (!doorReaches(via, fam)) continue;
        await door.reset();
        const id = fam.key === 'filemeta' ? `docs/${via}-kept.md` : `${fam.key}-${via}-kept`;
        await seedStored(fam, OPEN, id, 'none');
        await deliver(via, fam, OPEN, arriving(fam, OPEN, id, 6, 'none'));
        const after = await door.coll(OPEN, fam.collection).findOne({ _id: id });
        if (after?.seq !== 6) { wrong.push(`${fam.key}: fixture check — the arrival did not land`); continue; }
        const lost = [...LOCAL_ONLY].filter(f => !isDeepStrictEqual(after[f], LOCAL_VALUES[f]));
        if (lost.length) wrong.push(`${fam.key}: lost ${lost.join(', ')}`);
      }
      assert.deepEqual(wrong, [], `${via}: a peer's edit of a record this instance still embeds erased its own fields`);
    });
  }
});
