/**
 * `scripts/_shared/ythril-api.mjs` — the ONE client a script uses to call a Ythril REST tool — carries its
 * guards inside it, so no caller can leave one out.
 *
 * ## What this prevents
 *
 * A maintainer script that writes to a Ythril instance holds a bearer token. Three ways that token leaves the
 * machine or lands somewhere it was never meant to, each of which a hand-written `fetch` in each script gets
 * wrong somewhere:
 *
 * 1. **The wrong URL.** `http://` to a host that is not this machine sends the token in the clear, and a typo'd
 *    `http://localhost.evil.example` is a host that merely STARTS like a loopback name. The client refuses at
 *    construction — before anything is sent — any URL that is not `https`, or `http` to a loopback literal
 *    (`127.0.0.1`, `localhost`, `[::1]`); and refuses a URL that carries credentials, because the token has its own
 *    argument and a `user:password@` in a URL is printed by every layer that prints a URL.
 * 2. **A redirect.** `fetch` follows a 30x by default and a redirect target is chosen by whoever answers. The client
 *    follows none: a redirect is an error, and the target is never contacted (this test runs a second server and
 *    counts what it received).
 * 3. **A hang.** Default timeout 10 s (the exported `REQUEST_TIMEOUT_MS`), measured here against a server that
 *    never answers, plus a short override so the rest of the suite is quick.
 *
 * And the fourth, the one that is invisible until a log is read: **no error ever prints a secret.** Not the token,
 * not a `Bearer` header, not URL userinfo, not a header block a misbehaving server echoed back. Every failure
 * mode below is provoked and its error read three ways (`String`, stack, `util.inspect` with the cause chain) for
 * the token.
 *
 * ## The interface this pins
 *
 * `createYthrilApi({ url, token, timeoutMs? })` returns `{ call(tool, args) }`. `call` POSTs `<url>/api/<tool>`
 * with `Authorization: Bearer <token>` and the arguments as the JSON body, and resolves with the REST envelope
 * (`{ok, text, data}`) of a 2xx answer; any other outcome rejects with an error whose `status` is the HTTP status
 * (absent for a network failure). `REQUEST_TIMEOUT_MS` is exported and is `10_000`.
 *
 * Local servers only (127.0.0.1); no real instance, no network beyond them.
 *
 * Run: node --test testing/standalone/ythril-api-client-guards.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { startFakeYthril, FAKE_TOKEN, FAKE_SPACE } from '../_shared/fake-ythril-tool-server.mjs';
import { closedLoopbackPort } from '../_shared/closed-port.mjs';

const MODULE = pathToFileURL(resolve(import.meta.dirname, '..', '..', 'scripts', '_shared', 'ythril-api.mjs')).href;
let loaded;
const load = () => (loaded ??= import(MODULE));

const PASSWORD = 'hunter2-userinfo-secret';

/** Every way an error can be printed, joined — the secret must be in none of them. */
function everyPrinting(err) {
  const parts = [String(err), String(err?.message), String(err?.stack), inspect(err, { depth: null, showHidden: false })];
  try { parts.push(JSON.stringify(err, Object.getOwnPropertyNames(err))); } catch { /* circular: inspect covered it */ }
  for (let c = err?.cause; c; c = c?.cause) parts.push(String(c), inspect(c, { depth: null }));
  return parts.join('\n');
}

async function rejection(promise) {
  try { await promise; } catch (err) { return err; }
  assert.fail('expected the call to reject');
}


describe('the URL the client will send a token to', () => {
  const refused = [
    ['plain http to a public host', 'http://example.com'],
    ['plain http to a private address', 'http://192.168.1.5:8080'],
    ['plain http to a 10/8 address', 'http://10.0.0.1'],
    ['a host that only STARTS like a loopback name', 'http://localhost.evil.example'],
    ['a host that only starts like a loopback address', 'http://127.0.0.1.evil.example'],
    ['plain http to a global IPv6 literal', 'http://[2001:db8::1]:8080'],
    ['a scheme that is not http(s)', 'ftp://127.0.0.1'],
    ['a file URL', 'file:///etc/passwd'],
    ['not a URL at all', 'not a url'],
    ['empty', ''],
    ['credentials in an https URL', `https://someuser:${PASSWORD}@example.com`],
    ['credentials in a loopback URL', `http://someuser:${PASSWORD}@127.0.0.1:1234`],
  ];
  for (const [what, url] of refused) {
    it(`refuses ${what}, at construction, naming no part of the credentials`, async () => {
      const { createYthrilApi } = await load();
      let err;
      try { createYthrilApi({ url, token: FAKE_TOKEN }); } catch (e) { err = e; }
      assert.ok(err, `createYthrilApi({ url: ${JSON.stringify(url.replace(PASSWORD, '***'))} }) must throw`);
      assert.ok(!everyPrinting(err).includes(PASSWORD), 'the refusal must not print the URL userinfo');
      assert.ok(!everyPrinting(err).includes(FAKE_TOKEN), 'the refusal must not print the token');
    });
  }

  const accepted = [
    ['https to a public host', 'https://example.com'],
    ['https with a port and a path prefix', 'https://ythril.example:8443/ythril/'],
    ['http to 127.0.0.1', 'http://127.0.0.1:1234'],
    ['http to localhost', 'http://localhost:1234'],
    ['http to the IPv6 loopback', 'http://[::1]:1234'],
  ];
  for (const [what, url] of accepted) {
    it(`accepts ${what}, and sends nothing while constructing`, async () => {
      const { createYthrilApi } = await load();
      assert.doesNotThrow(() => createYthrilApi({ url, token: FAKE_TOKEN }));
    });
  }

  it('refuses a missing token', async () => {
    const { createYthrilApi } = await load();
    assert.throws(() => createYthrilApi({ url: 'http://127.0.0.1:1234', token: '' }));
    assert.throws(() => createYthrilApi({ url: 'http://127.0.0.1:1234' }));
  });
});

describe('a call is the REST tool door, exactly', () => {
  let server;
  before(async () => { server = await startFakeYthril(); });
  after(async () => { await server.close(); });

  it('POSTs /api/<tool> with the bearer token and the arguments as the body, and resolves with the envelope', async () => {
    const { createYthrilApi } = await load();
    const api = createYthrilApi({ url: server.url, token: server.token });
    const args = { space: FAKE_SPACE, collection: 'chrono', filter: { type: 'Test-Run' }, limit: 5 };
    const before = server.calls.length;
    const answer = await api.call('filter', args);
    const call = server.calls[before];
    assert.equal(call.method, 'POST');
    assert.equal(call.url, '/api/filter');
    assert.equal(call.authorization, `Bearer ${server.token}`);
    assert.deepEqual(call.args, args, 'the body is EXACTLY the arguments — nothing renamed, defaulted or injected');
    assert.equal(answer.ok, true);
    assert.equal(answer.data.collection, 'chrono');
  });

  it('keeps a path prefix on the base URL (an instance served under /ythril)', async () => {
    const { createYthrilApi } = await load();
    const prefixed = await startFakeYthril({ respond: (call) => (call.url === '/ythril/api/filter' ? { status: 200, body: { ok: true, text: 't', data: { results: [] } } } : undefined) });
    try {
      const api = createYthrilApi({ url: `${prefixed.url}/ythril/`, token: prefixed.token });
      await api.call('filter', { space: FAKE_SPACE, collection: 'chrono' });
      assert.equal(prefixed.calls.at(-1).url, '/ythril/api/filter');
    } finally { await prefixed.close(); }
  });

  it('rejects a non-2xx answer with its status and the server\'s own sentence, never a header block', async () => {
    const { createYthrilApi } = await load();
    const api = createYthrilApi({ url: server.url, token: server.token });
    const err = await rejection(api.call('delete_chrono', { space: FAKE_SPACE, id: 'does-not-exist' }));
    assert.equal(err.status, 404);
    assert.match(err.message, /delete_chrono/);
    assert.match(err.message, /not found/i);
  });
});

describe('no redirect is followed', () => {
  it('rejects a 302 and never contacts the target — the token does not follow it', async () => {
    const { createYthrilApi } = await load();
    const target = await startFakeYthril();
    const redirecting = await startFakeYthril({ respond: () => ({ status: 302, body: undefined, headers: { location: `${target.url}/api/filter` } }) });
    try {
      const api = createYthrilApi({ url: redirecting.url, token: FAKE_TOKEN });
      const err = await rejection(api.call('filter', { space: FAKE_SPACE, collection: 'chrono' }));
      assert.equal(target.calls.length, 0, 'the redirect target must never receive a request');
      assert.match(everyPrinting(err), /redirect|30[1278]/i);
      assert.ok(!everyPrinting(err).includes(FAKE_TOKEN));
    } finally { await redirecting.close(); await target.close(); }
  });
});

describe('a call that never answers ends', () => {
  it('has a 10 s default — the exported constant — and applies it', async () => {
    const mod = await load();
    assert.equal(mod.REQUEST_TIMEOUT_MS, 10_000);
    const hung = await startFakeYthril();
    hung.hang();
    try {
      const api = mod.createYthrilApi({ url: hung.url, token: hung.token });
      const started = Date.now();
      const err = await rejection(api.call('filter', { space: FAKE_SPACE, collection: 'chrono' }));
      const took = Date.now() - started;
      assert.ok(took >= 9_000 && took < 16_000, `rejected after ${took} ms; the default is 10 s`);
      assert.match(err.message, /time(d)? ?out/i);
    } finally { await hung.close(); }
  });

  it('honours a shorter timeoutMs', async () => {
    const { createYthrilApi } = await load();
    const hung = await startFakeYthril();
    hung.hang();
    try {
      const api = createYthrilApi({ url: hung.url, token: hung.token, timeoutMs: 200 });
      const started = Date.now();
      await rejection(api.call('filter', { space: FAKE_SPACE, collection: 'chrono' }));
      assert.ok(Date.now() - started < 5_000);
    } finally { await hung.close(); }
  });
});

describe('no error prints the token, the URL userinfo or a header', () => {
  /** Each provokes one failure mode; the error it produces is read every way an error is read. */
  const modes = {
    '401 whose body echoes the request headers back': async (mod) => {
      const s = await startFakeYthril({ token: 'a-different-token', respond: (call) => ({ status: 401, body: { ok: false, error: 'unauthorized', echoedHeaders: call.headers, data: null } }) });
      return { s, run: () => mod.createYthrilApi({ url: s.url, token: FAKE_TOKEN }).call('filter', { space: FAKE_SPACE, collection: 'chrono' }) };
    },
    '500 whose own sentence contains the token': async (mod) => {
      const s = await startFakeYthril({ respond: () => ({ status: 500, body: { ok: false, error: `internal failure while handling Bearer ${FAKE_TOKEN}`, data: null } }) });
      return { s, run: () => mod.createYthrilApi({ url: s.url, token: FAKE_TOKEN }).call('filter', { space: FAKE_SPACE, collection: 'chrono' }) };
    },
    '200 that is not JSON and contains the token': async (mod) => {
      const s = await startFakeYthril({ respond: () => ({ status: 200, body: `<html>${FAKE_TOKEN}</html>` }) });
      return { s, run: () => mod.createYthrilApi({ url: s.url, token: FAKE_TOKEN }).call('filter', { space: FAKE_SPACE, collection: 'chrono' }) };
    },
    'a refused connection': async (mod) => {
      const port = await closedLoopbackPort();
      return { s: null, run: () => mod.createYthrilApi({ url: `http://127.0.0.1:${port}`, token: FAKE_TOKEN }).call('filter', { space: FAKE_SPACE, collection: 'chrono' }) };
    },
    'a redirect': async (mod) => {
      const s = await startFakeYthril({ respond: () => ({ status: 307, body: undefined, headers: { location: 'http://127.0.0.1:9/elsewhere' } }) });
      return { s, run: () => mod.createYthrilApi({ url: s.url, token: FAKE_TOKEN }).call('filter', { space: FAKE_SPACE, collection: 'chrono' }) };
    },
    'a timeout': async (mod) => {
      const s = await startFakeYthril();
      s.hang();
      return { s, run: () => mod.createYthrilApi({ url: s.url, token: FAKE_TOKEN, timeoutMs: 200 }).call('filter', { space: FAKE_SPACE, collection: 'chrono' }) };
    },
  };

  for (const [name, provoke] of Object.entries(modes)) {
    it(`${name}`, async () => {
      const mod = await load();
      const { s, run } = await provoke(mod);
      try {
        const err = await rejection(run());
        const printed = everyPrinting(err);
        assert.ok(!printed.includes(FAKE_TOKEN), `the token appears in the error:\n${printed}`);
        assert.ok(!/bearer\s+[A-Za-z0-9._~+\/=-]{8,}/i.test(printed), `an Authorization value appears in the error:\n${printed}`);
        assert.ok(!/authorization/i.test(printed), `a header name appears in the error:\n${printed}`);
      } finally { await s?.close(); }
    });
  }
});
