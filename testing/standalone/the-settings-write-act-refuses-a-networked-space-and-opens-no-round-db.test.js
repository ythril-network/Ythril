/**
 * The settings write act (`spaces/space-meta-write-act.ts`, bundle-270, Q-754, design revision 3): the one chain `PATCH /api/spaces/:id`,
 * `schema_update` and the schema-from-RDF door write a space's settings through, answering its outcome as a value.
 *
 * ## What it holds
 *
 * - `refuseIfNetworked` on a space in a network refuses with `409 space_networked`, opens no vote round and stores nothing: a door that may
 *   not vote (the schema-from-RDF door, F1) never gets a `vote_pending` back. Without it, the same write opens its round as PATCH does.
 * - On a space in no network, `refuseIfNetworked` changes nothing: the write is applied, with its audit pair and its notices.
 * - A stale `ifMatch` is refused 412; a space an RDF import holds is refused 409 `space_being_rdf_imported` (the hold's own error is carried
 *   beside it), never thrown to the door.
 * - A field the caller's rungs do not reach is refused before anything is planned, naming the field.
 *
 * Run: node --test testing/standalone/the-settings-write-act-refuses-a-networked-space-and-opens-no-round-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { seedActEntry, clearActEntries } from './_space-act-harness.mjs';
import { NET_ID, P1 } from './_vote-round-sites.mjs';

const dir = tempInstanceDir('ythril-settings-write-act-');
const skip = await mongoSkipReason();
const LOCAL = 'local';
const SHARED = 'shared';
const ADMIN = { instanceAdmin: true, perSpace: {} };
const SEED_TYPES = { entity: { person: {} } };

describe('the settings write act', { skip }, () => {
  let inst, act;
  before(async () => {
    await openTestMongo('settings_write_act');
    inst = await bootSchemaInstance(dir, {
      spaces: [
        { id: LOCAL, label: 'Local', folders: [], meta: { suppressEmbeddings: true, typeSchemas: SEED_TYPES } },
        { id: SHARED, label: 'Shared', folders: [], meta: { suppressEmbeddings: true, typeSchemas: SEED_TYPES } },
      ],
      networks: [{
        id: NET_ID, label: 'Net', type: 'closed', origin: 'created', syncSchedule: '', spaces: [SHARED], votingDeadlineHours: 24,
        createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
        members: [{ instanceId: P1, label: 'Peer', url: 'https://p1.example', tokenHash: 'h', direction: 'both' }],
      }],
    });
    act = await import('../../server/dist/spaces/space-meta-write-act.js');
  });
  after(async () => {
    inst?.close();
    await closeTestMongo();
  });

  // The entries first: the loader's writer replaces the live config, which would undo a reset made before it.
  const fresh = () => {
    clearActEntries(inst.loader);
    inst.reset();
    inst.loader.getConfig().networks[0].pendingRounds = [];
    delete inst.loader.getConfig().networks[0].schemaLayers;
  };
  const rounds = () => inst.loader.getConfig().networks[0].pendingRounds.length;
  const body = { meta: { typeSchemas: { entity: { tool: {} } } } };
  const input = (spaceId, over = {}) => ({
    spaceId, body, ifMatch: undefined, caller: { record: { rights: ADMIN }, rights: ADMIN, instanceAdmin: true }, rateKey: 'act-test', ...over,
  });

  it('refuseIfNetworked on a networked space: 409 space_networked, no round, nothing stored', async () => {
    fresh();
    const answer = await act.writeSpaceMeta(input(SHARED, { refuseIfNetworked: true }));
    assert.equal(answer.kind, 'refused', JSON.stringify(answer).slice(0, 300));
    assert.equal(answer.status, 409);
    assert.equal(answer.body.code, act.SPACE_META_WRITE_NETWORKED);
    assert.equal(act.SPACE_META_WRITE_NETWORKED, 'space_networked');
    assert.equal(rounds(), 0, 'a refused write opened a round');
    assert.ok(!('tool' in (inst.heldTypes(SHARED).entity ?? {})));
  });

  it('without refuseIfNetworked the same write opens its round, as PATCH does', async () => {
    fresh();
    const answer = await act.writeSpaceMeta(input(SHARED));
    assert.equal(answer.kind, 'written', JSON.stringify(answer).slice(0, 300));
    assert.equal(answer.outcome.outcome, 'vote_pending');
    assert.equal(rounds(), 1);
    assert.ok(answer.audit?.after, 'the audit pair is handed back');
  });

  it('refuseIfNetworked on a space in no network: applied, with the audit pair and the notices', async () => {
    fresh();
    const answer = await act.writeSpaceMeta(input(LOCAL, { refuseIfNetworked: true, typeSchemasMode: 'merge' }));
    assert.equal(answer.kind, 'written', JSON.stringify(answer).slice(0, 300));
    assert.equal(answer.outcome.outcome, 'applied');
    assert.ok('tool' in inst.heldTypes(LOCAL).entity && 'person' in inst.heldTypes(LOCAL).entity, 'the merge kept the stored type');
    assert.ok('tool' in (answer.audit.after.typeSchemas?.entity ?? {}));
    assert.equal(typeof answer.notice, 'object');
  });

  it('a stale ifMatch is 412, and a space an RDF import holds is 409 space_being_rdf_imported, as answers', async () => {
    fresh();
    const stale = await act.writeSpaceMeta(input(LOCAL, { ifMatch: '9999' }));
    assert.equal(stale.kind, 'refused');
    assert.equal(stale.status, 412);
    await seedActEntry(inst.loader, { kind: 'rdf-import', localId: LOCAL, state: 'owed', retryAt: '2999-01-01T00:00:00.000Z', spoolId: 'planted' });
    // Read after the entry is stood up: the loader's writer replaces the live config, so what the space holds is read from here on.
    const before = inst.heldMeta(LOCAL);
    const held = await act.writeSpaceMeta(input(LOCAL, { body: { meta: { typeSchemas: { entity: { heldOut: {} } } } } }));
    assert.equal(held.kind, 'refused', JSON.stringify(held).slice(0, 300));
    assert.equal(held.status, 409);
    assert.equal(held.body.code, 'space_being_rdf_imported');
    assert.ok(held.held instanceof Error, 'the hold\'s own error is carried for a door that answers it as thrown');
    assert.ok(!('heldOut' in inst.heldTypes(LOCAL).entity), 'a held space took the type');
    assert.equal(inst.heldMeta(LOCAL).version, before.version, 'a held space was written');
  });

  it('a field the caller\'s rungs do not reach is refused before anything is planned', async () => {
    fresh();
    const rights = { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [LOCAL]: { knowledge: 'write', files: 'none', schema: 'none', dataQuality: 'none' } } };
    const answer = await act.writeSpaceMeta(input(LOCAL, { caller: { record: { rights }, rights, instanceAdmin: false } }));
    assert.equal(answer.kind, 'fields-refused', JSON.stringify(answer).slice(0, 300));
    assert.equal(answer.status, 403);
    assert.ok(answer.fields.some(f => /typeSchemas/.test(String(f))), JSON.stringify(answer.fields));
  });
});
