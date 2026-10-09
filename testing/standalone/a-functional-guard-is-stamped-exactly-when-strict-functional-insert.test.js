/**
 * A functional edge insert carries the write guard exactly when the space is strict, the label is functional and the
 * write is an INSERT — and "strict" is one predicate that every site asks (`Q-439`).
 *
 * ## The rule
 *
 * The planner stamps `_functionalGuard` (the marker the unique partial index collides on) on the document it plans for an
 * edge INSERT under a label that is functional in a STRICT space, and on nothing else:
 *
 *  - a CONVERGE never stamps (the stored edge is the subject's one edge, and a second stamp could only collide with itself);
 *  - `warn` and `off` never stamp (they let a second edge through, and a marker would refuse it with a duplicate key);
 *  - a label that is not functional never stamps (no subject has "at most one").
 *
 * An over-stamp is the worse half: it refuses a write the space allows, with a duplicate-key error nobody can explain.
 * An under-stamp is the race the marker exists to close. So the truth table is asserted over every row, and the planner is
 * exercised, not read.
 *
 * ## One predicate for "strict"
 *
 * `applyValidation` already says what `strict` means. The stamp, the relabel (`updateEdgeById`) and `applyValidation` each
 * deciding it for themselves is the defect this repo produces most: two spellings of one rule, and the weaker one wins
 * silently — a space flipped to `warn` that still refuses a second manager, or a strict space that stamps nothing. So
 * `validationRefuses(meta)` is the one exported predicate, `applyValidation` and both stamping sites call it, and the
 * comparison against `'strict'` is spelled in exactly one place.
 *
 * ## Names the code will use, and the one this test chose
 *
 * `_functionalGuard` and `validationRefuses` come from the plan. The plan does not fix WHERE `validationRefuses` is
 * exported: this test reads it from `spaces/schema-validation.ts`, beside `applyValidation`, whose strict test it is. The
 * marker is asserted to be a non-empty string, never a particular value.
 *
 * ## Seen red / mutations
 *
 * Red on 9a4b41c6: no planned insert carries `_functionalGuard`, and `validationRefuses` does not exist. The rows that are
 * green today (converge, warn, off, non-functional) are proven by a mutation: make the stamp unconditional and each of
 * them goes red; make it follow `meta.validationMode !== 'off'` and the `warn` row goes red.
 *
 * Run: node --test testing/standalone/a-functional-guard-is-stamped-exactly-when-strict-functional-insert.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';
import { LABELS, fixtureTypeSchemas } from './_inline-edge-doors.mjs';

const MARKER = '_functionalGuard';
const SPACE = 'guard-space';
const FROM = 'subject-1';
const TO = 'manager-1';

let dir;
let getConfig;
let planEdge;
let ReadSet;
let schemaValidation;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ythril-guard-stamp-'));
  const cfgPath = path.join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({
    instanceId: 'i-1', instanceLabel: 'Test', tokens: [], networks: [],
    spaces: [{ id: SPACE, label: 'Guard', folders: [], meta: {} }],
  }), 'utf8');
  // Imported AFTER CONFIG_PATH is set: the loader reads it once, at module load.
  process.env['CONFIG_PATH'] = cfgPath;
  const loader = await import('../../server/dist/config/loader.js');
  loader.loadConfig();
  getConfig = loader.getConfig;
  ({ planEdge } = await import('../../server/dist/brain/write-plan/plan-edge.js'));
  ({ ReadSet } = await import('../../server/dist/brain/write-plan/read-set.js'));
  schemaValidation = await import('../../server/dist/spaces/schema-validation.js');
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** The space's meta, in memory: the planner reads it through `getSpaceMeta`, which reads the loaded config. */
function declare({ validationMode }) {
  const space = getConfig().spaces.find(s => s.id === SPACE);
  // `strictLinkage: false` so the planner asks nothing about whether the ends exist: this test is about the stamp.
  space.meta = { strictLinkage: false, ...(validationMode ? { validationMode } : {}), typeSchemas: fixtureTypeSchemas() };
}

/**
 * Plan one edge with no database: the subject is a record this batch minted, so nothing stored can be an edge from it
 * and the read set answers without a read; `stored` is an edge the plan lands on (a converge).
 */
async function planned(label, { stored = false } = {}) {
  const view = new ReadSet(SPACE, async () => []);
  view.mint(FROM);
  view.noteWritten('entity', { _id: FROM, name: 'subject', type: 'person' }, false);
  view.noteWritten('entity', { _id: TO, name: 'manager', type: 'person' }, false);
  if (stored) {
    const { edgeIdFor } = await import('../../server/dist/brain/edge-id.js');
    view.noteWritten('edge', {
      _id: edgeIdFor(FROM, TO, label), spaceId: SPACE, from: FROM, to: TO, label, tags: [], seq: 5,
      author: { instanceId: 'i-1', label: 'Test' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }, false);
  }
  return planEdge(SPACE, { from: FROM, to: TO, label }, view);
}

/** What the plan writes, whichever shape it has: the inserted document, or the converge's `$set` and `$unset`. */
const writtenKeys = ({ plan }) => Object.keys(plan.op === 'insert' ? plan.doc : { ...plan.set, ...plan.unset });

describe('the guard is stamped exactly when a strict space inserts an edge under a functional label', () => {
  it('strict + functional + insert: the planned document carries the marker, a non-empty string', async () => {
    declare({ validationMode: 'strict' });
    const out = await planned(LABELS.functional);
    assert.equal(out.plan.op, 'insert');
    assert.equal(typeof out.plan.doc[MARKER], 'string', `the planned insert carries no ${MARKER}: two writers can both pass the planner's count`);
    assert.ok(out.plan.doc[MARKER].length > 0);
  });

  it('strict + functional + converge: not stamped (the edge already holds the subject\'s one slot)', async () => {
    declare({ validationMode: 'strict' });
    const out = await planned(LABELS.functional, { stored: true });
    assert.equal(out.plan.op, 'converge', 'the fixture did not land on the stored edge');
    assert.ok(!writtenKeys(out).includes(MARKER), `a converge writes ${MARKER}`);
  });

  it('warn + functional + insert: not stamped (warn lets a second edge through; a marker would refuse it)', async () => {
    declare({ validationMode: 'warn' });
    const out = await planned(LABELS.functional);
    assert.equal(out.plan.op, 'insert');
    assert.ok(!(MARKER in out.plan.doc), `a warn space stamps ${MARKER}`);
  });

  it('off + functional + insert: not stamped', async () => {
    declare({ validationMode: 'off' });
    const out = await planned(LABELS.functional);
    assert.ok(!(MARKER in out.plan.doc), `an off space stamps ${MARKER}`);
  });

  it('no validation mode declared + functional + insert: not stamped', async () => {
    declare({});
    const out = await planned(LABELS.functional);
    assert.ok(!(MARKER in out.plan.doc), `a space with no mode stamps ${MARKER}`);
  });

  it('strict + a label that is not functional + insert: not stamped', async () => {
    declare({ validationMode: 'strict' });
    for (const label of [LABELS.plain, LABELS.endpoints]) {
      const out = await planned(label);
      assert.ok(!(MARKER in out.plan.doc), `a strict space stamps ${MARKER} on the non-functional label '${label}'`);
    }
  });

  it('warn + a label the schema does not declare + insert: not stamped (strict refuses it outright, which is not this rule)', async () => {
    declare({ validationMode: 'warn' });
    const out = await planned(LABELS.undeclared);
    assert.ok(!(MARKER in out.plan.doc), `an undeclared label is stamped with ${MARKER}`);
  });
});

describe('"strict" is ONE predicate, `validationRefuses`', () => {
  const read = (rel) => stripComments(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
  const SCHEMA = 'server/src/spaces/schema-validation.ts';

  it('is exported, and answers true for strict only', () => {
    assert.equal(typeof schemaValidation.validationRefuses, 'function',
      'spaces/schema-validation.js exports no `validationRefuses`: the stamp and applyValidation each decide what strict means');
    const { validationRefuses } = schemaValidation;
    assert.equal(validationRefuses({ validationMode: 'strict' }), true);
    assert.equal(validationRefuses({ validationMode: 'warn' }), false);
    assert.equal(validationRefuses({ validationMode: 'off' }), false);
    assert.equal(validationRefuses({}), false);
    assert.equal(validationRefuses(undefined), false);
  });

  // A boolean, not `assert.match`: a failing match prints the whole function body.
  const calls = (body) => /\bvalidationRefuses\(/.test(body);

  it('applyValidation asks it', () => {
    assert.ok(calls(bodyOf(read(SCHEMA), 'applyValidation', 'applyValidation')), 'applyValidation spells the strict test itself');
  });

  it('the planner\'s stamp asks it (edgeRefusal or planEdge, wherever the stamp is decided)', () => {
    const src = read('server/src/brain/write-plan/plan-edge.ts');
    const decided = ['edgeRefusal', 'planEdge'].map(n => bodyOf(src, n, n)).join('\n');
    assert.ok(calls(decided), 'the planner decides which writes are stamped without asking validationRefuses');
  });

  it('the relabel (`updateEdgeById`) asks it, so a relabel stamps by the same rule as a create', () => {
    const body = bodyOf(read('server/src/brain/edges.ts'), 'updateEdgeById', 'updateEdgeById');
    assert.ok(calls(body), 'updateEdgeById decides the stamp of a relabel without asking validationRefuses');
  });

  it('`validationMode === \'strict\'` is spelled in exactly one place, inside validationRefuses', () => {
    const src = read(SCHEMA);
    const spellings = [...src.matchAll(/validationMode\s*[!=]==?\s*'strict'/g)];
    assert.ok(spellings.length >= 1, 'no strict comparison found in schema-validation.ts: re-point this gate');
    const body = bodyOf(src, 'validationRefuses', 'validationRefuses');
    for (const m of spellings) {
      assert.ok(body.includes(m[0]), `\`${m[0]}\` is spelled outside validationRefuses`);
    }
  });
});
