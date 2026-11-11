/**
 * A `config.json` that is PRESENT but cannot be read or parsed is a fault, never a first run (Q-350 a, bundle-70 S1).
 *
 * ## The defect
 *
 * `configExists()` answered `false` for a file that was there: one that was empty, whitespace only, `null`, not JSON, or that the
 * process could not read. First run is "no identity yet", so the boot started in setup mode, `GET /api/setup/status` said
 * `configured: false`, and `POST /api/setup/json` (unauthenticated) wrote a NEW config over the file: a new instance id, no tokens, no
 * spaces, for the person who found the door open. An instance whose config volume had a permission slip, or whose file a crash left
 * empty, could be taken over by the first visitor and its identity replaced.
 *
 * ## The rule
 *
 * First run is exactly one state: the file is ABSENT (ENOENT). Every other state of a present file is a fault:
 *
 * - boot refuses, naming the file and the fix, before it connects to anything or listens;
 * - the status door never says `configured: false` for it, and the setup door never writes over it;
 * - `configExists()` never answers `false` for it (it throws, or says the file is there).
 *
 * An unmounted config volume is an ABSENT file and stays a first run (stated in the hosting guide); that is not this rule.
 *
 * ## What is asserted
 *
 * - `configExists()` per bad state: not `false`; absent is `false`; a valid file is `true`.
 * - `GET /api/setup/status` and `POST /api/setup/json` through the real `setupRouter` over HTTP: the file's bytes are unchanged after the
 *   POST, and the status never reports `configured: false`.
 * - The real entry (`dist/index.js`) in a child process: it exits non-zero naming `config.json`, and never prints the first-run line.
 *
 * ## How a bad file is staged
 *
 * Content cases are real files (empty, whitespace, `null`, garbage). The unreadable case is a DIRECTORY at the file's path (a read
 * fails with EISDIR on every OS and as root, where chmod does nothing) and, for the existence check itself, the EACCES seam.
 *
 * Run: node --test testing/standalone/a-present-config-that-cannot-be-read-is-never-first-run.test.js   (requires a server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { withBlockedPaths } from './_unreadable-paths.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-config-presence-'));
const CONFIG = path.join(root, 'config.json');
process.env['CONFIG_PATH'] = CONFIG;
process.env['DATA_ROOT'] = path.join(root, 'data');

/** Every state of a PRESENT config.json that is not a readable, parsed config. `stage` puts the file in that state. */
const BAD_STATES = [
  ['empty', () => fs.writeFileSync(CONFIG, '')],
  ['whitespace only', () => fs.writeFileSync(CONFIG, '  \n\t \r\n')],
  ['null', () => fs.writeFileSync(CONFIG, 'null')],
  ['not JSON', () => fs.writeFileSync(CONFIG, '{"instanceId": ')],
  ['a directory at the path (the read fails)', () => fs.mkdirSync(CONFIG)],
];
const clear = () => fs.rmSync(CONFIG, { recursive: true, force: true });

/** What `fn` answered, or that it threw. */
function attempt(fn) { try { return { value: fn() }; } catch (error) { return { threw: error }; } }

/** One request; `null` when the server never answered inside `ms` (an unprotected handler that crashed after writing). */
function request(origin, method, urlPath, body, ms = 6000) {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(origin + urlPath, { method, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} }, (res) => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, json, text }); });
    });
    req.setTimeout(ms, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    if (payload) req.write(payload);
    req.end();
  });
}

describe('a present config.json that cannot be read is never first run', () => {
  let loader, setup;
  before(async () => {
    loader = await import('../../server/dist/config/loader.js');
    setup = await import('../../server/dist/setup/routes.js');
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('configExists(): an absent file is the first run, a valid one is configured, and no bad state of a present file is "no"', () => {
    clear();
    assert.equal(loader.configExists(), false, 'an absent config.json is the first run');
    fs.writeFileSync(CONFIG, JSON.stringify({ instanceId: 'i', instanceLabel: 'l', tokens: [], spaces: [], networks: [] }));
    assert.equal(loader.configExists(), true, 'a valid config.json is configured');
    for (const [label, stage] of BAD_STATES) {
      clear();
      stage();
      const a = attempt(() => loader.configExists());
      assert.notEqual(a.value, false, `a present config.json (${label}) was read as "no config": the instance would start in first-run setup`);
    }
    clear();
  });

  it('configExists(): a config.json the OS refuses to look at is not "no config"', async () => {
    clear();
    fs.writeFileSync(CONFIG, JSON.stringify({ instanceId: 'i', instanceLabel: 'l', tokens: [], spaces: [], networks: [] }));
    await withBlockedPaths([CONFIG], async (hits) => {
      const a = attempt(() => loader.configExists());
      assert.ok(hits.count > 0, 'config.json was never looked at: the case checks nothing');
      assert.notEqual(a.value, false, 'a config.json the OS refused to look at was read as "no config"');
    });
    clear();
  });

  describe('the setup doors, over HTTP, with a present bad file', () => {
    let server;
    before(async () => {
      const app = express();
      app.use(express.json());
      app.use('/api/setup', setup.setupRouter);
      server = await listenOnLoopback(http.createServer(app));
    });
    after(async () => { await server?.close(); });

    for (const [label, stage] of BAD_STATES.filter(([l]) => !l.startsWith('a directory'))) {
      it(`${label}: the status door does not say "configured: false"`, async () => {
        clear();
        stage();
        const status = await request(server.url, 'GET', '/api/setup/status');
        assert.ok(!(status && status.status === 200 && status.json?.configured === false),
          `GET /api/setup/status said "configured: false" for a present config.json (${label}): the SPA offers first-run setup`);
      });

      it(`${label}: the setup door writes nothing over the file and issues no token`, async () => {
        clear();
        stage();
        const bytesBefore = fs.readFileSync(CONFIG, 'utf8');
        const post = await request(server.url, 'POST', '/api/setup/json', { label: 'taken over' });
        const bytesAfter = fs.readFileSync(CONFIG, 'utf8');
        assert.equal(bytesAfter, bytesBefore, `POST /api/setup/json wrote a new config over a present config.json (${label}); it answered ${post ? post.status : 'nothing'}`);
        assert.notEqual(post?.status, 201, 'the setup door issued a first admin token over a present config.json');
        assert.ok(post === null || post.status >= 400, `the setup door answered ${post?.status} over a present config.json`);
        assert.equal(fs.existsSync(CONFIG + '.tmp'), false, 'the setup door left a temp file beside a config it must not touch');
      });
    }

  });

  describe('the real entry point', () => {
    const ENTRY = fileURLToPath(new URL('../../server/dist/index.js', import.meta.url));
    for (const [label, stage] of BAD_STATES) {
      it(`${label}: boot refuses naming config.json and never starts first-run setup`, async () => {
        clear();
        stage();
        const child = spawn(process.execPath, [ENTRY], {
          env: { ...process.env, CONFIG_PATH: CONFIG, DATA_ROOT: path.join(root, 'data'), PORT: '38' + String(100 + BAD_STATES.findIndex(s => s[0] === label)), MONGO_CONNECT_RETRY_MS: '1000' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', c => { out += c; });
        child.stderr.on('data', c => { out += c; });
        const exit = await new Promise((resolve) => {
          const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('still running after 15 s'); }, 15000);
          child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
        });
        clear();
        assert.notEqual(exit, 0, `boot over a present config.json (${label}) did not refuse: ${exit === 'still running after 15 s' ? exit : 'it exited 0'}\n${out.slice(0, 600)}`);
        assert.equal(typeof exit, 'number', `boot over a present config.json (${label}) did not refuse: ${exit}\n${out.slice(0, 600)}`);
        assert.match(out, /config\.json/, `the refusal does not name the file:\n${out.slice(0, 600)}`);
        assert.doesNotMatch(out, /first-run setup required/, 'boot started first-run setup over a present config.json');
      });
    }
  });
});
