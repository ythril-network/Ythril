/**
 * A type schema this instance will not store is refused by EVERY door that stores one, for the same reasons (`Q-215`, `Q-216`).
 *
 * ## What was found
 *
 * The inline doors (the space PATCH, `schema_update`, `PUT .../schema`, the single-type PUT) parse a schema through `TypeSchemaZ` and
 * `TypeSchemasZ`. Every other door that stores one parsed it differently or not at all:
 *
 * - the schema LIBRARY kept a hand-built `LibraryTypeSchemaZ` — a ReDoS `namingPattern` was accepted (a plain `.max(500)`), a library
 *   entry knew nothing of the collection it was filed under, and `whenDuePasses` was refused as an unknown key rather than for the
 *   rule it breaks;
 * - the single-type PUT parsed `TypeSchemaZ` ALONE, which cannot see the collection, so `endpoints` on an entity type was stored;
 * - a library entry whose `knowledgeType` is changed under a space that references it, and a `$ref` of the wrong kind, were never checked;
 * - a peer's PASSED `meta_change` round went from the wire to `commitOwnMetaEdit` / `storeNetworkLayer` with no parse at all, and a
 *   member cast its yes on a round it could not parse.
 *
 * One table (`_invalid-schema-fixtures.mjs`) drives all of them; a row is a schema, the collection it is filed under, and the reason
 * the refusal must give. A refusal for the wrong reason ("unrecognized key" where the rule is the collection scope) is a different
 * defect and fails the row.
 *
 * ## What each door must do
 *
 * - inline and library doors: answer 4xx, with the reason, and leave the stored schema exactly as it was;
 * - a layer arriving by the meta pull: refused whole, nothing stored as the network's layer;
 * - a passed round whose changed parts this member cannot parse (R6-6): NOT applied on this member at all, in its own definitions
 *   or in the layer, and the refusal is recorded where an operator reads it (the round's view or `space_schema_layers`);
 * - a member asked to cast yes on such a round (adoption, R6-6): no yes is cast.
 *
 * Run: node --test testing/standalone/an-invalid-schema-is-refused-at-every-door-db.test.js
 * (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { bootInstance, tempInstanceDir } from './_vote-round-instance.mjs';
import { NET_ID, ROUND_ID, SELF, P1, scenario, decide, startVotesPeer } from './_vote-round-sites.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import {
  invalidRows, REF_ROWS, EDGE_ENTRY, ENTITY_ENTRY, PLACEHOLDER_ROWS, metaOf, entryBodyOf,
} from './_invalid-schema-fixtures.mjs';
import { bootSchemaInstance, INLINE_DOORS } from './_schema-doors.mjs';

const dir = tempInstanceDir('ythril-invalid-schema-');
const skip = await mongoSkipReason();
const SPACE = 'sch';

/** A reason the refusal must carry, or a failure message saying what it carried instead. */
const reasonOf = (row, answer) => `${row.id}: refused, but for the wrong reason — ${answer.text.slice(0, 300)}`;

describe('an invalid schema is refused at every door that stores one', { skip }, () => {
  let inst;
  before(async () => {
    await openTestMongo('invalid_schema_doors');
    inst = await bootSchemaInstance(dir, {
      spaces: [
        { id: SPACE, label: 'Schema space', folders: [], meta: { validationMode: 'strict' } },
        { id: 'general', label: 'General', builtIn: true, folders: [] },
        { id: 'notes', label: 'Notes', folders: [] },
      ],
      library: [EDGE_ENTRY, ENTITY_ENTRY].map(e => ({ ...e, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })),
    });
  });
  after(async () => {
    inst?.close();
    await closeTestMongo();
  });

  it('the table is read in full (a table that matched nothing would pass every door)', () => {
    assert.ok(invalidRows().length >= 5);
    assert.deepEqual(INLINE_DOORS.length, 4);
    assert.ok(REF_ROWS.length >= 1);
    // The plan's table has a row that cannot be driven until F-46; it is listed, not dropped.
    assert.ok(PLACEHOLDER_ROWS.every(r => r.until === 'F-46'));
  });

  describe('the inline doors', () => {
    for (const row of invalidRows()) {
      for (const door of INLINE_DOORS) {
        it(`${door} refuses ${row.id}, for its own reason, and stores nothing`, async () => {
          inst.reset();
          const before = inst.heldMeta(SPACE);
          const answer = await inst.doors[door](SPACE, metaOf(row));
          assert.equal(answer.refused, true, `${door} ACCEPTED ${row.id} (status ${answer.status}); held: ${JSON.stringify(inst.heldTypes(SPACE))}`);
          assert.ok(answer.status >= 400 && answer.status < 500, `${door} answered ${answer.status} for ${row.id}, which is not a refusal of the caller's schema`);
          assert.match(answer.text, row.mentions, reasonOf(row, answer));
          assert.deepEqual(inst.heldMeta(SPACE), before, `${door} refused ${row.id} but the space's meta changed`);
        });
      }
    }
  });

  describe('the schema library doors take what the inline doors take', () => {
    for (const row of invalidRows()) {
      it(`POST refuses ${row.id}, for its own reason, and stores nothing`, async () => {
        inst.reset();
        const answer = await inst.library.post(entryBodyOf(row));
        assert.equal(answer.refused, true, `the library ACCEPTED ${row.id} on POST (status ${answer.status}); the inline doors refuse it`);
        assert.match(answer.text, row.mentions, reasonOf(row, answer));
        assert.equal(inst.heldEntry('fixture-entry'), undefined, 'a refused POST stored the entry');
      });
      it(`PUT refuses ${row.id}, for its own reason, and stores nothing`, async () => {
        inst.reset();
        const answer = await inst.library.put('fixture-entry', { knowledgeType: row.kind, typeName: row.type, schema: row.schema });
        assert.equal(answer.refused, true, `the library ACCEPTED ${row.id} on PUT (status ${answer.status}); the inline doors refuse it`);
        assert.match(answer.text, row.mentions, reasonOf(row, answer));
        assert.equal(inst.heldEntry('fixture-entry'), undefined, 'a refused PUT stored the entry');
      });
      it(`PATCH refuses ${row.id}, for its own reason, and leaves the entry as it was`, async () => {
        inst.reset();
        const created = await inst.library.post({ name: 'fixture-entry', knowledgeType: row.kind, typeName: row.type, schema: {} });
        assert.equal(created.refused, false, `the control entry was refused: ${created.text}`);
        const before = inst.heldEntry('fixture-entry');
        const answer = await inst.library.patch('fixture-entry', { schema: row.schema });
        assert.equal(answer.refused, true, `the library ACCEPTED ${row.id} on PATCH (status ${answer.status}); the inline doors refuse it`);
        assert.match(answer.text, row.mentions, reasonOf(row, answer));
        assert.deepEqual(inst.heldEntry('fixture-entry'), before, 'a refused PATCH changed the entry');
      });
    }

    it('export-to-library stores no type the library would refuse, and says what it left out', async () => {
      // A space can hold a schema stored before the rule existed (config.json, an import, a peer). Exporting it must not
      // launder it into the library, where every space that references it would then run the pattern.
      inst.reset();
      const space = inst.loader.getConfig().spaces.find(s => s.id === SPACE);
      space.meta = { validationMode: 'strict', typeSchemas: { entity: { LegacyRisky: { namingPattern: '^D[0-9]+:[0-9]+(,D[0-9]+:[0-9]+)*$' }, Fine: { namingPattern: '^[a-z]+$', retention: { days: 30 } } } } };
      const answer = await inst.library.exportSpace({ spaceId: SPACE, groupName: 'exported' });
      const held = inst.heldEntries().filter(e => e.schemaGroup === 'exported');
      assert.ok(held.every(e => e.schema.retention === undefined),
        `an exported entry carries retention, which the library refuses on every other door: ${JSON.stringify(held.map(e => [e.name, e.schema]))}`);
      assert.ok(!held.some(e => e.typeName === 'LegacyRisky'),
        'a ReDoS naming pattern was exported into the library, where the library door refuses it');
      assert.match(answer.text, /retention/i, 'export dropped the retention without reporting it');
      assert.match(answer.text, /LegacyRisky/, 'export left a type out without naming it');
      assert.ok(held.some(e => e.typeName === 'Fine'), 'the control type was not exported');
    });
  });

  describe('a library $ref of the wrong kind', () => {
    for (const row of REF_ROWS) {
      for (const door of INLINE_DOORS) {
        it(`${door} refuses ${row.id}, naming the entry, and stores nothing`, async () => {
          inst.reset();
          const before = inst.heldMeta(SPACE);
          const answer = await inst.doors[door](SPACE, { typeSchemas: { [row.kind]: { [row.type]: { $ref: `library:${row.ref}` } } } });
          assert.equal(answer.refused, true, `${door} stored an entity type that references an EDGE entry; its endpoints and functional would never apply: ${answer.text.slice(0, 200)}`);
          assert.match(answer.text, new RegExp(row.ref), `the refusal does not name the entry: ${answer.text.slice(0, 300)}`);
          assert.match(answer.text, row.mentions, reasonOf(row, answer));
          assert.deepEqual(inst.heldMeta(SPACE), before);
        });
        it(`${door} still accepts a $ref of the right kind (the control)`, async () => {
          inst.reset();
          const answer = await inst.doors[door](SPACE, { typeSchemas: { entity: { Person: { $ref: `library:${ENTITY_ENTRY.name}` } } } });
          assert.equal(answer.refused, false, `${door} refused a $ref of the right kind: ${answer.text.slice(0, 300)}`);
        });
      }
    }

    it('the library refuses to change the kind of an entry a space references, naming the spaces', async () => {
      inst.reset();
      inst.loader.getConfig().spaces.find(s => s.id === SPACE).meta = { typeSchemas: { entity: { Person: { $ref: `library:${ENTITY_ENTRY.name}` } } } };
      const before = inst.heldEntry(ENTITY_ENTRY.name);
      const put = await inst.library.put(ENTITY_ENTRY.name, { knowledgeType: 'edge', typeName: 'person', schema: { endpoints: { from: ['person'] } } });
      assert.equal(put.refused, true, `PUT moved an entry referenced as an entity type under edge: ${put.text.slice(0, 200)}`);
      assert.match(put.text, new RegExp(SPACE), `the refusal does not name the space that references it: ${put.text.slice(0, 300)}`);
      const patch = await inst.library.patch(ENTITY_ENTRY.name, { knowledgeType: 'edge' });
      assert.equal(patch.refused, true, `PATCH moved an entry referenced as an entity type under edge: ${patch.text.slice(0, 200)}`);
      assert.match(patch.text, new RegExp(SPACE));
      assert.deepEqual(inst.heldEntry(ENTITY_ENTRY.name), before, 'a refused change of kind altered the entry');
    });

    it('the library still lets an entry keep its kind (the control)', async () => {
      inst.reset();
      inst.loader.getConfig().spaces.find(s => s.id === SPACE).meta = { typeSchemas: { entity: { Person: { $ref: `library:${ENTITY_ENTRY.name}` } } } };
      const put = await inst.library.put(ENTITY_ENTRY.name, { knowledgeType: 'entity', typeName: 'person', schema: { propertySchemas: { email: { type: 'string' } } } });
      assert.equal(put.refused, false, `the control PUT was refused: ${put.text.slice(0, 300)}`);
    });
  });

  describe('a network sends the schema (peer doors)', () => {
    /** A scenario whose passed meta_change round proposes `row`'s schema for the network's space `notes`. */
    const roundFor = (row, site, { proposedHere = false } = {}) => {
      const scen = scenario('meta_change', 'closed', site, 'http://127.0.0.1:9');
      scen.round.pendingMeta = metaOf(row);
      scen.round.metaChangedFields = ['typeSchemas'];
      scen.round.baseMetaVersion = 0;
      scen.wire = { ...scen.round, votes: [...scen.round.votes, scen.decidingCast], concluded: false };
      if (proposedHere) scen.round.proposedHere = true;
      return scen;
    };
    const boot = (scen) => bootInstance(inst.dir, {
      instanceId: SELF,
      spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }, { id: 'notes', label: 'Notes', folders: [], meta: { validationMode: 'strict', purpose: 'kept' } }],
      networks: [scen.net], peerTokens: { [P1]: 'token-p1' },
    });
    const layerOf = (loader) => loader.getConfig().networks.find(n => n.id === NET_ID).schemaLayers?.notes;
    const heldNotes = (loader) => loader.getConfig().spaces.find(s => s.id === 'notes').meta;
    const nothingFrom = (row, loader, what) => {
      const layer = layerOf(loader);
      assert.ok(!JSON.stringify(layer ?? {}).includes(row.type), `${what}: the network's layer holds the refused type ${row.type}: ${JSON.stringify(layer)}`);
      assert.ok(!JSON.stringify(heldNotes(loader)).includes(row.type), `${what}: the space's meta holds the refused type ${row.type}`);
      const own = loader.getConfig().spaces.find(s => s.id === 'notes').ownMeta;
      assert.ok(!JSON.stringify(own ?? {}).includes(row.type), `${what}: the space's own definitions hold the refused type ${row.type}`);
    };

    for (const row of invalidRows()) {
      it(`the meta pull keeps no layer from a network that sends ${row.id}`, async () => {
        const loader = await boot(roundFor(row, 'relay'));
        const { acceptNetworkLayer } = await import('../../server/dist/sync/space-meta-pull.js');
        const changed = acceptNetworkLayer(NET_ID, 'notes', metaOf(row), 'upstream peer');
        assert.equal(changed, false, `${row.id} arrived by the meta pull and changed the meta`);
        nothingFrom(row, loader, 'meta pull');
      });

      it(`a passed round proposing ${row.id} is applied nowhere on this member, and is recorded`, async () => {
        const scen = roundFor(row, 'relay');
        const loader = await boot(scen);
        await decide('relay', loader, scen, { seen: [] });
        nothingFrom(row, loader, 'conclusion by a relayed cast');
        const { schemaLayersAct } = await import('../../server/dist/spaces/schema-layers-acts.js');
        const { roundForOperator } = await import('../../server/dist/networks/vote-acts.js');
        const net = loader.getConfig().networks.find(n => n.id === NET_ID);
        const record = JSON.stringify([schemaLayersAct('notes'), roundForOperator(net, net.pendingRounds.find(r => r.roundId === ROUND_ID))]);
        assert.ok(record.includes(row.type),
          `the member refused a round it could not parse and recorded nothing an operator can read: it must name ${row.type} in the round view or in space_schema_layers. Read: ${record.slice(0, 400)}`);
      });

      it(`a round proposing ${row.id} that arrives by gossip is applied nowhere on this member`, { skip: privateAddressSkipReason() }, async () => {
        const scen = roundFor(row, 'gossip');
        const peer = await startVotesPeer();
        try {
          scen.net.members[0].url = peer.url;
          const loader = await boot(scen);
          await decide('gossip', loader, scen, peer);
          nothingFrom(row, loader, 'conclusion by gossip');
        } finally {
          await peer.close();
        }
      });

      it(`the proposer's own definitions do not take ${row.id} from a round it cannot parse`, async () => {
        const scen = roundFor(row, 'relay', { proposedHere: true });
        const loader = await boot(scen);
        await decide('relay', loader, scen, { seen: [] });
        nothingFrom(row, loader, 'conclusion of an own proposal');
      });

      it(`a member does not cast yes on a round proposing ${row.id}`, async () => {
        const scen = roundFor(row, 'cast');
        const loader = await boot(scen);
        const { castVoteAct } = await import('../../server/dist/networks/vote-acts.js');
        const answer = castVoteAct(NET_ID, ROUND_ID, { vote: 'yes' });
        assert.notEqual(answer.status, 200, `the member cast yes on a round it cannot parse: ${JSON.stringify(answer).slice(0, 300)}`);
        const round = loader.getConfig().networks.find(n => n.id === NET_ID).pendingRounds.find(r => r.roundId === ROUND_ID);
        assert.ok(!round.votes.some(v => v.instanceId === SELF), 'a yes from this member is on the round');
        assert.notEqual(round.passed, true, 'the round passed on this member\'s refused yes');
        nothingFrom(row, loader, 'adoption');
      });
    }
  });
});
