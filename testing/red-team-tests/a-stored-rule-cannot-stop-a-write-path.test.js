/**
 * A rule is an expression written by an operator, replicated to every member of a network and run on every write: so nothing a
 * rule says may be able to stop a write path, slow it without bound, or reach Object.prototype (F-46; security and performance
 * vet of bundle-23).
 *
 * ## What is attacked
 *
 * - **A pattern that makes a backtracking engine exponential**, `(a+)+$`, as a rule's regex, against a 5 000-character value and a
 *   `!`. `@bufbuild/cel` runs `matches()` on RE2, so the rule is ACCEPTED (it is only a pattern) and the write answers in
 *   milliseconds. A refusal at save would be the old `hasReDoSRisk` heuristic turning away an ordinary rule; a write that does not
 *   answer is the DoS. Both are asserted.
 * - **The largest rule set the limits admit**, as a worst case for the cost budget: fifty rules of the heaviest shape that fits
 *   1000 characters (a comprehension over the tags with 35 regex tests in it). It is refused at SAVE, deterministically, naming the
 *   cost — never accepted and then truncated at write time, and never "worked out by a clock".
 * - **The largest record the input caps admit**, against a rule that reads all of it: 100 tags of 10 000 characters. It answers
 *   (the caps bound the work), and a record one tag over the cap is "too large to check" — a violation that quotes nothing.
 * - **The instance stays ready while that runs**: `GET /ready` answers inside its probe window with a write in flight.
 * - **Names that are not names**: `__proto__`, `constructor`, `prototype`, `toString` as a rule name, in a body the caller wrote
 *   as raw JSON (so `__proto__` is an own key, not an object literal's prototype), are refused at save and nothing is stored.
 *
 * ## Why a red-team test and the standalone tests are not enough
 *
 * `a-cel-rule-runs-in-linear-time` proves the engine in a child process. What only a live instance proves is the path a request
 * takes: the body parser, the save-time check, the stored rule, the write validator, the answer — with the real event loop under
 * them, which is the thing a synchronous evaluation can block.
 *
 * Needs the test stack (`npm run test:up`) and `testing/sync/configs/a/token.txt`.
 *
 * Run: node --test testing/red-team-tests/a-stored-rule-cannot-stop-a-write-path.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, patch, delWithBody } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `rule-dos-${RUN}`;

let token;
/** The generous ceiling for "the write answered": the point is that it ends, not how fast. */
const ANSWERED_MS = 15_000;

const meta = (rules, propertySchemas = { s: { type: 'string' } }) => ({
  validationMode: 'strict', suppressEmbeddings: true,
  typeSchemas: { entity: { thing: { propertySchemas, rules } } },
});
const setSchema = (rules, propertySchemas) => patch(INSTANCES.a, token, `/api/spaces/${SPACE}`, { meta: meta(rules, propertySchemas), typeSchemasMode: 'replace' });
const writeEntity = (properties, tags = []) => post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/entities`, { name: `Probe ${Math.random()}`, type: 'thing', tags, properties });
const timed = async (fn) => { const t0 = Date.now(); const out = await fn(); return { ...out, ms: Date.now() - t0 }; };

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const r = await post(INSTANCES.a, token, '/api/spaces', { id: SPACE, label: `Rule DoS ${RUN}`, meta: { strictLinkage: false } });
  assert.equal(r.status, 201, `space create failed: ${JSON.stringify(r.body)}`);
});
after(async () => { await delWithBody(INSTANCES.a, token, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {}); });

describe('a regex that makes a backtracking engine exponential is only a pattern here', () => {
  it('matches(\'(a+)+$\') is accepted at save, and a write of 5 000 `a`s and a `!` is answered in time', { timeout: 60_000 }, async () => {
    const saved = await setSchema({ pathological: { rule: `self.properties.s.matches('(a+)+$')`, message: 'ends in a run of a' } });
    assert.ok([200, 202].includes(saved.status), `the pattern was refused at save (that is a heuristic, not a bound): ${saved.status} ${JSON.stringify(saved.body).slice(0, 300)}`);
    const answered = await timed(() => writeEntity({ s: `${'a'.repeat(5000)}!` }));
    assert.ok(answered.ms < ANSWERED_MS, `the write took ${answered.ms} ms: the engine backtracks, and one stored rule can stop a write path`);
    assert.ok([201, 400, 422].includes(answered.status), `the write answered ${answered.status}`);
  });
});

describe('the worst rule set the limits admit', () => {
  it('fifty maximal comprehension rules are refused at save with the cost named, and nothing is stored', { timeout: 60_000 }, async () => {
    const heavy = `self.tags.all(t, ${Array(35).fill(`t.matches('^[a-z]+$')`).join(' && ')})`;
    assert.ok(heavy.length <= 1000, 'the fixture is over the rule limit, so the refusal below would be for length');
    const rules = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`h${i + 1}`, { rule: heavy, message: `heavy ${i + 1}` }]));
    const before_ = await get(INSTANCES.a, token, `/api/spaces/${SPACE}/meta`);
    const saved = await timed(() => setSchema(rules));
    assert.equal(saved.status, 400, `the set was accepted or failed another way: ${saved.status} ${JSON.stringify(saved.body).slice(0, 300)}`);
    assert.match(JSON.stringify(saved.body), /cost|budget/i, `the refusal does not say it is the cost: ${JSON.stringify(saved.body).slice(0, 300)}`);
    assert.ok(saved.ms < ANSWERED_MS, `the save-time check took ${saved.ms} ms`);
    const after_ = await get(INSTANCES.a, token, `/api/spaces/${SPACE}/meta`);
    assert.deepEqual(after_.body.typeSchemas, before_.body.typeSchemas, 'a refused set changed the stored schema');
  });
});

describe('the largest record the caps admit, and one past them', () => {
  const TAG = 'a'.repeat(10_000);

  it('100 tags of 10 000 characters against a rule that reads every one is answered; 101 is too large to check, and says nothing of the value', { timeout: 120_000 }, async () => {
    const saved = await setSchema({ lower: { rule: `self.tags.all(t, t.matches('^[a-z]+$'))`, message: 'tags are lower-case words' } });
    assert.ok([200, 202].includes(saved.status), `${saved.status} ${JSON.stringify(saved.body).slice(0, 300)}`);
    const atCap = await timed(() => writeEntity({ s: 'x' }, Array(100).fill(TAG)));
    assert.ok(atCap.ms < ANSWERED_MS, `a record at the caps took ${atCap.ms} ms`);
    assert.equal(atCap.status, 201, `a record at the caps was refused: ${atCap.status} ${JSON.stringify(atCap.body).slice(0, 300)}`);
    const over = await timed(() => writeEntity({ s: 'x' }, Array(101).fill(TAG)));
    assert.ok(over.ms < ANSWERED_MS, `a record over the caps took ${over.ms} ms`);
    assert.ok([400, 422].includes(over.status), `a record over the caps was accepted: ${over.status}`);
    // A 101st tag is refused by the request bound (`tags` holds at most 100) before any rule runs: the bound and the rule input's cap are
    // the same number, so the rule's own "too large to check" answer is for a value no write door lets through. Either says why.
    assert.match(JSON.stringify(over.body), /too large|at most 100 entries/i, 'the refusal does not say the record was too large');
    assert.ok(!JSON.stringify(over.body).includes(TAG.slice(0, 200)), 'the refusal quotes the oversize value');
  });
});

describe('the instance stays ready while a worst-case write is in flight', () => {
  it('GET /ready answers inside its probe window with the write running', { timeout: 120_000 }, async () => {
    const write = writeEntity({ s: 'x' }, Array(100).fill('a'.repeat(10_000)));
    const probes = [];
    for (let i = 0; i < 5; i++) probes.push(timed(() => get(INSTANCES.a, token, '/ready')));
    const answered = await Promise.all(probes);
    await write;
    for (const p of answered) {
      assert.ok(p.ms < 2_000, `/ready took ${p.ms} ms while a rule was being evaluated: the evaluation blocks the event loop for longer than the readiness probe waits`);
    }
  });
});

describe('names that are not names', () => {
  /** The body as raw JSON, so `__proto__` is an own key and not an object literal setting a prototype. */
  const rawPatch = (name) => fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: `{"meta":{"rules":{${JSON.stringify(name)}:{"rule":"true","message":"m"}}}}`,
  });

  for (const name of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf']) {
    it(`a rule named ${name} is refused at save and nothing is stored`, async () => {
      const res = await rawPatch(name);
      assert.equal(res.status, 400, `a rule named ${name} answered ${res.status}`);
      const meta_ = await get(INSTANCES.a, token, `/api/spaces/${SPACE}/meta`);
      assert.equal(Object.hasOwn(meta_.body.rules ?? {}, name), false, `a rule named ${name} was stored`);
      assert.equal(({}).polluted, undefined, 'Object.prototype was modified');
    });
  }

  it('the control: a rule with an ordinary name is accepted by the same raw door', async () => {
    const res = await rawPatch('ordinary');
    assert.ok([200, 202].includes(res.status), `an ordinary rule was refused: ${res.status} ${await res.text()}`);
  });
});
