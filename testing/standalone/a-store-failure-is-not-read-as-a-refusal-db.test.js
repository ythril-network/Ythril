/**
 * A store failure whose text holds the words of a refusal is the store's failure, not the caller's refusal — on the three
 * acts that used to read the wording first (bundle-53 G7, `Q-335`).
 *
 * ## The finding
 *
 * `renameSpaceAct`, `applySpaceCreate` and the link route's `addLink` catch each tested the caught error's message for
 * "not found" / "already exists" and answered what matched. The driver's own text for a failing store can hold either:
 * a `MongoNetworkError` for a connection closed "while the namespace already exists", a server error naming a collection
 * that is "not found". So the store failing in the middle of the act was answered as the caller's mistake — a 409 or a
 * 404, which every HTTP client believes and none retries — in the driver's words, naming the internal host.
 *
 * ## What is asserted, per site, on REST and on MCP where the capability has both
 *
 * The act's FIRST write fails with a real driver `MongoNetworkError` (the driver's own class, so the classifier sees what
 * it sees in an outage) whose text carries the trigger words and an internal address:
 *
 * - the answer is `503`, retryable, and holds none of the driver's text;
 * - **the fault fired**: its unique token is in the log line the door writes for a store failure. A fault that never
 *   fired leaves every assertion above passing about a request the store never failed (`failWrites` throws for a method
 *   it did not wrap; whether the wrapped call was reached is what the token proves);
 * - for the rename, the retry of the same request completes the rename — the marker the failed one left is what resumes.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-store-failure-is-not-read-as-a-refusal-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { failWrites } from './_write-faults.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
for (const k of ['SKIP_GLOBAL_RATE_LIMIT', 'SKIP_AUTH_RATE_LIMIT', 'SKIP_SYNC_RATE_LIMIT']) process.env[k] = 'true';
process.env['YTHRIL_RATE_LIMIT_PER_MINUTE'] ??= '1000000';

const requireFromServer = createRequire(path.resolve('server/package.json'));
const { MongoNetworkError } = requireFromServer('mongodb');

const LINKS = 'wording-links';
const RN_REST = 'wording-rn-rest';
const RN_MCP = 'wording-rn-mcp';
const ADDRESS = '172.16.0.9';
/** The driver's text: the refusal words the old code read, and an internal address no answer may carry. */
const failure = (token) => new MongoNetworkError(
  `connection 5 to ${ADDRESS}:27017 closed (${token}): namespace already exists, record not found`);
const LEAK = new RegExp(`${ADDRESS.replace(/\./g, '\\.')}|27017|namespace already exists`);

let door, faults, base, adminKey, callTool, ADMIN, server;

async function rest(method, url, body) {
  const init = { method, headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(`${base}${url}`, init);
  const raw = await r.text();
  let json = null; try { json = JSON.parse(raw); } catch { /* not JSON */ }
  return { status: r.status, retryable: json?.retryable, retryAfter: r.headers.get('retry-after'), raw, json };
}

async function mcp(tool, args) {
  const out = await callTool({ name: tool, args,
    caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' } });
  const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
  const sc = out.result.structuredContent ?? {};
  return { status: out.result.isError ? out.status : 200, retryable: sc.retryable, raw: `${text}\n${JSON.stringify(sc)}`, sc };
}

/** One request with a fault armed through `arm(token)`: what it answered and whether the fault's token reached the log. */
async function failedRequest(arm, request) {
  const token = `fired-${randomUUID()}`;
  arm(token);
  const { lines, result } = await logLinesDuring(request);
  return { ...result, fired: lines.some(l => l.includes(token) && /answered 503/.test(l)) };
}

function assertAnsweredAsTheStores(label, a) {
  assert.equal(a.status, 503, `${label} answered ${a.status}, not 503: ${a.raw}`);
  assert.equal(a.retryable, true, `${label} did not say the failure is retryable: ${a.raw}`);
  assert.ok(!LEAK.test(a.raw), `${label} answered with the driver's text: ${a.raw}`);
  assert.ok(a.fired, `${label}: the fault never reached the door's store-failure log line — the store was not failed, so the answer above is evidence of nothing`);
}

describe('a store failure is not read as a refusal', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'wording',
      spaces: [LINKS, RN_REST, RN_MCP].map(id => ({ id, label: id, folders: [], meta: { suppressEmbeddings: true } })) });
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    const { createApp } = await import('../../server/dist/app.js');
    server = await listenOnLoopback(http.createServer(createApp()));
    base = server.url;
    faults = failWrites(Object.getPrototypeOf(door.mongo.col('probe')),
      ['rename', 'createIndex', 'insertOne', 'insertMany', 'updateOne', 'updateMany', 'bulkWrite', 'replaceOne']);
  });
  after(async () => {
    faults?.restore();
    await server?.close();
    await door?.close();
  });
  beforeEach(() => faults.clear());

  /** Arm `method` on every collection of `space` that exists, once each. */
  async function armEvery(space, method, token) {
    const names = (await door.mongo.getDb().listCollections({}, { nameOnly: true }).toArray())
      .map(c => c.name).filter(n => n.startsWith(`${space}_`));
    assert.ok(names.length > 0, `${space} has no collections to arm`);
    for (const n of names) faults.fail(method, n, failure(token));
  }

  describe('rename (the first collection rename fails)', () => {
    for (const [via, id] of [['REST', RN_REST], ['MCP', RN_MCP]]) {
      it(`${via}: 503 retryable in our words, and the retry of the same request completes the rename`, async () => {
        const newId = `${id}-moved`;
        const ask = () => (via === 'REST'
          ? rest('PATCH', `/api/spaces/${id}/rename`, { newId })
          : mcp('space_rename', { space: id, newId }));
        const a = await failedRequest(token => armEvery(id, 'rename', token), ask);
        assertAnsweredAsTheStores(`${via} space_rename`, a);
        faults.clear();
        const retry = await ask();
        assert.equal(retry.status, 200, `the retry did not complete the rename: ${retry.raw}`);
      });
    }
  });

  describe('space create (the first index of the new space fails)', () => {
    for (const via of ['REST', 'MCP']) {
      it(`${via}: 503 retryable in our words`, async () => {
        const id = `wording-new-${via.toLowerCase()}`;
        const ask = () => (via === 'REST'
          ? rest('POST', '/api/spaces', { id, label: id })
          : mcp('save_space', { id, label: id }));
        const a = await failedRequest(token => {
          for (const suffix of ['facts', 'entities', 'edges', 'chrono', 'links']) faults.fail('createIndex', `${id}_${suffix}`, failure(token));
        }, ask);
        assertAnsweredAsTheStores(`${via} save_space`, a);
      });
    }
  });

  describe('link add (the first write of the link fails)', () => {
    const FACT = randomUUID();
    const ENTITY = randomUUID();
    beforeEach(async () => {
      await door.mongo.col(`${LINKS}_facts`).deleteMany({});
      await door.mongo.col(`${LINKS}_links`).deleteMany({});
      await door.mongo.col(`${LINKS}_entities`).deleteMany({});
      await door.mongo.col(`${LINKS}_facts`).insertOne(build.fact(LINKS, FACT, 1));
      await door.mongo.col(`${LINKS}_entities`).insertOne(build.entity(LINKS, ENTITY, 1));
    });
    const body = { from: FACT, fromKind: 'fact', to: ENTITY, toKind: 'entity' };
    for (const via of ['REST', 'MCP']) {
      it(`${via}: 503 retryable in our words`, async () => {
        const ask = () => (via === 'REST'
          ? rest('POST', `/api/brain/spaces/${LINKS}/links`, body)
          : mcp('save_link', { space: LINKS, ...body }));
        const a = await failedRequest(token => {
          for (const m of ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'bulkWrite', 'replaceOne']) {
            faults.fail(m, `${LINKS}_links`, failure(token));
          }
        }, ask);
        assertAnsweredAsTheStores(`${via} link add`, a);
      });
    }
  });
});
