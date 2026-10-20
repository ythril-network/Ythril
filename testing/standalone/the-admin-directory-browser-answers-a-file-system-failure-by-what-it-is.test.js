/**
 * The admin directory browser answers a file-system failure by what it is, not with Node's text as a 400 (Q-542).
 *
 * ## The defect
 *
 * `GET /api/admin/data/browse-dirs` (`api/data.ts`, the backup destination browser) catches every failure of `statSync` /
 * `readdirSync` and answers `400 { error: err.message }`. A directory that vanished between the existence check and the read
 * (`ENOENT`), one the server may not read (`EACCES`, `EPERM`) or a failing disk (`EIO`) is not a refusal of the request's shape,
 * and the client shows Node's sentence.
 *
 * ## The rule
 *
 * `ENOENT` answers `404`, `EACCES` and `EPERM` answer `403`, anything else `500` in our words — through the classifier Q-458
 * introduces, so the answer names no errno text and repeats neither the runtime's message nor the path it carried. The route is
 * admin-only and the admin typed the path, so nothing leaks here today; the defect is the status class and the wording.
 *
 * Injected, not real: `chmod` is a no-op on Windows, and a race between `existsSync` and `statSync` cannot be arranged on demand.
 * The stub fails `statSync` (and, in the second set, `readdirSync`) for the one path asked about, counts that it fired, and is
 * restored in a `finally`. The handler is the router's own, past rate limit and admin auth.
 *
 * Red against da4cafd8: every row answers 400 with the injected message.
 *
 * Run: node --test testing/standalone/the-admin-directory-browser-answers-a-file-system-failure-by-what-it-is.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const POISON = 'poison-q542-b20e';

let handler;
const TARGET = path.resolve(os.tmpdir());

const ROWS = [
  { code: 'ENOENT', status: 404 },
  { code: 'EACCES', status: 403 },
  { code: 'EPERM', status: 403 },
  { code: 'EIO', status: 500 },
];

/** Fail `fs[fn]` for TARGET with `code`, carrying the poison in message and path; returns `{ fired, restore }`. */
function failFor(fn, code) {
  const real = fs[fn];
  const state = { fired: 0 };
  fs[fn] = function injected(p, ...rest) {
    if (typeof p === 'string' && path.resolve(p) === TARGET) {
      state.fired += 1;
      throw Object.assign(new Error(`${code}: injected, ${fn === 'statSync' ? 'stat' : 'scandir'} '/srv/${POISON}/backups'`),
        { code, errno: -2, syscall: fn === 'statSync' ? 'stat' : 'scandir', path: `/srv/${POISON}/backups` });
    }
    return real.call(this, p, ...rest);
  };
  return { state, restore: () => { fs[fn] = real; } };
}

async function browse() {
  const out = { status: 200, body: undefined };
  const res = {
    headersSent: false,
    status(s) { out.status = s; return res; },
    setHeader() { return res; },
    json(b) { out.body = b; res.headersSent = true; return res; },
    end() { res.headersSent = true; return res; },
  };
  await handler({ method: 'GET', query: { path: TARGET }, params: {}, headers: {}, ip: '127.0.0.1', get: () => undefined }, res);
  return out;
}

describe('the admin directory browser answers a file-system failure by what it is (Q-542)', () => {
  before(async () => {
    const { dataRouter } = await import('../../server/dist/api/data.js');
    const layer = dataRouter.stack.find(l => l.route?.path === '/browse-dirs' && l.route.methods['get']);
    assert.ok(layer, 'no GET /browse-dirs on the data router — re-anchor this test');
    handler = layer.route.stack.at(-1).handle;
    assert.ok(fs.existsSync(TARGET) && fs.statSync(TARGET).isDirectory(), `${TARGET} must be a directory for the existence check to pass`);
  });

  // Found by the b110 verify drive (2026-10-21): `existsSync` swallows EACCES/EPERM and answers false, so a directory that exists
  // but cannot be read was answered 404 "not found" before the classifier ever saw the real error. Here existsSync says false, as
  // it does for such a directory, while statSync throws the permission error the directory really has.
  it('an existing directory the server may not read answers 403, never 404 from an existence pre-check', async () => {
    const realExists = fs.existsSync;
    fs.existsSync = (p) => (typeof p === 'string' && path.resolve(p) === TARGET ? false : realExists(p));
    const stub = failFor('statSync', 'EACCES');
    let out;
    try { out = await browse(); } finally { stub.restore(); fs.existsSync = realExists; }
    assert.equal(out.status, 403, `an unreadable existing directory answered ${out.status}, not 403 - ${JSON.stringify(out)}`);
  });

  for (const fn of ['statSync', 'readdirSync']) {
    for (const { code, status } of ROWS) {
      it(`${code} from ${fn} answers ${status}, in our words`, async () => {
        const stub = failFor(fn, code);
        let out;
        try { out = await browse(); } finally { stub.restore(); }
        const wire = JSON.stringify(out);
        assert.ok(stub.state.fired >= 1, `the injected ${code} never fired on ${fn} — the route did not read ${TARGET} that way: ${wire}`);
        assert.equal(out.status, status, `${code} from ${fn} answered ${out.status}, not ${status} — ${wire}`);
        assert.ok(!wire.includes(POISON), `the answer carries the runtime's message or path — ${wire}`);
        assert.doesNotMatch(wire, /injected|scandir|errno/, `the answer carries Node's own sentence — ${wire}`);
      });
    }
  }
});
