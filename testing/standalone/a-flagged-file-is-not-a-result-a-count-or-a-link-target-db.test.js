/**
 * A soft-deleted file's row is not a result, not a count and not a link target (bundle-89, Q-418).
 *
 * ## The rule
 *
 * With `softDeleteFileMeta` on, a deleted file's row stays in `<space>_files` flagged `deletedAt`: an audit record,
 * local to this instance. The rule is one sentence: a flagged row is not a result, not a count and not a link target.
 * Many readers of the `files` collection ask `LIVE_FILE_ROW` (`files/live-file-row.ts`) and many do not, and a reader
 * that forgets is invisible until a deleted file shows up as a hit, a count or a valid link end.
 *
 * Recall and `similar` have a fixture of their own (they need a vector index): `a-flagged-file-is-not-a-recall-result-db.test.js`.
 *
 * ## One fixture, every reader, asserted by identity
 *
 * One space holds a live file `live.md` (row and bytes), two chunk rows of it, and a flagged `gone.md` whose row still
 * carries a description, a hash and `embeddingStatus: complete`. Each case drives a REAL door against that one space and
 * asserts what came back BY ID — `gone.md` absent, `live.md` present — so a reader that looked in the wrong place cannot
 * pass on a count. Cases marked `control` ask a reader that already applies the predicate today (or a pure function): they
 * are green on purpose, and are here so a later edit that loosens one fails too.
 *
 * - `filter` over `files`, on both doors (`POST /api/filter` is `callTool` with the rest transport; MCP is `callTool`).
 * - a graph walk's endpoint resolution (`endpointRecordsByKind`, reached by `graph_traverse`), lean and with `projection`.
 * - `withTraverseBodies`, the bodies a walk attaches, called directly with a node naming the flagged file.
 * - the dispatcher's prior-row read (`files/dispatch.ts`, `readPriorProcessing`) through `recordAndDispatchFile`: a flagged
 *   row that keeps its hash and `complete` makes a re-upload of the same bytes to the path skip all processing.
 * - the file listing and the sync `filemeta` page (control), and the pull's held-row repair rule (control).
 * - the strict-linkage existence check (`missingRefs`): an edge or a link whose target is the flagged file is refused like a
 *   missing one, on the REST edges route, `save_edge` and `save_link`; a live file target is the accepted control.
 * - the three FILES COUNTS agree: REST stats, MCP `space_stats` and `space_meta` all say 1 for 1 live file, 2 chunks and
 *   1 flagged row, read in one case with each surface's number in the message (one surface weaker is the failure).
 *
 * Run: a Mongo the harness accepts, then
 *      node --test testing/standalone/a-flagged-file-is-not-a-result-a-count-or-a-link-target-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'e2rd';
const T0 = '2026-09-01T00:00:00.000Z';
const LIVE = 'live.md';
const GONE = 'gone.md';
const FLAGGED_BODY = 'FLAGGED-BODY-must-not-surface';
const E1 = 'cccccccc-0000-4000-8000-0000000e2101';
const E2 = 'cccccccc-0000-4000-8000-0000000e2102';
const EDGE_LIVE = 'cccccccc-0000-4000-8000-0000000e2111';
const EDGE_GONE = 'cccccccc-0000-4000-8000-0000000e2112';

let door, config, callTool, ADMIN, searchRouter, edgesRouter, fileStoreRouter, files;

const caller = (transport) => ({ rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport, tokenId: 't', tokenLabel: 't' });

/** A tool through `callTool`, as `POST /api/<tool>` (transport `rest`) or as MCP (transport `mcp`) reaches it. */
async function tool(transport, name, args) {
  const out = await callTool({ name, args: { space: S, ...args }, caller: caller(transport) });
  const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: out.status, isError: !!out.result.isError, text, json, sc: out.result.structuredContent ?? {} };
}
const TRANSPORTS = ['rest', 'mcp'];
/** The rows `filter` answered: its `results` array (carried in `structuredContent`, and as the text of the answer). */
const rowsOf = (out) => out.sc?.results ?? (Array.isArray(out.json) ? out.json : out.json?.results) ?? [];

/** A REST route's own handler, past rate limit and auth. */
function routeHandler(router, method, routePath) {
  const layer = router.stack.find(l => l.route?.path === routePath && l.route.methods[method]);
  assert.ok(layer, `no ${method.toUpperCase()} ${routePath} on its router — re-anchor this test`);
  return layer.route.stack.at(-1).handle;
}
async function viaRoute(handler, { params = {}, query = {}, body = {} } = {}) {
  const req = { method: 'X', params, query, body, ip: '127.0.0.1', get: () => undefined, headers: {},
    authToken: { id: 't', name: 'test', rights: ADMIN } };
  const res = { code: 200, body: undefined, headersSent: false,
    status(c) { this.code = c; return this; }, setHeader() { return this; },
    json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
  await handler(req, res);
  return { status: res.code, body: res.body };
}

const row = (id, extra = {}) => ({ _id: id, spaceId: S, path: id, sizeBytes: 10, tags: [], createdAt: T0, updatedAt: T0, seq: 1, ...extra });

describe('a flagged file is not a result, a count or a link target', { skip }, () => {
  before(async () => {
    // `completeLinkage`: the space's links are records (a walk refuses a space that has not been converted).
    door = await openPushDoor({ suite: 'b89e2creaders', spaces: [{ id: S, label: S, folders: [], completeLinkage: true, meta: { suppressEmbeddings: true } }] });
    config = (await import('../../server/dist/config/loader.js')).getConfig();
    config.softDeleteFileMeta = true;
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    ({ searchRouter } = await import('../../server/dist/api/brain/search.js'));
    ({ edgesRouter } = await import('../../server/dist/api/brain/edges.js'));
    ({ fileStoreRouter } = await import('../../server/dist/api/files.js'));
    files = await import('../../server/dist/files/files.js');

    fs.mkdirSync(path.join(process.env['DATA_ROOT'], 'files', S), { recursive: true });
    await files.writeFile(S, LIVE, 'the live file');
    const rows = door.coll(S, 'files');
    await rows.insertMany([
      row(LIVE, { description: 'live description', sha256: 'live-sha', embeddingStatus: 'complete' }),
      row(`${LIVE}#chunk0`, { parentFileId: LIVE, chunkIndex: 0, content: 'chunk zero' }),
      row(`${LIVE}#chunk1`, { parentFileId: LIVE, chunkIndex: 1, content: 'chunk one' }),
      // The audit row a soft delete left: no bytes, but a description, a hash and a finished state, as a field instance holds.
      row(GONE, { description: FLAGGED_BODY, sha256: 'gone-sha', embeddingStatus: 'complete', deletedAt: T0 }),
    ]);
    await door.coll(S, 'entities').insertMany([
      { _id: E1, spaceId: S, name: 'Hub', type: 'thing', tags: [], properties: {}, seq: 1, createdAt: T0, updatedAt: T0 },
      { _id: E2, spaceId: S, name: 'Other', type: 'thing', tags: [], properties: {}, seq: 1, createdAt: T0, updatedAt: T0 },
    ]);
    await door.coll(S, 'edges').insertMany([
      { _id: EDGE_LIVE, spaceId: S, from: E1, to: LIVE, toKind: 'file', label: 'cites', tags: [], seq: 1, createdAt: T0, updatedAt: T0 },
      { _id: EDGE_GONE, spaceId: S, from: E1, to: GONE, toKind: 'file', label: 'cites', tags: [], seq: 1, createdAt: T0, updatedAt: T0 },
    ]);
  });
  after(async () => {
    delete config?.softDeleteFileMeta;
    await door?.close();
  });

  describe('fixture', () => {
    it('holds one live file, two chunks and one flagged row', async () => {
      const all = await door.coll(S, 'files').find({}).toArray();
      assert.deepEqual(all.map(r => r._id).sort(), [GONE, LIVE, `${LIVE}#chunk0`, `${LIVE}#chunk1`].sort());
      assert.deepEqual(all.filter(r => r.deletedAt !== undefined).map(r => r._id), [GONE]);
    });
  });

  describe('filter over files', () => {
    for (const transport of TRANSPORTS) {
      it(`${transport === 'mcp' ? 'MCP filter' : 'POST /api/filter'}: the flagged row is not a result, the live file is`, async () => {
        const out = await tool(transport, 'filter', { collection: 'files', limit: 100 });
        assert.equal(out.isError, false, out.text.slice(0, 300));
        const ids = rowsOf(out).map(r => String(r._id));
        assert.ok(ids.includes(LIVE), `control: the live file is not in [${ids.join(', ')}] — the read looked in the wrong place: ${out.text.slice(0, 300)}`);
        assert.ok(!ids.includes(GONE), `filter over files returned the soft-deleted row ${GONE}: [${ids.join(', ')}]`);
        // Asked for by id, the flagged row is still not there: no predicate of the caller's finds an audit row.
        const asked = await tool(transport, 'filter', { collection: 'files', filter: { _id: GONE } });
        assert.deepEqual(rowsOf(asked).map(r => r._id), [], `filter {_id: ${GONE}} returned the flagged row`);
      });
    }
  });

  describe('a graph walk', () => {
    for (const transport of TRANSPORTS) {
      for (const withBodies of [false, true]) {
        it(`${transport === 'mcp' ? 'MCP graph_traverse' : 'POST /api/graph_traverse'}${withBodies ? ' with projection' : ''}: an edge to the flagged file does not reach it`, async () => {
          const out = await tool(transport, 'graph_traverse', {
            startId: E1, maxDepth: 2, ...(withBodies ? { projection: { description: 1, path: 1 } } : {}) });
          assert.equal(out.isError, false, out.text.slice(0, 300));
          const ids = (out.json?.nodes ?? []).map(n => String(n._id ?? n.id));
          assert.ok(ids.includes(LIVE), `control: the live file endpoint is not reached: [${ids.join(', ')}]`);
          assert.ok(!ids.includes(GONE), `the walk reached the soft-deleted file ${GONE}: [${ids.join(', ')}]`);
          assert.ok(!out.text.includes(FLAGGED_BODY), 'the flagged row\'s description came back inside the walk');
        });
      }
    }

    it('the bodies a walk attaches (withTraverseBodies) are never the flagged row\'s', async () => {
      const { withTraverseBodies } = await import('../../server/dist/brain/traverse-bodies.js');
      const { normaliseProjection } = await import('../../server/dist/brain/projection.js');
      const result = {
        nodes: [
          { _id: E1, name: 'Hub', type: 'thing', depth: 0 },
          { _id: LIVE, name: LIVE, type: 'file', kind: 'file', depth: 1 },
          { _id: GONE, name: GONE, type: 'file', kind: 'file', depth: 1 },
        ],
        edges: [],
      };
      const out = await withTraverseBodies([S], result, normaliseProjection({ description: 1, path: 1 }), false);
      const byId = new Map(out.nodes.map(n => [String(n._id), n]));
      assert.equal(byId.get(LIVE)?.description, 'live description', 'control: the live file\'s body was not attached');
      assert.notEqual(byId.get(GONE)?.description, FLAGGED_BODY, 'withTraverseBodies attached the soft-deleted row\'s body to a node');
    });
  });

  describe('re-uploading the same bytes to a soft-deleted path', () => {
    it('is processed, not skipped on the flagged row\'s stale hash and finished state (dispatch prior read)', async () => {
      const { recordAndDispatchFile } = await import('../../server/dist/files/dispatch.js');
      const answer = await recordAndDispatchFile(S, GONE, { bytes: 10, sha256: 'gone-sha' }, async () => {});
      assert.notEqual(answer.embeddingStatus, 'complete',
        `the dispatcher read the flagged row's hash and 'complete' as work already done and skipped the processing: ${JSON.stringify(answer)}`);
    });
    it('control: a live row with the same hash and a finished state IS skipped', async () => {
      const { recordAndDispatchFile } = await import('../../server/dist/files/dispatch.js');
      const answer = await recordAndDispatchFile(S, LIVE, { bytes: 10, sha256: 'live-sha' }, async () => {});
      assert.equal(answer.embeddingStatus, 'complete', `the identical-bytes skip no longer fires for a live file: ${JSON.stringify(answer)}`);
    });
  });

  describe('readers that already ask the question (controls)', () => {
    it('control: the REST file listing does not show or describe the flagged row', async () => {
      const handler = routeHandler(fileStoreRouter, 'get', '/:spaceId');
      const out = await viaRoute(handler, { params: { spaceId: S }, query: { path: '/' } });
      assert.equal(out.status, 200, JSON.stringify(out.body).slice(0, 300));
      assert.ok(!JSON.stringify(out.body).includes(FLAGGED_BODY), 'the listing carried the flagged row\'s metadata');
      assert.ok(!JSON.stringify(out.body).includes(GONE), 'the listing named the flagged file');
      assert.ok(JSON.stringify(out.body).includes(LIVE), 'the live file is not listed — the control reads nothing');
    });
    it('control: a sync filemeta page offers the live file and neither the chunks nor the flagged row', async () => {
      const page = await door.pull('/filemeta', { spaceId: S });
      const ids = (page.filemeta ?? page.files ?? page.docs ?? Object.values(page).find(Array.isArray) ?? []).map(d => d._id);
      assert.ok(ids.includes(LIVE), `the live file is not offered: ${JSON.stringify(page).slice(0, 300)}`);
      assert.deepEqual(ids.filter(id => id === GONE || id.includes('#chunk')), [], 'a flagged row or a chunk was offered to a peer');
    });
    it('control: the pull repairs no flagged row (sync/file-sync.ts heldRowsFor carries `deletedAt`; repairReasonOf honours it)', async () => {
      const { repairReasonOf } = await import('../../server/dist/sync/file-sync.js');
      assert.equal(repairReasonOf({ sha256: 'old', deletedAt: T0 }, 'a-different-hash', GONE), null);
      assert.equal(repairReasonOf({ sha256: 'old' }, 'a-different-hash', GONE), 'stale_row', 'control: an unflagged stale row IS repaired');
    });
  });

  describe('a link target', () => {
    const edgeArgs = (to, label) => ({ from: E2, fromKind: 'entity', to, toKind: 'file', label });
    const storedTo = (to, label) => door.coll(S, 'edges').countDocuments({ from: E2, to, label });

    for (const transport of TRANSPORTS) {
      it(`${transport === 'mcp' ? 'MCP save_edge' : 'POST /api/save_edge'}: a flagged file is refused like a missing one, a live file is accepted`, async () => {
        const accepted = await tool(transport, 'save_edge', edgeArgs(LIVE, `ok-${transport}`));
        assert.equal(accepted.isError, false, `control: an edge to the live file was refused: ${accepted.text.slice(0, 300)}`);
        const refused = await tool(transport, 'save_edge', edgeArgs(GONE, `gone-${transport}`));
        assert.equal(refused.isError, true, `an edge to the soft-deleted file ${GONE} was accepted: ${refused.text.slice(0, 200)}`);
        assert.match(refused.text, /does not exist|not exist/i);
        assert.equal(await storedTo(GONE, `gone-${transport}`), 0, 'the edge to the flagged file was stored');
      });

      // A link class always hangs off a file (file.entityIds ...), never at one: the FILE is the `from` of the link record.
      it(`${transport === 'mcp' ? 'MCP save_link' : 'POST /api/save_link'}: a link hung off a flagged file is refused like a missing one, off a live file accepted`, async () => {
        const link = (from) => ({ from, fromKind: 'file', to: E2, toKind: 'entity' });
        const accepted = await tool(transport, 'save_link', link(LIVE));
        assert.equal(accepted.isError, false, `control: a link off the live file was refused: ${accepted.text.slice(0, 300)}`);
        const refused = await tool(transport, 'save_link', link(GONE));
        assert.equal(refused.isError, true, `a link off the soft-deleted file ${GONE} was accepted: ${refused.text.slice(0, 200)}`);
        assert.equal(await door.coll(S, 'links').countDocuments({ from: GONE }), 0, 'the link off the flagged file was stored');
      });
    }

    it('REST POST /edges: a flagged file is a 400 like a missing one, a live file is accepted', async () => {
      const handler = routeHandler(edgesRouter, 'post', '/spaces/:spaceId/edges');
      const accepted = await viaRoute(handler, { params: { spaceId: S }, body: edgeArgs(LIVE, 'ok-route') });
      assert.ok(accepted.status < 300, `control: ${accepted.status} ${JSON.stringify(accepted.body).slice(0, 300)}`);
      const refused = await viaRoute(handler, { params: { spaceId: S }, body: edgeArgs(GONE, 'gone-route') });
      assert.equal(refused.status, 400, `an edge to the flagged file answered ${refused.status}: ${JSON.stringify(refused.body).slice(0, 300)}`);
      assert.equal(await storedTo(GONE, 'gone-route'), 0, 'the edge to the flagged file was stored');
    });

    it('MCP update_file_meta: a flagged file takes no links (it is not a file to edit), a live file does', async () => {
      const accepted = await tool('mcp', 'update_file_meta', { path: LIVE, linkEntities: [E1] });
      assert.equal(accepted.isError, false, `control: the live file's links were refused: ${accepted.text.slice(0, 300)}`);
      const refused = await tool('mcp', 'update_file_meta', { path: GONE, linkEntities: [E1] });
      assert.equal(refused.isError, true, `the soft-deleted file ${GONE} was edited: ${refused.text.slice(0, 200)}`);
      assert.equal(await door.coll(S, 'links').countDocuments({ from: GONE }), 0, 'a link was written off the flagged file');
    });

    it('control: a file that never existed is refused (the answer a flagged file must now share)', async () => {
      const refused = await tool('mcp', 'save_edge', edgeArgs('never-was.md', 'never'));
      assert.equal(refused.isError, true, 'a missing file was accepted — the strict-linkage check is not running in this space');
    });
  });

  describe('the three files counts', () => {
    it('REST stats, MCP space_stats and space_meta all count the 1 live file — not 2 chunks, not the flagged row', async () => {
      const statsHandler = routeHandler(searchRouter, 'get', '/spaces/:spaceId/stats');
      const rest = () => viaRoute(statsHandler, { params: { spaceId: S } });
      const before = await rest();
      const stats = await tool('mcp', 'space_stats', {});
      const meta = await tool('mcp', 'space_meta', {});
      const after = await rest();
      const numbers = {
        'REST GET /spaces/:spaceId/stats': before.body?.files,
        'MCP space_stats': stats.sc?.files ?? stats.json?.files,
        'space_meta (space-shape.ts)': meta.sc?.stats?.files ?? meta.json?.stats?.files,
      };
      // Sandwich: the REST number is read on both sides, so a count that moved under the read cannot be what disagrees.
      assert.equal(before.body?.files, after.body?.files, 'the live count moved while it was being read');
      for (const [surface, n] of Object.entries(numbers)) {
        assert.equal(typeof n, 'number', `${surface} answered no files count: ${JSON.stringify({ meta: meta.text.slice(0, 200) })}`);
      }
      assert.deepEqual(numbers, Object.fromEntries(Object.keys(numbers).map(k => [k, 1])),
        `the files count must be 1 on every surface (1 live file; 2 chunk rows and 1 flagged row are not files): ${JSON.stringify(numbers)}`);
    });
  });
});
