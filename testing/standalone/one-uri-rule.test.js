/**
 * ONE rule for where the database URI comes from, and an empty `MONGO_URI` is UNSET (bundle-157 plan rev 4 R4.4, rev 5 R5.5; Q-553).
 *
 * ## The rule
 *
 * `effectiveMongoUri()` answers the URI the process connects to AND where it came from (`env`, `config` or `default`). The loader
 * (`getMongoUri`) and the admin route (`GET /api/admin/data/config`, `getMongoUriSource` in `api/data.ts`) both ask it, and an empty
 * `MONGO_URI` is read as unset by both. `redactUri` lives beside it, once: the copies in `api/data.ts` and `db/dump.ts` go.
 *
 * ## What is red today, and why that is the right reason
 *
 * The characterization (`characterization-the-mongo-uri-today-env-then-config-then-default.test.js`, green) pins that `MONGO_URI=''` makes
 * the process connect to the bundled default while the route says `config`. This states the rule over every combination, so the two rows
 * with an empty env and a config URI fail on the connect URI (the config's is ignored), and nothing exports `effectiveMongoUri`.
 *
 * ## The module is DERIVED, not named
 *
 * The design says "one URI module" and does not fix its path, so the module is found by scanning the tracked server sources for the
 * export `effectiveMongoUri` (floor: a hundred sources read) and imported from `server/dist`. Zero found is the red row; more than one
 * would be the second implementation this rule exists to prevent.
 *
 * ## Rows
 *
 * | env MONGO_URI | config mongo.uri | connects to | source |
 * |---|---|---|---|
 * | unset | set | config's | config |
 * | unset | unset | bundled default | default |
 * | a value | set | the value | env |
 * | `''` | set | config's | config |
 * | `''` | unset | bundled default | default |
 *
 * Run: node --test testing/standalone/one-uri-rule.test.js (a prior `npx tsc -p server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-uri-rule-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
delete process.env['MONGO_USERNAME'];
delete process.env['MONGO_PASSWORD'];

const BUNDLED = 'mongodb://ythril-mongo:27017/ythril?directConnection=true';
const FROM_CONFIG = 'mongodb://config-host.example:27017/fromconfig';
const FROM_ENV = 'mongodb://env-host.example:27017/fromenv';
const savedEnv = process.env['MONGO_URI'];

const ROWS = [
  { name: 'env unset, config set', env: undefined, config: FROM_CONFIG, uri: FROM_CONFIG, source: 'config' },
  { name: 'env unset, config unset', env: undefined, config: undefined, uri: BUNDLED, source: 'default' },
  { name: 'env a value, config set', env: FROM_ENV, config: FROM_CONFIG, uri: FROM_ENV, source: 'env' },
  { name: "env '' (empty), config set: an empty MONGO_URI is UNSET, so the config's URI is the one", env: '', config: FROM_CONFIG, uri: FROM_CONFIG, source: 'config' },
  { name: "env '' (empty), config unset: unset, so the bundled default", env: '', config: undefined, uri: BUNDLED, source: 'default' },
];

/** The server sources that export `name`, read with comments out. Floor: a hundred sources scanned. */
function modulesExporting(name) {
  const files = trackedSources('server/src', { floor: 100, specs: false });
  const re = new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`);
  return files.filter(f => re.test(stripComments(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'))));
}

describe('one rule for where the database URI comes from', () => {
  let loader; let configHandler;
  before(async () => {
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'uri-rule', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    const { dataRouter } = await import('../../server/dist/api/data.js');
    configHandler = dataRouter.stack.find(l => l.route?.path === '/config' && l.route.methods?.get)?.route.stack.at(-1).handle;
    assert.ok(configHandler, 'GET /config is gone from the data router - re-anchor this test');
  });
  after(() => {
    if (savedEnv === undefined) delete process.env['MONGO_URI']; else process.env['MONGO_URI'] = savedEnv;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const apply = ({ env, config }) => {
    if (env === undefined) delete process.env['MONGO_URI']; else process.env['MONGO_URI'] = env;
    loader.mutateConfig(cfg => { if (config === undefined) delete cfg.mongo; else cfg.mongo = { uri: config }; });
  };
  const routeSays = () => {
    const res = { body: undefined, status() { return this; }, json(b) { this.body = b; return this; } };
    configHandler({ params: {}, query: {}, body: {}, headers: {} }, res);
    return res.body;
  };

  it('exactly one server module exports effectiveMongoUri', () => {
    const found = modulesExporting('effectiveMongoUri');
    assert.equal(found.length, 1, `effectiveMongoUri is exported by ${found.length} module(s): ${found.join(', ') || 'none'} - there is no one URI rule to ask`);
  });

  for (const row of ROWS) {
    it(`${row.name}: the loader connects to the same URI the route says it came from`, async () => {
      apply(row);
      assert.equal(loader.getMongoUri(), row.uri, 'the process would connect to a different URI than the rule says');
      const said = routeSays();
      assert.equal(said.source, row.source, 'the route names a different source than the rule says');

      const homes = modulesExporting('effectiveMongoUri');
      if (homes.length === 1) {
        const mod = await import(`../../server/dist/${homes[0].replace(/^server\/src\//, '').replace(/\.ts$/, '.js')}`);
        const effective = mod.effectiveMongoUri();
        assert.deepEqual({ uri: effective.uri, source: effective.source }, { uri: row.uri, source: row.source }, 'effectiveMongoUri disagrees with the loader or the route');
      }
    });
  }

  it('the redacted URI the route answers hides credentials and is the same function the dump uses: redactUri is declared once', () => {
    const files = trackedSources('server/src', { floor: 100, specs: false });
    const re = /(?:function\s+redactUri\b|(?:const|let)\s+redactUri\s*=)/;
    const declaredIn = files.filter(f => re.test(stripComments(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'))));
    assert.deepEqual(declaredIn.length, 1, `redactUri is declared in ${declaredIn.length} places: ${declaredIn.join(', ')}`);
  });
});
