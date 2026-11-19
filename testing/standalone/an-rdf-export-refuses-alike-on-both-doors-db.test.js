/**
 * The RDF records export refuses alike on both doors, says no more in a refusal than the caller may read, and describes itself (Q-750,
 * design r4 §5.4-§5.5; parent 2026-11-19).
 *
 * ## What it holds
 *
 * - A space with RDF off is 409 `rdf_not_enabled` on both doors.
 * - A space whose base is in conflict is 409 `rdf_base_conflict` on both doors. The offering network, member and base are named only to a
 *   caller who may read that network through its own doors (`visibleNetworks`: `networks: read` on every space it carries, or administering
 *   them); any other caller is told only that the base is in conflict and who can resolve it.
 * - A token without `knowledge: read` is refused (403) on both doors.
 * - `tools/list` declares an `outputSchema` for `export_rdf` and `space_schema_rdf`, and the description of `export_rdf` states each
 *   guarantee and its cost in plain words: the four formats, the pages and `nextAfter`, the values left out, the files rung, the slots.
 *
 * Run: node --test testing/standalone/an-rdf-export-refuses-alike-on-both-doors-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta, baseOf } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const ON = 'rdfrefon';
const OFF = 'rdfrefoff';
const CONF = 'rdfrefconf';
const NET = 'net-rdf-conflict';
const PEER = 'peer-rdf-conflict';
const OFFERED = 'https://elsewhere.example.org/ld/rdfrefconf/';

describe('the RDF export refuses alike on both doors', { skip }, () => {
  let d, admin, reader, nothing;
  before(async () => {
    d = await openRdfExportDoors({ suite: 'rdf_export_refusals', spaces: [
      { id: ON, meta: rdfMeta(ON) }, { id: OFF, meta: { suppressEmbeddings: true } }, { id: CONF, meta: rdfMeta(CONF) },
    ] });
    d.loader.mutateConfig(c => {
      c.networks.push({
        id: NET, label: 'Net', type: 'club', origin: 'created', syncSchedule: '', spaces: [CONF], votingDeadlineHours: 24,
        createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
        members: [{ instanceId: PEER, label: 'Peer', url: 'https://peer.example', tokenHash: 'h', direction: 'both' }],
        rdfBaseConflicts: { [CONF]: { held: { base: baseOf(CONF), vocab: `${baseOf(CONF)}vocab/`, epoch: 0 },
          offered: [{ networkId: NET, memberId: PEER, base: OFFERED, vocab: `${OFFERED}vocab/`, epoch: 1 }] } },
      });
    });
    admin = await d.mint('admin', {}, { admin: true });
    reader = await d.mint('reader', { [ON]: d.row({ knowledge: 'read' }), [OFF]: d.row({ knowledge: 'read' }), [CONF]: d.row({ knowledge: 'read' }) });
    nothing = await d.mint('nothing', { [ON]: d.row({ files: 'read' }) });
  });
  after(async () => { await d?.close(); });

  it('RDF off is 409 rdf_not_enabled on both doors', async () => {
    const r = await d.exportRest(reader.key, OFF, {});
    assert.equal(r.status, 409, r.text.slice(0, 300));
    assert.equal(r.body?.code, 'rdf_not_enabled');
    const m = await d.exportMcp(reader.key, { space: OFF });
    assert.equal(m.isError, true);
    assert.match(m.text, /rdf_not_enabled/);
  });

  it('a base in conflict is 409 rdf_base_conflict; the network is named only to who may read it', async () => {
    const full = await d.exportRest(admin.key, CONF, {});
    assert.equal(full.status, 409, full.text.slice(0, 300));
    assert.equal(full.body?.code, 'rdf_base_conflict');
    assert.ok(full.text.includes(NET) && full.text.includes(OFFERED), full.text.slice(0, 400));
    const fullMcp = await d.exportMcp(admin.key, { space: CONF });
    assert.equal(fullMcp.isError, true);
    assert.match(fullMcp.text, /rdf_base_conflict/);
    assert.ok(fullMcp.text.includes(NET));
    const limited = await d.exportRest(reader.key, CONF, {});
    assert.equal(limited.status, 409);
    assert.equal(limited.body?.code, 'rdf_base_conflict');
    for (const hidden of [NET, PEER, OFFERED, 'Peer']) assert.ok(!limited.text.includes(hidden), `a limited caller is not told ${hidden}: ${limited.text}`);
    assert.match(limited.body?.error ?? '', /administrator/i, 'it says who can resolve it');
    const limitedMcp = await d.exportMcp(reader.key, { space: CONF });
    for (const hidden of [NET, PEER, OFFERED]) assert.ok(!limitedMcp.text.includes(hidden), limitedMcp.text);
  });

  it('a token without knowledge: read is refused on both doors', async () => {
    const r = await d.exportRest(nothing.key, ON, {});
    assert.equal(r.status, 403, r.text.slice(0, 200));
    const m = await d.exportMcp(nothing.key, { space: ON });
    assert.equal(m.isError, true);
  });

  it('both tools declare an outputSchema, and export_rdf states its guarantees and costs', async () => {
    const list = await d.rpc(admin.key, 'tools/list');
    const tools = list.result?.result?.tools ?? [];
    for (const name of ['export_rdf', 'space_schema_rdf']) {
      const tool = tools.find(t => t.name === name);
      assert.ok(tool, `${name} is listed`);
      assert.equal(tool.outputSchema?.type, 'object', `${name} declares an outputSchema`);
    }
    const exp = tools.find(t => t.name === 'export_rdf');
    for (const words of [/Turtle/, /TriG/, /N-Quads/, /JSON-LD/, /nextAfter/, /left out/i, /files: read/, /rdf_export_busy/, /knowledge: read/, /personal view/i]) {
      assert.match(exp.description, words);
    }
    assert.ok(exp.outputSchema.properties.records && exp.outputSchema.properties.complete && exp.outputSchema.properties.skippedValues);
  });
});
