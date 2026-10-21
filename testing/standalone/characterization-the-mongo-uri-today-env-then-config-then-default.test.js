/**
 * CHARACTERIZATION - pins how the server picks the database URI it CONNECTS to, and what the admin route reports as its source
 * (bundle-157, plan rev 4 R4.4, rev 5 R5.5; Q-553).
 *
 * ## What it pins
 *
 * `getMongoUri()` (`config/loader.ts`) and `GET /api/admin/data/config` both ask `effectiveMongoUri()` (`config/mongo-uri.ts`): a
 * non-empty `MONGO_URI`, else the config's `mongo.uri`, else the bundled default. An EMPTY `MONGO_URI` (what `docker-compose.yml` writes
 * for `MONGO_URI: ${MONGO_URI:-}` when the operator sets nothing) is UNSET, so the process connects to the config's URI and the route says
 * `config` - the same answer from both.
 *
 * | env MONGO_URI | config mongo.uri | connects to | route says |
 * |---|---|---|---|
 * | unset | set | the config's | config |
 * | unset | unset | the bundled default | default |
 * | a value | any | the value | env |
 * | `''` | set | the config's (an empty MONGO_URI is unset) | config |
 *
 * ## The row that changed, and why
 *
 * Before the rule, the last row pinned the disagreement: `getMongoUri` read `MONGO_URI ?? config.mongo.uri`, `??` kept the empty string,
 * and the process connected to the BUNDLED default with the config's URI ignored, while the route (reading by truthiness) said `config`.
 * The operator was told the URI came from the config file while the process connected somewhere else. The rule landed, and that row
 * was rewritten - and only that row - so the change is a visible edit of a pinned row and not a silent one.
 *
 * Run: node --test testing/standalone/characterization-the-mongo-uri-today-env-then-config-then-default.test.js (a prior `npx tsc -p server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-uri-characterization-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
delete process.env['MONGO_USERNAME'];
delete process.env['MONGO_PASSWORD'];

const BUNDLED = 'mongodb://ythril-mongo:27017/ythril?directConnection=true';
const FROM_CONFIG = 'mongodb://config-host.example:27017/fromconfig';
const FROM_ENV = 'mongodb://env-host.example:27017/fromenv';

let loader; let configHandler;
const savedEnv = process.env['MONGO_URI'];

/** The `source` the admin config route answers, run as a request reaches the handler. */
function sourceTold() {
  const res = { body: undefined, status() { return this; }, json(b) { this.body = b; return this; } };
  configHandler({ params: {}, query: {}, body: {}, headers: {} }, res);
  assert.ok(res.body && typeof res.body.source === 'string', `GET /config answered no source: ${JSON.stringify(res.body)}`);
  return res.body.source;
}

const setup = ({ env, config }) => {
  if (env === undefined) delete process.env['MONGO_URI']; else process.env['MONGO_URI'] = env;
  loader.mutateConfig(cfg => { if (config === undefined) delete cfg.mongo; else cfg.mongo = { uri: config }; });
};

describe('the connect URI is a non-empty env, else config, else the bundled default, and the route names the same source', () => {
  before(async () => {
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'uri-characterization', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    const { dataRouter } = await import('../../server/dist/api/data.js');
    const layer = dataRouter.stack.find(l => l.route?.path === '/config' && l.route.methods?.get);
    assert.ok(layer, 'GET /config is gone from the data router - re-anchor this characterization');
    configHandler = layer.route.stack.at(-1).handle;
  });
  after(() => {
    if (savedEnv === undefined) delete process.env['MONGO_URI']; else process.env['MONGO_URI'] = savedEnv;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('env unset, config set: connects to the config\'s URI and the route says config', () => {
    setup({ env: undefined, config: FROM_CONFIG });
    assert.equal(loader.getMongoUri(), FROM_CONFIG);
    assert.equal(sourceTold(), 'config');
  });

  it('env unset, config unset: connects to the bundled default and the route says default', () => {
    setup({ env: undefined, config: undefined });
    assert.equal(loader.getMongoUri(), BUNDLED);
    assert.equal(sourceTold(), 'default');
  });

  it('env set to a value: it wins over the config, and the route says env', () => {
    setup({ env: FROM_ENV, config: FROM_CONFIG });
    assert.equal(loader.getMongoUri(), FROM_ENV);
    assert.equal(sourceTold(), 'env');
  });

  it('env set to the EMPTY string, config set: an empty MONGO_URI is unset, so it connects to the config\'s URI and the route says config', () => {
    setup({ env: '', config: FROM_CONFIG });
    assert.equal(loader.getMongoUri(), FROM_CONFIG, 'an empty MONGO_URI made the process ignore the config\'s URI again');
    assert.equal(sourceTold(), 'config', 'the route names another source than the one the process connects by');
  });
});
