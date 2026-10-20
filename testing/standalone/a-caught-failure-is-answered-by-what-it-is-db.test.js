/**
 * A caught failure is answered by what it IS, never by its raw message — one truth table, every answerer (Q-458).
 *
 * ## The defect
 *
 * Three functions answer what a handler threw, and each decides by its own rule. `answerThrown` (the tool door, MCP and
 * `POST /api/<tool>`) answers anything it does not recognise `400 Error: <message>`: a `TypeError` from our own code, a
 * file-system error carrying the server's absolute data path, a socket failure naming an internal host — all "your request was
 * wrong", in the runtime's words. `sendReadFailure` does the same with `retryable: false`. `sendCaughtFailure` answers them a bare
 * generic `500`, so the same failure is a `400` on one door and a `500` on the next.
 *
 * ## The rule (plan rev 3 of Q-458, section 2: the truth table is the contract)
 *
 * | caught | status | body |
 * |---|---|---|
 * | store down / timeout | 503 | unchanged |
 * | StoredFileUnreadable | 500 | our words: the file's base name and "cannot be read" |
 * | a file-system error with a file syscall, also through `cause` (`ERR_FS_*` with syscall `rm`/`cp` too) | 500 | `file_system_fault` |
 * | socket-shaped (ECONN*, EPIPE, ETIMEDOUT, ENOTFOUND, EAI_*) | 502 | "an upstream service did not answer" |
 * | MongoServerError the server answered | its status today (the door's own) | our words, never the driver's (db, collection, key values) |
 * | TypeError, ReferenceError, SyntaxError, a non-Error | 500 | "Internal server error", `retryable: false`, `code: 'internal'` |
 * | Error, RangeError (our refusal convention) | 400 on the tool doors and `sendReadFailure`; 500 on `sendCaughtFailure` (a REST catch-all: its routes answer their own refusals first, so what reaches it is a fault; plan rev 3.1) | its message; on `sendCaughtFailure` "Internal server error" |
 *
 * Every row carries a poison marker wherever the runtime would put its own text (the message, a path, an address, a key value),
 * and no answer may carry it — except the last two rows, whose message IS the answer.
 *
 * ## Doors held, all or none
 *
 * MCP `callTool` and `POST /api/<tool>` (the tool's handler is replaced for the call by one that throws the row's error, restored
 * in a `finally`, and counted so a call refused before the handler cannot pass), `sendReadFailure` and `sendCaughtFailure`
 * (called with a recording response). And a route that stamps `retryable` from the status (`statesRetryability`: `/recall`,
 * `/similar`, `/traverse`) must not turn a fault into `retryable: true`: driven through `/recall`'s own handler chain.
 *
 * Red against da4cafd8: the tool door and `sendReadFailure` answer 400 with the raw text for every fault row; `sendCaughtFailure`
 * answers a generic 500 with no code for the file-system and socket rows.
 *
 * Run: YTHRIL_TEST_MONGO_PORT=27017 YTHRIL_TEST_MONGO_CREDS= node --test testing/standalone/a-caught-failure-is-answered-by-what-it-is-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'caughtfail';
const POISON = 'poison-q458-c41d';
const POISON_PATH = `/srv/${POISON}/data/files/${S}/notes/x.txt`;
/** A read tool that takes a `space` and nothing else required: the call reaches its handler, which the row replaces. */
const TOOL = 'space_stats';

const driver = createRequire(path.resolve('server/package.json'))('mongodb');

const fsErr = (code, syscall) => Object.assign(new Error(`${code}: injected, ${syscall} '${POISON_PATH}'`),
  { code, errno: -5, syscall, path: POISON_PATH });
const sockErr = (code, syscall) => Object.assign(new Error(`${syscall} ${code} ${POISON}.internal:27017`),
  { code, errno: -111, syscall, address: `${POISON}.internal`, port: 27017 });

const INTERNAL = { status: 500, error: 'Internal server error', code: 'internal', retryable: false };

let StoredFileUnreadable;
/**
 * The truth table. `make()` builds a fresh error per door (an error is mutable, and a door that decorates one must not decide the
 * next door's answer). `expect` is what every door answers: `status` (or `statusIn`), and any of `error` (exact, after an
 * `Error: ` prefix), `errorMatches`, `code`, `retryable`; `echoes` is true only where the message IS the answer.
 */
const ROWS = () => [
  { name: 'store down (a network error)', make: () => new driver.MongoNetworkError(`connection to ${POISON}.internal:27017 closed`),
    expect: { status: 503, retryable: true } },
  { name: 'StoredFileUnreadable', make: () => new StoredFileUnreadable(POISON_PATH, Object.assign(new Error('the envelope is not this instance\'s'), { code: 'foreign_key' })),
    expect: { status: 500, errorMatches: /\bx\.txt cannot be read\b/ } },
  { name: 'a file-system error (EIO, syscall open)', make: () => fsErr('EIO', 'open'), expect: { status: 500, code: 'file_system_fault' } },
  { name: 'a file-system error reached through `cause`', make: () => new Error('copying the upload failed', { cause: fsErr('EACCES', 'rename') }),
    expect: { status: 500, code: 'file_system_fault' } },
  { name: 'ERR_FS_CP_EINVAL (syscall cp)', make: () => fsErr('ERR_FS_CP_EINVAL', 'cp'), expect: { status: 500, code: 'file_system_fault' } },
  { name: 'ERR_FS_EISDIR (syscall rm)', make: () => fsErr('ERR_FS_EISDIR', 'rm'), expect: { status: 500, code: 'file_system_fault' } },
  { name: 'socket-shaped: ECONNREFUSED (syscall connect)', make: () => sockErr('ECONNREFUSED', 'connect'),
    expect: { status: 502, error: 'an upstream service did not answer' } },
  { name: 'socket-shaped: EAI_AGAIN (syscall getaddrinfo)', make: () => sockErr('EAI_AGAIN', 'getaddrinfo'),
    expect: { status: 502, error: 'an upstream service did not answer' } },
  { name: 'socket-shaped: EPIPE (syscall write)', make: () => sockErr('EPIPE', 'write'),
    expect: { status: 502, error: 'an upstream service did not answer' } },
  { name: 'a MongoServerError the server answered (duplicate key)', make: () => new driver.MongoServerError({
    errmsg: `E11000 duplicate key error collection: ${POISON}_db.files index: _id_ dup key: { _id: "${POISON}" }`, code: 11000, keyValue: { _id: POISON } }),
    // "Its status today" is the door's own: the tool doors and a read answer 400 or 409, `sendCaughtFailure` a 500. Only the words change.
    expect: { statusIn: [400, 409] }, expectOn: { sendCaughtFailure: { statusIn: [500] } } },
  { name: 'TypeError', make: () => new TypeError(`Cannot read properties of undefined (reading '${POISON}')`), expect: INTERNAL },
  { name: 'ReferenceError', make: () => new ReferenceError(`${POISON} is not defined`), expect: INTERNAL },
  { name: 'SyntaxError', make: () => new SyntaxError(`Unexpected token in JSON at ${POISON}`), expect: INTERNAL },
  { name: 'a non-Error (a thrown string)', make: () => `thrown string ${POISON}`, expect: INTERNAL },
  { name: 'a non-Error (a thrown object)', make: () => ({ reason: POISON }), expect: INTERNAL },
  // `sendCaughtFailure` is a REST catch-all: every route answers its own refusals before it, so what reaches it is a fault (plan rev 3.1).
  { name: 'Error (our refusal convention)', make: () => new Error('the caller asked for something this refuses'),
    expect: { status: 400, errorMatches: /the caller asked for something this refuses/ }, echoes: true,
    expectOn: { sendCaughtFailure: { status: 500, error: 'Internal server error' } } },
  { name: 'RangeError (our refusal convention)', make: () => new RangeError('offset must be within the file'),
    expect: { status: 400, errorMatches: /offset must be within the file/ }, echoes: true,
    expectOn: { sendCaughtFailure: { status: 500, error: 'Internal server error' } } },
];

let acts, tools, sendReadFailure, sendCaughtFailure, recallChain, ADMIN_RIGHTS;

const recording = () => {
  const out = { status: 200, headers: {}, body: undefined };
  const res = {
    headersSent: false,
    status(s) { out.status = s; return res; },
    setHeader(k, v) { out.headers[String(k).toLowerCase()] = v; return res; },
    getHeader(k) { return out.headers[String(k).toLowerCase()]; },
    json(b) { out.body = b; res.headersSent = true; return res; },
    end() { res.headersSent = true; return res; },
  };
  return { res, out };
};

/** Run `fn` while the tool's handler throws `err`; the real handler is back afterwards, whatever `fn` did. */
async function whileToolThrows(name, err, fn) {
  const tool = tools.TOOLS_BY_NAME.get(name);
  assert.ok(tool, `no tool '${name}' — re-anchor this test`);
  const real = tool.handle;
  let fired = 0;
  tool.handle = async () => { fired += 1; throw err; };
  try { return { answer: await fn(), fired }; } finally { tool.handle = real; }
}

/** Each door's answer to `err`, normalised to `{ status, error, code, retryable, wire }`. */
const DOORS = {
  async 'MCP callTool'(err) {
    const { answer, fired } = await whileToolThrows(TOOL, err, () => acts.mcp(TOOL, {}));
    assert.equal(fired, 1, `the tool handler never ran — the call was refused before it (${answer.text}), so this door was not asked`);
    return { status: answer.status, error: answer.text.replace(/^Error: /, ''), code: answer.sc.code, retryable: answer.sc.retryable,
      wire: JSON.stringify({ text: answer.text, sc: answer.sc }) };
  },
  async 'POST /api/<tool>'(err) {
    const { answer, fired } = await whileToolThrows(TOOL, err, () => acts.tool(TOOL, {}));
    const b = answer.body ?? {};
    assert.equal(fired, 1, `the tool handler never ran — the call was refused before it (${JSON.stringify(b)}), so this door was not asked`);
    const d = b.data ?? {};
    return { status: answer.code, error: String(b.error ?? '').replace(/^Error: /, ''), code: d.code ?? b.code, retryable: d.retryable ?? b.retryable,
      wire: JSON.stringify({ body: b, headers: answer.headers }) };
  },
  async sendReadFailure(err) {
    const { res, out } = recording();
    sendReadFailure(res, 'test read', err);
    return { status: out.status, error: out.body?.error, code: out.body?.code, retryable: out.body?.retryable, wire: JSON.stringify(out) };
  },
  async sendCaughtFailure(err) {
    const { res, out } = recording();
    sendCaughtFailure(res, 'test act', err);
    return { status: out.status, error: out.body?.error, code: out.body?.code, retryable: out.body?.retryable, wire: JSON.stringify(out) };
  },
};

function assertRow(door, row, a) {
  const e = row.expectOn?.[door] ?? row.expect;
  const where = `${door}, ${row.name}`;
  if (e.statusIn) assert.ok(e.statusIn.includes(a.status), `${where}: answered ${a.status}, not one of ${e.statusIn} — ${a.wire}`);
  else assert.equal(a.status, e.status, `${where}: answered ${a.status}, not ${e.status} — ${a.wire}`);
  if (e.error !== undefined) assert.equal(a.error, e.error, `${where}: said ${JSON.stringify(a.error)} — ${a.wire}`);
  if (e.errorMatches) assert.match(String(a.error), e.errorMatches, `${where}: said ${JSON.stringify(a.error)} — ${a.wire}`);
  if (e.code !== undefined) assert.equal(a.code, e.code, `${where}: carries code ${JSON.stringify(a.code)}, not ${e.code} — ${a.wire}`);
  if (e.retryable !== undefined) assert.equal(a.retryable, e.retryable, `${where}: retryable is ${a.retryable}, not ${e.retryable} — ${a.wire}`);
  if (!row.echoes) assert.ok(!a.wire.includes(POISON), `${where}: the answer carries the runtime's own text (message, path, address or key) — ${a.wire}`);
}

describe('a caught failure is answered by what it is, on every answerer (Q-458 truth table)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'caughtfail', space: S });
    tools = await import('../../server/dist/mcp/tools/index.js');
    ({ StoredFileUnreadable } = await import('../../server/dist/files/stored-bytes.js'));
    ({ sendReadFailure } = await import('../../server/dist/api/brain/_read-failure.js'));
    ({ sendCaughtFailure } = await import('../../server/dist/api/send-failure.js'));
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ADMIN_RIGHTS = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const { searchRouter } = await import('../../server/dist/api/brain/search.js');
    const layer = searchRouter.stack.find(l => l.route?.path === '/recall' && l.route.methods['post']);
    assert.ok(layer, 'no POST /recall on the search router — re-anchor this test');
    recallChain = layer.route.stack.map(l => l.handle);
  });
  after(async () => { await acts?.close(); });

  for (const row of ROWS()) {
    for (const [door, ask] of Object.entries(DOORS)) {
      it(`${row.name} -> ${row.expect.status ?? row.expect.statusIn.join('/')} on ${door}`, async () => {
        assertRow(door, row, await ask(row.make()));
      });
    }
  }

  /*
   * A route that stamps `retryable` from the status when a body omits it (`statesRetryability`) would call a fault `retryable: true`
   * the moment it became a 500, so the fault's body says `retryable: false` itself. Driven through `/recall`'s own chain, past rate
   * limit and auth (the two middlewares before the decorator), with the tool behind it throwing.
   */
  for (const [label, make] of [['TypeError', () => new TypeError(`x is undefined at ${POISON}`)], ['thrown string', () => `oops ${POISON}`]]) {
    it(`/recall (decorated): a ${label} is 500 Internal server error with retryable: false`, async () => {
      const names = recallChain.map(h => h.name);
      const at = names.indexOf('statesRetryability');
      assert.ok(at > 0 && at === recallChain.length - 2, `/recall's chain is ${JSON.stringify(names)} — re-anchor where the decorator sits`);
      const { res, out } = recording();
      const req = { method: 'POST', params: {}, query: {}, body: { space: S, query: 'anything' }, headers: {}, ip: '127.0.0.1',
        authToken: { id: 't', name: 'test', rights: ADMIN_RIGHTS }, get: () => undefined };
      const { fired } = await whileToolThrows('recall', make(), async () => {
        await new Promise((resolve, reject) => { recallChain[at](req, res, (e) => (e ? reject(e) : resolve())); });
        await recallChain[at + 1](req, res);
      });
      const wire = JSON.stringify(out);
      assert.equal(fired, 1, `the recall tool never ran behind the route — ${wire}`);
      assert.equal(out.status, 500, `/recall answered ${out.status}, not 500 — ${wire}`);
      assert.equal(out.body?.retryable, false, `/recall stamped retryable ${out.body?.retryable} on a fault — ${wire}`);
      assert.equal(String(out.body?.error).replace(/^Error: /, ''), 'Internal server error', `/recall said ${JSON.stringify(out.body?.error)} — ${wire}`);
      assert.ok(!wire.includes(POISON), `/recall carries the runtime's own text — ${wire}`);
    });
  }

  /*
   * `ythril_tool_failures_total` (Q-458): one increment per failure answered by the classifier, labelled by door, tool and class, the class
   * always one of `CAUGHT_KINDS`. Read by delta against series that already moved (`pitfall-gauge-reset-reads-zero`: a counter cannot be
   * poisoned below zero, so each series is first moved to a value no fresh process holds, and the case then asserts WHICH series changed
   * and by how much — an identity, not "is zero"). The two tool doors reach it: `mcp` and `rest` (`POST /api/<tool>`).
   */
  const METRIC = 'ythril_tool_failures_total';
  const KIND_OF_ROW = {
    'StoredFileUnreadable': 'unreadable_file',
    'a file-system error (EIO, syscall open)': 'file_system',
    'a file-system error reached through `cause`': 'file_system',
    'socket-shaped: ECONNREFUSED (syscall connect)': 'upstream',
    'a MongoServerError the server answered (duplicate key)': 'driver_refusal',
    'TypeError': 'internal',
    'a non-Error (a thrown string)': 'internal',
    'Error (our refusal convention)': 'refusal',
  };

  describe('every classified tool failure is counted once, by door, tool and class (Q-458)', () => {
    let registry, kinds;
    before(async () => {
      registry = await import('../../server/dist/metrics/registry.js');
      ({ CAUGHT_KINDS: kinds } = await import('../../server/dist/util/answer-for-caught.js'));
    });
    /** The series of the counter on the exposition text an operator reads: `{ 'door|tool|class': value }`. */
    const scrape = async () => {
      const out = {};
      for (const line of (await registry.register.getSingleMetricAsString(METRIC)).split('\n')) {
        if (!line.startsWith(`${METRIC}{`)) continue;
        const m = /^[^{]+\{([^}]*)\}\s+(\S+)/.exec(line);
        assert.ok(m, `unreadable series line: ${line}`);
        const l = Object.fromEntries([...m[1].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map(x => [x[1], x[2]]));
        out[`${l.door}|${l.tool}|${l.class}`] = Number(m[2]);
      }
      return out;
    };
    const delta = (a, b) => Object.fromEntries(Object.keys({ ...a, ...b }).map(k => [k, (b[k] ?? 0) - (a[k] ?? 0)]).filter(([, d]) => d !== 0));
    const rowNamed = (name) => ROWS().find(r => r.name === name);
    const failOn = (door, row) => whileToolThrows(TOOL, row.make(), () => (door === 'mcp' ? acts.mcp(TOOL, {}) : acts.tool(TOOL, {})));

    it('the table covers every class the module names, so no class goes uncounted unseen', () => {
      for (const name of Object.keys(KIND_OF_ROW)) assert.ok(rowNamed(name), `no truth-table row '${name}' — re-anchor this test`);
      assert.deepEqual([...new Set(Object.values(KIND_OF_ROW))].sort(), [...kinds].sort(),
        'every class in CAUGHT_KINDS needs a row here (and a class used here must be in CAUGHT_KINDS)');
    });

    for (const [name, kind] of Object.entries(KIND_OF_ROW)) {
      for (const door of ['mcp', 'rest']) {
        it(`${name}: one failure on the ${door} door moves ${door}|${TOOL}|${kind} by exactly one`, async () => {
          for (let i = 0; i < 3; i += 1) await failOn(door, rowNamed(name)); // move the series off anything a fresh process holds
          const before = await scrape();
          assert.ok((before[`${door}|${TOOL}|${kind}`] ?? 0) >= 3, `the series did not move on its poisoning calls — ${JSON.stringify(before)}`);
          const { fired } = await failOn(door, rowNamed(name));
          assert.equal(fired, 1, 'the tool handler never ran, so the door was not asked');
          assert.deepEqual(delta(before, await scrape()), { [`${door}|${TOOL}|${kind}`]: 1 },
            'exactly the one series for this door, tool and class moved, once');
        });
      }
    }

    it('no series carries a class outside CAUGHT_KINDS, and a refused or typed answer is not counted as a failure', async () => {
      const before = await scrape();
      // A store failure is the door's first question (`storeFailureAnswer`), asked before the classifier: not this counter's.
      await failOn('mcp', rowNamed('store down (a network error)'));
      assert.deepEqual(delta(before, await scrape()), {}, 'a store-down answer moved the classifier counter');
      for (const key of Object.keys(await scrape())) {
        const cls = key.split('|')[2];
        assert.ok(kinds.includes(cls), `series ${key} carries a class that is not in CAUGHT_KINDS`);
      }
    });
  });
});
