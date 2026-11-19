/**
 * A space's RDF base is kept through every door that writes the meta, and moves only by the deliberate act (Q-748, slice A, design r4
 * §4.1). Driven through production's own handlers: the REST `PATCH /api/spaces/:id` and MCP `schema_update`, which must answer alike.
 *
 * - RDF is off until switched on: a write that says nothing of `rdf` leaves a space with none.
 * - The first enable takes `<public url>/ld/<space>/`; with only the fallback URL it is 400 `rdf_base_needed`; a base sent with it is
 *   taken as it is.
 * - Switching off keeps the base; switching on again reuses it; a write that omits `rdf` keeps it.
 * - A different base is 409 `rdf_base_frozen` naming both; with `rebase: true` on a space in no network the epoch goes up by one.
 * - A meta write leaving two terms with one address is 422 `rdf_term_clash` naming both.
 * - On a networked space `rebase: true` opens a `space_rebase` round carrying `{ base, vocab, epoch }` and answers `vote_pending`; the
 *   base is unchanged (it lands at the round's deadline, `a-passed-rebase-lands-at-its-deadline-db`).
 *
 * Run: node --test testing/standalone/an-rdf-base-is-kept-through-every-door-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { NET_ID, P1 } from './_vote-round-sites.mjs';

const dir = tempInstanceDir('ythril-rdf-base-');
const skip = await mongoSkipReason();
const SOLO = 'solo';
const SHARED = 'shared';
const OLD = 'https://old.example.org/ld/solo/';
const NEW = 'https://new.example.org/ld/solo/';
const DOORS = ['space-patch', 'mcp-schema-update'];

const network = () => ({
  id: NET_ID, label: 'Net', type: 'club', origin: 'created', syncSchedule: '', spaces: [SHARED], votingDeadlineHours: 24,
  createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
  members: [{ instanceId: P1, label: 'Peer', url: 'https://a1.example', tokenHash: 'h', direction: 'both' }],
});
const SHARED_RDF = { enabled: true, base: 'https://old.example.org/ld/shared/', vocab: 'https://old.example.org/ld/shared/vocab/', baseEpoch: 0 };

describe('an RDF base is kept through every door', { skip }, () => {
  let inst;
  before(async () => {
    await openTestMongo('rdf_base_doors');
    delete process.env['PUBLIC_BASE_URL'];
    inst = await bootSchemaInstance(dir, {
      spaces: [
        { id: SOLO, label: 'Solo', folders: [], meta: { validationMode: 'warn' } },
        { id: SHARED, label: 'Shared', folders: [], meta: { validationMode: 'warn', rdf: SHARED_RDF } },
      ],
      networks: [network()],
    });
  });
  after(async () => {
    inst?.close();
    delete process.env['PUBLIC_BASE_URL'];
    await closeTestMongo();
  });

  const write = (door, spaceId, meta) => inst.doors[door](spaceId, structuredClone(meta));
  const rdfOf = (spaceId) => inst.heldMeta(spaceId).rdf;

  for (const door of DOORS) {
    describe(door, () => {
      it('RDF is off until switched on: a write that says nothing of rdf leaves none', async () => {
        inst.reset();
        const answer = await write(door, SOLO, { purpose: 'p' });
        assert.equal(answer.refused, false, answer.text.slice(0, 300));
        assert.equal(rdfOf(SOLO), undefined);
      });
      it('the first enable with only the fallback URL is 400 rdf_base_needed', async () => {
        inst.reset();
        delete process.env['PUBLIC_BASE_URL'];
        const answer = await write(door, SOLO, { rdf: { enabled: true } });
        assert.equal(answer.status, 400, answer.text.slice(0, 300));
        assert.match(answer.text, /rdf_base_needed/);
        assert.equal(rdfOf(SOLO), undefined, 'nothing was stored');
      });
      it('the first enable takes <public url>/ld/<space>/', async () => {
        inst.reset();
        process.env['PUBLIC_BASE_URL'] = 'https://pub.example.org/';
        try {
          const answer = await write(door, SOLO, { rdf: { enabled: true } });
          assert.equal(answer.refused, false, answer.text.slice(0, 300));
          assert.deepEqual(rdfOf(SOLO), { enabled: true, base: 'https://pub.example.org/ld/solo/', vocab: 'https://pub.example.org/ld/solo/vocab/', baseEpoch: 0 });
        } finally { delete process.env['PUBLIC_BASE_URL']; }
      });
      it('off keeps the base, on again reuses it, an omission keeps it', async () => {
        inst.reset();
        assert.equal((await write(door, SOLO, { rdf: { enabled: true, base: OLD } })).refused, false);
        const held = rdfOf(SOLO);
        assert.equal(held.base, OLD);
        assert.equal((await write(door, SOLO, { rdf: { enabled: false } })).refused, false);
        assert.deepEqual(rdfOf(SOLO), { ...held, enabled: false });
        assert.equal((await write(door, SOLO, { rdf: { enabled: true } })).refused, false);
        assert.deepEqual(rdfOf(SOLO), held);
        assert.equal((await write(door, SOLO, { purpose: 'another purpose' })).refused, false);
        assert.deepEqual(rdfOf(SOLO), held);
      });
      it('a different base is 409 rdf_base_frozen naming both; rebase raises the epoch', async () => {
        inst.reset();
        await write(door, SOLO, { rdf: { enabled: true, base: OLD } });
        const frozen = await write(door, SOLO, { rdf: { enabled: true, base: NEW } });
        assert.equal(frozen.status, 409, frozen.text.slice(0, 300));
        assert.match(frozen.text, /rdf_base_frozen/);
        assert.ok(frozen.text.includes(OLD) && frozen.text.includes(NEW), frozen.text.slice(0, 300));
        assert.equal(rdfOf(SOLO).base, OLD);
        const rebased = await write(door, SOLO, { rdf: { enabled: true, base: NEW, rebase: true } });
        assert.equal(rebased.refused, false, rebased.text.slice(0, 300));
        assert.deepEqual(rdfOf(SOLO), { enabled: true, base: NEW, vocab: `${NEW}vocab/`, baseEpoch: 1 });
      });
      it('a write leaving two terms with one address is 422 rdf_term_clash naming both', async () => {
        inst.reset();
        await write(door, SOLO, { rdf: { enabled: true, base: OLD } });
        const answer = await write(door, SOLO, { typeSchemas: { entity: {
          person: { iri: 'https://schema.org/Person' }, human: { iri: 'https://schema.org/Person' } } } });
        assert.equal(answer.status, 422, answer.text.slice(0, 300));
        assert.match(answer.text, /rdf_term_clash/);
        assert.ok(answer.text.includes('person') && answer.text.includes('human'), answer.text.slice(0, 300));
      });
      it('the same clash on a space with RDF off is no clash: nothing changes until it is switched on', async () => {
        inst.reset();
        const answer = await write(door, SOLO, { typeSchemas: { entity: {
          person: { iri: 'https://schema.org/Person' }, human: { iri: 'https://schema.org/Person' } } } });
        assert.equal(answer.refused, false, answer.text.slice(0, 300));
      });
      it('on a networked space rebase opens a space_rebase round and the base is unchanged', async () => {
        inst.reset();
        const net = inst.loader.getConfig().networks.find(n => n.id === NET_ID);
        net.pendingRounds = [];
        const answer = await write(door, SHARED, { rdf: { enabled: true, base: 'https://new.example.org/ld/shared/', rebase: true } });
        assert.equal(answer.refused, false, answer.text.slice(0, 300));
        assert.match(answer.text, /vote_pending|vote pending|network vote/i, answer.text.slice(0, 300));
        assert.deepEqual(rdfOf(SHARED), SHARED_RDF, 'the base moves at the round\'s deadline, never at the door');
        const rounds = net.pendingRounds.filter(r => r.type === 'space_rebase');
        assert.equal(rounds.length, 1, JSON.stringify(net.pendingRounds));
        assert.deepEqual(rounds[0].rebase, { base: 'https://new.example.org/ld/shared/', vocab: 'https://new.example.org/ld/shared/vocab/', epoch: 1 });
        const again = await write(door, SHARED, { rdf: { enabled: true, base: 'https://new.example.org/ld/shared/', rebase: true } });
        assert.equal(again.refused, false, again.text.slice(0, 300));
        assert.equal(net.pendingRounds.filter(r => r.type === 'space_rebase').length, 1, 'a repeat answers the round in progress and opens no second one');
      });
      it('on a networked space a different base without rebase is frozen too', async () => {
        inst.reset();
        const answer = await write(door, SHARED, { rdf: { enabled: true, base: 'https://new.example.org/ld/shared/' } });
        assert.equal(answer.status, 409, answer.text.slice(0, 300));
      });
    });
  }
});
