/**
 * The pager for a peer that serves records in seq order never skips the rest of a run of equal seqs, never trusts a
 * seq it refused, and says how far it is COMPLETE when it stops (bundle-52, Q-277 / Q-295).
 *
 * ## The defect
 *
 * Records from several authors share seqs, so a page boundary can fall inside a run. The pager in
 * `sync/tombstone-transfer.ts` (`pageTombstones`) re-asked at "the lowest last seq of a full group, MINUS ONE" and
 * skipped what it had handed on — correct for a legacy peer, but written for tombstones only, with a seen set that
 * grew for the whole transfer, a cursor that a forged element could not move but an all-refused full page could
 * not move PAST either (a transfer wedged behind one planted page), and `deliveredThrough` left at the cursor.
 *
 * Module under test: `server/src/sync/seq-run-pager.ts` (built to `server/dist/sync/seq-run-pager.js`), extracted
 * from `pageTombstones` and used by the record pull and the tombstone pull alike. It reads cursors with
 * `server/src/util/seq-keyset.ts`.
 *
 * ## The contract, as these tests state it
 *
 * `pageSeqRuns(o)` resolves when the transfer ends and reports through `o.outcome` (`{ deliveredThrough, truncated }`,
 * the shape `sync/watermark.ts` reads), updated as it goes so a throw leaves it at the last position delivered.
 *
 * - `o.limit`: what a request asks for. `o.maxLimit` (default `o.limit`): the one larger ask a legacy page made of a
 *   single seq is retried at before the transfer gives up. `o.maxPages` (default: a bound of the module's own): pages
 *   one call may fetch before it stops as a cap.
 * - `o.fetch({ sinceSeq, cursor }, limit)` -> `{ groups: unknown[][], nextCursor?: string | null } | { status: number }`.
 *   `cursor` is the SERVER's own cursor, handed back verbatim, and only once the server has handed out a PAIR cursor;
 *   otherwise it is `null` and `sinceSeq` is the position. `nextCursor`: a string is the server's cursor (a pair, or a
 *   bare seq from a legacy server); `null` means this was the last page; `undefined` means the server has no cursor at
 *   all (a legacy tombstone route), and a group then counts as full when it holds `limit` elements.
 * - `o.admit(raw)` -> `{ seq, key } | null`: the one admission rule of the caller. `null` is a refused element. Only an
 *   ADMITTED element counts as handed on, and only an admitted seq may move anything the pager reports.
 * - `o.deliver(fresh)` -> `null` when delivered, or the reason the transfer must stop. `fresh` is what was not handed
 *   on before; refused elements are passed on too, so the caller counts its refusal.
 * - `o.stopped(why, heldAt)`: how a stop is logged — what stopped it, and the position it is held at.
 *
 * ## The rules
 *
 * - FULL means `nextCursor !== null` when the server sends one, and never `items.length`: a last page inflated by
 *   riders must stop, and a page shorter than `limit` that has a `nextCursor` must go on.
 * - A pair cursor is followed. Each one must decode to the page's LAST element `(seq, _id)` and be strictly greater than
 *   the one before, with `_id` compared as UTF-8 bytes (how Mongo orders it), else the transfer stops (`failed`).
 * - A bare-seq cursor, or none, is the legacy path: re-ask at the lowest last admitted seq of a full group minus one.
 * - `deliveredThrough` is the last COMPLETE seq: a finished transfer gets its highest admitted seq; a stop inside a
 *   run gets that seq minus one.
 * - The seen set keeps only keys at or above the lowest seq that can be served again.
 *
 * Every rule loads both modules itself and fails with "does not exist" while they are not written.
 *
 * Run: node --test testing/standalone/a-seq-run-pager-never-skips-a-tie.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

let pagerLoaded;
let keysetLoaded;
before(async () => {
  pagerLoaded = await loadDistModule('../../server/dist/sync/seq-run-pager.js', import.meta.url);
  keysetLoaded = await loadDistModule('../../server/dist/util/seq-keyset.js', import.meta.url);
});

/** Both modules, or the failure that names the one that is missing. */
function modules(rule) {
  const { pageSeqRuns } = needModule(pagerLoaded, ['pageSeqRuns'], rule);
  const { encodeSeqCursor, decodeSeqCursor } = needModule(keysetLoaded, ['encodeSeqCursor', 'decodeSeqCursor'], rule);
  return { pageSeqRuns, encodeSeqCursor, decodeSeqCursor };
}

const byteOrder = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const sortRecords = (records) => [...records].sort((a, b) => a.seq - b.seq || byteOrder(a._id, b._id));
const rec = (seq, id, extra = {}) => ({ _id: id, seq, ...extra });
const refused = (seq, id) => rec(seq, id, { refused: true });
const bare = (seq) => Buffer.from(String(seq)).toString('base64url');

/** The one admission rule of these tests: a record flagged `refused` is not admitted. */
const admit = (raw) => (raw && !raw.refused ? { seq: raw.seq, key: `seqpager-${raw._id}` } : null);

/** A server that pages by the PAIR cursor, the way the new `GET /api/sync/*` routes do. */
function pairServer(records, m) {
  const sorted = sortRecords(records);
  return async (ask, limit) => {
    const pos = ask.cursor !== null && ask.cursor !== undefined ? m.decodeSeqCursor(ask.cursor) : { seq: ask.sinceSeq };
    assert.ok(pos, 'the pager must hand back a cursor the server can read');
    const after = sorted.filter(r => r.seq > pos.seq || (pos.id !== undefined && r.seq === pos.seq && byteOrder(r._id, pos.id) > 0));
    const items = after.slice(0, limit);
    const last = items[items.length - 1];
    return { groups: [items], nextCursor: after.length > limit ? m.encodeSeqCursor({ seq: last.seq, id: last._id }) : null };
  };
}

/** A server that pages by a bare seq — what 5.6.x does: `seq > since`, `nextCursor` the last seq, ties lost to the cursor. */
function legacyServer(records, { riders = 0 } = {}) {
  const sorted = sortRecords(records);
  return async (ask, limit) => {
    const since = ask.cursor ? Number.parseInt(Buffer.from(ask.cursor, 'base64url').toString(), 10) : ask.sinceSeq;
    const after = sorted.filter(r => r.seq > since);
    let items = after.slice(0, limit);
    const more = after.length > limit;
    // Riders are appended past `limit` on a page with nothing more to say: the page is longer than `limit` and is the last.
    if (!more && riders > 0) items = [...items, ...sorted.slice(0, riders).map(r => ({ ...r, rider: true }))];
    return { groups: [items], nextCursor: more ? bare(items[items.length - 1].seq) : null };
  };
}

/** Run the pager over a scripted or simulated server and report everything it did. */
async function run(m, serve, { limit = 3, start = 0, maxLimit, maxPages, deliverImpl } = {}) {
  const outcome = { deliveredThrough: start, truncated: false };
  const asks = [];
  const deliveries = [];
  const stops = [];
  let calls = 0;
  const opts = {
    outcome,
    limit,
    fetch: async (ask, l) => { asks.push({ ...ask, limit: l }); return serve(ask, l); },
    admit,
    deliver: async (fresh) => {
      calls++;
      const refusal = deliverImpl ? deliverImpl(fresh, calls) : null;
      if (refusal === null) deliveries.push(fresh); // only what LANDED counts as handed on
      return refusal;
    },
    stopped: (why, heldAt) => stops.push({ why, heldAt }),
  };
  if (maxLimit !== undefined) opts.maxLimit = maxLimit;
  if (maxPages !== undefined) opts.maxPages = maxPages;
  await m.pageSeqRuns(opts);
  const handedOn = deliveries.flat().filter(r => !r.refused && !r.rider).map(r => r._id);
  return { outcome, asks, deliveries, stops, handedOn };
}

/** What an operator-visible transfer is owed: every admitted record once. */
const everyAdmittedOnce = (records) => sortRecords(records).filter(r => !r.refused).map(r => r._id);

/** A deterministic spread of runs: `runLengths` records per seq, seqs 1.. (never a run longer than `maxRun`). */
function runsOf(runLengths) {
  const records = [];
  runLengths.forEach((n, i) => { for (let k = 0; k < n; k++) records.push(rec(i + 1, `r${String(i + 1).padStart(3, '0')}-${k}`)); });
  return records;
}

const SERVERS = [['pair cursor', pairServer], ['legacy bare cursor', (r) => legacyServer(r)]];

describe('ties across pages are all delivered, once', () => {
  for (const [name, make] of SERVERS) {
    it(`${name}: records sharing a seq across every page boundary all arrive, none twice`, async () => {
      const m = modules(`ties (${name})`);
      for (const limit of [2, 3, 4, 5]) {
        // Runs strictly shorter than a page: the case the legacy path can serve. Every boundary is placed by `limit`.
        const lengths = Array.from({ length: 24 }, (_, i) => 1 + ((i * 7 + limit) % (limit - 1)));
        const records = runsOf(lengths);
        const r = await run(m, make(records, m), { limit, maxLimit: limit });
        assert.deepEqual(r.handedOn, everyAdmittedOnce(records), `limit ${limit}`);
        assert.equal(new Set(r.handedOn).size, r.handedOn.length, `limit ${limit}: a record handed on twice`);
        assert.equal(r.outcome.truncated, false, `limit ${limit}: ${JSON.stringify(r.stops)}`);
        assert.equal(r.outcome.deliveredThrough, lengths.length, `limit ${limit}: a finished transfer is complete through its highest seq`);
        assert.deepEqual(r.stops, []);
      }
    });
  }

  it('pair cursor: a run LONGER than a page is served whole, with no retry and no stop', async () => {
    const m = modules('long run');
    const records = [rec(1, 'r1'), rec(5, 'r5a'), rec(5, 'r5b'), rec(5, 'r5c'), rec(5, 'r5d'), rec(5, 'r5e'), rec(5, 'r5f'), rec(6, 'r6'), rec(7, 'r7')];
    const r = await run(m, pairServer(records, m), { limit: 2, maxLimit: 2 });
    assert.deepEqual(r.handedOn, everyAdmittedOnce(records));
    assert.equal(r.outcome.truncated, false);
    assert.equal(r.outcome.deliveredThrough, 7);
    assert.ok(r.asks.every(a => a.limit === 2), 'no larger retry was needed');
  });

  it('a transfer that starts above 0 asks from there, and a transfer with nothing to do leaves it', async () => {
    const m = modules('start position');
    for (const [name, make] of SERVERS) {
      const r = await run(m, make([rec(1, 'a'), rec(2, 'b')], m), { start: 100 });
      assert.equal(r.asks[0].sinceSeq, 100, name);
      assert.equal(r.asks.length, 1, name);
      assert.equal(r.outcome.deliveredThrough, 100, name);
      assert.equal(r.outcome.truncated, false, name);
      assert.deepEqual(r.handedOn, [], name);
    }
  });

  it('a peer with no cursor at all: groups are full by their length, and every group of every page is delivered', async () => {
    const m = modules('cursorless groups');
    const g1 = [rec(1, 'a1'), rec(2, 'a2'), rec(3, 'a3'), rec(3, 'a3b'), rec(4, 'a4'), rec(5, 'a5')];
    const g2 = [rec(1, 'b1'), rec(9, 'b9')];
    const sorted = [sortRecords(g1), sortRecords(g2)];
    const serve = async (ask, limit) => ({ groups: sorted.map(g => g.filter(r => r.seq > ask.sinceSeq).slice(0, limit)) });
    const r = await run(m, serve, { limit: 3, maxLimit: 3 });
    assert.deepEqual([...r.handedOn].sort(), [...g1, ...g2].map(x => x._id).sort());
    assert.equal(new Set(r.handedOn).size, r.handedOn.length);
    assert.equal(r.outcome.truncated, false, JSON.stringify(r.stops));
    assert.equal(r.outcome.deliveredThrough, 9);
  });

  it('a legacy page that is ONE seq is asked again at maxLimit, and past it the transfer stops at that seq minus one', async () => {
    const m = modules('legacy single-seq page');
    const records = [rec(3, 'r3'), rec(5, 'r5a'), rec(5, 'r5b'), rec(5, 'r5c'), rec(6, 'r6')];
    const retried = await run(m, legacyServer(records), { limit: 3, maxLimit: 10 });
    assert.deepEqual(retried.handedOn, everyAdmittedOnce(records), 'one larger ask serves the whole run');
    assert.equal(retried.outcome.truncated, false);
    assert.ok(retried.asks.some(a => a.limit === 10), 'it asked again at maxLimit');

    const stuck = await run(m, legacyServer(records), { limit: 3, maxLimit: 3 });
    assert.equal(stuck.outcome.truncated, true, 'a run no ask can page past holds the transfer');
    assert.equal(stuck.outcome.deliveredThrough, 4, 'held at S-1: seq 5 is not complete');
    assert.equal(stuck.stops.length, 1);
    assert.equal(stuck.stops[0].heldAt, 4);
    assert.ok(stuck.asks.length <= 6, 'it stops, it does not loop');
  });
});

describe('a stop inside a run reports the seq before the run, never the run', () => {
  for (const [name, make] of SERVERS) {
    it(`${name}: deliver refusing on page 2, inside the run at seq 5, holds at 4`, async () => {
      const m = modules(`stop in a run (${name})`);
      const records = [rec(1, 'r1'), rec(2, 'r2'), rec(5, 'r5a'), rec(5, 'r5b'), rec(6, 'r6')];
      const r = await run(m, make(records, m), { limit: 3, maxLimit: 3, deliverImpl: (_f, call) => (call === 2 ? 'the peer answered 503' : null) });
      assert.equal(r.outcome.truncated, true);
      assert.equal(r.outcome.deliveredThrough, 4, 'seq 5 was delivered in part (5a, not 5b): complete through 4');
      assert.deepEqual(r.stops.map(s => s.heldAt), [4]);
      assert.match(r.stops[0].why, /503/, 'the stop says why');
      assert.deepEqual(r.handedOn, ['r1', 'r2', 'r5a'], 'page 1 landed, page 2 did not');
    });

    it(`${name}: the first delivery refused leaves the position where the transfer started`, async () => {
      const m = modules(`first stop (${name})`);
      const records = [rec(1, 'r1'), rec(2, 'r2'), rec(5, 'r5a'), rec(5, 'r5b')];
      const r = await run(m, make(records, m), { limit: 3, start: 0, deliverImpl: () => 'the store is down' });
      assert.equal(r.outcome.truncated, true);
      assert.equal(r.outcome.deliveredThrough, 0, 'nothing was handed on, so nothing is vouched for');
    });

    it(`${name}: a non-ok answer on page 2 holds at the last complete seq`, async () => {
      const m = modules(`status stop (${name})`);
      const records = [rec(1, 'r1'), rec(2, 'r2'), rec(5, 'r5a'), rec(5, 'r5b'), rec(6, 'r6')];
      const inner = make(records, m);
      let calls = 0;
      const r = await run(m, async (ask, limit) => (++calls === 2 ? { status: 503 } : inner(ask, limit)), { limit: 3, maxLimit: 3 });
      assert.equal(r.outcome.truncated, true);
      assert.equal(r.outcome.deliveredThrough, 4);
      assert.match(r.stops[0].why, /503/);
    });
  }
});

describe('the seen set keeps only what can be served again', () => {
  /** The largest size any Set or Map reached while holding one of this test's keys, while `fn` ran. */
  async function largestKeyCollection(fn) {
    let max = 0;
    const hasMark = (v) => typeof v === 'string' && v.includes('seqpager-');
    const setAdd = Set.prototype.add;
    const mapSet = Map.prototype.set;
    Set.prototype.add = function add(v) { const out = setAdd.call(this, v); if (hasMark(v) && this.size > max) max = this.size; return out; };
    Map.prototype.set = function set(k, v) { const out = mapSet.call(this, k, v); if ((hasMark(k) || hasMark(v)) && this.size > max) max = this.size; return out; };
    try { await fn(); } finally { Set.prototype.add = setAdd; Map.prototype.set = mapSet; }
    return max;
  }

  it('legacy cursor: 300 seqs through pages of 4 never hold more than a few pages of keys, and nothing is handed on twice', async () => {
    const m = modules('bounded seen set');
    const records = runsOf(Array.from({ length: 300 }, () => 1));
    let result;
    const biggest = await largestKeyCollection(async () => { result = await run(m, legacyServer(records), { limit: 4, maxLimit: 4 }); });
    assert.deepEqual(result.handedOn, everyAdmittedOnce(records));
    assert.equal(new Set(result.handedOn).size, 300, 'the spy on deliver saw every record exactly once');
    assert.equal(result.outcome.truncated, false);
    assert.ok(result.asks.length >= 75, 'the transfer really was many pages');
    assert.ok(biggest > 0, 'the pager did hold keys, so the bound below measures something');
    assert.ok(biggest <= 3 * 4, `the seen set reached ${biggest} keys; only keys at or above the lowest re-readable seq may stay`);
  });
});

describe('a refused element never moves a position, and an all-refused page does not wedge a pair cursor', () => {
  it('pair cursor: a full page of refused elements is passed by the SERVER\'s position, and the honest records after it arrive', async () => {
    const m = modules('all-refused (pair)');
    const records = [refused(10, 'f1'), refused(11, 'f2'), refused(12, 'f3'), rec(13, 'h1'), rec(14, 'h2')];
    const r = await run(m, pairServer(records, m), { limit: 3, maxLimit: 3 });
    assert.deepEqual(r.handedOn, ['h1', 'h2']);
    assert.equal(r.outcome.truncated, false, JSON.stringify(r.stops));
    assert.equal(r.outcome.deliveredThrough, 14);
    assert.ok(r.deliveries.flat().some(x => x.refused), 'the refused elements still reach deliver, so the caller counts them');
  });

  it('legacy cursor: a full page of refused elements holds — it stops, says it was that stop, and moves nothing', async () => {
    const m = modules('all-refused (legacy)');
    const records = [refused(10, 'f1'), refused(11, 'f2'), refused(12, 'f3'), rec(13, 'h1')];
    const r = await run(m, legacyServer(records), { limit: 3, maxLimit: 3 });
    assert.equal(r.outcome.truncated, true);
    assert.equal(r.outcome.deliveredThrough, 0, 'no seq was taken from a refused element');
    assert.equal(r.stops.length, 1);
    assert.match(r.stops[0].why, /refus|admit|forg/i, 'the stop names what it was, so an operator can tell it from a long run');
    assert.ok(r.asks.length <= 3, 'it holds; it does not loop');
  });

  it('pair cursor: a forged seq of 1e15 in a refused element moves neither the position nor deliveredThrough', async () => {
    const m = modules('forged seq (pair)');
    const FORGED = 1e15;
    const records = [rec(1, 'h1'), rec(2, 'h2'), refused(FORGED, 'f1'), refused(FORGED + 1, 'f2')];
    // Stop at page 2 so deliveredThrough is read straight after the page that ended on the forged element.
    const r = await run(m, pairServer(records, m), { limit: 3, maxLimit: 3, deliverImpl: (_f, call) => (call === 2 ? 'stopped for the test' : null) });
    assert.equal(r.outcome.truncated, true);
    assert.ok(r.outcome.deliveredThrough <= 2, `deliveredThrough ${r.outcome.deliveredThrough} was taken from the forged seq`);
    assert.ok(r.stops.every(s => s.heldAt < 1e12), 'the stop is not held at the forged seq');
  });

  it('legacy cursor: a forged seq of 1e15 in a refused element moves neither the next ask nor deliveredThrough', async () => {
    const m = modules('forged seq (legacy)');
    const FORGED = 1e15;
    const records = [rec(1, 'h1'), rec(2, 'h2'), rec(3, 'h3'), refused(FORGED, 'f1'), refused(FORGED + 1, 'f2'), refused(FORGED + 2, 'f3')];
    const r = await run(m, legacyServer(records), { limit: 3, maxLimit: 3 });
    assert.ok(r.asks.every(a => a.sinceSeq < 1e12), `an ask used the forged seq: ${JSON.stringify(r.asks.map(a => a.sinceSeq))}`);
    assert.ok(r.outcome.deliveredThrough < 1e12);
    assert.deepEqual(r.handedOn, ['h1', 'h2', 'h3'], 'the honest records before the forgery are all handed on');
    assert.ok(r.outcome.deliveredThrough <= 3, 'complete only through what was admitted');
  });

  it('a finished transfer is complete through its highest ADMITTED seq, not through a refused one', async () => {
    const m = modules('finished transfer');
    for (const [name, make] of SERVERS) {
      const r = await run(m, make([rec(1, 'h1'), rec(2, 'h2'), refused(1e15, 'f1')], m), { limit: 5, maxLimit: 5 });
      assert.equal(r.outcome.truncated, false, name);
      assert.equal(r.outcome.deliveredThrough, 2, name);
    }
  });
});

describe('"full" is the server\'s word, not the length of the page', () => {
  it('a last page inflated past the limit by riders, with nextCursor null, is the last: one request', async () => {
    const m = modules('rider-inflated last page');
    const records = [rec(1, 'a'), rec(2, 'b')];
    const r = await run(m, legacyServer(records, { riders: 4 }), { limit: 3, maxLimit: 3 });
    assert.equal(r.asks.length, 1, 'riders made the page longer than limit, which is not a reason to ask again');
    assert.equal(r.outcome.truncated, false);
    assert.deepEqual(r.handedOn, ['a', 'b']);
  });

  it('a page SHORTER than the limit that carries a nextCursor is not the last', async () => {
    const m = modules('short page with a cursor');
    const pages = [
      { groups: [[rec(1, 'a'), rec(2, 'b')]], nextCursor: m.encodeSeqCursor({ seq: 2, id: 'b' }) },
      { groups: [[rec(3, 'c')]], nextCursor: null },
    ];
    let i = 0;
    const r = await run(m, async () => pages[i++], { limit: 5, maxLimit: 5 });
    assert.equal(r.asks.length, 2);
    assert.deepEqual(r.handedOn, ['a', 'b', 'c']);
    assert.equal(r.outcome.deliveredThrough, 3);
  });
});

describe('a cursor that does not advance strictly is a stop, not a loop', () => {
  /** Serve `pages` in order, then fail the test if asked for more. */
  const script = (pages) => { let i = 0; return async () => { assert.ok(i < pages.length, 'the pager asked past the script'); return pages[i++]; }; };

  it('the same cursor twice', async () => {
    const m = modules('repeated cursor');
    const c = m.encodeSeqCursor({ seq: 5, id: 'a' });
    const r = await run(m, script([
      { groups: [[rec(4, 'x'), rec(5, 'a')]], nextCursor: c },
      { groups: [[rec(5, 'a')]], nextCursor: c },
      { groups: [[rec(5, 'a')]], nextCursor: c },
    ]), { limit: 2, maxLimit: 2 });
    assert.equal(r.outcome.truncated, true);
    assert.equal(r.stops.length, 1);
    assert.ok(r.asks.length <= 3);
    assert.ok(r.outcome.deliveredThrough <= 4, 'seq 5 was never completed');
  });

  it('a cursor that goes backwards', async () => {
    const m = modules('backward cursor');
    const r = await run(m, script([
      { groups: [[rec(4, 'x'), rec(5, 'm')]], nextCursor: m.encodeSeqCursor({ seq: 5, id: 'm' }) },
      { groups: [[rec(5, 'a')]], nextCursor: m.encodeSeqCursor({ seq: 5, id: 'a' }) },
    ]), { limit: 2, maxLimit: 2 });
    assert.equal(r.outcome.truncated, true);
    assert.equal(r.stops.length, 1);
  });

  it('a cursor that is not the position of the page\'s last element', async () => {
    const m = modules('cursor off the last element');
    const r = await run(m, script([
      { groups: [[rec(4, 'x'), rec(5, 'a')]], nextCursor: m.encodeSeqCursor({ seq: 9, id: 'zzz' }) },
    ]), { limit: 2, maxLimit: 2 });
    assert.equal(r.outcome.truncated, true, 'a server that skips ahead of what it served is not followed');
    assert.equal(r.stops.length, 1);
    assert.ok(r.outcome.deliveredThrough < 9);
  });

  it('a cursor that cannot be read at all', async () => {
    const m = modules('unreadable cursor');
    const r = await run(m, script([{ groups: [[rec(4, 'x'), rec(5, 'a')]], nextCursor: '!!!!' }]), { limit: 2, maxLimit: 2 });
    assert.equal(r.outcome.truncated, true);
    assert.equal(r.stops.length, 1);
  });

  it('_id is compared as UTF-8 BYTES, as Mongo orders it, never as UTF-16 code units', async () => {
    const m = modules('byte order');
    const lower = ''; // bytes EE 80 80
    const higher = '\u{1F600}'; // bytes F0 9F 98 80, but its UTF-16 units D83D DE00 sort BEFORE U+E000
    assert.ok(byteOrder(lower, higher) < 0, 'premise: as bytes, U+E000 comes first');
    assert.ok(higher < lower, 'premise: JavaScript `<` says the opposite, which is the trap');
    const records = [rec(5, lower), rec(5, higher), rec(5, '�'), rec(6, 'a')];
    const r = await run(m, pairServer(records, m), { limit: 1, maxLimit: 1 });
    assert.equal(r.outcome.truncated, false, `a correctly ordered server was refused: ${JSON.stringify(r.stops)}`);
    assert.deepEqual(r.handedOn, sortRecords(records).map(x => x._id));
  });

  it('an _id past 1024 characters becomes a bare cursor at that one boundary, and the run still arrives whole', async () => {
    const m = modules('long-id boundary');
    const long = `p/${'d/'.repeat(1000)}f.md`;
    const records = [rec(4, 'x'), rec(5, 'a'), rec(5, long), rec(5, 'z'.repeat(2000)), rec(6, 'q')];
    // Four per page: the re-read from the bare cursor holds the whole run (3) and the record after it.
    const r = await run(m, pairServer(records, m), { limit: 4, maxLimit: 4 });
    assert.equal(r.outcome.truncated, false, JSON.stringify(r.stops));
    assert.deepEqual(r.handedOn, sortRecords(records).map(x => x._id));
    assert.equal(new Set(r.handedOn).size, r.handedOn.length);
  });
});

describe('maxPages bounds one cycle, and the next one resumes from what was complete', () => {
  it('pair cursor: five pages, then a cap stop held at the last complete seq', async () => {
    const m = modules('cap (pair)');
    const records = runsOf(Array.from({ length: 40 }, () => 1));
    const r = await run(m, pairServer(records, m), { limit: 3, maxLimit: 3, maxPages: 5 });
    assert.equal(r.asks.length, 5, 'it fetched maxPages pages and no more');
    assert.equal(r.outcome.truncated, true);
    assert.equal(r.outcome.deliveredThrough, 14, 'fifteen records handed on; seq 15 may have more at it, so complete through 14');
    assert.equal(r.stops.length, 1);
    assert.equal(r.stops[0].heldAt, 14);
    assert.equal(r.handedOn.length, 15);
  });

  it('legacy cursor: the same, held at the cursor of the last full page', async () => {
    const m = modules('cap (legacy)');
    const records = runsOf(Array.from({ length: 40 }, () => 1));
    const r = await run(m, legacyServer(records), { limit: 3, maxLimit: 3, maxPages: 5 });
    assert.equal(r.asks.length, 5);
    assert.equal(r.outcome.truncated, true);
    assert.equal(r.outcome.deliveredThrough, 10);
    assert.equal(r.stops[0].heldAt, 10);
  });

  it('a transfer that ends exactly on its last allowed page is complete, not capped', async () => {
    const m = modules('cap boundary');
    const records = runsOf(Array.from({ length: 13 }, () => 1)); // four full pages of 3, then one record
    const r = await run(m, pairServer(records, m), { limit: 3, maxLimit: 3, maxPages: 5 });
    assert.equal(r.asks.length, 5);
    assert.equal(r.outcome.truncated, false, JSON.stringify(r.stops));
    assert.equal(r.outcome.deliveredThrough, 13);
  });
});
