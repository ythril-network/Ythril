/**
 * `sparql.timeoutMs`, `sparql.maxRecordsRead`, `sparql.maxResults` and `sparql.maxResultBytes` are refused at load and at reload unless they are whole numbers inside
 * their bounds, naming the key; a refused reload keeps the limits in effect; an absent key reads as its default (bundle-271, Q-756; r2 R3.3,
 * R3.4; `config/sparql-limits.ts`).
 *
 * ## What it prevents
 *
 * A bound read as `NaN`, a string or a fraction compares false against every count, so the query it bounds is unbounded; zero refuses every
 * query; a timeout past five minutes holds a slot for longer than any reader waits. Both loader paths ask the one validator.
 *
 * ## Seen red
 *
 * On 2bfffd806: the loader takes any `sparql` block, and `config/sparql-limits.ts` does not exist. Mutation (seen red once it does): the
 * reload path not asking the validator.
 *
 * Run: `node --test testing/standalone/the-sparql-limits-are-refused-at-load-and-reload-unless-in-range.test.js` (a prior
 * `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-sparql-limits-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

const GOOD = { timeoutMs: 20_000, maxRecordsRead: 50_000, maxResults: 500, maxResultBytes: 2_097_152, maxRecordsChanged: 200, maxIndexRowsRead: 600_000 };
const base = { instanceId: 'sparql-limits-test', instanceLabel: 'test', tokens: [], networks: [], spaces: [{ id: 'general', label: 'General', folders: [] }] };
const write = (sparql) => fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...base, ...(sparql === undefined ? {} : { sparql }) }, null, 2), { mode: 0o600 });

/** Per key, values outside its bounds or not whole numbers. */
const BAD = {
  timeoutMs: { zero: 0, 'below a second': 999, 'past five minutes': 300_001, fraction: 1500.5, string: '20000', null: null },
  maxRecordsRead: { zero: 0, negative: -1, 'past ten million': 10_000_001, fraction: 10.5, string: '1000' },
  maxResults: { zero: 0, 'past a million': 1_000_001, fraction: 2.5, 'a number past the safe integers': 2 ** 60 },
  maxResultBytes: { zero: 0, 'below a mebibyte': 1_048_575, 'past a gibibyte': 1_073_741_825, fraction: 1_048_576.5, string: '2097152' },
  // Q-761: the records one SPARQL Update may change, at most a write group's ceiling.
  maxRecordsChanged: { zero: 0, negative: -1, 'past a write group': 5_001, fraction: 10.5, string: '1000' },
};

let loader, limits;

describe('the SPARQL limits are whole numbers inside their bounds, at load and at reload', () => {
  before(async () => {
    write(GOOD);
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    limits = await loadDistModule('../../server/dist/config/sparql-limits.js', import.meta.url);
  });
  after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('control: values inside the bounds load and are read live; an absent block reads the defaults', () => {
    const { sparqlLimits, SPARQL_LIMIT_DEFAULTS } = needModule(limits, ['sparqlLimits', 'SPARQL_LIMIT_DEFAULTS'], 'the SPARQL limits');
    write(GOOD);
    loader.loadConfig();
    assert.deepEqual(sparqlLimits(loader.getConfig()), GOOD);
    write(undefined);
    loader.loadConfig();
    assert.deepEqual(sparqlLimits(loader.getConfig()), SPARQL_LIMIT_DEFAULTS);
    assert.ok(SPARQL_LIMIT_DEFAULTS.maxRecordsRead >= 1000 && SPARQL_LIMIT_DEFAULTS.timeoutMs === 30_000 && SPARQL_LIMIT_DEFAULTS.maxResults === 10_000);
    write(GOOD);
    loader.loadConfig();
  });

  it('a sparql block that is not an object is refused, naming it', () => {
    write('fast');
    try {
      assert.throws(() => loader.loadConfig(), /sparql/);
    } finally { write(GOOD); loader.loadConfig(); }
  });

  // S1 review m4: a key the block does not know (a typo of a bound, a bound of another version) was taken and read as nothing, so the
  // operator believed a limit was set that never was.
  for (const key of ['timeout', 'maxRecords', 'timeoutMS', 'maxResult', '__proto__', 'constructor', '']) {
    it(`an unknown key ${JSON.stringify(key)} in the sparql block is refused at load and at reload, naming it, and the limits in effect stay`, () => {
      const text = JSON.stringify({ ...base, sparql: GOOD }).replace(/"sparql":\{/, `"sparql":{${JSON.stringify(key)}:5,`);
      fs.writeFileSync(CONFIG_PATH, text, { mode: 0o600 });
      try {
        assert.throws(() => loader.loadConfig(), (err) => err.message.includes('sparql') && err.message.includes(JSON.stringify(key)), `loadConfig() took the key ${JSON.stringify(key)}`);
        assert.throws(() => loader.reloadConfig(), (err) => err.message.includes('sparql') && err.message.includes(JSON.stringify(key)), `reloadConfig() took the key ${JSON.stringify(key)}`);
        assert.equal(loader.getConfig().sparql?.maxResults, GOOD.maxResults, 'a refused reload changed the limits in effect');
      } finally { write(GOOD); loader.loadConfig(); }
    });
  }

  for (const [key, values] of Object.entries(BAD)) {
    for (const [what, value] of Object.entries(values)) {
      it(`sparql.${key} as ${what} is refused at load, naming the key`, () => {
        write({ ...GOOD, [key]: value });
        try {
          assert.throws(() => loader.loadConfig(), (err) => err.message.includes(`sparql.${key}`), `loadConfig() took sparql.${key} = ${JSON.stringify(value)}`);
        } finally { write(GOOD); loader.loadConfig(); }
      });

      it(`sparql.${key} as ${what} is refused at reload, and the limits in effect stay`, () => {
        write({ ...GOOD, [key]: value });
        try {
          assert.throws(() => loader.reloadConfig(), (err) => err.message.includes(`sparql.${key}`), `reloadConfig() took sparql.${key} = ${JSON.stringify(value)}`);
          assert.equal(loader.getConfig().sparql?.[key], GOOD[key], `a refused reload changed sparql.${key} in effect`);
        } finally { write(GOOD); loader.loadConfig(); }
      });
    }
  }
});
