/**
 * `ythril_unknown_write_fields_total{door,operation,mode,outcome}` is counted once per judged call that carried an unknown key, by the
 * shared judge, and its labels come from a fixed vocabulary — never from a key name a caller chose (bundle-128, Q-320; design-v3 section 2b).
 *
 * ## What it prevents
 *
 * - **A series minted by spelling.** A caller can send any key it likes. A label built from it makes one time series per spelling,
 *   unbounded, from any authenticated caller (the same reason `toolCallsTotal` is counted only after the tool name is known). So `door`,
 *   `operation`, `mode` and `outcome` are each drawn from a set the code holds, and the scrape never names a key a caller sent.
 * - **Counting per key, or per door.** The judge counts each judged call that carried at least one unknown key ONCE, so a body with
 *   three unknown names is one count, and both doors count alike because the count is inside the shared judge.
 * - **A series that is absent until it happens.** The registered pairs are on the scrape at 0 from the start, so "absent" and "0" never mean
 *   opposite things on a graph (the way `ythril_schema_refusals_total` is declared).
 *
 * ## Read by delta against a series that already moved, never reset
 *
 * `pitfall-gauge-reset-reads-zero`: a metric reset in a test reads a plausible zero whether or not the step under test wrote it. A counter
 * cannot be poisoned below zero, so each case first moves the series it asks about to a value no fresh process holds (three judged calls),
 * then reads the whole scrape, runs the step, reads it again, and asserts WHICH series changed and by how much — an identity, not a count of
 * series, and not "is zero".
 *
 * ## Red on the unchanged base
 *
 * The counter is not registered and the judge module does not exist; every case fails for exactly that.
 *
 * Run: node --test testing/standalone/the-unknown-write-fields-counter-takes-its-labels-from-a-fixed-vocabulary.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { openUnknownWriteFieldsConfig, WARN_SPACE, REFUSE_SPACE } from './_unknown-write-fields-config.mjs';

const NAME = 'ythril_unknown_write_fields_total';
const OPERATION = 'entity.create';
const valid = { name: 'Acme', type: 'concept' };
const DOORS = ['rest', 'mcp', 'tool'];
const MODES = ['warn', 'refuse'];
const OUTCOMES = ['stored', 'refused'];

let judge, registry, operations;

/** The series of the counter on the scrape, as `Map<labelsKey, { labels, value }>`. Parsed from the exposition text, the form an operator reads. */
async function scrape() {
  const text = await registry.register.metrics();
  const series = new Map();
  let typed = false;
  for (const line of text.split('\n')) {
    if (line === `# TYPE ${NAME} counter`) typed = true;
    if (!line.startsWith(`${NAME}{`)) continue;
    const m = /^[^{]+\{([^}]*)\}\s+(\S+)/.exec(line);
    assert.ok(m, `unreadable series line: ${line}`);
    const labels = Object.fromEntries([...m[1].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map(x => [x[1], x[2]]));
    series.set(JSON.stringify(Object.entries(labels).sort()), { labels, value: Number(m[2]) });
  }
  return { series, typed, text };
}
const keyOf = (labels) => JSON.stringify(Object.entries(labels).sort());
/** The series whose value differs between two scrapes, as `{ key: delta }`. A series that appeared counts from 0. */
function changed(before, after) {
  const out = {};
  for (const [k, { value }] of after.series) {
    const was = before.series.get(k)?.value ?? 0;
    if (value !== was) out[k] = value - was;
  }
  return out;
}

describe('the unknown-write-fields counter', () => {
  before(async () => {
    await openUnknownWriteFieldsConfig({ suite: 'b128-metric' });
    judge = await import('../../server/dist/contract/write-accepts.js');
    registry = await import('../../server/dist/metrics/registry.js');
    const { MCP_TOOL_OPERATIONS } = await import('../../server/dist/mcp/audit-map.js');
    operations = new Set(Object.values(MCP_TOOL_OPERATIONS).flat().filter(Boolean));
  });

  const run = (space, body, door) => judge.answerUnknownWriteFields(body, OPERATION, space, door);
  const labelsFor = (door, mode, outcome) => ({ door, operation: OPERATION, mode, outcome });

  it('is declared as a counter, with every registered series on the scrape at zero before anything is judged', async () => {
    const s = await scrape();
    assert.ok(s.typed, `${NAME} is not a registered counter`);
    assert.ok(s.series.size >= 6, `only ${s.series.size} series are declared at start: absent and zero would mean opposite things on a graph`);
    for (const [, { labels, value }] of s.series) assert.equal(value, 0, `${JSON.stringify(labels)} is not 0 at start`);
    for (const [label, values] of [['door', DOORS], ['mode', MODES], ['outcome', OUTCOMES]]) {
      for (const v of values) assert.ok([...s.series.values()].some(x => x.labels[label] === v), `no declared series has ${label}="${v}"`);
    }
  });

  it('every series carries exactly the four labels, each from its vocabulary', async () => {
    const s = await scrape();
    assert.ok(s.series.size >= 6);
    const bad = [];
    for (const { labels } of s.series.values()) {
      if (JSON.stringify(Object.keys(labels).sort()) !== JSON.stringify(['door', 'mode', 'operation', 'outcome'])) bad.push(`labels ${Object.keys(labels)}`);
      if (!DOORS.includes(labels.door)) bad.push(`door ${labels.door}`);
      if (!MODES.includes(labels.mode)) bad.push(`mode ${labels.mode}`);
      if (!OUTCOMES.includes(labels.outcome)) bad.push(`outcome ${labels.outcome}`);
      if (!operations.has(labels.operation)) bad.push(`operation ${labels.operation}`);
    }
    assert.deepEqual(bad, [], 'a label value outside the fixed vocabulary');
  });

  for (const door of DOORS) {
    it(`a judged call with three unknown keys on the ${door} door moves exactly one series, once — warn is stored, refuse is refused`, async () => {
      // Poison first: three calls so the series reads a value no fresh process holds, whatever a reset would have said.
      for (let i = 0; i < 3; i++) run(WARN_SPACE, { ...valid, zz: 1 }, door);
      for (let i = 0; i < 3; i++) run(REFUSE_SPACE, { ...valid, zz: 1 }, door);
      const poisoned = await scrape();
      assert.ok(poisoned.series.get(keyOf(labelsFor(door, 'warn', 'stored')))?.value >= 3, `the warn series for ${door} did not move: the judge does not count`);

      const a = await scrape();
      run(WARN_SPACE, { ...valid, zz: 1, yy: 2, xx: 3 }, door);
      const b = await scrape();
      assert.deepEqual(changed(a, b), { [keyOf(labelsFor(door, 'warn', 'stored'))]: 1 },
        'one judged call with three unknown keys must be ONE count on ONE series (not one per key)');

      run(REFUSE_SPACE, { ...valid, zz: 1, yy: 2, xx: 3 }, door);
      const c = await scrape();
      assert.deepEqual(changed(b, c), { [keyOf(labelsFor(door, 'refuse', 'refused'))]: 1 });
    });
  }

  it('a judged call that carried no unknown key counts nothing, in either mode', async () => {
    run(WARN_SPACE, { ...valid, zz: 1 }, 'rest');
    const a = await scrape();
    run(WARN_SPACE, { ...valid, description: 'fine' }, 'rest');
    run(REFUSE_SPACE, { ...valid, description: 'fine' }, 'rest');
    run(REFUSE_SPACE, undefined, 'rest');
    const b = await scrape();
    assert.deepEqual(changed(a, b), {});
  });

  it('a caller\'s key name never becomes a label: no series is minted, and the scrape never names the key', async () => {
    run(WARN_SPACE, { ...valid, zz: 1 }, 'rest');
    const a = await scrape();
    const poison = 'POISON_KEY_NAME_a_caller_chose';
    for (const space of [WARN_SPACE, REFUSE_SPACE]) for (const door of DOORS) run(space, { ...valid, [poison]: 1, [`${poison}2`]: 2 }, door);
    const b = await scrape();
    assert.deepEqual([...b.series.keys()].sort(), [...a.series.keys()].sort(), 'a call minted a series: a label took a caller\'s spelling');
    assert.ok(!b.text.includes('POISON_KEY_NAME'), 'the scrape carries a key name a caller chose');
  });
});
