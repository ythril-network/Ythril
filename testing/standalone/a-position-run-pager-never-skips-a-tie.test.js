/**
 * The pager for a 6.0 peer never skips the rest of a run of equal positions, trusts nothing it was not told, and says how far it is COMPLETE when it stops
 * (bundle-52, Q-277 / Q-295; re-pointed to positions by bundle-81, design rev 8 §6: `sync/position-run-pager.ts`, the successor of `sync/seq-run-pager.ts`).
 *
 * ## The defect it holds
 *
 * Records relayed from several authors keep their author's seq, and a carried record's position is its legacy seq (the identity band), so several records can share
 * a position and a page boundary can fall inside such a run. A pager that asked "after the last position it saw" skipped the rest of the run at every boundary,
 * nothing reported it, and a mark moved past records it never read. The server's cursor is a PAIR `(pos, _id)` so the next page continues the run, and the page
 * says `through`: where it is COMPLETE (the position BEFORE the last item's when more follows, the settled end less one when nothing does).
 *
 * ## The contract, as these tests state it
 *
 * `pagePositionRuns(o)` resolves when the transfer ends and reports through `o.outcome` (`{ deliveredThrough, truncated, stoppedBy }`, the shape
 * `sync/watermark.ts` reads), updated as it goes so a throw leaves it at the last position delivered.
 *
 * - `o.fetch({ afterPos, cursor }, limit)` -> `{ body }` (a 2xx page, which the pager PARSES: `parsePageAnswer`) or `{ status }` (a refusal). `cursor` is the
 *   server's own cursor, handed back verbatim; before the first page it is `null` and `afterPos` is the mark.
 * - `o.deliver(items)` -> `null` when delivered, or the reason the transfer must stop. Called once per page with items.
 * - `o.maxPages` (default 200): the cycle's bound. Reaching it with more to read stops as a CAP (`stoppedBy: 'cap'`), nothing failed.
 * - `o.onBehind(head, startedFrom)`: the peer's `head` is below the mark the transfer started from; called once, and the transfer restarts from 0.
 *
 * ## The rules
 *
 * - A page without the 6.0 shape (no `positions: 1`, `through` or `head`) THROWS `PeerPagesBySeq` and delivers nothing.
 * - A pair cursor is followed, and checked: it must be readable (`p1.`), strictly past where the request was made from, and a page that says more follows must serve
 *   something. Otherwise the transfer stops (`stoppedBy: 'error'`) rather than loops.
 * - `through` is the PEER's: the pager takes it after `deliver` returned and never derives a position from an element (a record carries none on the wire). A
 *   `through` above the peer's own `head` is a lie about its stream and stops the transfer.
 * - A stop leaves `deliveredThrough` at the last page that was delivered; `truncated` says it stopped and `stoppedBy` says why.
 *
 * The server in these tests is the real page builder (`pageAnswer`, `sync/wire-answer.ts`) over records with positions, so `through` and `head` are the ones the code
 * under test is served by the real doors.
 *
 * Run: node --test testing/standalone/a-position-run-pager-never-skips-a-tie.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

let pagerLoaded;
let answerLoaded;
let keysetLoaded;
before(async () => {
  pagerLoaded = await loadDistModule('../../server/dist/sync/position-run-pager.js', import.meta.url);
  answerLoaded = await loadDistModule('../../server/dist/sync/wire-answer.js', import.meta.url);
  keysetLoaded = await loadDistModule('../../server/dist/util/position-keyset.js', import.meta.url);
});

/** The modules, or the failure that names the one that is missing. */
function modules(rule) {
  const { pagePositionRuns, serverCursorOf } = needModule(pagerLoaded, ['pagePositionRuns', 'serverCursorOf'], rule);
  const { pageAnswer } = needModule(answerLoaded, ['pageAnswer'], rule);
  const { decodePositionCursor, encodePositionCursor } = needModule(keysetLoaded, ['decodePositionCursor', 'encodePositionCursor'], rule);
  return { pagePositionRuns, serverCursorOf, pageAnswer, decodePositionCursor, encodePositionCursor };
}

const byteOrder = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const sortRecords = (records) => [...records].sort((a, b) => a.pos - b.pos || byteOrder(a._id, b._id));
/** A record at position `pos`: the wire carries the document without its position, which the server keeps beside it. */
const rec = (pos, id) => ({ _id: id, pos });
const CAP = 1_000_000;

/** A server that pages the way `GET /api/sync/*` does: the real page builder over records, a settled cap of `cap`. */
function server(records, m, { cap = CAP } = {}) {
  const sorted = sortRecords(records);
  const calls = [];
  const serve = async (ask, limit) => {
    const start = ask.cursor !== null && ask.cursor !== undefined ? m.decodePositionCursor(ask.cursor) : { pos: ask.afterPos };
    assert.ok(start, 'the pager must hand back a cursor the server can read');
    const after = sorted.filter(r => r.pos > start.pos || (start.id !== undefined && r.pos === start.pos && byteOrder(r._id, start.id) > 0));
    const rows = after.slice(0, limit + 1).map(r => ({ row: { _id: r._id }, pos: r.pos }));
    calls.push({ ...ask, limit });
    return { body: m.pageAnswer({ rows, cap }, limit) };
  };
  serve.calls = calls;
  return serve;
}

/** Run the pager over a scripted or simulated server and report everything it did. */
async function run(m, serve, { limit = 3, start = 0, maxPages, deliverImpl, onBehind } = {}) {
  const outcome = { deliveredThrough: start, truncated: false };
  const asks = [];
  const deliveries = [];
  const stops = [];
  let calls = 0;
  const opts = {
    outcome,
    limit,
    fetch: async (ask, l) => { asks.push({ ...ask, limit: l }); return serve(ask, l); },
    deliver: async (items) => {
      calls++;
      const refusal = deliverImpl ? deliverImpl(items, calls) : null;
      if (refusal === null) deliveries.push(items); // only what LANDED counts as handed on
      return refusal;
    },
    stopped: (why, heldAt) => stops.push({ why, heldAt }),
  };
  if (maxPages !== undefined) opts.maxPages = maxPages;
  if (onBehind) opts.onBehind = onBehind;
  await m.pagePositionRuns(opts);
  return { outcome, asks, deliveries, stops, handedOn: deliveries.flat().map(r => r._id) };
}

const everyOnce = (records) => sortRecords(records).map(r => r._id);

/** `runLengths[i]` records at position `i + 1`: ties by construction, ids ordered by `_id`. */
function runsOf(runLengths) {
  const records = [];
  runLengths.forEach((n, i) => { for (let k = 0; k < n; k++) records.push(rec(i + 1, `r${String(i + 1).padStart(3, '0')}-${k}`)); });
  return records;
}

describe('ties across pages are all delivered, once', () => {
  it('records sharing a position across every page boundary all arrive, none twice', async () => {
    const m = modules('ties');
    for (const limit of [1, 2, 3, 4, 5]) {
      const lengths = Array.from({ length: 24 }, (_, i) => 1 + ((i * 7 + limit) % (limit + 2)));
      const records = runsOf(lengths);
      const r = await run(m, server(records, m), { limit });
      assert.deepEqual(r.handedOn, everyOnce(records), `limit ${limit}`);
      assert.equal(new Set(r.handedOn).size, r.handedOn.length, `limit ${limit}: a record handed on twice`);
      assert.equal(r.outcome.truncated, false, `limit ${limit}: ${JSON.stringify(r.stops)}`);
      assert.equal(r.outcome.deliveredThrough, CAP - 1, `limit ${limit}: a finished transfer is complete through the peer's settled end less one`);
      assert.deepEqual(r.stops, []);
    }
  });

  it('a run LONGER than a page is served whole, with no retry and no stop', async () => {
    const m = modules('long run');
    const records = [rec(1, 'r1'), rec(5, 'r5a'), rec(5, 'r5b'), rec(5, 'r5c'), rec(5, 'r5d'), rec(5, 'r5e'), rec(5, 'r5f'), rec(6, 'r6'), rec(7, 'r7')];
    const r = await run(m, server(records, m), { limit: 2 });
    assert.deepEqual(r.handedOn, everyOnce(records));
    assert.equal(r.outcome.truncated, false);
    assert.ok(r.asks.every(a => a.limit === 2), 'no larger retry was needed');
  });

  it('the first request asks from the mark, and the pages after it ask by the server\'s own cursor', async () => {
    const m = modules('the ask');
    const r = await run(m, server(runsOf([2, 2, 2, 2]), m), { limit: 3, start: 1 });
    assert.deepEqual([r.asks[0].afterPos, r.asks[0].cursor], [1, null]);
    assert.ok(r.asks.length >= 2 && r.asks.slice(1).every(a => typeof a.cursor === 'string' && a.cursor.startsWith('p1.')), 'a later ask is the cursor a page handed back');
  });

  it('a transfer that starts above 0 asks from there, and a transfer with nothing to do ends at the peer\'s settled end', async () => {
    const m = modules('start position');
    const r = await run(m, server([rec(1, 'a'), rec(2, 'b')], m), { start: 100 });
    assert.equal(r.asks[0].afterPos, 100);
    assert.equal(r.asks.length, 1);
    assert.equal(r.outcome.deliveredThrough, CAP - 1, 'nothing above the mark: complete through the settled end, which is how a tombstone-only cycle moves the mark');
    assert.equal(r.outcome.truncated, false);
    assert.deepEqual(r.handedOn, []);
  });
});

describe('a stop inside a run reports the position before the run, never the run', () => {
  it('deliver refusing on page 2, inside the run at position 5, holds at the page-1 `through`', async () => {
    const m = modules('stop in a run');
    const records = [rec(1, 'r1'), rec(2, 'r2'), rec(5, 'r5a'), rec(5, 'r5b'), rec(6, 'r6')];
    const r = await run(m, server(records, m), { limit: 3, deliverImpl: (_f, call) => (call === 2 ? 'the peer answered 503' : null) });
    assert.equal(r.outcome.truncated, true);
    assert.equal(r.outcome.stoppedBy, 'error');
    assert.equal(r.outcome.deliveredThrough, 4, 'position 5 was delivered in part (5a, not 5b): complete through 4, which is what page 1 said');
    assert.deepEqual(r.stops.map(s => s.heldAt), [4]);
    assert.match(r.stops[0].why, /503/, 'the stop says why');
    assert.deepEqual(r.handedOn, ['r1', 'r2', 'r5a'], 'page 1 landed, page 2 did not');
  });

  it('the first delivery refused leaves the position where the transfer started', async () => {
    const m = modules('first stop');
    const r = await run(m, server([rec(1, 'r1'), rec(2, 'r2'), rec(5, 'r5a'), rec(5, 'r5b')], m), { limit: 3, start: 0, deliverImpl: () => 'the store is down' });
    assert.equal(r.outcome.truncated, true);
    assert.equal(r.outcome.deliveredThrough, 0, 'nothing was handed on, so nothing is vouched for');
  });

  it('a non-ok answer on page 2 holds at the last complete position, and is a fault', async () => {
    const m = modules('status stop');
    const inner = server([rec(1, 'r1'), rec(2, 'r2'), rec(5, 'r5a'), rec(5, 'r5b'), rec(6, 'r6')], m);
    let calls = 0;
    const r = await run(m, async (ask, limit) => (++calls === 2 ? { status: 503 } : inner(ask, limit)), { limit: 3 });
    assert.equal(r.outcome.truncated, true);
    assert.equal(r.outcome.stoppedBy, 'error');
    assert.equal(r.outcome.deliveredThrough, 4);
    assert.match(r.stops[0].why, /503/);
  });
});

describe('a page without the 6.0 shape is refused by a throw, and nothing is taken from it', () => {
  it('a 5.x page ({ items, nextCursor } with no through, head or positions) throws PeerPagesBySeq and delivers nothing', async () => {
    const m = modules('5.x page');
    const { PeerPagesBySeq } = await import('../../server/dist/util/errors.js');
    let delivered = 0;
    await assert.rejects(
      m.pagePositionRuns({
        outcome: { deliveredThrough: 7, truncated: false }, limit: 3,
        fetch: async () => ({ body: { items: [{ _id: 'a', seq: 9 }], nextCursor: null } }),
        deliver: async () => { delivered++; return null; }, stopped: () => {},
      }),
      (err) => err instanceof PeerPagesBySeq,
    );
    assert.equal(delivered, 0);
  });

  it('each missing or malformed member of the answer is the same refusal', async () => {
    const m = modules('malformed page');
    const { PeerPagesBySeq } = await import('../../server/dist/util/errors.js');
    const good = { items: [], nextCursor: null, through: 10, head: 10, positions: 1 };
    for (const bad of [{ ...good, positions: undefined }, { ...good, positions: 2 }, { ...good, through: undefined }, { ...good, head: 'x' },
      { ...good, through: -1 }, { ...good, head: 1.5 }, { ...good, items: {} }, null, 'text', [], 7]) {
      const outcome = { deliveredThrough: 3, truncated: false };
      await assert.rejects(
        m.pagePositionRuns({ outcome, limit: 3, fetch: async () => ({ body: bad }), deliver: async () => null, stopped: () => {} }),
        (err) => err instanceof PeerPagesBySeq, JSON.stringify(bad));
      assert.deepEqual(outcome, { deliveredThrough: 3, truncated: false }, 'a refused answer moved nothing: the mark is exactly where it was, and not NaN');
    }
  });
});

describe('what the peer says is checked against what it served', () => {
  /** Serve `pages` in order, then fail the test if asked for more. */
  const script = (pages) => { let i = 0; return async () => { assert.ok(i < pages.length, 'the pager asked past the script'); return { body: pages[i++] }; }; };
  const page = (items, o = {}) => ({ items, nextCursor: null, through: 100, head: 100, positions: 1, ...o });

  it('a `through` above the peer\'s own head is a stop, and moves nothing', async () => {
    const m = modules('through above head');
    const r = await run(m, script([page([{ _id: 'a' }], { through: 500, head: 100 })]), { limit: 2 });
    assert.equal(r.outcome.truncated, true);
    assert.equal(r.outcome.deliveredThrough, 0);
    assert.equal(r.stops.length, 1);
    assert.deepEqual(r.handedOn, [], 'a page that lies about its own stream hands nothing on');
  });

  it('the same cursor twice is a stop, not a loop', async () => {
    const m = modules('repeated cursor');
    const c = m.encodePositionCursor({ pos: 5, id: 'a' });
    const r = await run(m, script([
      page([{ _id: 'x' }, { _id: 'a' }], { nextCursor: c, through: 4 }),
      page([{ _id: 'a' }], { nextCursor: c, through: 4 }),
      page([{ _id: 'a' }], { nextCursor: c, through: 4 }),
    ]), { limit: 2 });
    assert.equal(r.outcome.truncated, true);
    assert.equal(r.stops.length, 1);
    assert.ok(r.asks.length <= 3);
    assert.ok(r.outcome.deliveredThrough <= 4, 'position 5 was never completed');
  });

  it('a cursor that goes backwards is a stop', async () => {
    const m = modules('backward cursor');
    const r = await run(m, script([
      page([{ _id: 'x' }, { _id: 'm' }], { nextCursor: m.encodePositionCursor({ pos: 5, id: 'm' }), through: 4 }),
      page([{ _id: 'a' }], { nextCursor: m.encodePositionCursor({ pos: 5, id: 'a' }), through: 4 }),
    ]), { limit: 2 });
    assert.equal(r.outcome.truncated, true);
    assert.equal(r.stops.length, 1);
  });

  it('a cursor that cannot be read, and every OLD cursor form, is a stop', async () => {
    const m = modules('unreadable cursor');
    const bare = (n) => Buffer.from(String(n)).toString('base64url');
    for (const bad of ['!!!!', bare(5), Buffer.from('5:some-record-id').toString('base64url'), 'p1.', 'p1.!!', 'p1.' + Buffer.from('x:y').toString('base64url')]) {
      const r = await run(m, script([page([{ _id: 'x' }, { _id: 'a' }], { nextCursor: bad, through: 4 })]), { limit: 2 });
      assert.equal(r.outcome.truncated, true, `cursor ${bad}`);
      assert.equal(r.stops.length, 1, `cursor ${bad}`);
    }
  });

  it('a page that says more follows and serves nothing is a stop', async () => {
    const m = modules('more but empty');
    const r = await run(m, script([page([], { nextCursor: m.encodePositionCursor({ pos: 9, id: 'z' }), through: 8 })]), { limit: 2 });
    assert.equal(r.outcome.truncated, true);
    assert.equal(r.stops.length, 1);
  });

  it('_id is compared as UTF-8 BYTES, as Mongo orders it, never as UTF-16 code units', async () => {
    const m = modules('byte order');
    const lower = '\u{E000}'; // bytes EE 80 80
    const higher = '\u{1F600}'; // bytes F0 9F 98 80, but its UTF-16 units D83D DE00 sort BEFORE U+E000
    assert.ok(byteOrder(lower, higher) < 0, 'premise: as bytes, U+E000 comes first');
    assert.ok(higher < lower, 'premise: JavaScript `<` says the opposite, which is the trap');
    const records = [rec(5, lower), rec(5, higher), rec(5, '\u{FFFD}'), rec(6, 'a')];
    const r = await run(m, server(records, m), { limit: 1 });
    assert.equal(r.outcome.truncated, false, `a correctly ordered server was refused: ${JSON.stringify(r.stops)}`);
    assert.deepEqual(r.handedOn, sortRecords(records).map(x => x._id));
  });

  it('an _id past 1024 characters becomes a bare-position cursor at that one boundary, and the run still arrives whole', async () => {
    const m = modules('long-id boundary');
    const long = `p/${'d/'.repeat(1000)}f.md`;
    const records = [rec(4, 'x'), rec(5, 'a'), rec(5, long), rec(5, 'z'.repeat(2000)), rec(6, 'q')];
    // Four per page: the re-read from the bare cursor holds the whole run (3) and the record after it.
    const r = await run(m, server(records, m), { limit: 4 });
    assert.equal(r.outcome.truncated, false, JSON.stringify(r.stops));
    assert.equal(new Set(r.handedOn).size, r.handedOn.length, 'a record handed on twice');
    assert.deepEqual([...new Set(r.handedOn)].sort(), sortRecords(records).map(x => x._id).sort(), 'a record was skipped');
  });
});

describe('maxPages bounds one cycle as a CAP, and the next one resumes from what was complete', () => {
  it('five pages, then a cap stop held at the last page\'s `through`', async () => {
    const m = modules('cap');
    const records = runsOf(Array.from({ length: 40 }, () => 1));
    const r = await run(m, server(records, m), { limit: 3, maxPages: 5 });
    assert.equal(r.asks.length, 5, 'it fetched maxPages pages and no more');
    assert.equal(r.outcome.truncated, true);
    assert.equal(r.outcome.stoppedBy, 'cap', 'the cycle\'s bound is a cap, not a fault: the member is catching up and is not failing');
    assert.equal(r.outcome.deliveredThrough, 14, 'fifteen records handed on; position 15 may have more at it, so complete through 14');
    assert.equal(r.stops.length, 1);
    assert.equal(r.stops[0].heldAt, 14);
    assert.equal(r.handedOn.length, 15);
  });

  it('a transfer that ends exactly on its last allowed page is complete, not capped', async () => {
    const m = modules('cap boundary');
    const r = await run(m, server(runsOf(Array.from({ length: 13 }, () => 1)), m), { limit: 3, maxPages: 5 }); // four full pages of 3, then one record
    assert.equal(r.asks.length, 5);
    assert.equal(r.outcome.truncated, false, JSON.stringify(r.stops));
    assert.equal(r.outcome.deliveredThrough, CAP - 1);
  });

  it('with no maxPages named, a transfer that never ends stops as capped at the one shared bound', async () => {
    const m = modules('the shared page bound');
    let n = 0;
    const idOf = (i) => `e${String(i).padStart(4, '0')}`;
    const endless = async () => {
      n++;
      return { body: { items: [{ _id: idOf(n) }], nextCursor: m.encodePositionCursor({ pos: n, id: idOf(n) }), through: n - 1, head: CAP, positions: 1 } };
    };
    const r = await run(m, endless, { limit: 1 });
    assert.equal(r.asks.length, 200, 'the bound is one constant, 200 requests');
    assert.equal(r.outcome.truncated, true);
    assert.equal(r.outcome.stoppedBy, 'cap');
    assert.equal(r.stops.length, 1);
    assert.match(r.stops[0].why, /200-request bound/);
  });
});

describe('the head guard: a mark above the peer\'s head means its positions went backwards', () => {
  it('the transfer restarts from 0 once, tells the caller, and reads everything the peer holds', async () => {
    const m = modules('head guard');
    const records = runsOf([2, 2, 2]);
    const calls = [];
    const r = await run(m, server(records, m, { cap: 50 }), { limit: 4, start: 9_999, onBehind: (head, from) => calls.push({ head, from }) });
    assert.deepEqual(calls, [{ head: 49, from: 9_999 }], 'called once, with the peer\'s head and the mark it started from');
    assert.deepEqual(r.handedOn, everyOnce(records), 'the whole of what the peer holds was read again from 0');
    assert.equal(r.outcome.truncated, false);
    assert.equal(r.outcome.deliveredThrough, 49, 'complete through the peer\'s own end, which is BELOW the stale mark');
    assert.equal(r.asks[0].afterPos, 9_999);
    assert.equal(r.asks[1].afterPos, 0);
  });

  it('control: a mark at or below the head is not forgotten', async () => {
    const m = modules('head guard control');
    const calls = [];
    const r = await run(m, server(runsOf([2, 2]), m, { cap: 50 }), { limit: 4, start: 49, onBehind: (h, f) => calls.push({ h, f }) });
    assert.deepEqual(calls, []);
    assert.deepEqual(r.handedOn, []);
    assert.equal(r.outcome.deliveredThrough, 49);
  });
});

describe('the pager\'s shared helper', () => {
  it('serverCursorOf reads a cursor three ways: a string, null for the last page, undefined for a server with no cursor', () => {
    const { serverCursorOf } = modules('one reading of a cursor for every pull');
    assert.equal(serverCursorOf('abc'), 'abc');
    assert.equal(serverCursorOf(null), null);
    for (const none of [undefined, 5, {}, [], true]) assert.equal(serverCursorOf(none), undefined, `${JSON.stringify(none)} is no cursor`);
  });
});
