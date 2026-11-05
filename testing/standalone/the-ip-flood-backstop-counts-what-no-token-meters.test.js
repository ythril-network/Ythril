/**
 * The per-address flood backstop counts every request that no token's own limit meters, and none that one does (Q-693, bundle-233).
 *
 * ## The defect
 *
 * `ipFloodBackstop` was a literal `max: 3000` per source address over EVERY request, while a token's own default is 1 200 a
 * minute (`DEFAULT_PER_MINUTE`, raised from 300 by Q-692). Three busy tokens behind one address (a gateway, an NAT, the default Docker
 * bridge, one reverse proxy) therefore reach 3 000 together and the fourth minute-long second of any of them is a `429` from a limiter
 * none of them was ever told about, with the token's own `rateLimitEffective` still saying it has room. The same ceiling that exists
 * for a flood of INVENTED bearers was spent by the callers it was never meant to bound.
 *
 * ## The rule the design fixes (design v3)
 *
 * The backstop keeps `max: 3000` per address and `skipSuccessfulRequests`, and its `requestWasSuccessful` is
 * `res.locals.meteredByToken === true`. `attachToken` sets that flag where `tokenRateLimit` admits the request, and the limiter's own
 * 429 handler resets it to false. So a request a valid token's limiter admitted is bounded by that limiter and is not counted here
 * whatever its answer (200, 403, 500); everything else is counted whatever its answer: anonymous requests, invented bearers, a valid token
 * refused before metering, 404s, static files, the SPA fallback, maintenance 503s, and `tokenRateLimit`'s own 429.
 *
 * The status is never the question. A 200 that no token metered (the SPA fallback, a static file, `/api/theme` with a junk bearer)
 * still counts, which is what a count-only-401 rule got wrong.
 *
 * ## What this file holds
 *
 *  - source: the predicate, the number, the two writers of the flag and no third;
 *  - the truth table, driven through the REAL limiter on a small app (a route that sets the flag and the status it is told to), with a
 *    distinct source address per row so no row's count reaches another;
 *  - the flood, driven through the REAL application over loopback (it needs the test Mongo: the audit middleware writes to it):
 *    3 x 1 200 valid requests from one address get no backstop answer; 3 001 each to an unknown `/api` path, a static asset, the SPA
 *    fallback and `/api/theme` with a junk bearer get exactly one; a token refused by its own limiter is counted;
 *  - the backstop's answer says what it counts (an address, no token's limit), so an operator who meets it is not sent to a token.
 *
 * Every flood row measures its own elapsed time: the window is 60 s, and a flood slow enough to straddle it would pass on the old
 * rule for the wrong reason.
 *
 * Run: `npm run test:up` first, then node --test testing/standalone/the-ip-flood-backstop-counts-what-no-token-meters.test.js
 * (requires a prior `npm run build -w server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { removeInstanceDir } from './_vote-round-instance.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { tempInstance, boot } from './_round-open-fixtures.mjs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const MW_PATH = 'server/src/rate-limit/middleware.ts';
const AUTH_PATH = 'server/src/auth/middleware.ts';
const src = (p) => stripComments(fs.readFileSync(p, 'utf8'));

/** The flood's number, read from the source, never typed here. */
const BACKSTOP_MAX = Number(/max:\s*(\d+)/.exec(bodyOf(src(MW_PATH), 'ipFloodBackstop'))?.[1]);
const WINDOW_BUDGET_MS = 45_000;

/** Environment the limiter reads at call time; a kill-switch left set would make every row below vacuous. */
/** Unset `names`; the returned function puts each back as it was. */
function cleanEnv(names) {
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  return () => { for (const [n, v] of Object.entries(saved)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; } };
}

/**
 * `count` GET requests with at most `concurrency` in flight, each answered and read to its end. Every answer is
 * `{ status, error, from }`: the `error` and `from` members of a JSON body, so a limiter's 429 can be told from a route's.
 */
async function flood({ count, concurrency = 40, url, headers = () => ({}) }) {
  const out = new Array(count);
  let next = 0;
  const started = Date.now();
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= count) return;
      const res = await fetch(typeof url === 'function' ? url(i) : url, { headers: headers(i) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* html or a file */ }
      out[i] = { status: res.status, error: json?.error, from: json?.from };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
  return { answers: out, elapsedMs: Date.now() - started };
}

const BACKSTOP_WORDS = /address/i;
/** An answer that is the backstop's: a 429 whose sentence names the address (design v3: it says what it counts). */
const isBackstop429 = (a) => a.status === 429 && BACKSTOP_WORDS.test(String(a.error ?? ''));

describe('the backstop\'s rule, in the source', () => {
  it('keeps the number, counts everything it does not skip, and skips only a request a token metered', () => {
    const body = bodyOf(src(MW_PATH), 'ipFloodBackstop');
    assert.equal(BACKSTOP_MAX, 3000, 'the backstop is 3 000 per address');
    assert.doesNotMatch(body, /hasCredential/, 'the backstop must NOT step aside for a presented credential: it is the bound on inventing them');
    assert.match(body, /skipSuccessfulRequests:\s*true/, 'the backstop does not give a metered request back to the count (skipSuccessfulRequests)');
    assert.match(body, /requestWasSuccessful:[^,}]*res\.locals\.meteredByToken\s*===\s*true/,
      'the one thing that gives a request back is res.locals.meteredByToken === true: not its status, not a credential header');
    assert.doesNotMatch(body.replace(/requestWasSuccessful:[^\n]*/, ''), /res\.statusCode|\bstatus\s*[<>=]/,
      'the backstop reads no status anywhere else: a 200 nobody metered still counts');
  });

  it('the flag is written in exactly two places: attachToken before tokenRateLimit, and tokenRateLimit\'s own 429 handler', () => {
    const writers = [];
    for (const dir of ['server/src']) {
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name))
        : /\.ts$/.test(e.name) ? [path.join(d, e.name)] : []);
      for (const f of walk(dir)) {
        const text = stripComments(fs.readFileSync(f, 'utf8'));
        for (const m of text.matchAll(/meteredByToken\s*=(?!=)\s*(\w+)/g)) writers.push(`${f.replaceAll('\\', '/')} = ${m[1]}`);
      }
    }
    assert.deepEqual(writers.sort(), [`${AUTH_PATH} = true`, `${MW_PATH} = false`].sort(),
      'a third writer of meteredByToken is a way past the backstop; the flag is set where the token limiter admits and reset where it refuses');
    const attach = bodyOf(src(AUTH_PATH), 'attachToken');
    const setAt = attach.search(/meteredByToken\s*=\s*true/);
    const meterAt = attach.search(/tokenRateLimit\(/);
    assert.ok(setAt > -1, 'attachToken does not set res.locals.meteredByToken');
    assert.ok(meterAt > -1 && setAt < meterAt,
      'the flag is set BEFORE tokenRateLimit runs, so its 429 handler can reset it (a flag set after the limiter would also mark the refusal)');
    assert.match(bodyOf(src(MW_PATH), 'tokenRateLimit'), /handler:[\s\S]*meteredByToken\s*=\s*false/,
      'tokenRateLimit\'s 429 handler must reset the flag: a token\'s own refusal is counted by the backstop, or one over-quota token floods the address for free');
  });
});

describe('the skip predicate, row by row (the real limiter, a distinct address per row)', () => {
  let server; let n = 0; let restoreEnv = () => {};
  before(async () => {
    restoreEnv = cleanEnv(['SKIP_GLOBAL_RATE_LIMIT']);
    assert.ok(Number.isFinite(BACKSTOP_MAX) && BACKSTOP_MAX > 0, 'the backstop number was not read from the source');
    const { ipFloodBackstop } = await import('../../server/dist/rate-limit/middleware.js');
    const app = express();
    app.set('trust proxy', 1);
    app.use(ipFloodBackstop);
    // The route stands for what follows the limiter: `metered` is what attachToken sets, `flag` an explicit value, `status` the answer.
    app.get('/answer/:flag/:status', (req, res) => {
      const f = req.params.flag;
      if (f === 'true') res.locals.meteredByToken = true;
      else if (f === 'false') res.locals.meteredByToken = false;
      else if (f === 'truthy') res.locals.meteredByToken = 1;
      res.status(Number(req.params.status)).json({ from: 'route' });
    });
    server = await listenOnLoopback(http.createServer(app));
  });
  after(async () => { await server?.close(); restoreEnv(); });

  /** Send BACKSTOP_MAX + 2 requests from one address and report the backstop's own answers. */
  async function hitsFor(flag, status) {
    const ip = `10.77.${Math.floor(++n / 250)}.${n % 250 + 1}`;
    const { answers, elapsedMs } = await flood({
      count: BACKSTOP_MAX + 2, url: `${server.url}/answer/${flag}/${status}`, headers: () => ({ 'x-forwarded-for': ip }),
    });
    assert.ok(elapsedMs < WINDOW_BUDGET_MS, `the row took ${elapsedMs} ms: slower than the window allows it to prove anything`);
    const routeAnswers = answers.filter(a => a.from === 'route');
    return { hits: answers.length - routeAnswers.length, routeAnswers };
  }

  for (const status of [200, 403, 500]) {
    it(`a request a token metered is NOT counted, whatever its answer (${status})`, async () => {
      const { hits, routeAnswers } = await hitsFor('true', status);
      assert.equal(hits, 0, `the backstop answered ${hits} requests of a stream every one of which a token's own limiter metered (${status})`);
      assert.ok(routeAnswers.every(a => a.status === status), 'the route did not answer what it was told: the row proves nothing');
    });
  }

  for (const status of [401, 403, 404, 200, 429, 503]) {
    it(`a request no token metered IS counted, whatever its answer (${status})`, async () => {
      const { hits } = await hitsFor('unset', status);
      assert.ok(hits >= 1, `${BACKSTOP_MAX + 2} unmetered ${status} answers from one address were never refused: the backstop skips by status`);
    });
  }

  it('a request whose flag a token limiter reset to false IS counted, even with a 200', async () => {
    const { hits } = await hitsFor('false', 200);
    assert.ok(hits >= 1, 'a flag reset to false still skipped the count');
  });

  it('only the value true meters: a truthy non-boolean IS counted', async () => {
    const { hits } = await hitsFor('truthy', 200);
    assert.ok(hits >= 1, 'a truthy flag skipped the count: the predicate must be === true');
  });

  it('the backstop\'s own answer says what it counts: an address, and that no token\'s limit covered it', async () => {
    const ip = '10.78.0.1';
    const { answers } = await flood({
      count: BACKSTOP_MAX + 2, url: `${server.url}/answer/unset/200`, headers: () => ({ 'x-forwarded-for': ip }),
    });
    const refused = answers.filter(a => a.status === 429 && a.from !== 'route');
    assert.ok(refused.length >= 1, 'the backstop never answered, so its sentence cannot be read');
    for (const a of refused) {
      assert.match(String(a.error), BACKSTOP_WORDS, `the backstop answered "${a.error}": it must say the count is of this ADDRESS, not of a token`);
      assert.match(String(a.error), /token/i, `the backstop answered "${a.error}": it must say what a token's own limit has to do with it`);
    }
  });
});

describe('the flood, through the real application (valid tokens are not the flood; what no token meters is)', { skip: await mongoSkipReason() }, () => {
  const dir = tempInstance('ythril-q693-flood-');
  const clientDist = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-q693-dist-'));
  fs.writeFileSync(path.join(clientDist, 'index.html'), '<!doctype html><title>spa</title>');
  fs.writeFileSync(path.join(clientDist, 'app.css'), 'body{}');
  let server; let tokens; let serial = 0; let restoreEnv = () => {};
  before(async () => {
    // The application reads these when it is imported (CLIENT_DIST) and when it is created (TRUST_PROXY), so they are set before listenApp.
    restoreEnv = cleanEnv(['SKIP_GLOBAL_RATE_LIMIT', 'SKIP_AUTH_RATE_LIMIT', 'YTHRIL_RATE_LIMIT_PER_MINUTE', 'TRUST_PROXY', 'CLIENT_DIST', 'NODE_ENV']);
    process.env['TRUST_PROXY'] = '1';
    process.env['CLIENT_DIST'] = clientDist;
    await openTestMongo('q693flood');
    await boot(dir, { networks: [] });
    tokens = await import('../../server/dist/auth/tokens.js');
    server = await listenApp();
  });
  after(async () => {
    await server?.close();
    await closeTestMongo();
    removeInstanceDir(dir);
    fs.rmSync(clientDist, { recursive: true, force: true });
    restoreEnv();
  });

  const addressOf = () => `10.88.${Math.floor(++serial / 250)}.${serial % 250 + 1}`;
  const bearer = (token) => ({ authorization: `Bearer ${token}` });

  it('three tokens behind one address, 1 200 valid requests each, are never answered by the backstop', async () => {
    const minted = [];
    for (let i = 0; i < 3; i++) minted.push(await tokens.createToken({ name: `busy-${i}` }));
    const ip = addressOf();
    const { answers, elapsedMs } = await flood({
      count: 3 * 1200, concurrency: 30,
      url: `${server.url}/api/tokens/me`,
      headers: (i) => ({ ...bearer(minted[i % 3].plaintext), 'x-forwarded-for': ip }),
    });
    assert.ok(elapsedMs < WINDOW_BUDGET_MS, `the flood took ${elapsedMs} ms: slower than the window allows it to prove anything`);
    const refused = answers.filter(a => a.status !== 200);
    assert.deepEqual(refused.map(a => `${a.status} ${a.error}`).slice(0, 3), [],
      `${refused.length} of ${answers.length} valid requests inside each token's own 1 200 a minute were refused: the backstop counted what a token's own limit already bounds`);
  });

  /** BACKSTOP_MAX + 1 requests from a fresh address to `pathOf`, the answers split into the backstop's and any other 429. */
  async function unmeteredFlood(pathOf, headersOf = () => ({})) {
    const ip = addressOf();
    const { answers, elapsedMs } = await flood({
      count: BACKSTOP_MAX + 1, concurrency: 40,
      url: (i) => `${server.url}${pathOf(i)}`,
      headers: (i) => ({ ...headersOf(i), 'x-forwarded-for': ip }),
    });
    assert.ok(elapsedMs < WINDOW_BUDGET_MS, `the flood took ${elapsedMs} ms: slower than the window allows it to prove anything`);
    const all429 = answers.filter(a => a.status === 429);
    return { all429, backstop: all429.filter(isBackstop429) };
  }

  const classes = [
    ['an unknown /api path, behind a junk bearer', () => '/api/no-such-thing-here', () => ({ authorization: 'Bearer junk-not-a-token' })],
    ['a static asset, anonymous', () => '/app.css', () => ({})],
    ['the SPA fallback, anonymous', (i) => `/some/page/${i % 7}`, () => ({})],
    ['/api/theme, behind a junk bearer (the credential steps the global limiter aside, so only the backstop is left)', () => '/api/theme', () => ({ authorization: 'Bearer junk-not-a-token' })],
  ];
  for (const [label, pathOf, headersOf] of classes) {
    it(`${BACKSTOP_MAX + 1} requests from one address to ${label} get exactly one 429, the backstop's`, async () => {
      const { all429, backstop } = await unmeteredFlood(pathOf, headersOf);
      assert.equal(all429.length, 1, `${all429.length} requests were refused with a 429 (one request over ${BACKSTOP_MAX} is the first the backstop refuses)`);
      assert.equal(backstop.length, 1, `the one 429 said "${all429[0]?.error}": it must be the backstop's, and say it counts an address`);
    });
  }

  it('a token refused by its OWN limiter is counted: the address is answered by the backstop after 3 001, with the token\'s own 429s before it', async () => {
    const t = await tokens.createToken({ name: 'tiny-quota', rateLimitPerMinute: 1 });
    const ip = addressOf();
    const { answers, elapsedMs } = await flood({
      count: BACKSTOP_MAX + 3, concurrency: 40,
      url: `${server.url}/api/tokens/me`,
      headers: () => ({ ...bearer(t.plaintext), 'x-forwarded-for': ip }),
    });
    assert.ok(elapsedMs < WINDOW_BUDGET_MS, `the flood took ${elapsedMs} ms: slower than the window allows it to prove anything`);
    const own = answers.filter(a => a.status === 429 && /this token/i.test(String(a.error ?? '')));
    assert.ok(own.length >= BACKSTOP_MAX - 5, `the token's own limiter answered only ${own.length} requests: the row does not hold the token refused`);
    assert.ok(answers.some(isBackstop429),
      'a token over its own limit sent 3 000+ requests and the backstop never answered: its 429 was marked metered, so the address-wide flood bound did not count it');
  });
});
