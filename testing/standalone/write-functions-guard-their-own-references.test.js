/**
 * A write function that stores references validates them itself, rather than trusting its callers to have done it.
 *
 * ## The shape, now seen three times
 *
 * `strictLinkage` promises that a stored reference resolves. That promise was kept by the API doors calling
 * `assertRefsResolve` before the write — so it held for callers who remembered, and not otherwise:
 *
 *  - `upsertEdge` did not validate its schema; `api/contradictions.ts` and `brain/bulk.ts` went around it.
 *  - `updateFileMeta` did not validate its references; `files/media/face-embedder.ts` goes around it,
 *    attaching an auto-labelled face's entity with no check at all.
 *  - `brain/merge.ts` validated nothing while rewriting the survivor.
 *
 * Owner's ruling, 2026-08-29: *"all upsert/update/insert things must validate."*
 *
 * ## What this pins
 *
 * That the reference check lives INSIDE the function that stores the reference. Callers may check too — the API
 * doors legitimately do, for better error shapes — so this asserts presence at the write, never absence at the
 * caller.
 *
 * It also pins the `strictLinkage` gate, because moving a check is exactly when an opt-out gets lost by
 * accident: the setting exists for staged imports where targets resolve in a later pass, and a relocation that
 * quietly made the check unconditional would break that without anyone asking for it.
 *
 * Run: node --test testing/standalone/write-functions-guard-their-own-references.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf, blockAfter } from './_structural-window.mjs';
import { inlineEdgeDoorFiles, serverSource as door } from './_edge-accepting-sources.mjs';

/**
 * The writers that can be handed a link set, and the kind each one writes from.
 *
 * Three, not one. The check was per FIELD while `updateFileMeta` was the only writer that had it; it is
 * one call now — class and existence together — and a writer that skips it is the same defect wherever it
 * happens.
 */
const GUARDED = [
  // The create/converge writers DECIDE in their planners since `Q-99` part 3, so the planner is where the
  // check has to be: `refuseLinks` asks the read set what `assertDesiredLinks` asks the store, in its words.
  { file: 'server/src/brain/write-plan/plan-fact.ts', fn: 'planFact', check: 'refuseLinks(', decided: 'noteWritten(' },
  { file: 'server/src/brain/fact.ts', fn: 'updateFact', check: 'assertDesiredLinks(' },
  { file: 'server/src/brain/write-plan/plan-chrono.ts', fn: 'planChrono', check: 'refuseLinks(', decided: 'noteWritten(' },
  { file: 'server/src/brain/chrono.ts', fn: 'updateChrono', check: 'assertDesiredLinks(' },
  { file: 'server/src/files/file-meta.ts', fn: 'updateFileMeta', check: 'assertDesiredLinks(' },
];

describe('write functions guard their own references', () => {
  for (const target of GUARDED) {
    const src = () => stripComments(readFileSync(target.file, 'utf8'));

    it(`${target.fn} asserts its links itself`, () => {
      /*
       * At the WRITER, not at the door. The existence check sat at each door for the 4.x arrays and
       * NOWHERE for `linkEntities`, so on a strict space one spelling was refused and the other stored —
       * and `files/media/face-embedder.ts` reaches a writer directly, past every door there is.
       */
      const body = bodyOf(src(), target.fn);
      assert.ok(body.includes(target.check),
        `${target.fn} writes a link set without asserting it. The check used to live only at the API `
        + 'doors, so the strict-linkage guarantee held only for callers who remembered it.');
    });

    it(`${target.fn} asserts BEFORE it writes`, () => {
      /*
       * The half that makes it worth having. The link rows are written AFTER the record is stored, so a
       * refusal there leaves the record written without the links it asked for: a `400` and a row the
       * caller did not want, which is the silent unlinked write made noisy rather than fixed.
       *
       * A planner writes nothing (`a-write-planner-touches-no-collection`), so for one the question is
       * whether it refuses before it DECIDES — before it records the plan in the read set, after which a
       * later item of the same batch treats the record as written.
       */
      const body = bodyOf(src(), target.fn);
      const checkAt = body.indexOf(target.check);
      const writeAt = target.decided
        ? body.indexOf(target.decided)
        : body.search(/\.(updateOne|replaceOne|insertOne|findOneAndUpdate)\(/);
      assert.notEqual(writeAt, -1, `no write found in ${target.fn} — re-point this gate`);
      assert.ok(checkAt !== -1 && checkAt < writeAt,
        'asserting after the write leaves a record stored without the links the same call was refused for');
    });
  }

  it('EVERY door that accepts edges refuses FIRST, whichever doors those are', () => {
    /*
     * The door half, and it is the half that was missing. `applyConnections` runs AFTER the record is
     * written — it has to, because a link needs both ends and the `from` is what was just minted — so a
     * door that only calls it answers `400` with the record already stored. Measured: a fact created with
     * a link id naming nothing was refused AND kept.
     *
     * DERIVED from the calls rather than from a list of doors: a seventh write door is covered on the
     * commit that adds it, which a list of six could never do.
     */
    // A door is whatever ACCEPTS `edges`, however it spells it (`Q-170`) — NOT only whoever calls `applyConnections`.
    // The bulk door plans a body's connections through `connectionsOf` and never calls `applyConnections`, so a set
    // derived from that one call left it out while its title claimed every door. Each spelling of "takes edges":
    // declaring the field (`connectionSchemas(`), refusing its shape (`connectionInputError(`), knowing its key
    // (`CONNECTION_BODY_KEYS`), applying it (`applyConnections(`), planning it (`connectionsOf(`), or handing the
    // body to the batch door (`bulkWrite(`, not the driver's `.bulkWrite(`). The module that defines them is not a door.
    const doors = inlineEdgeDoorFiles();
    assert.ok(doors.length >= 9, `only ${doors.length} file(s) accept edges — the sweep has broken: ${doors.join(', ')}`);
    for (const known of ['server/src/brain/bulk.ts', 'server/src/mcp/tools/bulk.ts', 'server/src/api/brain/bulk.ts']) {
      assert.ok(doors.includes(known), `${known} is not being seen as a door that accepts edges — the derivation narrowed`);
    }

    const offenders = [];
    for (const file of doors) {
      const src = door(file);
      const applies = [...src.matchAll(/applyConnections\(/g)].length;
      const asserts = [...src.matchAll(/assertConnections\(/g)].length;
      const plans = /\bconnectionsOf\(/.test(src);
      if (asserts < applies) offenders.push(`${file} (${applies} apply, ${asserts} assert)`);
      // A door that plans the connections itself (the batch) has no `assertConnections` to call — its refusal is the
      // per-item `edgeRefusal`, asked before the record is planned (the next case holds the order).
      if (plans && !/\bedgeRefusal\(/.test(src)) offenders.push(`${file} (plans connections, never asks edgeRefusal)`);
      // A door that neither applies nor plans must hand the body to a door that does: declaring the field and
      // dropping it is the silent ignore this module exists to prevent.
      if (applies === 0 && !plans && !/(?<![.\w])bulkWrite\(/.test(src)) {
        offenders.push(`${file} (accepts edges, applies none and delegates to no door)`);
      }
    }
    assert.deepEqual(offenders, [],
      'these accept a body\'s connections without refusing them first, so an inline edge naming nothing (or '
      + 'breaking the schema) is an error with the record already written: ' + offenders.join(', '));
  });

  it('the batch door refuses an item\'s inline edges BEFORE the item is planned, inside the item\'s own try', () => {
    /*
     * Design 7. Bulk reports per item, and an item whose inline edge is refused must be rejected WITH the item and
     * leave nothing in the batch: not a planned record, not a declared `$ref` key another item could then resolve
     * to a record that is never written. So the refusal sits inside the `try` whose catch is the item's rejection,
     * ahead of `p.plan(` (which decides the record) and of the declaration of its key.
     */
    const bulk = door('server/src/brain/bulk.ts');
    const at = bulk.indexOf('async function planRecord(');
    assert.notEqual(at, -1, 'planRecord is gone from brain/bulk.ts — re-point this gate to where an item is planned');
    const block = blockAfter(bulk, at, 'planRecord');
    const planAt = block.indexOf('p.plan(');
    assert.notEqual(planAt, -1, 'planRecord no longer calls p.plan( — re-point this gate');
    const refuseAt = block.search(/\bedgeRefusal\(/);
    assert.notEqual(refuseAt, -1,
      'planRecord never asks edgeRefusal, so an item whose inline edge breaks the schema is planned and committed, '
      + 'and the refusal comes after the record is stored');
    assert.ok(refuseAt < planAt, 'planRecord asks edgeRefusal AFTER p.plan( — the item is already planned');
    const tryAt = block.lastIndexOf('try {', planAt);
    assert.ok(tryAt !== -1 && tryAt < refuseAt,
      'the refusal is outside the item\'s try, so a refused edge throws out of the batch instead of rejecting the item');
    const declareAt = block.lastIndexOf('refs.declare(');
    assert.ok(declareAt === -1 || refuseAt < declareAt,
      'planRecord declares the item\'s `$ref` key BEFORE the refusal, so a refused item leaves a key that resolves to nothing');
  });

  it('a top-level bulk edge is refused by the same function, not by a copy of the existence rule', () => {
    const bulk = door('server/src/brain/bulk.ts');
    const at = bulk.indexOf('async function planTopLevelEdge(');
    assert.notEqual(at, -1, 'planTopLevelEdge is gone from brain/bulk.ts — re-point this gate');
    assert.match(blockAfter(bulk, at, 'planTopLevelEdge'), /\bedgeRefusal\(/,
      'planTopLevelEdge decides existence and the schema without edgeRefusal — a second implementation of the rule '
      + 'the single-record doors and the planner ask, which is the one that drifts');
  });

  it('the shared pre-write check asks the shape AND every inline edge\'s refusal', () => {
    /*
     * `assertConnections` is what a single-record door asks before its record is written. It used to refuse link ids
     * only, so an inline edge broke the schema AFTER the record was stored, and MCP create/update (which never ran
     * `connectionInputError`) accepted shapes REST refused. One call, both halves: the shape, then each edge's
     * `edgeRefusal`.
     */
    const body = bodyOf(door('server/src/brain/write-connections.ts'), 'assertConnections');
    assert.match(body, /\bconnectionInputError\(/,
      'assertConnections does not refuse the SHAPE of the connections, so the doors that never ran it accept what REST refuses');
    assert.match(body, /\bedgeRefusal\(/,
      'assertConnections does not ask edgeRefusal, so a door that asks it first still stores the record and then fails the edge');
  });

  it('and the shared assertion keeps EXISTENCE behind strictLinkage, while the class check is absolute', () => {
    /*
     * `strictLinkage: false` is a deliberate per-space choice to accept dangling references — a staged
     * import whose targets resolve in a later pass — so moving the check must not quietly withdraw it.
     * The CLASS check is not that: a fact cannot link to a chrono entry whatever the space says, because
     * there is no such class and the id would be derived from a label nothing reads.
     */
    // ONE implementation of the order, `refuseDesiredLinks`; the store's check (`assertDesiredLinks`) and the
    // read set's (`refuseLinks`) differ only in where "which ids are missing" is answered.
    const links = stripComments(readFileSync('server/src/brain/links.ts', 'utf8'));
    const body = bodyOf(links, 'refuseDesiredLinks');
    const strictAt = body.indexOf('isStrictLinkage(');
    const classAt = body.indexOf('linkClassRefusal(');
    assert.notEqual(strictAt, -1, 'refuseDesiredLinks: the reference check must stay opt-out-able');
    assert.notEqual(classAt, -1, 'refuseDesiredLinks: the class check is missing, so a seventh class could be written');
    assert.ok(classAt < strictAt,
      'refuseDesiredLinks: the class check sits behind the linkage setting, so a lax space can store a link class '
      + 'that does not exist — which no reader will ever follow');
    for (const [file, fn] of [['server/src/brain/links.ts', 'assertDesiredLinks'], ['server/src/brain/write-plan/plan-links.ts', 'refuseLinks']]) {
      assert.match(bodyOf(stripComments(readFileSync(file, 'utf8')), fn), /\brefuseDesiredLinks\(/,
        `${fn} no longer goes through refuseDesiredLinks, so it is a second copy of the order and can drift from it`);
    }
  });
});
