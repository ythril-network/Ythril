/**
 * A write is judged on the record it LEAVES — with what its `deleteFields` removes gone (R6-3), on every kind.
 *
 * ## What it prevents
 *
 * The retype flow in a strict space: an operator changes a record's type, the server refuses because the old type's properties are
 * undeclared on the new one, and the client resends the same write with `deleteFields: ['properties.age', 'properties.email']`. The
 * server refused AGAIN, naming the keys the write was removing as "introduced" — so a retype in a strict space could not complete by
 * any route the product offers.
 *
 * Each update writer applied `deleteFields` to its own merged record and handed THAT to the classifier, and the classifier rebuilt
 * the after-view by merging it over the stored record a second time (`recordAfterUpsert`): every deleted property key came back, and
 * every removed tag with it. The after-view was a record no write leaves.
 *
 * ## What is asserted
 *
 * Per kind, through the writer every door calls (REST PATCH and MCP `update_*` both land in it):
 *
 * - a strict retype that deletes the old type's keys is accepted, and the stored record has neither key;
 * - the same retype WITHOUT `deleteFields` is still refused — the control, so a fix that stops validating passes nothing;
 * - a write that removes a record's tags is judged on a record without them: a rule requiring a tag refuses it.
 *
 * Run: node --test testing/standalone/a-retype-that-deletes-the-old-keys-completes-db.test.js
 * (requires a prior `npm run build` in server/ and a test Mongo)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-retype-delete-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';

/** The old type declares the two keys the record holds; the new one declares neither. */
const OLD = { age: { type: 'number' }, email: { type: 'string' } };
const NEW = { industry: { type: 'string' } };
const TAGGED = { rules: { tagged: { rule: 'size(self.tags) > 0', message: 'a tag is required' } } };

/** Per kind: the collection, the old and new type names, the writer, and a stored record of the old type. */
const KINDS = {
  entity: {
    collection: 'entities', typeField: 'type', from: 'person', to: 'company', module: 'entities.js', writer: 'updateEntityById',
    stored: (id, o) => ({ _id: id, spaceId: SPACE, name: `Acme ${id}`, type: 'person', tags: [], ...o }),
  },
  fact: {
    collection: 'facts', typeField: 'type', from: 'person', to: 'company', module: 'fact.js', writer: 'updateFact',
    stored: (id, o) => ({ _id: id, spaceId: SPACE, fact: `a fact ${id}`, type: 'person', tags: [], ...o }),
  },
  chrono: {
    collection: 'chrono', typeField: 'type', from: 'event', to: 'milestone', module: 'chrono.js', writer: 'updateChrono',
    stored: (id, o) => ({ _id: id, spaceId: SPACE, title: `An event ${id}`, type: 'event', status: 'upcoming',
      startsAt: '2026-01-01T00:00:00.000Z', tags: [], ...o }),
  },
  edge: {
    collection: 'edges', typeField: 'label', from: 'knows', to: 'employs', module: 'edges.js', writer: 'updateEdgeById',
    stored: (id, o) => ({ _id: id, spaceId: SPACE, from: `from-${id}`, to: `to-${id}`, label: 'knows', tags: [], ...o }),
  },
};

const schemasOf = (k) => ({
  [k.from]: { propertySchemas: OLD },
  [k.to]: { propertySchemas: NEW },
  tagged: { propertySchemas: OLD, ...TAGGED },
});

let mongo, loader;
const writers = {};

describe('a retype that deletes the old type\'s keys completes in a strict space', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('retypedelete');
    loader = await import('../../server/dist/config/loader.js');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'retype-delete-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{
        id: SPACE, label: 'General', builtIn: true, folders: [],
        meta: {
          validationMode: 'strict',
          typeSchemas: {
            entity: schemasOf(KINDS.entity), fact: schemasOf(KINDS.fact),
            chrono: schemasOf(KINDS.chrono), edge: schemasOf(KINDS.edge),
          },
        },
      }],
    }, null, 2), { mode: 0o600 });
    loader.loadConfig();
    for (const [kind, k] of Object.entries(KINDS)) {
      writers[kind] = (await import(`../../server/dist/brain/${k.module}`))[k.writer];
    }
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['entities', 'facts', 'chrono', 'edges', 'embed_jobs', 'tombstones']) {
      await mongo.col(`${SPACE}_${c}`).deleteMany({});
    }
  });

  const now = new Date().toISOString();
  async function seed(kind, id, o = {}) {
    const k = KINDS[kind];
    await mongo.col(`${SPACE}_${k.collection}`).insertOne(
      k.stored(id, { properties: { age: 41, email: 'a@example.com' }, seq: 1, createdAt: now, updatedAt: now, ...o }));
  }
  // A relabel re-keys an edge (its id is derived from `(from, to, label)`), so an edge is found by its subject.
  const stored = (kind, id) => mongo.col(`${SPACE}_${KINDS[kind].collection}`)
    .findOne(kind === 'edge' ? { from: `from-${id}` } : { _id: id });

  for (const [kind, k] of Object.entries(KINDS)) {
    it(`${kind}: a retype with deleteFields removing the old type's keys is accepted and stores neither key`, async () => {
      await seed(kind, `${kind}-1`);
      await writers[kind](SPACE, `${kind}-1`, { [k.typeField]: k.to, properties: { industry: 'steel' } },
        ['properties.age', 'properties.email']);
      const after = await stored(kind, `${kind}-1`);
      assert.equal(after[k.typeField], k.to, `${kind}: the retype was not stored`);
      assert.deepEqual(after.properties, { industry: 'steel' },
        `${kind}: the write did not leave the record its deleteFields describe`);
    });

    it(`${kind}: the same retype WITHOUT deleteFields is still refused (the control)`, async () => {
      await seed(kind, `${kind}-2`);
      await assert.rejects(
        writers[kind](SPACE, `${kind}-2`, { [k.typeField]: k.to, properties: { industry: 'steel' } }),
        (err) => err?.name === 'SchemaViolationError' || /schema/i.test(String(err?.message)),
        `${kind}: a retype that keeps keys the new type does not declare was not refused`);
      const after = await stored(kind, `${kind}-2`);
      assert.equal(after[k.typeField], k.from, `${kind}: the refused retype was stored`);
    });

    it(`${kind}: a write that removes every tag is judged on a record without them`, async () => {
      await seed(kind, `${kind}-3`, { [k.typeField]: 'tagged', tags: ['kept'] });
      await assert.rejects(
        writers[kind](SPACE, `${kind}-3`, {}, ['tags']),
        (err) => err?.name === 'SchemaViolationError' || /tag is required/.test(String(err?.message)),
        `${kind}: the after-view kept the tags the write removed, so a rule requiring one passed`);
      const after = await stored(kind, `${kind}-3`);
      assert.deepEqual(after.tags, ['kept'], `${kind}: the refused write removed the tags anyway`);
    });
  }
});
