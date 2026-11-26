/**
 * The join's fetches of the network's schema share one deadline and run four at a time (`Q-966`, review F7).
 *
 * The join asked the inviter for each joined space's schema one after another, ten seconds each, for up to a thousand spaces, and answered
 * only when the last was done: an inviter that took the join's own handshake and then stopped answering held the joiner's request for hours.
 * The fetches now run as one piece of work (`takeLayersAtJoin`): at most four in flight, and one deadline for all of them. What the deadline
 * cuts off is not lost, the space holds no seeded layer and the heal takes it at its first cycle.
 *
 * The inviter is a real HTTP listener. For the deadline it never answers; the deadline is passed in short (the default is the join's own,
 * fifteen seconds) and the margin to the check is several seconds, so a loaded runner does not turn it into a flake.
 *
 * Run: node --test testing/standalone/a-join-takes-the-schema-within-one-deadline-and-four-at-a-time.test.js
 * (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listenOnPrivateAddress } from '../_shared/local-server.mjs';
import { privateHostAddress, privateAddressSkipReason } from './_private-address.mjs';

process.env['SYNC_ALLOW_PRIVATE_PEERS'] = 'true';
const skip = privateAddressSkipReason();

let door;
let mode = 'hang';
let inFlight = 0;
let peak = 0;
const asked = new Set();
let takeLayersAtJoin;

before(async () => {
  if (skip) return;
  ({ takeLayersAtJoin } = await import('../../server/dist/sync/join-layers.js'));
  door = await listenOnPrivateAddress(http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x.invalid');
    if (u.pathname !== '/api/sync/meta') { res.statusCode = 404; res.end(); return; }
    asked.add(u.searchParams.get('spaceId'));
    inFlight += 1; peak = Math.max(peak, inFlight);
    res.on('close', () => { inFlight -= 1; });
    if (mode === 'hang') return;
    setTimeout(() => {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'refused', code: 'schema_rung' }));
    }, 150);
  }), privateHostAddress());
});

after(() => door?.close());

const entries = (n, tag) => Array.from({ length: n }, (_, i) => ({ networkId: `${tag}-${i}`, localId: `${tag}-${i}` }));
const run = (n, tag, extra) => takeLayersAtJoin({
  networkId: `net-${tag}`, peerUrl: door.url, from: 'inviter A', memberId: 'inviter-a', entries: entries(n, tag),
  headers: { Authorization: 'Bearer t' }, ...extra,
});

describe('the join\'s schema fetches', { skip }, () => {
  it('end at one deadline when the inviter stops answering, with four asked at most', async () => {
    mode = 'hang'; peak = 0; asked.clear();
    const started = Date.now();
    const out = await run(8, 'hang', { deadlineMs: 700 });
    const took = Date.now() - started;
    assert.ok(took < 6_000, `the join waited ${took} ms for an inviter that never answers`);
    assert.equal(out.cutOff, 8, 'every space the deadline cut off is told, so the heal is known to owe it');
    assert.ok(peak <= 4, `${peak} fetches were in flight at once`);
    assert.ok(asked.size <= 4, `${asked.size} spaces were asked while the first four hung`);
  });

  it('run four at a time and ask every space when the inviter answers', async () => {
    mode = 'refuse'; peak = 0; asked.clear();
    const out = await run(12, 'refuse', {});
    assert.equal(asked.size, 12, 'a space was never asked');
    assert.equal(out.cutOff, 0);
    assert.ok(peak > 1, 'the fetches ran one after another');
    assert.ok(peak <= 4, `${peak} fetches were in flight at once`);
  });

  it('say the refusals of the whole join in one log line, not one per space', async () => {
    mode = 'refuse'; asked.clear();
    const { log } = await import('../../server/dist/util/log.js');
    const lines = [];
    const orig = log.warn;
    log.warn = (...a) => { lines.push(a.join(' ')); };
    try { await run(12, 'agg', {}); } finally { log.warn = orig; }
    assert.equal(asked.size, 12, 'a space was never asked, so the lines below prove nothing');
    assert.equal(lines.length, 1, `a join of 12 refused spaces wrote ${lines.length} warnings: ${lines.join(' | ')}`);
    assert.match(lines[0], /12 of 12/, 'the one line does not say how many spaces were refused');
  });
});
