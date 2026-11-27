/**
 * A recall driven as a caller drives it, on a real store, with an embedder and a text index the spec can watch (bundle-378, Q-976, fix round A).
 *
 * ## The question it answers
 *
 * "What does one recall, asked by this caller with these rights, do to the embedder, the text query and the answer?" The specs of the
 * recall caches (a query vector is kept per caller, a text query ends with its recall, a cached vector still meets the rights filter) each
 * ask it, so the setup lives here once.
 *
 * ## What it prevents
 *
 * - **A recall that reaches no embedder.** The embedder is a counting HTTP endpoint (`embedder.inputs` is every text it was asked, as the
 *   model call sends it), so "embedded once" is a count of requests the endpoint saw, never a claim the code makes about itself.
 * - **A text query nobody watches.** `watchTextFinds` notes each `$text` find with the options it was sent with, so a spec can read its
 *   deadline and its signal.
 * - **A caller that is not one.** `recallAs` goes through MCP's `callTool` with the token id and rights it is given, the same dispatch REST's
 *   generic tool door reaches, so the caller id the cache keys on is the one a real request carries (`null` is a caller with no identity).
 *
 * The vector index answers nothing (as for a record written just now), so the fresh-write scan supplies the records: every record is
 * found by its vector at its own angle from the query axis, and by its `matchedText` through the text index.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Collection } from 'mongodb';
import { openTestMongo, closeTestMongo } from './_mongo-harness.mjs';
import { queryAxis, unitAt, createSpaceCollections } from './_vector-harness.mjs';
import { patchVectorSearch, answersNothing } from './_mongot-refusals.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const DIMS = 8;

/** A caller with the instance's full rights. */
export async function adminRights() {
  const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
  return { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
}

/** A caller who reads the knowledge of `spaces` and nothing else. */
export const readerOf = (...spaces) => ({
  instanceAdmin: false, createSpaces: false, floor: null,
  perSpace: Object.fromEntries(spaces.map(s => [s, { knowledge: 'read', files: 'none', schema: 'none', dataQuality: 'none', networks: 'none' }])),
});

/** An OpenAI-shaped embedding endpoint that logs each input and can be told to refuse (`failing`). Sets `EMBEDDING_URL`. */
export async function startCountingEmbedder() {
  const inputs = [];
  const state = { failing: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const input = JSON.parse(body || '{}').input;
      inputs.push(String(input));
      if (state.failing) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'the embedder refuses this input' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ index: 0, embedding: queryAxis(DIMS) }] }));
    });
  });
  const { url, close } = await listenOnLoopback(server);
  process.env['EMBEDDING_URL'] = url;
  return { url, inputs, close, get failing() { return state.failing; }, set failing(v) { state.failing = v; } };
}

/** Note each `$text` find the server's driver is sent, in order, with the options it carried. */
export function watchTextFinds() {
  const original = Collection.prototype.find;
  const finds = [];
  Collection.prototype.find = function find(filter, ...rest) {
    if (filter && typeof filter === 'object' && '$text' in filter) finds.push({ collection: this.collectionName, options: rest[0] ?? {} });
    return original.call(this, filter, ...rest);
  };
  return { finds, restore: () => { Collection.prototype.find = original; } };
}

/**
 * Open the instance: `spaces` is `{ <id>: [{ id, deg, text }] }`, each record written just now at `deg` degrees from the query axis.
 * @returns `{ mongo, embedder, recallAs, recallDirect, textFinds, metric, close }`
 */
export async function openRecallCaller({ suite, spaces }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ythril-${suite}-`));
  process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
  process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
  process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
  for (const k of ['SKIP_GLOBAL_RATE_LIMIT', 'SKIP_AUTH_RATE_LIMIT']) process.env[k] = 'true';
  delete process.env['YTHRIL_HYBRID_SEARCH'];
  fs.mkdirSync(process.env['DATA_ROOT'], { recursive: true });
  const embedder = await startCountingEmbedder();
  fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
    instanceId: suite, instanceLabel: 'test', tokens: [], networks: [],
    spaces: Object.keys(spaces).map(id => ({ id, label: id, folders: [], completeLinkage: true })),
  }, null, 2), { mode: 0o600 });
  const mongo = await openTestMongo(suite);
  (await import('../../server/dist/config/loader.js')).loadConfig();
  const { callTool } = await import('../../server/dist/mcp/call-tool.js');
  await mongo.checkVectorSearchAvailability();
  const now = new Date().toISOString();
  for (const [space, records] of Object.entries(spaces)) {
    await createSpaceCollections(mongo, space);
    await mongo.col(`${space}_entities`).createIndex({ matchedText: 'text' }, { name: 'lexical_text' });
    if (records.length === 0) continue;
    await mongo.col(`${space}_entities`).insertMany(records.map((r, i) => ({
      _id: r.id, spaceId: space, name: r.id, type: 'thing', tags: [], properties: {}, matchedText: r.text,
      embedding: unitAt(r.deg, DIMS), embeddingModel: 'stub', seq: i + 1, createdAt: now, updatedAt: now,
    })));
  }
  const noIndexHits = patchVectorSearch(() => answersNothing());
  const textFinds = watchTextFinds();

  /** One recall as `tokenId` (or no identity, `null`) with `rights`. `text` is the answer; `failed` says whether the call was refused. */
  async function recallAs(tokenId, rights, args) {
    const out = await callTool({
      name: 'recall', args: { topK: 10, types: ['entity'], ...args },
      caller: { rights, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId, tokenLabel: tokenId },
    });
    const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
    return { failed: out.result.isError === true, text, meta: out.result._meta ?? null };
  }

  /** One recall of one space straight through `recall()`, as the ingest shortlist calls it (no fan-out, no caller): resolves its results, rejects as the recall does. */
  async function recallDirect(space, query) {
    const { recall } = await import('../../server/dist/brain/recall.js');
    return recall(space, query, 10, undefined, ['entity']);
  }

  /** The value of the series `name{labels}` as the registry says it now (`null` when it has no such series). */
  async function metric(name, labels = {}) {
    const { register } = await import('../../server/dist/metrics/registry.js');
    const text = await register.metrics();
    const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
    for (const line of text.split('\n')) {
      if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
      if (wanted.every(w => line.includes(w))) return Number(line.slice(line.lastIndexOf(' ') + 1));
    }
    return null;
  }

  async function close() {
    noIndexHits.restore();
    textFinds.restore();
    await closeTestMongo();
    await embedder.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  return { mongo, embedder, recallAs, recallDirect, textFinds: textFinds.finds, metric, close };
}
