/**
 * The checks every stored record must pass before any store call are ONE module, one function per kind (bundle-270, amendment A5).
 *
 * ## The rule
 *
 * `server/src/brain/record-checks.ts` answers, per kind, whether one record may reach the store: the fact text's cap, the primitive-property rule
 * (entities), the chrono status rule, the tag cap, the link caps (`linkEntities`, `linkFacts`) and the record's size. The bulk import calls it
 * for every item, the doors that held a copy of a cap call it, and the RDF import calls it from the dry plan, so an oversized record cannot pass
 * the dry plan and then fail in the store after other records landed.
 *
 * Each bound is tested at the bound (taken) and one over (refused), through the module. The second half reads the tree: no server source
 * compares a length with `MAX_FACT_LENGTH` except the shape table and this module, and the bulk import reaches the module for every kind.
 *
 * ## Red on the unchanged tree (1c41ddf04)
 *
 * `server/dist/brain/record-checks.js` does not exist, and `brain/bulk.ts`, `api/brain/facts.ts` and `mcp/tools/fact.ts` each compare a
 * fact's length with `MAX_FACT_LENGTH` themselves.
 *
 * Run: node --test testing/standalone/every-record-check-refuses-one-over-its-bound.test.js (requires a prior `npm run build:server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, SERVER_CODE_ROOTS, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

let checks;
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = (n) => Array.from({ length: n }, (_, i) => ID(i));
const tags = (n) => Array.from({ length: n }, (_, i) => `t${i}`);

before(async () => {
  checks = await import('../../server/dist/brain/record-checks.js');
});

/** The smallest record of each kind that passes every check. */
const BASE = {
  fact: () => ({ fact: 'f' }),
  entity: () => ({ name: 'n', type: 't' }),
  chrono: () => ({ title: 't', type: 'event', startsAt: '2026-01-01T00:00:00Z' }),
  edge: () => ({ from: ID(1), to: ID(2), label: 'l' }),
};

const ok = (kind, rec) => assert.equal(checks.recordCheckError(kind, rec), null, `${kind} at the bound is refused`);
const refused = (kind, rec, re) => {
  const why = checks.recordCheckError(kind, rec);
  assert.ok(typeof why === 'string', `${kind} one over the bound is taken`);
  assert.match(why, re);
};

describe('each record check refuses one over its bound, through the one module', () => {
  it('the fact text: 50 000 characters taken, 50 001 refused', () => {
    ok('fact', { fact: 'x'.repeat(50_000) });
    refused('fact', { fact: 'x'.repeat(50_001) }, /50 000/);
  });

  for (const kind of ['fact', 'entity', 'chrono', 'edge']) {
    it(`the tags of a ${kind}: 100 taken, 101 refused`, () => {
      ok(kind, { ...BASE[kind](), tags: tags(100) });
      refused(kind, { ...BASE[kind](), tags: tags(101) }, /tags/);
    });
  }

  for (const [kind, field] of [['fact', 'linkEntities'], ['chrono', 'linkEntities'], ['chrono', 'linkFacts']]) {
    it(`the ${field} of a ${kind}: 1000 taken, 1001 refused`, () => {
      ok(kind, { ...BASE[kind](), [field]: ids(1000) });
      refused(kind, { ...BASE[kind](), [field]: ids(1001) }, new RegExp(field));
    });
  }

  it('an entity property value: a primitive taken, a nested value refused', () => {
    ok('entity', { ...BASE.entity(), properties: { a: 'x', b: 1, c: true } });
    refused('entity', { ...BASE.entity(), properties: { a: { nested: 1 } } }, /string, number, or boolean/);
  });

  it('a chrono status: a known one taken, any other refused', () => {
    ok('chrono', { ...BASE.chrono(), status: 'completed' });
    refused('chrono', { ...BASE.chrono(), status: 'someday' }, /status/);
  });

  for (const kind of ['fact', 'entity', 'chrono', 'edge']) {
    it(`the size of a ${kind}: at the bound taken, one byte over refused`, () => {
      const base = BASE[kind]();
      // `description` carries the padding: no other check bounds it, so the size is the only rule it can meet.
      const empty = Buffer.byteLength(JSON.stringify({ ...base, description: '' }), 'utf8');
      const at = { ...base, description: 'd'.repeat(checks.MAX_RECORD_BYTES - empty) };
      assert.equal(Buffer.byteLength(JSON.stringify(at), 'utf8'), checks.MAX_RECORD_BYTES);
      ok(kind, at);
      refused(kind, { ...base, description: 'd'.repeat(checks.MAX_RECORD_BYTES - empty + 1) }, /bytes/);
    });
  }
});

describe('the record checks have one home', () => {
  it('no server source compares a length with MAX_FACT_LENGTH except the shape table and the record checks', () => {
    const home = new Set(['server/src/brain/write-shape.ts', 'server/src/brain/record-checks.ts']);
    const offenders = trackedSources(SERVER_CODE_ROOTS, { untracked: true })
      .filter(f => !home.has(f))
      .filter(f => /\.length\s*>=?\s*MAX_FACT_LENGTH\b/.test(stripComments(readFileSync(path.join(REPO_ROOT, f), 'utf8'))));
    assert.deepEqual(offenders, [], 'a second copy of the fact cap is a check the import\'s dry plan does not run');
  });

  it('the bulk import and the dry plan call the record check for every item kind', () => {
    const bulk = stripComments(readFileSync(path.join(REPO_ROOT, 'server/src/brain/bulk.ts'), 'utf8'));
    for (const kind of ['fact', 'entity', 'chrono', 'edge']) {
      assert.match(bulk, new RegExp(`plannedInputError\\(\\s*\\{\\s*kind:\\s*'${kind}'`), `the bulk import's ${kind} items do not reach the record check`);
    }
    const dry = stripComments(readFileSync(path.join(REPO_ROOT, 'server/src/brain/write-plan/dry-plan.ts'), 'utf8'));
    assert.match(dry, /plannedInputError\(\s*item\s*\)/, 'the dry plan does not ask the record check of each item');
    assert.match(dry, /if \(why\) refusals\.push/, 'the dry plan asks the record check and does not refuse on it');
  });
});
