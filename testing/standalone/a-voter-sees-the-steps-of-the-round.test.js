/**
 * A member asked to vote on a schema round can read the conversion steps the round carries before it casts, on both doors alike (`Q-745`,
 * bundle-284 design r5 sections 3 and 4.1).
 *
 * ## What it prevents
 *
 * A yes on a `meta_change` round that carries `convertRecords` is also a yes to rewriting every record of the named types on every member that
 * applies the steps. The vote rows the operator doors answer (`GET /api/networks/:id/votes`, MCP `network_votes`) are projected
 * (`roundForOperator`: the proposal body, a candidate's credential record and an invite key's hash are left out, a `summary` sentence stands in
 * for the schema). A projection that dropped `convertRecords` beside `pendingMeta` would have a member vote on a rewrite it cannot see.
 *
 * ## What holds
 *
 * - the open round's row carries the round's `convertRecords` exactly as the round holds it, on REST and on MCP;
 * - both doors answer the same row, and neither hands out what the projection keeps from an operator (`pendingMeta`, `metaBase`);
 * - a round that carried no steps has no `convertRecords` key on its row.
 *
 * Run: node --test testing/standalone/a-voter-sees-the-steps-of-the-round.test.js
 * (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempInstanceDir, bootInstance, removeInstanceDir, callRoute } from './_vote-round-instance.mjs';
import { SELF, P1 } from './_vote-round-sites.mjs';

const dir = tempInstanceDir('ythril-voter-sees-steps-');
const NET = '44444444-4444-4444-8444-444444444444';
const AUTH = { rights: { instanceAdmin: true, perSpace: {} } };
const string = { type: 'string' };
const STEPS = {
  steps: [
    { op: 'renameProperty', kind: 'entity', type: 'Person', from: 'fullName', to: 'name' },
    { op: 'renameType', kind: 'entity', from: 'Human', to: 'Person' },
  ],
};

describe('a voter sees the steps of the round it votes on', () => {
  let loader, votesRouter, network_votesTool;
  before(async () => {
    loader = await bootInstance(dir, { instanceId: SELF, spaces: [
      { id: 'people', label: 'People', folders: [] },
      { id: 'general', label: 'General', builtIn: true, folders: [] },
    ] });
    ({ votesRouter } = await import('../../server/dist/api/networks/votes.js'));
    ({ network_votesTool } = await import('../../server/dist/mcp/tools/networks.js'));
    const now = Date.now();
    const round = (roundId, extra) => ({
      roundId, type: 'meta_change', subjectInstanceId: P1, subjectLabel: 'proposer', subjectUrl: '',
      openedAt: new Date(now).toISOString(), deadline: new Date(now + 86_400_000).toISOString(), votes: [],
      spaceId: 'people', changedTypes: ['entity:Person'], metaChangedFields: ['typeSchemas'], baseMetaVersion: 0,
      metaBase: { typeSchemas: { entity: { Person: { propertySchemas: { fullName: string } } } } },
      pendingMeta: { typeSchemas: { entity: { Person: { propertySchemas: { name: string } } } } },
      ...extra,
    });
    loader.getConfig().networks.push({
      id: NET, label: 'Net', type: 'closed', origin: 'joined', syncSchedule: '', spaces: ['people'], votingDeadlineHours: 24,
      createdAt: '2026-01-01T00:00:00.000Z',
      members: [{ instanceId: P1, label: 'proposer', url: 'https://peer.example', tokenHash: 'h', direction: 'both' }],
      pendingRounds: [round('round-with-steps', { convertRecords: STEPS }), round('round-without-steps', {})],
    });
  });
  after(() => { removeInstanceDir(dir); });

  const rest = async () => {
    const r = await callRoute(votesRouter, 'get', '/:id/votes', { params: { id: NET }, authToken: AUTH });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    return r.body.rounds;
  };
  const mcp = async () => {
    const r = await network_votesTool.handle({ args: { id: NET }, rights: AUTH.rights });
    assert.ok(!r.isError, JSON.stringify(r.content));
    return r.structuredContent.rounds;
  };

  for (const [name, door] of [['GET /api/networks/:id/votes', rest], ['MCP network_votes', mcp]]) {
    it(`${name}: the open round's row carries its convertRecords, and none of what is kept from an operator`, async () => {
      const rows = await door();
      const row = rows.find(r => r.roundId === 'round-with-steps');
      assert.ok(row, `the open round is not listed: ${JSON.stringify(rows.map(r => r.roundId))}`);
      assert.deepEqual(row.convertRecords, STEPS, 'the voter cannot read the steps it votes on');
      assert.equal('pendingMeta' in row, false);
      assert.equal('metaBase' in row, false);
    });

    it(`${name}: a round that carried no steps has no convertRecords on its row`, async () => {
      const row = (await door()).find(r => r.roundId === 'round-without-steps');
      assert.ok(row);
      assert.equal('convertRecords' in row, false);
    });
  }

  it('both doors answer the same rows', async () => {
    assert.deepEqual(await mcp(), await rest());
  });
});
