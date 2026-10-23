/**
 * `scripts/_shared/telemetry-record.mjs` answers ONE question: declare, check and upsert-by-key ONE telemetry record of a
 * code-declared chrono type (Q-590, design rev 2 item 1). Both `Test-Run` (scripts/test-times.mjs) and `Trade`
 * (scripts/trade.mjs) are records of this kind.
 *
 * ## What it prevents
 *
 * A second recorder that writes its own find-and-write goes wrong in the ways the first one was fixed for, each of them
 * silent on a real instance:
 *
 * 1. **A record found by key alone.** `recordKey` is a short string (`trade:130`); a `Test-Run` entry may carry the same
 *    text. A find that does not name the TYPE updates another type's record and leaves the right one unwritten.
 * 2. **A replace that keeps a stale field.** `update_chrono` MERGES `properties`, so a field the new payload leaves out keeps
 *    the old value, and the record then says two things about two moments. Every field is written every time.
 * 3. **A type that cannot be declared.** The declaration is generated from the spec and sent to `schema_update`; the server's
 *    own validator refuses what it does not know (an array, a date: only string, number and boolean exist), so every
 *    registered spec is run through it here, derived from what the module registers (a floor of two: Test-Run and Trade).
 * 4. **A failure that is a throw.** The caller chooses the exit code and the words, so a failed write comes back as an
 *    outcome of that record, never as an exception that hides the records after it.
 *
 * ## The contract this file pins (the names are the tests', the behaviour is the design's)
 *
 * - `TELEMETRY_SPECS`: an array of specs `{ space, type, description, schema, retention }`; `schema` is
 *   `{ [property]: { type: 'string'|'number'|'boolean', required?, values?, doc } }` (the shape of `TEST_RUN_SCHEMA`),
 *   `retention` is `{ days }`. It holds at least `Test-Run` and `Trade`, and `recordKey` (a required string) is in every schema.
 * - `telemetryTypeDeclaration(spec)`: the arguments of the `schema_update` call, as `testRunTypeDeclaration()` returns them
 *   for `Test-Run` (and equal to it, so there is one description of that type).
 * - `upsertTelemetryRecords(api, spec, payloads)`: `payloads` are `{ title, startsAt, endsAt, status, properties }` as
 *   `save_chrono` takes them, `properties.recordKey` the identity. Resolves with one outcome per payload, in order:
 *   `{ key, outcome: 'inserted' | 'replaced' | 'failed', error? }`. It finds by type AND key and writes every field.
 *   (`kept`, the refusal to replace a record that holds runs the listing no longer shows, is trade's rule and is held by the
 *   CLI tests: where the module takes it as a hook is the implementation's choice.)
 *
 * Local server only; no real instance. Run: node --test testing/standalone/telemetry-record-declares-checks-and-upserts-by-key.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeYthril, FAKE_SPACE } from '../_shared/fake-ythril-tool-server.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { createYthrilApi, YthrilApiError } from '../../scripts/_shared/ythril-api.mjs';
import { testRunTypeDeclaration } from '../../scripts/test-times.mjs';
import { TypeSchemasZ } from '../../server/dist/spaces/body-schemas.js';
import { getAllowedChronoTypes } from '../../server/dist/spaces/schema-validation.js';

const MODULE = '../../scripts/_shared/telemetry-record.mjs';
let mod = null;
let loadError = null;
try { mod = await import(MODULE); } catch (error) { loadError = error; }
/** The module, or a failure that says the module is what is missing (so a red here is read as that, not as a broken rule). */
const module_ = () => {
  assert.ok(mod, `scripts/_shared/telemetry-record.mjs cannot be imported: ${loadError?.message}`);
  for (const name of ['TELEMETRY_SPECS', 'telemetryTypeDeclaration', 'upsertTelemetryRecords']) assert.ok(name in mod, `the module does not export ${name}`);
  return mod;
};

const SCALARS = new Set(['string', 'number', 'boolean']);
const specOf = (type) => module_().TELEMETRY_SPECS.find(s => s.type === type);

/** A value of the type a schema field declares (the first of its enum when it has one). */
const valueFor = (field, n) => (field.values ? field.values[0] : field.type === 'number' ? n : field.type === 'boolean' ? false : `text-${n}`);

/** A complete payload of `spec`, every schema field present, `n` making the values distinct from another payload's. */
function payloadOf(spec, key, n = 1) {
  const properties = {};
  for (const [name, field] of Object.entries(spec.schema)) properties[name] = valueFor(field, n);
  properties.recordKey = key;
  return { title: `${spec.type} ${key}`, startsAt: '2026-10-20T10:00:00.000Z', endsAt: '2026-10-20T11:00:00.000Z', status: 'completed', properties };
}

async function withInstance(body) {
  const server = await startFakeYthril();
  try { return await body({ server, api: createYthrilApi({ url: server.url, token: server.token }) }); } finally { await server.close(); }
}

describe('every registered spec declares a type the server accepts', () => {
  it('registers at least Test-Run and Trade, each once (a floor, so an empty registry cannot pass every loop below)', () => {
    const specs = module_().TELEMETRY_SPECS;
    assert.ok(Array.isArray(specs) && specs.length >= 2, `${specs?.length} spec(s) registered`);
    const types = specs.map(s => s.type);
    assert.equal(new Set(types).size, types.length, `a type is registered twice: ${types.join(', ')}`);
    for (const type of ['Test-Run', 'Trade']) assert.ok(types.includes(type), `${type} is not registered (${types.join(', ')})`);
  });

  it('for each spec: the declaration is the spec, field for field, and the server\'s own validator accepts it', () => {
    const { TELEMETRY_SPECS, telemetryTypeDeclaration } = module_();
    assert.ok(TELEMETRY_SPECS.length >= 2);
    const defaults = [...getAllowedChronoTypes(undefined)].sort();
    assert.ok(defaults.length >= 5, 'the server\'s default chrono types could not be read: the read is broken');
    for (const spec of TELEMETRY_SPECS) {
      const at = spec.type;
      assert.ok(typeof spec.space === 'string' && spec.space, `${at}: space`);
      const decl = telemetryTypeDeclaration(spec);
      assert.equal(decl.space, spec.space, `${at}: the declaration is for the spec's space`);
      assert.equal(decl.typeSchemasMode, 'merge', `${at}: merge, or declaring one type erases the space's others`);
      const parsed = TypeSchemasZ.safeParse(decl.typeSchemas);
      assert.ok(parsed.success, `${at}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues).slice(0, 500)}`);
      const type = decl.typeSchemas.chrono[spec.type];
      assert.ok(type, `${at}: the declaration holds no chrono type of that name`);
      assert.deepEqual(Object.keys(type.propertySchemas).sort(), Object.keys(spec.schema).sort(), `${at}: declared properties are the schema's`);
      for (const [name, field] of Object.entries(spec.schema)) {
        assert.ok(SCALARS.has(field.type), `${at}.${name}: ${field.type} is no type a chrono property has (string, number, boolean)`);
        assert.equal(type.propertySchemas[name].type, field.type, `${at}.${name}: type`);
        assert.equal(type.propertySchemas[name].description, field.doc, `${at}.${name}: description`);
        assert.ok(field.doc && field.doc.length > 10, `${at}.${name}: a property with no description is the one nobody can read`);
        assert.equal(type.propertySchemas[name].required === true, field.required === true, `${at}.${name}: required`);
      }
      assert.equal(spec.schema.recordKey?.type, 'string', `${at}: recordKey is the identity, a string`);
      assert.equal(spec.schema.recordKey?.required, true, `${at}: recordKey is required`);
      assert.equal(type.description, spec.description, `${at}: description`);
      assert.ok(spec.description && spec.description.length > 20, `${at}: the type says what it is`);
      assert.equal(type.suppressEmbeddings, true, `${at}: found by date and filter, never by meaning`);
      assert.equal(type.whenDuePasses, 'nothing', `${at}: a passed date means nothing here`);
      assert.ok(Number.isInteger(spec.retention?.days) && spec.retention.days > 0, `${at}: a retention of nothing is no bound`);
      assert.deepEqual(type.retention, { days: spec.retention.days }, `${at}: retention`);
      assert.deepEqual(Object.keys(decl.typeSchemas.chrono).filter(t => t !== spec.type).sort(), defaults, `${at}: the server's default chrono types stay beside it, or declaring one closes the space to the others`);
    }
  });

  it('the Test-Run declaration is the one test-times prints: there is one description of that type', () => {
    const { telemetryTypeDeclaration } = module_();
    assert.deepEqual(telemetryTypeDeclaration(specOf('Test-Run')), testRunTypeDeclaration());
  });
});

describe('upserting one record by type and key', () => {
  it('inserts when the key is new: finds first by type and key, then saves the whole payload into the spec\'s space', async () => {
    await withInstance(async ({ server, api }) => {
      const { upsertTelemetryRecords } = module_();
      const spec = specOf('Trade');
      const payload = payloadOf(spec, 'trade:130');
      const outcomes = await upsertTelemetryRecords(api, spec, [payload]);
      assert.deepEqual(outcomes.map(o => [o.key, o.outcome]), [['trade:130', 'inserted']]);
      assert.equal(server.store.length, 1);
      assert.equal(server.store[0].type, 'Trade');
      assert.deepEqual(server.store[0].properties, payload.properties);
      assert.equal(server.calls[0].tool, 'filter', 'the first call is the read');
      assert.equal(server.calls[0].args.filter.type, 'Trade', 'the find names the type');
      assert.equal(server.calls[0].args.filter['properties.recordKey'], 'trade:130', 'and the key');
      const saves = server.callsTo('save_chrono');
      assert.equal(saves.length, 1);
      assert.equal(saves[0].args.space, spec.space);
      assert.equal(saves[0].args.type, 'Trade');
    });
  });

  it('recording the same key again leaves one record, replaced by an update that carries EVERY field (update merges, so a stale field would stay)', async () => {
    await withInstance(async ({ server, api }) => {
      const { upsertTelemetryRecords } = module_();
      const spec = specOf('Trade');
      await upsertTelemetryRecords(api, spec, [payloadOf(spec, 'trade:130', 1)]);
      const numeric = Object.keys(spec.schema).filter(k => spec.schema[k].type === 'number');
      assert.ok(numeric.length >= 5, 'the Trade spec declares its figures as numbers');
      for (const k of numeric) server.store[0].properties[k] = 999; // what an older recording left behind
      const second = payloadOf(spec, 'trade:130', 2);
      const outcomes = await upsertTelemetryRecords(api, spec, [second]);
      assert.deepEqual(outcomes.map(o => [o.key, o.outcome]), [['trade:130', 'replaced']]);
      assert.equal(server.store.length, 1, 'one record, not two');
      assert.equal(server.callsTo('save_chrono').length, 1, 'no second insert');
      const updates = server.callsTo('update_chrono');
      assert.equal(updates.length, 1);
      assert.deepEqual(Object.keys(updates[0].args.properties).sort(), Object.keys(spec.schema).sort(), 'the update names every schema field');
      assert.deepEqual(server.store[0].properties, second.properties, 'no field kept its older value');
    });
  });

  it('never finds, updates or deletes another type\'s record that holds the same key, for every registered spec', async () => {
    const { TELEMETRY_SPECS, upsertTelemetryRecords } = module_();
    assert.ok(TELEMETRY_SPECS.length >= 2);
    for (const spec of TELEMETRY_SPECS) {
      await withInstance(async ({ server, api }) => {
        const others = TELEMETRY_SPECS.filter(s => s.type !== spec.type);
        const seeded = others.map(o => server.seed({ type: o.type, title: `${o.type} held`, properties: { recordKey: 'trade:130', marker: o.type } }));
        const snapshot = structuredClone(server.store);
        const outcomes = await upsertTelemetryRecords(api, spec, [payloadOf(spec, 'trade:130')]);
        assert.deepEqual(outcomes.map(o => o.outcome), ['inserted'], `${spec.type}: the key is new for THIS type`);
        assert.deepEqual(server.store.slice(0, seeded.length), snapshot, `${spec.type}: another type's record was touched`);
        assert.equal(server.store.length, seeded.length + 1);
        assert.deepEqual([...server.callsTo('update_chrono'), ...server.callsTo('delete_chrono')], [], `${spec.type}: nothing is updated or deleted`);
      });
    }
  });

  it('a failed write is that record\'s outcome, never a throw, and never carries the token', async () => {
    await withInstance(async ({ server, api }) => {
      const { upsertTelemetryRecords } = module_();
      const spec = specOf('Trade');
      server.respond = (call) => (call.tool === 'save_chrono' ? { status: 500, body: { ok: false, error: 'the store is down' } } : undefined);
      const outcomes = await upsertTelemetryRecords(api, spec, [payloadOf(spec, 'trade:130')]);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].key, 'trade:130');
      assert.equal(outcomes[0].outcome, 'failed');
      assert.ok(String(outcomes[0].error ?? '').length > 0, 'the failure says why');
      assert.ok(!JSON.stringify(outcomes).includes(server.token), 'a token in an outcome is a token in a log');
      assert.equal(server.store.length, 0);
    });
  });
});

describe('a replace leaves no field of the old record behind, optional ones included', () => {
  const optionalOf = (spec) => Object.keys(spec.schema).filter(k => !spec.schema[k].required);

  it('an optional field the new payload lacks is deleted by the update (the merge would keep its old value)', async () => {
    await withInstance(async ({ server, api }) => {
      const { upsertTelemetryRecords } = module_();
      const spec = specOf('Test-Run');
      const optional = optionalOf(spec);
      assert.ok(optional.length >= 2, 'Test-Run has optional fields (wallMs, measurementsChars): the test needs them');
      await upsertTelemetryRecords(api, spec, [payloadOf(spec, 'k:1', 1)]);
      for (const k of optional) assert.ok(k in server.store[0].properties, `${k} was written the first time`);
      const without = payloadOf(spec, 'k:1', 2);
      for (const k of optional) delete without.properties[k];
      const outcomes = await upsertTelemetryRecords(api, spec, [without]);
      assert.deepEqual(outcomes.map(o => o.outcome), ['replaced']);
      for (const k of optional) assert.ok(!(k in server.store[0].properties), `${k} kept the value of the record it replaced`);
      assert.deepEqual([...server.callsTo('update_chrono')[0].args.deleteFields].sort(), optional.map(k => `properties.${k}`).sort());
      assert.deepEqual(server.store[0].properties, without.properties);
    });
  });

  it('a payload that carries them all deletes nothing, and a type with no optional field sends no deleteFields', async () => {
    await withInstance(async ({ server, api }) => {
      const { upsertTelemetryRecords } = module_();
      for (const type of ['Test-Run', 'Trade']) {
        const spec = specOf(type);
        await upsertTelemetryRecords(api, spec, [payloadOf(spec, `${type}:1`, 1)]);
        await upsertTelemetryRecords(api, spec, [payloadOf(spec, `${type}:1`, 2)]);
      }
      for (const c of server.callsTo('update_chrono')) assert.ok(!c.args.deleteFields || c.args.deleteFields.length === 0, JSON.stringify(c.args.deleteFields));
    });
  });
});

describe('a batch goes on after one record fails, and stops when every later call would fail the same way', () => {
  const stubApi = (error) => ({ calls: 0, async call() { this.calls += 1; throw error; } });
  const two = () => { const spec = specOf('Trade'); return { spec, payloads: [payloadOf(spec, 'trade:1'), payloadOf(spec, 'trade:2')] }; };

  for (const [what, error] of [
    ['a 401 (the token is refused)', new YthrilApiError('filter: HTTP 401', { status: 401, tool: 'filter' })],
    ['a 403', new YthrilApiError('filter: HTTP 403', { status: 403, tool: 'filter' })],
    ['no status at all (the instance is not there)', new YthrilApiError('filter: request failed (ECONNREFUSED)', { tool: 'filter' })],
  ]) {
    it(`stops at ${what}: the rest are failed with the same reason, unsent`, async () => {
      const { spec, payloads } = two();
      const api = stubApi(error);
      const outcomes = await module_().upsertTelemetryRecords(api, spec, payloads);
      assert.deepEqual(outcomes.map(o => [o.key, o.outcome]), [['trade:1', 'failed'], ['trade:2', 'failed']]);
      assert.equal(outcomes[1].error, outcomes[0].error);
      assert.equal(api.calls, 1, 'the second record was never sent');
    });
  }

  it('goes on after a 500 (that record\'s failure only)', async () => {
    const { spec, payloads } = two();
    const api = stubApi(new YthrilApiError('filter: HTTP 500', { status: 500, tool: 'filter' }));
    const outcomes = await module_().upsertTelemetryRecords(api, spec, payloads);
    assert.deepEqual(outcomes.map(o => o.outcome), ['failed', 'failed']);
    assert.equal(api.calls, 2, 'each record was tried');
  });
});

describe('duplicates of a key collapse to the newest, for a Trade record', () => {
  it('updates the newest, deletes the two older, leaves one', async () => {
    await withInstance(async ({ server, api }) => {
      const spec = specOf('Trade');
      const old = server.seed({ type: 'Trade', title: 'old', createdAt: '2020-01-01T00:00:00.000Z', properties: { recordKey: 'trade:9' } });
      const middle = server.seed({ type: 'Trade', title: 'middle', createdAt: '2021-01-01T00:00:00.000Z', properties: { recordKey: 'trade:9' } });
      const newest = server.seed({ type: 'Trade', title: 'newest', createdAt: '2099-01-01T00:00:00.000Z', properties: { recordKey: 'trade:9' } });
      const outcomes = await module_().upsertTelemetryRecords(api, spec, [payloadOf(spec, 'trade:9')]);
      assert.deepEqual(outcomes.map(o => o.outcome), ['replaced']);
      assert.equal(server.store.length, 1);
      assert.equal(server.store[0]._id, newest._id);
      assert.deepEqual(new Set(server.callsTo('delete_chrono').map(c => c.args.id)), new Set([old._id, middle._id]));
      assert.equal(server.callsTo('update_chrono')[0].args.id, newest._id);
    });
  });
});

describe('the newest-first comparator is written once', () => {
  it('exactly one script spells it, and it is the shared module both recorders import', () => {
    const files = [...readdirSync(join(REPO_ROOT, 'scripts')).filter(f => f.endsWith('.mjs')).map(f => `scripts/${f}`),
      ...readdirSync(join(REPO_ROOT, 'scripts', '_shared')).filter(f => f.endsWith('.mjs')).map(f => `scripts/_shared/${f}`)];
    assert.ok(files.length >= 20, `${files.length} scripts read: the scan is blind`);
    const spelling = /\b\w+(?:\.\w+|\[\w+\])\s*<\s*\w+(?:\.\w+|\[\w+\])\s*\?\s*1\s*:/;
    const spellers = files.filter(f => spelling.test(stripComments(readFileSync(join(REPO_ROOT, f), 'utf8'))));
    assert.deepEqual(spellers, ['scripts/_shared/newest-by.mjs']);
    assert.match(readFileSync(join(REPO_ROOT, 'scripts/_shared/newest-by.mjs'), 'utf8'), /export const newestBy\b/);
  });
});

describe('the fake instance is the space the recorder writes to', () => {
  it('Trade and Test-Run live in the one space the tests\' instance serves (a spec for another space is a red here, not a 404 later)', () => {
    for (const spec of module_().TELEMETRY_SPECS) assert.equal(spec.space, FAKE_SPACE, spec.type);
  });
});
