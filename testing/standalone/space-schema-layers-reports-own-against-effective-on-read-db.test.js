/**
 * `space_schema_layers` reports, per field, what this instance's own definitions hold against what the space runs on, and which
 * layer wins — derived on READ, on REST and on MCP alike (`R6-8`, Q-67).
 *
 * ## The question
 *
 * A space in networks runs on `own ⊕ layers` and a layer outranks the own definitions (`F-39.2`). So an edit of an own definition
 * can be stored and never seen: the field comes back as a network's value. Q-67 asked that this be VISIBLE rather than refused
 * (a request-time refusal would block every single-network edit and name a door three routes lack). The answer is on the one
 * act both doors read, `space_schema_layers`: for each top-level meta field some layer supplies,
 *
 *     fields: [{ field, own, effective, winner, hidden }]
 *
 * `own` is what the own definitions hold, `effective` what the space runs on, `winner` the network id of the layer the effective
 * value comes from (`'own'` when no layer supplies the field), and `hidden` is true exactly when the own definitions hold a value
 * the space does not run on.
 *
 * ## Derived, never recorded
 *
 * Nothing is stored for it: the view is computed from the own definitions, the layers and the precedence at the moment it is
 * read, so it cannot go stale. The cases prove that by changing each input and reading again with NO round concluded in between:
 *
 *  - a precedence reorder moves the winner (and the effective value with it);
 *  - a layer arriving (a network's schema pulled or relayed) changes the effective value and the winner;
 *  - an own edit changes `own` and keeps the field hidden while a layer still outranks it;
 *  - a layer that now agrees with the own value un-hides the field.
 *
 * And the two doors answer the same `fields` in every state (REST route handler and the MCP tool handler, over one config).
 *
 * ## Seen red
 *
 * On 85c4c564 every case fails at its first read: the answer has `own`, `layers`, `precedence` and `clashes` and no `fields`.
 * The shape control (precedence, layers, own) passes there.
 *
 * Run: a Mongo the harness accepts, then
 *      node --test testing/standalone/space-schema-layers-reports-own-against-effective-on-read-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir, removeInstanceDir, bootInstance, callRoute } from './_vote-round-instance.mjs';

const dir = tempInstanceDir('ythril-layers-read-');
const skip = await mongoSkipReason();

const SELF = 'cccccccc-0000-4000-8000-000000005e1f';
const P1 = 'cccccccc-0000-4000-8000-0000000000a1';
const N1 = 'dddddddd-0000-4000-8000-0000000000d1';
const N2 = 'dddddddd-0000-4000-8000-0000000000d2';
const SPACE = 'notes';

const network = (id, label) => ({
  id, label, type: 'club', origin: 'joined', syncSchedule: '', spaces: [SPACE], votingDeadlineHours: 24, createdAt: '2026-01-01T00:00:00.000Z',
  members: [{ instanceId: P1, label: 'peer', url: 'https://p1.example', tokenHash: 'h', direction: 'both' }], pendingRounds: [],
});

let loader, effective, acts, restRouter, mcpTool;

/** This instance's own purpose; N1 and N2 each send a layer, N1 first (the order they were joined). */
async function boot() {
  loader = await bootInstance(dir, {
    instanceId: SELF,
    spaces: [
      { id: 'general', label: 'General', builtIn: true, folders: [] },
      { id: SPACE, label: 'Notes', folders: [], meta: { purpose: 'own purpose', usageNotes: 'own notes', version: 1, updatedAt: '2026-10-01T00:00:00.000Z' } },
    ],
    networks: [network(N1, 'Network one'), network(N2, 'Network two')],
    peerTokens: { [P1]: 'token-p1' },
  });
  effective.storeNetworkLayer(N1, SPACE, { purpose: 'n1 purpose' });
  effective.storeNetworkLayer(N2, SPACE, { purpose: 'n2 purpose', validationMode: 'warn' });
}

/** The answer on both doors; asserts they agree on everything a caller reads, and returns the REST body. */
async function read() {
  const rest = await callRoute(restRouter, 'get', '/:id/schema-layers', { params: { id: SPACE }, authToken: { rights: { instanceAdmin: true } } });
  assert.equal(rest.code, 200, JSON.stringify(rest.body));
  const mcp = await mcpTool.handle({ callSpace: SPACE, args: {}, space: SPACE });
  assert.ok(!mcp.isError, JSON.stringify(mcp));
  assert.deepEqual(mcp.structuredContent, rest.body, 'the MCP tool answers something other than the route');
  return rest.body;
}
/** The row as a client reads it: through JSON, where a value that is absent is a key that is absent. */
const field = (body, name) => { const row = body.fields?.find(f => f.field === name); return row && JSON.parse(JSON.stringify(row)); };
/** The row says what the contract names (a row may carry more, such as the round a later release links); never less. */
function assertRow(row, expected, message) {
  assert.ok(row, `${message ?? 'the field'} has no row in fields`);
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(row[key], value, `${message ?? expected.field}: ${key} (${JSON.stringify(row)})`);
}
const noRoundWasOpened = () => {
  for (const n of loader.getConfig().networks) assert.deepEqual(n.pendingRounds ?? [], [], `a round exists on ${n.label}: the view must not need one`);
};

describe('space_schema_layers: own against effective, derived on read, on both doors', { skip }, () => {
  before(async () => {
    await openTestMongo('schema_layers_read');
    effective = await import('../../server/dist/spaces/effective-meta.js');
    acts = await import('../../server/dist/spaces/schema-layers-acts.js');
    ({ spaceSchemaLayersRouter: restRouter } = await import('../../server/dist/api/spaces-schema-layers.js'));
    ({ space_schema_layersTool: mcpTool } = await import('../../server/dist/mcp/tools/schema-layers.js'));
  });
  after(async () => {
    await closeTestMongo();
    removeInstanceDir(dir);
  });
  beforeEach(async () => { await boot(); });

  it('control: the answer still carries the own definitions, each layer in precedence and the clash', async () => {
    const body = await read();
    assert.equal(body.own?.purpose, 'own purpose');
    assert.deepEqual(body.precedence, [N1, N2]);
    assert.deepEqual(body.layers.map(l => l.networkId), [N1, N2]);
    assert.ok(body.clashes.some(c => c.field === 'purpose'), 'the purpose clash between the layers is no longer listed');
  });

  it('a field a layer supplies: own against effective, the winning layer, and whether the own value is hidden', async () => {
    const body = await read();
    assert.ok(Array.isArray(body.fields), `the answer has no per-field view: ${Object.keys(body).join(', ')}`);
    assertRow(field(body, 'purpose'),
      { field: 'purpose', own: 'own purpose', effective: 'n1 purpose', winner: N1, hidden: true },
      'purpose: the own value is outranked by the first network and must be reported as hidden by it');
    // Nothing of the own definitions is hidden where the own definitions hold nothing: the layer simply supplies it.
    assertRow(field(body, 'validationMode'),
      { field: 'validationMode', own: undefined, effective: 'warn', winner: N2, hidden: false });
    // A field only the own definitions hold is the space's own: not hidden, and if listed it names no layer.
    const mine = field(body, 'usageNotes');
    assert.ok(mine === undefined || (mine.winner === 'own' && mine.hidden === false && mine.effective === 'own notes'),
      `a field no layer supplies is reported as outranked: ${JSON.stringify(mine)}`);
    noRoundWasOpened();
  });

  it('a precedence reorder moves the winner and the effective value, with no round', async () => {
    const reordered = acts.setNetworkPrecedenceAct(SPACE, { networks: [N2, N1] });
    assert.equal(reordered.status, 200, JSON.stringify(reordered));
    const body = await read();
    assertRow(field(body, 'purpose'),
      { field: 'purpose', own: 'own purpose', effective: 'n2 purpose', winner: N2, hidden: true });
    noRoundWasOpened();
  });

  it('a layer arriving changes the effective value and the winner, with no round', async () => {
    assert.equal(effective.storeNetworkLayer(N1, SPACE, { purpose: 'n1 purpose, revised by the network' }), true);
    const body = await read();
    assertRow(field(body, 'purpose'),
      { field: 'purpose', own: 'own purpose', effective: 'n1 purpose, revised by the network', winner: N1, hidden: true });
    noRoundWasOpened();
  });

  it('an own edit changes what the own definitions hold and the field stays hidden while a layer outranks it', async () => {
    effective.commitOwnMetaEdit(SPACE, base => ({ ...base, purpose: 'own purpose, edited' }));
    const body = await read();
    assertRow(field(body, 'purpose'),
      { field: 'purpose', own: 'own purpose, edited', effective: 'n1 purpose', winner: N1, hidden: true },
      'the edit was stored and the space does not run on it — that is the hidden edit the view exists to show');
    noRoundWasOpened();
  });

  it('a layer that comes to agree with the own value un-hides it', async () => {
    effective.storeNetworkLayer(N1, SPACE, { purpose: 'own purpose' });
    const body = await read();
    const purpose = field(body, 'purpose');
    assert.equal(purpose?.effective, 'own purpose');
    assert.equal(purpose?.hidden, false, `the own value is the effective value and is reported hidden: ${JSON.stringify(purpose)}`);
  });
});
