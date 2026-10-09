/**
 * `file_stamp_report` names a row "likely stamped here" only when a peer's own file feed says so, and says nothing about
 * a row it has no evidence for (`Q-433`, plan rev 4 items 1, 2, 4, 7, 13, 14, 16, 17, 19, 23, 28).
 *
 * ## What the owner asked for, and why this file is the proof
 *
 * D-22: *"Build nothing automatic. Add a command you run per space, which reports what it would change before changing
 * it."* D-26 = A: a REPORT, never a repair. A report that names a genuine upload as a stamp sends an operator to edit
 * the metadata of a file that was theirs, so every row it prints has to be backed by the peer, and every row it cannot
 * back has to say so. The unit table (`a-file-stamp-verdict-says-likely-only-on-every-piece-of-evidence`) holds the
 * verdict function; this holds the REPORT around it, over a real Mongo and a fake peer whose file feed is the REAL
 * `GET /api/sync/filemeta` handler (`_file-stamp-door.mjs`), so the wire contract is the production one.
 *
 * ## The answer's contract (item 28), pinned here
 *
 * `fileStampReport(space, { limit, after, deadlineMs?, now? })` answers
 * `{ space, startedAt, candidates, checked, likely, cannotTell, truncated, nextAfter?, rows, rules }`:
 *
 *  - `rows` — one per candidate of THIS answer, ascending by path, each `{ path, verdict, reason, ours, peer? }` with
 *    `ours` `{ seq, createdAt, updatedAt, sha256? }` and `peer` `{ instanceId, author, seq, createdAt, updatedAt,
 *    sha256? }`; `verdict` is `likely-stamped-here` or `cannot-tell`; `reason` is a value of `FILE_STAMP_REASONS`.
 *  - `candidates` is `rows.length`; `checked` is the rows the run reached a conclusion about, and the rows it did not
 *    reach before the deadline say `NOT_CHECKED_BEFORE_DEADLINE`, so `candidates === checked + notChecked`;
 *    `likely + cannotTell === candidates`.
 *  - `limit` bounds the rows of an answer; `truncated` is true when a `limit + 1` read found one more, and then
 *    `nextAfter` is the last row's path, which `after` takes to continue.
 *  - `startedAt` is the run's start, read from `now` (default the wall clock) and written as an ISO instant.
 *  - `rules` — one sentence per exclusion rule, never a count and never a path.
 *
 * ## What it must NOT contain
 *
 * Peer text beyond the typed fields (no description, no tag), a member URL, a token, a network id — a report is read by
 * an operator and pasted into tickets (privacy S-5, S-6, S-9). The peer is named by instance id only.
 *
 * ## Time
 *
 * The deadline and the clock are INJECTED (`deadlineMs`, `now`), and the breaker is driven by CALL COUNT: the fake peer
 * fails its Nth request and the case counts what it was sent afterwards. Nothing here waits for a default timeout.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-file-stamp-report-names-only-what-the-peer-evidence-supports-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openStampDoor, PEER, PEER_AUTHOR, PEER_CREATED, OURS_CREATED, sha256Of, bytesOf } from './_file-stamp-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'stampev';
const LIKELY = 'likely-stamped-here';
const CANNOT = 'cannot-tell';

let stamp, door, REASONS;
/** Every feed GET the fake peer received since the case began, by the hook `serving` installs. */
let served;
/** Responses a case parked, so teardown can end them: a hung socket keeps `server.close` waiting for ever. */
let parked;

before(async () => {
  stamp = await openStampDoor({ suite: 'stampev', space: S });
  door = stamp.door;
});
after(async () => { await stamp?.close(); });
beforeEach(async () => { served = []; parked = []; await stamp.reset(); });
afterEach(() => { for (const res of parked) { try { res.status(500).end(); } catch { /* already gone */ } } });

/** The reasons, imported with the report: a missing module fails the case that needs it, after its fixture. */
async function reasons() {
  REASONS ??= (await import('../../server/dist/files/file-stamp-report.js')).FILE_STAMP_REASONS;
  return REASONS;
}

/**
 * Replace the fake peer's feed handler. `behave(req, res, serve)` answers each feed GET (`serve()` is the real handler);
 * every request is recorded first, with its 1-based number.
 */
function serving(behave = (_req, _res, serve) => serve()) {
  door.state.family = async (req, res, family) => {
    served.push({ n: served.length + 1, query: { ...req.query } });
    await behave(req, res, () => door.serveFamily(req, res, family), served.length);
  };
}
const fails = (status) => (_req, res) => { res.status(status).json({ error: 'scripted refusal' }); };

const notChecked = (a, R) => a.rows.filter(r => r.reason === R.NOT_CHECKED_BEFORE_DEADLINE).length;

/** The counts every answer must keep, in every case (item 13). */
async function assertCounts(a) {
  const R = await reasons();
  assert.equal(a.candidates, a.rows.length, 'candidates is not the number of rows of the answer: a candidate went unlisted');
  assert.equal(a.candidates, a.checked + notChecked(a, R), `candidates ${a.candidates} != checked ${a.checked} + not checked ${notChecked(a, R)}`);
  assert.equal(a.likely + a.cannotTell, a.candidates, 'likely + cannotTell != candidates: a row has no verdict');
  assert.equal(a.likely, a.rows.filter(r => r.verdict === LIKELY).length);
  assert.equal(a.cannotTell, a.rows.filter(r => r.verdict === CANNOT).length);
  const paths = a.rows.map(r => r.path);
  assert.deepEqual(paths, [...paths].sort(), 'rows are not ascending by path, so a cursor cannot continue from the last one');
}

describe('a stamp the peer vouches for', { skip }, () => {
  it('an S1 row comes back likely, with the evidence of both sides and nothing the peer did not say', async () => {
    const R = await reasons();
    const { ours, peer } = await stamp.s1('docs/a.txt');
    const answer = await stamp.report();

    assert.deepEqual(Object.keys(answer).filter(k => k !== 'nextAfter').sort(),
      ['candidates', 'cannotTell', 'checked', 'likely', 'rows', 'rules', 'space', 'startedAt', 'truncated'].sort(),
      'the answer has other keys than the contract (item 28)');
    assert.equal(answer.space, S);
    assert.equal(new Date(answer.startedAt).toISOString(), answer.startedAt, 'startedAt is not an ISO instant');
    assert.deepEqual([answer.candidates, answer.checked, answer.likely, answer.cannotTell, answer.truncated], [1, 1, 1, 0, false]);
    assert.equal(answer.nextAfter, undefined, 'a complete answer carries no cursor');
    await assertCounts(answer);

    const row = stamp.rowOf(answer, 'docs/a.txt');
    assert.ok(row, `the stamp is not in the report: ${JSON.stringify(answer)}`);
    assert.deepEqual(Object.keys(row).sort(), ['ours', 'path', 'peer', 'reason', 'verdict']);
    assert.equal(row.verdict, LIKELY);
    assert.equal(row.reason, R.LIKELY);
    assert.deepEqual(row.ours, { seq: ours.seq, createdAt: OURS_CREATED, updatedAt: OURS_CREATED, sha256: ours.sha256 });
    assert.deepEqual(row.peer, { instanceId: PEER, author: PEER_AUTHOR.instanceId, seq: peer.seq, createdAt: PEER_CREATED, updatedAt: PEER_CREATED, sha256: peer.sha256 });
  });

  it('the report asked the peer\'s file feed, by the network\'s space id, with the member\'s token, and nothing else', async () => {
    await stamp.s1('docs/a.txt');
    serving();
    await stamp.report();
    assert.ok(served.length >= 1, 'no request reached the peer: the evidence cannot have come from it');
    for (const { query } of served) {
      assert.equal(query.spaceId, stamp.remote, 'the feed was asked for another space than the network\'s id for this one');
      assert.equal(query.full, 'true', 'the feed was read as a listing of ids; the evidence is in the whole rows');
    }
  });

  it('nothing a peer said that is not a typed field reaches the report: no description, no tag, no address, no token', async () => {
    await stamp.s1('docs/a.txt', { ours: { description: 'WORDS-OF-OURS', tags: ['TAG-OURS'] }, peer: { description: 'WORDS-OF-THE-PEER', tags: ['TAG-PEER'] } });
    await stamp.peer('docs/b.txt', { description: 'WORDS-OF-THE-PEER-B', author: { instanceId: PEER, instanceLabel: '<script>LABEL-OF-THE-PEER</script>' } });
    await stamp.ours('docs/b.txt', { description: 'WORDS-OF-OURS-B' });
    const text = JSON.stringify(await stamp.report());
    for (const secret of ['WORDS-OF', 'TAG-', 'LABEL-OF-THE-PEER', 'pull-door-token', door.url, 'http://', 'tokenHash', door.NET, 'Pull-door network']) {
      assert.ok(!text.includes(secret), `the report carries ${JSON.stringify(secret)}: ${text.slice(0, 400)}`);
    }
  });

  it('a stamp drained through the REAL fillFileMetaFromStray (the peer\'s description, no source) is still likely', async () => {
    const R = await reasons();
    const content = { description: 'what the author wrote', tags: ['report'], properties: { owner: 'ops' } };
    await stamp.ours('docs/drained.txt');
    const row = await stamp.drained('docs/drained.txt', content);
    assert.equal(row.description, content.description, 'the fixture is not a drained row');
    assert.equal(row.descriptionSource, undefined, 'a drained row carries no machine label: the drain copies a HUMAN description');
    assert.deepEqual(row.tags, content.tags);
    await stamp.peer('docs/drained.txt', content);

    const answer = await stamp.report();
    const got = stamp.rowOf(answer, 'docs/drained.txt');
    assert.equal(got?.verdict, LIKELY, `a drained S1 row was not called likely: ${JSON.stringify(got)}`);
    assert.equal(got.reason, R.LIKELY);
    await assertCounts(answer);
  });
});

describe('what it will not call a stamp', { skip }, () => {
  it('an own upload this instance pushed (the peer says the author is THIS instance) is "cannot tell"', async () => {
    const R = await reasons();
    await stamp.s1('docs/own.txt', { peer: { author: stamp.selfAuthor } });
    const answer = await stamp.report();
    const row = stamp.rowOf(answer, 'docs/own.txt');
    assert.equal(row?.verdict, CANNOT, JSON.stringify(row));
    assert.equal(row.reason, R.PEER_SAYS_SELF);
    assert.equal(answer.likely, 0);
    await assertCounts(answer);
  });

  it('a description written here that the peer does not share is "cannot tell: edited here"', async () => {
    const R = await reasons();
    await stamp.s1('docs/edited.txt', { ours: { description: 'my own words' }, peer: { description: 'the author\'s words' } });
    const row = stamp.rowOf(await stamp.report(), 'docs/edited.txt');
    assert.equal(row?.verdict, CANNOT, JSON.stringify(row));
    assert.equal(row.reason, R.EDITED_HERE);
  });

  it('different bytes, a third author and a creation time too close each give "cannot tell", each with its own reason', async () => {
    const R = await reasons();
    await stamp.s1('docs/bytes.txt', { peer: { sha256: sha256Of('other bytes entirely') } });
    await stamp.s1('docs/relay.txt', { peer: { author: { instanceId: 'a-third-instance', instanceLabel: 'Third' } } });
    await stamp.s1('docs/close.txt', { peer: { createdAt: '2026-07-31T23:59:00.000Z' } });
    await stamp.s1('docs/nohash.txt', { ours: { sha256: undefined } });
    const answer = await stamp.report();
    const reasonOf = (p) => stamp.rowOf(answer, p)?.reason;
    assert.equal(reasonOf('docs/bytes.txt'), R.HASH_DIFFERS);
    assert.equal(reasonOf('docs/relay.txt'), R.RELAYED);
    assert.equal(reasonOf('docs/close.txt'), R.CREATED_NOT_EARLIER);
    assert.equal(reasonOf('docs/nohash.txt'), R.HASH_UNKNOWN);
    assert.equal(answer.likely, 0);
    await assertCounts(answer);
  });

  it('a path the peer holds nothing for is "cannot tell", not "likely" and not silence', async () => {
    const R = await reasons();
    await stamp.ours('docs/unheld.txt');
    const answer = await stamp.report();
    const row = stamp.rowOf(answer, 'docs/unheld.txt');
    assert.equal(row?.verdict, CANNOT, JSON.stringify(answer));
    assert.equal(row.reason, R.PEER_HOLDS_NOTHING);
    assert.equal(row.peer, undefined, 'a peer that holds nothing is named as holding something');
  });
});

describe('absence: a row that qualifies on every other count is never in the report for the one it fails (item 16)', { skip }, () => {
  it('a moved row (no syncBase), a deleted row, a peer-authored row (S2, seq inflated) and a chunk are not listed or counted; the control is', async () => {
    const { ours: control } = await stamp.s1('keep/control.txt');
    // Each of these has a peer row that would make it likely, and differs from the control in ONE count.
    await stamp.s1('skip/moved.txt', { ours: { syncBase: undefined } });
    await stamp.s1('skip/deleted.txt', { ours: { deletedAt: '2026-08-15T00:00:00.000Z' } });
    await stamp.s1('skip/s2.txt', { ours: { author: PEER_AUTHOR, seq: 9_999_999, deliveredBy: PEER } });
    await stamp.s1('skip/chunked.txt', { ours: { parentFileId: 'skip/parent.txt' } });

    const answer = await stamp.report();
    assert.deepEqual(answer.rows.map(r => r.path), ['keep/control.txt'], `rows: ${JSON.stringify(answer.rows)}`);
    assert.equal(answer.candidates, 1, 'an excluded row was counted as a candidate');
    assert.equal(answer.rows[0].verdict, LIKELY);
    assert.equal(answer.rows[0].ours.seq, control.seq);
    await assertCounts(answer);

    // The exclusions are said once, as rules: no path, no count (an excluded peer-authored row cannot be told from a local edit, D-22).
    assert.ok(Array.isArray(answer.rules) && answer.rules.length >= 3, `the report states ${answer.rules?.length} exclusion rules; it excludes at least three kinds of row`);
    for (const rule of answer.rules) {
      assert.ok(typeof rule === 'string' && rule.trim() !== '' && !rule.includes('skip/'), `a rule is not a plain sentence: ${JSON.stringify(rule)}`);
    }
    assert.equal(new Set(answer.rules).size, answer.rules.length, 'a rule is stated twice');
    assert.ok(!JSON.stringify(answer).includes('skip/'), 'the report mentions an excluded row');
  });

  it('a row deleted between the local read and the verdict is dropped, never reported as likely (privacy S-8)', async () => {
    await stamp.s1('race/gone.txt');
    await stamp.s1('race/stays.txt');
    serving(async (_req, _res, serve) => {
      // The peer's answer is on its way: this is after the candidates were read and before any verdict.
      await stamp.files().updateOne({ _id: 'race/gone.txt' }, { $set: { deletedAt: '2026-09-02T00:00:00.000Z' } });
      await serve();
    });
    const answer = await stamp.report();
    assert.equal(stamp.rowOf(answer, 'race/gone.txt'), undefined, `a file deleted since was reported: ${JSON.stringify(stamp.rowOf(answer, 'race/gone.txt'))}`);
    assert.equal(stamp.rowOf(answer, 'race/stays.txt')?.verdict, LIKELY);
    assert.ok(!JSON.stringify(answer).includes('race/gone.txt'));
  });
});

describe('a peer that cannot answer says "cannot tell" and is asked once (items 4, 19)', { skip }, () => {
  const OUTCOMES = [
    [500, 'PEER_UNREACHABLE', 'a server error'],
    [503, 'PEER_UNREACHABLE', 'an unavailable peer'],
    [429, 'PEER_UNREACHABLE', 'a peer over its rate limit'],
    [401, 'PEER_REFUSED', 'a refused token'],
    [403, 'PEER_REFUSED', 'a forbidden token'],
    [404, 'PEER_TOO_OLD', 'a peer without the route'],
  ];
  for (const [status, key, what] of OUTCOMES) {
    it(`${what} (${status}) is ${key}, for every row, and the peer is not asked again`, async () => {
      const R = await reasons();
      await stamp.s1('docs/a.txt');
      await stamp.s1('docs/b.txt');
      await stamp.s1('docs/c.txt');
      serving(fails(status));
      const answer = await stamp.report();
      assert.equal(served.length, 1, `the peer was asked ${served.length} times after it answered ${status}: the breaker must be the answer, no retry`);
      assert.deepEqual(answer.rows.map(r => [r.verdict, r.reason]), Array(3).fill([CANNOT, R[key]]));
      assert.equal(answer.likely, 0);
      await assertCounts(answer);
    });
  }

  it('a peer with no token held for it: "no credentials", and nothing was sent', async () => {
    const R = await reasons();
    const loader = await import('../../server/dist/config/loader.js');
    delete loader.getSecrets().peerTokens[PEER];
    await stamp.s1('docs/a.txt');
    serving();
    const answer = await stamp.report();
    assert.equal(served.length, 0, 'a request went out with no credentials to send');
    assert.equal(answer.rows[0].reason, R.NO_CREDENTIALS);
  });

  it('a member address the SSRF guards refuse: "address refused", and nothing was sent', async () => {
    const R = await reasons();
    const member = door.member();
    const url = member.url;
    try {
      member.url = 'http://127.0.0.1:9';
      await stamp.s1('docs/a.txt');
      serving();
      const answer = await stamp.report();
      assert.equal(served.length, 0, 'the fake peer was reached through a refused address');
      assert.equal(answer.rows[0].verdict, CANNOT);
      assert.equal(answer.rows[0].reason, R.PEER_ADDRESS_REFUSED);
    } finally { member.url = url; }
  });

  it('a peer that never answers ends at the INJECTED deadline, every row "cannot tell", with no default timeout waited for', async () => {
    const R = await reasons();
    await stamp.s1('docs/a.txt');
    await stamp.s1('docs/b.txt');
    serving((_req, res) => { parked.push(res); return new Promise(() => {}); });
    const began = Date.now();
    const answer = await stamp.report({ deadlineMs: 300 });
    const waited = Date.now() - began;
    assert.ok(waited < 15_000, `the report waited ${waited} ms for a peer that never answers, with a 300 ms deadline injected: the deadline is not what ends it`);
    assert.deepEqual(answer.rows.map(r => r.verdict), [CANNOT, CANNOT]);
    for (const r of answer.rows) {
      assert.ok([R.PEER_UNREACHABLE, R.NOT_CHECKED_BEFORE_DEADLINE].includes(r.reason), `a hung peer gave ${JSON.stringify(r.reason)}`);
    }
    await assertCounts(answer);
  });
});

describe('the breaker is the call count, per run (items 4, 19)', { skip }, () => {
  /** A peer whose feed has more rows than any one page holds, with the rows under test at its two ends. */
  async function bigFeed() {
    const fillers = Array.from({ length: 700 }, (_, i) => build.filemeta(stamp.remote, `filler/f${String(i).padStart(4, '0')}.txt`, 10 + i,
      { author: PEER_AUTHOR, createdAt: PEER_CREATED, updatedAt: PEER_CREATED, sha256: sha256Of('filler') }));
    await door.seedPeerRecords(stamp.remote, 'filemeta', fillers);
    await stamp.ours('a-early.txt');
    await door.seedPeerRecords(stamp.remote, 'filemeta', [build.filemeta(stamp.remote, 'a-early.txt', 1,
      { author: PEER_AUTHOR, createdAt: PEER_CREATED, updatedAt: PEER_CREATED, sha256: sha256Of(bytesOf('a-early.txt')) })]);
    await stamp.ours('z-late.txt');
    await door.seedPeerRecords(stamp.remote, 'filemeta', [build.filemeta(stamp.remote, 'z-late.txt', 100_000,
      { author: PEER_AUTHOR, createdAt: PEER_CREATED, updatedAt: PEER_CREATED, sha256: sha256Of(bytesOf('z-late.txt')) })]);
    await stamp.ours('m-absent.txt');
  }

  it('a feed that fails on its SECOND request is not asked a third; what page one proved stands, the rest is "cannot tell"', async () => {
    const R = await reasons();
    await bigFeed();
    serving((req, res, serve) => (served.length >= 2 ? fails(500)(req, res) : serve()));
    const answer = await stamp.report();
    assert.equal(served.length, 2, `the peer was sent ${served.length} requests; the first page, one failure, and no more`);
    assert.equal(stamp.rowOf(answer, 'a-early.txt')?.verdict, LIKELY, 'the evidence page one carried was thrown away with the failure');
    for (const p of ['z-late.txt', 'm-absent.txt']) {
      const row = stamp.rowOf(answer, p);
      assert.equal(row?.verdict, CANNOT, p);
      assert.equal(row.reason, R.PEER_UNREACHABLE, `${p}: a walk that did not finish cannot say the peer holds nothing`);
    }
    await assertCounts(answer);

    // The breaker lives for the run: a second run asks again.
    served.length = 0;
    await stamp.report();
    assert.ok(served.length >= 1, 'the breaker outlived its run: the peer is never asked again');
  });

  it('a clock past the deadline stops the walk BETWEEN requests: rows not reached say so, and the next page is not requested', async () => {
    const R = await reasons();
    await bigFeed();
    const DEADLINE = 60_000;
    let t = Date.parse('2026-10-01T00:00:00.000Z');
    const now = () => t;
    serving(async (_req, _res, serve) => { await serve(); t += DEADLINE + 1; });
    const answer = await stamp.report({ now, deadlineMs: DEADLINE });
    assert.equal(served.length, 1, `the peer was asked ${served.length} times; the clock was past the deadline after the first page`);
    assert.equal(answer.startedAt, '2026-10-01T00:00:00.000Z', 'startedAt is not the run\'s start as the injected clock read it');
    assert.equal(stamp.rowOf(answer, 'a-early.txt')?.verdict, LIKELY, 'what the first page proved was dropped with the deadline');
    for (const p of ['z-late.txt', 'm-absent.txt']) {
      assert.equal(stamp.rowOf(answer, p)?.reason, R.NOT_CHECKED_BEFORE_DEADLINE, p);
    }
    assert.equal(answer.candidates, 3);
    assert.equal(answer.checked, 1);
    await assertCounts(answer);
  });
});

describe('paging: limit, limit + 1 and exactly limit (item 13)', { skip }, () => {
  const PATHS = ['a%2Fb.txt', 'p/a.txt', 'p/b.txt', 'p/c.txt'];
  async function seed(n) { for (const p of PATHS.slice(0, n)) await stamp.s1(p); }

  it('fewer than limit rows: one answer, not truncated, no cursor', async () => {
    await seed(2);
    const a = await stamp.report({ limit: 3 });
    assert.deepEqual([a.rows.length, a.truncated, a.nextAfter], [2, false, undefined]);
    await assertCounts(a);
  });

  it('exactly limit rows: NOT truncated (the limit + 1 read found nothing more)', async () => {
    await seed(3);
    const a = await stamp.report({ limit: 3 });
    assert.deepEqual([a.rows.length, a.truncated, a.nextAfter], [3, false, undefined], 'a full page that ends the space was called truncated');
    await assertCounts(a);
  });

  it('limit + 1 rows: truncated, the cursor is the last row, and `after` continues with the rest and nothing twice', async () => {
    await seed(4);
    const first = await stamp.report({ limit: 3 });
    assert.equal(first.truncated, true);
    assert.equal(first.rows.length, 3, 'the extra row of the limit + 1 read was listed');
    assert.equal(first.candidates, 3);
    assert.equal(first.nextAfter, first.rows.at(-1).path, 'the cursor is not the last row listed');
    await assertCounts(first);

    const rest = await stamp.report({ limit: 3, after: first.nextAfter });
    assert.equal(rest.truncated, false);
    assert.equal(rest.nextAfter, undefined);
    assert.deepEqual([...first.rows, ...rest.rows].map(r => r.path), [...PATHS].sort(), 'the pages do not add up to every row, once each, in order');
    await assertCounts(rest);
  });

  it('a cursor spelled like a path (`.`, `..`, `a%2Fb.txt`) is a cursor, not a traversal and not a refusal', async () => {
    await seed(4);
    for (const after of ['.', '..']) {
      const a = await stamp.report({ limit: 10, after });
      assert.deepEqual(a.rows.map(r => r.path), [...PATHS].sort(), `after ${JSON.stringify(after)}`);
    }
    const a = await stamp.report({ limit: 10, after: 'a%2Fb.txt' });
    assert.deepEqual(a.rows.map(r => r.path), ['p/a.txt', 'p/b.txt', 'p/c.txt'], 'after a%2Fb.txt');
  });
});
