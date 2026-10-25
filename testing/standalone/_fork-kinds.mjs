/**
 * The kinds that fork, as a test reads them: the set from the planner, one fixture per member, and the one id a fork
 * of a body must have (Q-624, design rev 4 sections 1, 3 and 16).
 *
 * ## What it prevents
 *
 * A fork test written over "facts" is the defect Q-624 removes, and a test written over a hand list of four kinds is the same
 * defect with a later expiry date: the day a fifth kind forks, the test says nothing about it. So the SET is read from the
 * planner (`FORKING_FAMILIES`, `sync/upsert-plan.ts`), floored, and every member must have a fixture here: a family the planner
 * gains and this file lacks FAILS, loudly, instead of being skipped.
 *
 * What is chosen here, not derived, and why that is allowed: a fixture is literal (`CLAUDE.md`, "A test fixture is allowed to be
 * literal"). Which field a case edits to make two copies say different things is the one per-kind value no module states
 * for the tests; the design's `mainField` (section 9) is the same value and is the presentation field Review shows.
 *
 * ## The fork id is computed by the module that owns it
 *
 * `forkIdFor` (the id from a subject, a seq and a text) and `authoredContentHash` (the text from a body) are the server's. A
 * test that spelled its own id would assert the code equals itself; one that asks them for the id the design says
 * (`forkIdFor(forkOf, seq, authoredContentHash(family, body).text)`, section 3) asserts the rule. Both are imported from
 * `server/dist` when asked, so a file that never asks them still loads on a build that lacks them.
 *
 * One owner: this file is owned by the Q-624 test slice t2 (`test/q624-t2`). Other slices that need the same set or the same
 * id take it from here once merged, and write no second copy.
 */
import assert from 'node:assert/strict';
import { build } from './_push-door.mjs';

/** One fixture per family: the builder, the body field two copies are made to differ in, the single route, the record type. */
export const FORK_FIXTURE = Object.freeze({
  facts:    { build: build.fact,   field: 'fact',        single: '/facts',    type: 'fact',   word: 'fact' },
  entities: { build: build.entity, field: 'name',        single: '/entities', type: 'entity', word: 'entity' },
  edges:    { build: build.edge,   field: 'description', single: '/edges',    type: 'edge',   word: 'edge' },
  chrono:   { build: build.chrono, field: 'title',       single: '/chrono',   type: 'chrono', word: 'chrono entry' },
});

/** The families that fork, read from the planner, floored, each with a fixture. Throws when the planner states none. */
export async function forkingFamilies() {
  const plan = await import('../../server/dist/sync/upsert-plan.js');
  assert.ok(Array.isArray(plan.FORKING_FAMILIES),
    'sync/upsert-plan.ts exports no FORKING_FAMILIES: the set of kinds that fork is not stated anywhere a test can read it (design section 1)');
  assert.ok(plan.FORKING_FAMILIES.length >= 4,
    `only ${plan.FORKING_FAMILIES.length} forking famil(ies) stated: ${plan.FORKING_FAMILIES} (design section 1 names four)`);
  const missing = plan.FORKING_FAMILIES.filter(f => !(f in FORK_FIXTURE));
  assert.deepEqual(missing, [], `forking families with no fixture in _fork-kinds.mjs: ${missing} — add one, or the kind is not tested`);
  return [...plan.FORKING_FAMILIES];
}

/** The body text of `doc` as the fork id derives from it: `authoredContentHash(family, doc).text`. */
export async function bodyTextOf(family, doc) {
  const mod = await import('../../server/dist/sync/authored-content.js');
  assert.equal(typeof mod.authoredContentHash, 'function', 'sync/authored-content.js exports no authoredContentHash (design section 2)');
  const hashed = await mod.authoredContentHash(family, doc);
  assert.equal(typeof hashed?.text, 'string', 'authoredContentHash(family, doc) must return { text, hash, normalised } (design section 2)');
  return hashed.text;
}

/** The id a fork of `subjectId`, at `seq`, carrying `doc`'s body must have: section 3's equation. */
export async function forkIdOf(family, subjectId, seq, doc) {
  const { forkIdFor } = await import('../../server/dist/sync/upsert-plan.js');
  return forkIdFor(subjectId, seq, await bodyTextOf(family, doc));
}

/** A document of `family` in `space` whose `field` says `text`, authored by `author` when given. */
export function copyOf(family, space, id, seq, text, extra = {}) {
  const fx = FORK_FIXTURE[family];
  return fx.build(space, id, seq, { [fx.field]: text, ...extra });
}

/**
 * The three doors an arrival comes through that take a page of copies, each with one way to deliver `docsBySpace` (local space id
 * -> the documents of `family` it is handed): the single route, `POST /batch-upsert`, and the pull (the real engine against the
 * door's fake peer, which serves every space of the map in one cycle). The one place that spells them, because a door a test
 * leaves out is the door the rule silently stopped covering (`a-fork-keeps-its-copys-created-at-db` wrote them by hand).
 *
 * @param door  an `openPullDoor` door
 * @param token the pushing token, proving the peer the pull reads from
 */
export function arrivalDoors(door, token) {
  const at = (space) => ({ spaceId: space, networkId: door.NET, token });
  return {
    single: async (family, docsBySpace) => {
      for (const [space, docs] of Object.entries(docsBySpace)) {
        for (const doc of docs) await door.push(FORK_FIXTURE[family].single, doc, at(space));
      }
    },
    batch: async (family, docsBySpace) => {
      for (const [space, docs] of Object.entries(docsBySpace)) await door.push('/batch-upsert', { [family]: docs }, at(space));
    },
    pull: async (family, docsBySpace) => {
      for (const [space, docs] of Object.entries(docsBySpace)) door.state.records[space] = { [family]: docs };
      await door.sync();
    },
  };
}
