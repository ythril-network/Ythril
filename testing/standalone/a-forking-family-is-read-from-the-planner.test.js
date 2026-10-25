/**
 * Every place that says which families fork reads `FORKING_FAMILIES` (`sync/upsert-plan.ts`), so a fifth forking family is a
 * one-line change and a family dropped from one place is a red gate, not a silent hole (Q-624, design rev 4 section 1 and
 * section 16 test 14).
 *
 * ## The defect this holds
 *
 * Bundle-81 made facts fork with `'facts'` written at every site: the planner's branch, the fork context read, the writer's
 * read-back, the fork write, the list and the resolve. A second family forking is then a hunt for the sites, and the site
 * that is missed is invisible: an entity fork row stored by one door and refused by another, a chrono fork nobody can resolve,
 * an edge fork with no index behind its sibling count. The set is declared ONCE, in the planner, and every consumer below
 * must read it.
 *
 * ## What it checks, derived from FORKING_FAMILIES
 *
 *  - `forkOf` is declared on each family's `Incoming*` schema (the leaf, `sync/incoming-schemas.ts`), as an optional,
 *    non-empty string: a hashed field must replicate;
 *  - `tags` defaults to `[]` on each, so two equal copies normalise alike (R10);
 *  - `FORK_INDEXES` is declared for each family's collection (`spaces/space-indexes.ts`);
 *  - `FORK_KINDS` (`brain/forks.ts`) is derived from `FORKING_FAMILIES`;
 *  - `RelinkKind` covers every forking kind a reference can name (`REF_KINDS`); an edge cannot be named, so it has none;
 *  - the batch push stats count `forked`, `forkRefused` and `invalidFork` per family, and the single push answers each;
 *  - each family's `delete_*` tool imports `FORKS_GO_WITH_THEIR_SUBJECT`;
 *  - `writeKeptBody` has exactly one caller, `resolveFork`;
 *  - `_resolvedElsewhere` is in `LOCAL_ONLY_FIELDS` and `RESTORED_LOCAL_FIELDS` and on no `Incoming*` schema;
 *  - the decline branch of `applyPeerTombstones` and the planner's fork branch each read `FORKING_FAMILIES`;
 *  - no literal `'facts'` is left where the fork path is written: `sync/accept-page.ts`, `sync/push-reads.ts`, `brain/forks.ts`,
 *    the planner's `planArrivals` (but for naming the facts family's own `inserted`/`updated` verdicts, on the line that names
 *    them) and the arrival writer's `writeArrivals`.
 *
 * ## Seen red
 *
 * On b857da8f: the leaf does not exist, `forkOf` is on the fact schema alone, `FORK_INDEXES` is declared for facts alone and
 * `'facts'` is written at every site above. After the change, by hand (each put back by hand): chrono taken out of the
 * `FORKING_FAMILIES` consumer of one site.
 *
 * Run: node --test testing/standalone/a-forking-family-is-read-from-the-planner.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { moduleIndex } from './_call-graph.mjs';
import { readTrackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf, statementFrom } from './_structural-window.mjs';
import { requireSpaceIndexDeclaration } from './_space-index-declaration.mjs';

const code = (file) => stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
const literalsOfFacts = (text) => [...text.matchAll(/(['"])facts\1/g)];

/**
 * A module that is not built fails the case that needs it, naming the module, and no other: one missing module must not cancel
 * the whole file and hide which rule each of the others states.
 */
const loaded = {};
const load = async (key, spec) => {
  try { loaded[key] = await import(spec); } catch (err) { loaded[key] = { __missing: `${spec.replace('../../server/dist/', 'dist/')} (${String(err?.code ?? err?.message)})` }; }
};
const need = (key) => { assert.ok(!loaded[key].__missing, `${loaded[key].__missing} is not built`); return loaded[key]; };

before(async () => {
  await load('plan', '../../server/dist/sync/upsert-plan.js');
  await load('leaf', '../../server/dist/sync/incoming-schemas.js');
  await load('localOnly', '../../server/dist/sync/local-only-fields.js');
  await load('types', '../../server/dist/config/types.js');
  await load('knowledge', '../../server/dist/config/types-knowledge.js');
  FORKING_FAMILIES = loaded.plan.FORKING_FAMILIES;
  INCOMING_SCHEMA_OF = loaded.leaf.INCOMING_SCHEMA_OF;
  localOnly = loaded.localOnly;
  recordTypes = loaded.types.RECORD_TYPES;
  recordCollection = loaded.types.RECORD_COLLECTION;
  refKinds = loaded.knowledge.REF_KINDS;
});

let FORKING_FAMILIES, INCOMING_SCHEMA_OF, localOnly, recordTypes, recordCollection, refKinds;

/** The set every case ranges over, or the case's own failure when it is not declared (an empty set passes every loop). */
const familiesNow = () => {
  assert.ok(Array.isArray(FORKING_FAMILIES) && FORKING_FAMILIES.length > 0, 'FORKING_FAMILIES is not exported by sync/upsert-plan.ts: there is no one set for a consumer to read');
  return FORKING_FAMILIES;
};

/** The record types (`fact`, `entity`, `chrono`, `edge`) whose collection is a forking family. */
const forkingKinds = () => recordTypes.filter(t => FORKING_FAMILIES.includes(recordCollection[t]));

describe('the set is declared once, and is the set it should be', () => {
  it('FORKING_FAMILIES is a frozen list of brain collections, and is read at all', () => {
    familiesNow();
    assert.ok(Object.isFrozen(FORKING_FAMILIES), 'the set every consumer reads can be edited by one of them');
    assert.ok(FORKING_FAMILIES.length >= 4, `only ${FORKING_FAMILIES.length} forking families: facts, entities, edges and chrono fork`);
    assert.deepEqual(forkingKinds().length, FORKING_FAMILIES.length, 'a forking family is not the collection of a record type');
  });
});

describe('every forking family is handled where a family is handled', () => {
  it('forkOf is declared on each Incoming schema, optional and non-empty, so a hashed field replicates', () => {
    familiesNow(); need('leaf');
    for (const family of FORKING_FAMILIES) {
      const shape = INCOMING_SCHEMA_OF[family]?.schema?.shape;
      assert.ok(shape, `INCOMING_SCHEMA_OF has no schema for ${family}`);
      assert.ok(shape.forkOf, `the ${family} schema does not declare forkOf, so a pushed fork row loses its parent link (zod strips it) while a pulled one keeps it`);
      assert.equal(shape.forkOf.safeParse(undefined).success, true, `${family}: forkOf must be optional`);
      assert.equal(shape.forkOf.safeParse('p').success, true, `${family}: forkOf must take an id`);
      assert.equal(shape.forkOf.safeParse('').success, false, `${family}: forkOf '' must be refused: it escapes the partial identity index`);
    }
  });

  it('tags defaults to [] on each, so a copy without tags and one with [] normalise alike', () => {
    familiesNow(); need('leaf');
    for (const family of FORKING_FAMILIES) {
      const parsed = INCOMING_SCHEMA_OF[family].schema.shape.tags.safeParse(undefined);
      assert.ok(parsed.success && Array.isArray(parsed.data) && parsed.data.length === 0,
        `${family}: tags does not default to [], so two equal copies hash apart and an equal-seq pair forks against itself`);
    }
  });

  it('_resolvedElsewhere is local-only and restored, and on no Incoming schema', () => {
    need('leaf');
    assert.ok(localOnly.LOCAL_ONLY_FIELDS.has('_resolvedElsewhere'), '_resolvedElsewhere is not in LOCAL_ONLY_FIELDS: it would be hashed and replicated');
    assert.ok(localOnly.RESTORED_LOCAL_FIELDS.has('_resolvedElsewhere'), '_resolvedElsewhere is not in RESTORED_LOCAL_FIELDS: a restore would clear a decision still owed');
    for (const [family, { schema }] of Object.entries(INCOMING_SCHEMA_OF)) {
      assert.equal('_resolvedElsewhere' in schema.shape, false, `${family}: a peer could plant a decision mark through its schema`);
    }
  });

  it('FORK_INDEXES is declared for each family\'s collection, sparse', async () => {
    familiesNow();
    const { FORK_INDEXES } = await import('../../server/dist/sync/upsert-plan.js');
    const declared = await requireSpaceIndexDeclaration(assert);
    for (const family of FORKING_FAMILIES) {
      for (const ix of FORK_INDEXES) {
        const e = declared.find(d => d.part === family && JSON.stringify(d.raw.keys) === JSON.stringify(ix.keys));
        assert.ok(e, `${JSON.stringify(ix.keys)} of FORK_INDEXES is not declared on ${family}: the sibling count, the list and the delete cascade scan it`);
        assert.equal(e.spec.sparse, ix.sparse === true, `${family}: declared with another sparseness than FORK_INDEXES says`);
      }
    }
  });

  it('FORK_KINDS is derived from FORKING_FAMILIES, one row per family', async () => {
    familiesNow();
    const src = code('server/src/brain/forks.ts');
    const at = src.indexOf('export const FORK_KINDS');
    assert.ok(at > -1, 'brain/forks.ts does not export FORK_KINDS');
    // Bounded by the declaration itself (its statement), not by a guessed number of characters after the anchor.
    assert.match(statementFrom(src, at, 'FORK_KINDS'), /FORKING_FAMILIES/, 'FORK_KINDS is written out instead of derived from FORKING_FAMILIES');
    const { FORK_KINDS } = await import('../../server/dist/brain/forks.js');
    const rows = Array.isArray(FORK_KINDS) ? FORK_KINDS.length : FORK_KINDS.size ?? Object.keys(FORK_KINDS).length;
    assert.equal(rows, FORKING_FAMILIES.length, 'FORK_KINDS holds another number of kinds than there are forking families');
  });

  it('RelinkKind covers every forking kind a reference can name; an edge cannot be named', () => {
    familiesNow();
    const decl = code('server/src/brain/relink-references.ts').match(/export type RelinkKind\s*=([^;]*);/);
    assert.ok(decl, 'RelinkKind is not declared in brain/relink-references.ts');
    const named = [...decl[1].matchAll(/'(\w+)'/g)].map(m => m[1]);
    const referable = forkingKinds().filter(k => refKinds.includes(k));
    assert.ok(referable.length >= 3, `only ${referable.length} forking kinds are referable: fact, entity and chrono are`);
    for (const k of referable) assert.ok(named.includes(k), `RelinkKind does not name '${k}': a ${k} fork resolved or merged leaves its edges and links on the old id`);
    assert.equal(forkingKinds().some(k => !refKinds.includes(k)), true, 'every forking kind is referable: the edge exception this test names is gone, re-anchor');
  });

  it('the batch push counts forked, forkRefused and invalidFork for each family, and the single push answers each', () => {
    familiesNow();
    const src = code('server/src/api/sync/docs.ts');
    for (const family of FORKING_FAMILIES) {
      for (const verdict of ['forked', 'forkRefused', 'invalidFork']) {
        assert.ok(new RegExp(`count\\(\\s*'${family}'\\s*,\\s*'${verdict}'\\s*\\)`).test(src),
          `the batch stats of ${family} do not count '${verdict}': a peer's report of it reads as stored`);
      }
    }
    const answered = (word) => (src.match(new RegExp(word, 'g')) ?? []).length;
    assert.ok(answered("verdict === 'forked'") >= FORKING_FAMILIES.length, 'a forking family\'s single push does not answer `forked`');
    assert.ok(answered("verdict === 'forkRefused'") >= FORKING_FAMILIES.length, 'a forking family\'s single push does not answer the cap');
    assert.ok(answered("invalid_fork") >= FORKING_FAMILIES.length, 'a forking family\'s single push does not answer `invalid_fork`');
  });

  it('each family\'s delete tool imports FORKS_GO_WITH_THEIR_SUBJECT', () => {
    familiesNow();
    const toolFiles = readTrackedSources('server/src/mcp/tools', { ext: ['.ts'], floor: 5, specs: false, untracked: true });
    for (const kind of forkingKinds()) {
      const owner = toolFiles.filter(s => stripComments(s.text).includes(`name: 'delete_${kind}'`));
      assert.equal(owner.length, 1, `delete_${kind} is declared in ${owner.length} tool files`);
      assert.match(stripComments(owner[0].text), /\bFORKS_GO_WITH_THEIR_SUBJECT\b/,
        `delete_${kind} does not say that deleting a record deletes its unresolved versions: ${owner[0].file}`);
    }
  });

  it('writeKeptBody has exactly one caller, and it is resolveFork', () => {
    const sources = readTrackedSources('server/src', { ext: ['.ts'], floor: 300, specs: false, untracked: true });
    const calls = sources.flatMap(s => [...stripComments(s.text).matchAll(/\bwriteKeptBody\s*\(/g)].map(() => s.file));
    const definition = sources.filter(s => /\bfunction\s+writeKeptBody\b/.test(stripComments(s.text)));
    assert.equal(definition.length, 1, 'writeKeptBody is not defined once');
    assert.equal(calls.length, definition.length + 1, `writeKeptBody has ${calls.length - definition.length} caller(s): the keep that overwrites a record's body is reachable from more than the resolve`);
    const resolve = bodyOf(code('server/src/brain/forks.ts'), 'resolveFork');
    assert.match(resolve, /\bwriteKeptBody\s*\(/, 'the one caller is not resolveFork');
  });
});

describe('the fork path no longer spells the facts family', () => {
  it('the decline branch of applyPeerTombstones and the planner\'s fork branch read FORKING_FAMILIES', () => {
    assert.ok(/\bFORKING_FAMILIES\b/.test(bodyOf(code('server/src/sync/tombstone-apply.ts'), 'applyPeerTombstones')),
      'a declined fork tombstone is marked for the facts family alone: an entity, edge or chrono fork another instance resolved stays unmarked here');
    assert.ok(/\bFORKING_FAMILIES\b/.test(bodyOf(code('server/src/sync/upsert-plan.ts'), 'planArrivals')),
      'the planner forks the facts family alone');
  });

  for (const file of ['server/src/sync/accept-page.ts', 'server/src/sync/push-reads.ts', 'server/src/brain/forks.ts']) {
    it(`${file.replace('server/src/', '')} writes no literal 'facts'`, () => {
      const found = literalsOfFacts(code(file)).length;
      assert.equal(found, 0, `${found} literal 'facts' left in ${file}: the fork path there handles one family`);
    });
  }

  it('planArrivals names the facts family only for its own inserted/updated verdicts, and writeArrivals not at all', () => {
    const plan = bodyOf(code('server/src/sync/upsert-plan.ts'), 'planArrivals');
    const stray = plan.split(/\r?\n/).filter(l => literalsOfFacts(l).length > 0 && !/'inserted'|'updated'/.test(l));
    assert.deepEqual(stray, [], 'planArrivals spells the facts family on a line that is not the naming of its verdicts: the fork branch handles one family');
    assert.equal(literalsOfFacts(bodyOf(code('server/src/sync/arrivals.ts'), 'writeArrivals')).length, 0,
      'writeArrivals reads back the facts family\'s body alone: a divergence of another family is read as landed');
  });

  it('the derivation reads what a literal is, and does not read a word in a comment', () => {
    assert.equal(literalsOfFacts("const x = kind === 'facts';").length, 1);
    assert.equal(literalsOfFacts('const x = kind === "facts";').length, 1);
    assert.equal(literalsOfFacts(stripComments("// the facts family is 'facts'\nconst x = 1;")).length, 0);
    assert.equal(literalsOfFacts("const factsCount = 1; const x = 'factsheet';").length, 0);
  });

  it('the files that carry the fork path exist and were read (floor)', () => {
    assert.ok(moduleIndex('server/src').bodies.size >= 1000, 'the call graph read too few functions to hold the sweep above');
  });
});
