/**
 * An unknown top-level field is named on EVERY answer a brain write route gives after the judge ran, through the server's real
 * Express application — a success, a refusal, a 412, a record whose connections failed — and on none where nothing was stored
 * because the store failed (bundle-128, Q-320; design-v3 section 2a, V5 and V6, section 3 "Rows on every answer after the judge").
 *
 * ## What it prevents
 *
 * A route has about fifteen `res.status(400).json(...)` sites. A judge that put its rows on the success body only (as
 * `unknownFieldWarnings` does today, create and update) tells a caller nothing on the answer it reads most carefully: the refusal.
 * The rows ride on every answer through ONE `res.json` decoration (`api/decorate-json-answer.ts`), which is why none of the
 * sites has to remember. This file asks the real routes, over HTTP, with a real store, the questions the module's own test
 * (`a-json-answer-is-decorated-once-and-the-decoration-never-harms-the-body`) cannot: that the judge installs it, after target
 * resolution and before any other check, on the routes people use.
 *
 * - **success**: stored, so each row says `ignored` and carries its value;
 * - **a refusal for another reason (400, 404) and a 412**: the call failed, so each row says `not accepted` and carries NO value;
 * - **a mode that refuses**: the same, and the store is unchanged (read before and after, by identity, not by count);
 * - **`ConnectionsNotWritten` with a store cause**: the record IS stored although the status is 5xx, so the rows ride along and the
 *   answer keeps its `written`;
 * - **a plain store failure (nothing stored)**: no rows, because `sendCaughtFailure` keeps that body generic on purpose;
 * - **a failed target resolution**: no rows, because resolution precedes the judge.
 *
 * The three-door comparison of the same rows (REST, MCP, `POST /api/<tool>`) is the parity file's; this file is the REST
 * half's decoration over the real application.
 *
 * ## Red on the unchanged base
 *
 * Today only the SUCCESS body carries rows, none has a `code`, and a refusal, a 412 and a `ConnectionsNotWritten` carry none.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/an-unknown-field-rides-every-answer-after-the-judge-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
for (const k of ['SKIP_GLOBAL_RATE_LIMIT', 'SKIP_AUTH_RATE_LIMIT', 'SKIP_SYNC_RATE_LIMIT']) process.env[k] = 'true';
process.env['YTHRIL_RATE_LIMIT_PER_MINUTE'] ??= '1000000';

const DASH = '—';
const IGNORED = `unknown field ${DASH} ignored`;
const NOT_ACCEPTED = `unknown field ${DASH} not accepted`;
const WARN = 'b128-ride-warn';
const REFUSE = 'b128-ride-refuse';
const PROXY = 'b128-ride-proxy';
const UUID = 'dddddddd-0000-4000-8000-0000000000a1';

// The driver the SERVER loads, so the patched class is the one its operations go through (the store-failure gate's own way in).
const requireFromServer = createRequire(path.resolve('server/package.json'));
const driverLib = path.dirname(requireFromServer.resolve('mongodb'));
const { Server } = requireFromServer(path.join(driverLib, 'sdam', 'server.js'));
const { PoolClearedError } = requireFromServer(path.join(driverLib, 'cmap', 'errors.js'));
const { MongoNetworkTimeoutError } = requireFromServer('mongodb');

let door, server, base, key;
const realCommand = Server.prototype.command;
/** `null` = the store is up; a predicate over the operation = the store fails the commands it matches. */
let failing = null;
const WRITE_COMMANDS = new Set(['insert', 'update', 'delete', 'findAndModify']);

async function send(method, route, body, headers = {}) {
  const r = await fetch(`${base}${route}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const entities = (space) => `/api/brain/spaces/${space}/entities`;
const rowOf = (body, field) => (body?.warnings ?? []).find(w => w.field === field);
const idsOf = async (space) => (await door.coll(space, 'entities').find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id).sort();

describe('an unknown field is named on every answer after the judge', { skip }, () => {
  before(async () => {
    door = await openPushDoor({
      suite: 'b128-contract-ride',
      spaces: [
        { id: WARN, label: WARN, folders: [], meta: { suppressEmbeddings: true } },
        { id: REFUSE, label: REFUSE, folders: [], meta: { suppressEmbeddings: true }, unknownWriteFields: 'refuse' },
        { id: PROXY, label: PROXY, folders: [], meta: {}, proxyFor: [WARN, REFUSE] },
      ],
    });
    const tokens = await import('../../server/dist/auth/tokens.js');
    key = (await tokens.createToken({ name: 'b128-ride-admin', admin: true })).plaintext;
    const { createApp } = await import('../../server/dist/app.js');
    server = await listenOnLoopback(http.createServer(createApp()));
    base = server.url;
    Server.prototype.command = async function storeFaulting(...args) {
      const op = args[0];
      if (failing && failing(op)) {
        throw new PoolClearedError({ address: 'mongo.internal:27017', serverError: new MongoNetworkTimeoutError('connection <monitor> to 172.16.0.9:27017 timed out') });
      }
      return realCommand.apply(this, args);
    };
  });
  after(async () => {
    Server.prototype.command = realCommand;
    failing = null;
    await server?.close();
    await door?.close();
  });
  beforeEach(async () => {
    failing = null;
    for (const s of [WARN, REFUSE]) {
      for (const part of ['entities', 'edges', 'links']) await door.coll(s, part).deleteMany({});
    }
  });

  it('a stored write names each unknown field as ignored, with its value and the stable code', async () => {
    const r = await send('POST', entities(WARN), { name: 'Acme', type: 'concept', zz: 1, yy: 'text' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    for (const [field, value] of [['zz', 1], ['yy', 'text']]) {
      const row = rowOf(r.body, field);
      assert.ok(row, `the 201 does not name ${field}: ${JSON.stringify(r.body.warnings)}`);
      assert.equal(row.code, 'unknown_field');
      assert.ok(row.reason.startsWith(IGNORED), `the row says ${JSON.stringify(row.reason)}`);
      assert.equal(row.value, value);
    }
  });

  it('a 400 for another reason names them as not accepted and reflects no value (the call failed, so nothing was ignored)', async () => {
    const before = await idsOf(WARN);
    const r = await send('POST', entities(WARN), { type: 'concept', zz: 'secret-looking' });
    assert.equal(r.status, 400, `the body has no name and must be refused: ${JSON.stringify(r.body)}`);
    assert.equal(typeof r.body.error, 'string', 'the route\'s own refusal text is gone');
    const row = rowOf(r.body, 'zz');
    assert.ok(row, `the refusal does not name zz: ${JSON.stringify(r.body)}`);
    assert.equal(row.code, 'unknown_field');
    assert.ok(row.reason.startsWith(NOT_ACCEPTED), `the row says ${JSON.stringify(row.reason)}`);
    assert.ok(!('value' in row), 'a refusal reflects the received value');
    assert.ok(!JSON.stringify(r.body).includes('secret-looking'), 'the received value appears somewhere in a refusal');
    assert.deepEqual(await idsOf(WARN), before, 'a refused write stored something');
  });

  it('a space set to refuse refuses the write before anything is stored, with the rows, and the store is unchanged', async () => {
    const before = await idsOf(REFUSE);
    const r = await send('POST', entities(REFUSE), { name: 'Acme', type: 'concept', zz: 1 });
    const again = await idsOf(REFUSE);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.ok(rowOf(r.body, 'zz')?.reason.startsWith(NOT_ACCEPTED), JSON.stringify(r.body));
    assert.deepEqual(r.body.issues?.[0]?.keys, ['zz'], `the refusal carries no unrecognized_keys issue: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.issues?.[0]?.code, 'unrecognized_keys');
    assert.deepEqual(again, before, 'a write refused for its unknown field was stored');
    assert.deepEqual(await idsOf(REFUSE), before, 'sandwich: the store moved between the reads');
  });

  it('a 404 for a record that does not exist carries the rows', async () => {
    const missing = await send('PATCH', `${entities(WARN)}/${UUID}`, { name: 'x', zz: 1 });
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
    assert.ok(rowOf(missing.body, 'zz'), `the 404 does not name zz: ${JSON.stringify(missing.body)}`);
  });

  it('a 412 for a stale If-Match carries the rows, without a value, and leaves the record alone', async () => {
    const made = await send('POST', entities(WARN), { name: 'Acme', type: 'concept' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const madeId = made.body._id;
    const stale = await send('PATCH', `${entities(WARN)}/${madeId}`, { name: 'Renamed', zz: 1 }, { 'if-match': '987654' });
    assert.equal(stale.status, 412, JSON.stringify(stale.body));
    const row = rowOf(stale.body, 'zz');
    assert.ok(row, `the 412 does not name zz: ${JSON.stringify(stale.body)}`);
    assert.ok(row.reason.startsWith(NOT_ACCEPTED));
    assert.ok(!('value' in row));
    assert.equal((await door.coll(WARN, 'entities').findOne({ _id: madeId })).name, 'Acme', 'a 412 changed the record');
  });

  it('a failed target resolution names nothing (it precedes the judge); the next refusal of the same body does', async () => {
    const resolved = await send('POST', `${entities(PROXY)}?targetSpace=b128-not-a-member`, { name: 'Acme', type: 'concept', zz: 1 });
    assert.equal(resolved.status, 400, JSON.stringify(resolved.body));
    assert.equal(resolved.body.warnings, undefined, `rows rode an answer that never reached the judge: ${JSON.stringify(resolved.body)}`);
    const judged = await send('POST', `${entities(PROXY)}?targetSpace=${WARN}`, { type: 'concept', zz: 1 });
    assert.ok(rowOf(judged.body, 'zz'), `control: the same unknown key after a resolved target is named: ${JSON.stringify(judged.body)}`);
  });

  it('a store failure with nothing stored carries no rows, and the same body refused with the store up does', async () => {
    const control = await send('POST', entities(WARN), { type: 'concept', zz: 1 });
    assert.ok(rowOf(control.body, 'zz'), `control: with the store up the refusal names zz: ${JSON.stringify(control.body)}`);

    failing = () => true;
    const down = await send('POST', entities(WARN), { name: 'Acme', type: 'concept', zz: 1 });
    failing = null;
    assert.ok(down.status >= 500, `the store failed under the write and the answer was ${down.status}: ${JSON.stringify(down.body)}`);
    assert.equal(down.body.written, undefined, 'nothing was stored, so no `written`');
    assert.equal(down.body.warnings, undefined, `a store-failure answer (nothing stored) carries rows: ${JSON.stringify(down.body)}`);
    assert.ok(!JSON.stringify(down.body).includes('172.16.0.9'), 'the driver\'s text reached the answer');
  });

  it('a record stored while its connections were not keeps its 5xx and carries the rows, though the status is 5xx', async () => {
    const target = await send('POST', entities(WARN), { name: 'Target', type: 'concept' });
    assert.equal(target.status, 201, JSON.stringify(target.body));
    const targetId = target.body._id;
    // Fail the CONNECTION writes only: the record itself lands, which is what makes the answer a ConnectionsNotWritten.
    failing = (op) => WRITE_COMMANDS.has(op?.commandName) && /_(edges|links)$/.test(op?.ns?.collection ?? '');
    const r = await send('POST', entities(WARN), {
      name: 'Source', type: 'concept', zz: 1, edges: [{ to: targetId, label: 'relates' }],
    });
    failing = null;
    assert.ok(r.status >= 500, `the connections failed on the store and the answer was ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(typeof r.body.written?.id, 'string', `the answer lost its \`written\`: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.retryable, false, 'a record that landed must not be answered as retryable');
    const row = rowOf(r.body, 'zz');
    assert.ok(row, `the record was stored and the answer does not name zz: ${JSON.stringify(r.body)}`);
    assert.ok(row.reason.startsWith(IGNORED), `the record WAS stored, so the field was ignored: ${row.reason}`);
    const stored = await door.coll(WARN, 'entities').findOne({ _id: r.body.written.id });
    assert.equal(stored?.name, 'Source', 'the answer says the record landed and it is not in the store');
  });
});
