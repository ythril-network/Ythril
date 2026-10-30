/**
 * An arrival THIS instance suppresses is stored with this instance's own `matchedText` of what arrived (Q-262).
 *
 * ## The rule
 *
 * `suppressEmbeddings` retires a record from meaning-ranked search; it stays findable by its words. A write made HERE
 * stores the text the lexical channel searches either way (`matchedText`, built by this instance's text builder), and an
 * arrival must do no less: a suppressed arrival used to land with NO `matchedText` at all, so the record was missing from
 * the lexical index and from the duplicate scanner, and nothing queued it (a suppressed record is not queued), so nothing
 * would ever write it later.
 *
 * What a suppressed arrival must NOT carry is the STORED copy's vector, model or `matchedText` (Q-230): they describe the
 * previous content. So the text it is stored with is the receiver's own of the ARRIVING content, never a carried one.
 *
 * ## The table
 *
 * Kinds: every `EMBED_SWEEP_KINDS` member, matched to the replicated family that holds it (floor of five). Doors: the push
 * (`/batch-upsert`), the pull and the admin import (a restore) — one rule over every door. Tiers: record, type schema (not for
 * a file, which has no type) and space. Per cell: the record lands with `matchedText` equal to the text built from the
 * stored record, no vector, no model and no job, and a lexical query on the receiver finds it by its words; and a suppressed
 * UPDATE onto a vectored copy drops the vector and stores the NEW text, not the old.
 *
 * Plus, pinned: an update the receiver does NOT suppress keeps the stored vector and its `matchedText` (the job writes both).
 *
 * Run: node --test testing/standalone/a-suppressed-arrival-is-found-by-its-text-on-the-receiver-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, FAMILIES } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const OPEN = 'text-open';
const QUIET = 'text-quiet';
const MUTED = 'muted';
const TOKEN = Object.freeze({ rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } }, peerInstanceId: PEER });
const KIND = { facts: 'fact', entities: 'entity', edges: 'edge', chrono: 'chrono', filemeta: 'filemeta' };
/** The word only the ARRIVING content has, and the one only the stored copy had. */
const NEW_WORD = 'quokkanew';
const OLD_WORD = 'wombatold';
const STORED_VECTOR = [0.25, 0.5, 0.75];

let door, importMod, families, TYPE_FIELD, EMBED_SWEEP_KINDS, buildEmbedText;

/** Every replicated family that holds something to embed, with the kind the embed queue calls it. */
const embeddable = () => families.filter(f => f.recordType !== null);

/** The content field that carries the words, per family (a file's is its description). */
const WORDS = { facts: 'fact', entities: 'name', edges: 'description', chrono: 'title', filemeta: 'description' };

function arriving(fam, space, id, seq, tier, word) {
  const extra = { author: { ...PEER_AUTHOR }, [WORDS[fam.key]]: `the ${word} wording` };
  if (tier === 'record') extra.suppressEmbeddings = true;
  if (tier === 'schema') extra[TYPE_FIELD[fam.recordType]] = MUTED;
  return build[KIND[fam.key]](space, id, seq, extra);
}

/** The stored copy before the arrival: embedded from OTHER words, with the vector the receiver made. */
async function seedStored(fam, space, id, tier) {
  const stored = {
    ...build[KIND[fam.key]](space, id, 5, { author: { ...PEER_AUTHOR }, [WORDS[fam.key]]: `the ${OLD_WORD} wording` }),
    embedding: STORED_VECTOR, embeddingModel: 'receiver-model', matchedText: `the ${OLD_WORD} wording`,
  };
  if (tier === 'schema') stored[TYPE_FIELD[fam.recordType]] = MUTED;
  await door.coll(space, fam.collection).insertOne(stored);
}

async function deliver(via, fam, space, doc) {
  const at = { spaceId: space, networkId: door.NET, token: TOKEN };
  if (via === 'batch') {
    const r = await door.push('/batch-upsert', { [fam.key]: [doc] }, at);
    assert.equal(r.code, 200, JSON.stringify(r.body));
  } else if (via === 'pull') {
    door.state.records[space] = { [fam.key]: [doc] };
    await door.sync();
  } else {
    await importMod.importDocuments(space, { [fam.collection]: [doc] });
  }
  await door.settled();
}

const DOORS = ['batch', 'pull', 'import'];

describe('a suppressed arrival is found by its text on the receiver (Q-262)', { skip }, () => {
  before(async () => {
    const muted = { [MUTED]: { suppressEmbeddings: true } };
    door = await openPullDoor({
      suite: 'suppressed-arrival-text', spaces: [OPEN, QUIET],
      meta: {
        [OPEN]: { typeSchemas: { fact: muted, entity: muted, edge: muted, chrono: { ...muted, event: {} } } },
        [QUIET]: { suppressEmbeddings: true },
      },
    });
    ({ TYPE_FIELD } = await import('../../server/dist/brain/ttl.js'));
    importMod = await import('../../server/dist/api/admin-import.js');
    ({ buildEmbedText } = await import('../../server/dist/brain/embed-record.js'));
    ({ EMBED_SWEEP_KINDS } = await import('../../server/dist/brain/queue-embed-sweep.js'));
    const { REPLICATED_FAMILIES, RECORD_TYPE_OF } = await import('../../server/dist/sync/replicated-families.js');
    families = REPLICATED_FAMILIES.map(f => ({ key: f.payloadKey, collection: f.collection, recordType: RECORD_TYPE_OF[f.collection] }));
  });
  after(async () => { await door?.close(); });

  it('the table is derived: every embed kind has its family, floor of five', () => {
    assert.ok(EMBED_SWEEP_KINDS.length >= 5, `only ${EMBED_SWEEP_KINDS.length} embed kinds`);
    assert.deepEqual(embeddable().map(f => f.recordType).sort(), [...EMBED_SWEEP_KINDS].sort(),
      'a kind the embed queue knows has no replicated family here, or the reverse');
    assert.ok(embeddable().every(f => f.key in WORDS), 'a family has no content field in this table');
  });

  for (const via of DOORS) {
    for (const tier of ['record', 'schema', 'space']) {
      it(`${via}, ${tier} tier: a suppressed arrival lands with the receiver's own text, no vector and no job, and is found by its words`, async () => {
        const wrong = [];
        for (const fam of embeddable()) {
          if (tier === 'schema' && fam.recordType === 'file') continue;
          const space = tier === 'space' ? QUIET : OPEN;
          const id = fam.key === 'filemeta' ? `docs/text-${via}-${tier}.md` : `${fam.key}-text-${via}-${tier}`;
          // Once as a first arrival, once as an update onto a vectored copy.
          for (const mode of ['insert', 'update']) {
            await door.reset();
            if (mode === 'update') await seedStored(fam, space, id, tier);
            await deliver(via, fam, space, arriving(fam, space, id, 6, tier, NEW_WORD));
            const stored = await door.coll(space, fam.collection).findOne({ _id: id });
            const at = `${fam.key} (${mode})`;
            if (stored?.seq !== 6) { wrong.push(`${at}: fixture check — the arrival did not land`); continue; }
            if ('embedding' in stored || 'embeddingModel' in stored) wrong.push(`${at}: holds a vector this instance suppresses`);
            const own = await buildEmbedText(space, fam.recordType, stored);
            if (stored.matchedText !== own) wrong.push(`${at}: matchedText ${JSON.stringify(stored.matchedText)}, this instance's own text is ${JSON.stringify(own)}`);
            if (String(stored.matchedText ?? '').includes(OLD_WORD)) wrong.push(`${at}: carries the text of the content it replaced`);
            if (await door.coll(space, 'embed_jobs').countDocuments({ recordId: id }) !== 0) wrong.push(`${at}: a job was queued for a record that is not embedded`);
            const found = await door.coll(space, fam.collection).find({ $text: { $search: NEW_WORD } }).project({ _id: 1 }).toArray();
            if (!found.some(r => r._id === id)) wrong.push(`${at}: a lexical query for its words does not find it`);
          }
        }
        assert.deepEqual(wrong, [], `${via}, ${tier} tier: a record this instance suppresses is missing from the lexical channel`);
      });
    }
  }

  it('PIN: an update the receiver does not suppress keeps the stored vector and its text, for the job to write both', async () => {
    const wrong = [];
    for (const fam of embeddable()) {
      if (fam.recordType === 'file') continue;
      await door.reset();
      const id = `${fam.key}-text-kept`;
      await seedStored(fam, OPEN, id, 'none');
      await deliver('batch', fam, OPEN, arriving(fam, OPEN, id, 6, 'none', NEW_WORD));
      const stored = await door.coll(OPEN, fam.collection).findOne({ _id: id });
      if (stored?.seq !== 6) { wrong.push(`${fam.key}: fixture check — the arrival did not land`); continue; }
      if (JSON.stringify(stored.embedding) !== JSON.stringify(STORED_VECTOR)) wrong.push(`${fam.key}: lost the stored vector`);
      if (stored.matchedText !== `the ${OLD_WORD} wording`) wrong.push(`${fam.key}: matchedText is ${JSON.stringify(stored.matchedText)}, not the stored pair's`);
      if (await door.coll(OPEN, 'embed_jobs').countDocuments({ recordId: id }) !== 1) wrong.push(`${fam.key}: no job queued to write the pair`);
    }
    assert.deepEqual(wrong, []);
  });
});
