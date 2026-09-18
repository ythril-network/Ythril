/**
 * A chrono entry's `status` means two things, and which one you get is now a PARAMETER, not a door.
 *
 * ## The report this answers
 *
 * A chrono entry's status can be DERIVED at read time: an entry whose due moment has passed comes back
 * as `overdue` rather than as the `active` the collection holds, unless its type sets `whenDuePasses`.
 * The per-collection chrono list route derives; `filter` and sync return the stored value.
 *
 * **Both behaviours are correct and both are wanted** — a predicate read must see what is stored, or it
 * cannot be used to repair anything. The cost was that the two were indistinguishable from outside. The
 * canary operator, 2026-09-15, after a fortnight-old episode read `active` through one door and
 * `overdue` through the other: *"'I checked the status' is not a claim anyone can evaluate without the
 * door being named"*. Every attempt they made to confirm the suspicion queried the collection, got
 * `active`, and read as a clean bill of health.
 *
 * ## Why a parameter rather than the documentation `B-8` originally scoped
 *
 * Documenting the difference does not help a caller who needs the OTHER answer. And it became blocking
 * rather than merely untidy: `B-9` moves the Chrono tab onto `filter` and then deletes the list route,
 * so without this the tab silently stops showing `overdue`.
 *
 * ## THE DEFAULT IS WHAT MAKES IT SAFE, and it is the half worth guarding
 *
 * `deriveStatus` defaults FALSE, so every existing `filter` caller sees exactly what it saw before, and
 * the client asks for `true`, so the tab is unchanged too. Nothing moves for anybody who does not ask.
 * A default of `true` would have been a behaviour change dressed as a feature.
 *
 * Run: node --test testing/standalone/a-chrono-status-means-one-thing-you-can-ask-for.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';
import { FILTER_DOORS } from '../_shared/search-doors.mjs';

const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
const { QUERY_BODY_FIELDS } = await import('../../server/dist/brain/query.js');
const { decoratePage } = await import('../../server/dist/brain/list-decorations.js');

const src = (p) => stripComments(readFileSync(p, 'utf8'));
const DOORS = FILTER_DOORS;

function filterSchema() {
  const tool = ALL_TOOLS.find(t => t.name === 'filter');
  assert.ok(tool, 'the `filter` tool is gone or renamed — re-anchor this gate');
  return tool.inputSchema({ requiredSpace: {}, optionalSpace: {} });
}

/** A chrono row whose due moment is long past, so a derivation has something to change. */
const overdueRow = () => ({
  _id: 'c1',
  spaceId: 'nonexistent-space-for-this-test',
  type: 'deadline',
  title: 'shipped late',
  status: 'active',
  startsAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
});

describe('both doors accept the parameter, with the same default', () => {
  it('the REST body allowlist admits it', () => {
    // Absent, it is a 400 for a parameter the tool takes. Present WITHOUT the derivation wired is the
    // worse half — a 200 with the flag doing nothing, which is the silent no-op this replaces.
    assert.ok(QUERY_BODY_FIELDS.has('deriveStatus'), 'the REST door 400s on a flag its twin accepts');
  });

  it('the tool declares it and defaults it FALSE', () => {
    const prop = filterSchema().properties?.deriveStatus;
    assert.ok(prop, 'the tool refuses a flag the route accepts — `additionalProperties` is false here');
    assert.equal(prop.default, false,
      'defaulting true would change what every existing `filter` caller sees, which this must not do');
    assert.match(prop.description ?? '', /chrono/i,
      'the schema is what a caller reads while constructing arguments — say which collection it is for');
  });

  it('and both doors actually pass it to the decorator', () => {
    for (const door of DOORS) {
      assert.match(src(door), /deriveStatus:\s*(?:a|body)\['deriveStatus'\] === true/,
        `${door} accepts the flag and does not act on it, which is a silent no-op`);
    }
  });

  it('both REFUSE it on a collection it cannot mean', () => {
    // A silently dropped flag is a caller who believes they asked. Same rule as `entityName` on
    // entities, and asserted on both doors because one refusing while the other ignores is worse.
    for (const door of DOORS) {
      assert.match(src(door), /deriveStatus'\] !== undefined && coll(?:ection)? !== 'chrono'/,
        `${door} ignores \`deriveStatus\` on a non-chrono collection instead of refusing it`);
    }
  });
});

describe('the derivation itself is not a second implementation', () => {
  it('nobody derives a chrono status outside the module that owns the rule', () => {
    /*
     * `whenDuePasses` makes "what a passed due moment means" a per-TYPE decision, so a second copy of
     * the derivation is a second answer to it. Derived over the tree, including untracked files, so the
     * copy a change is introducing is visible on the commit that introduces it.
     */
    const owners = ['server/src/brain/chrono-status.ts', 'server/src/brain/chrono.ts'];
    const offenders = trackedSources(['server/src'], { untracked: true, exclude: owners })
      .filter(f => src(f).includes('deriveChronoStatus('));
    // `recall.ts` presents chrono results and is the one other legitimate caller — it derives for the
    // same reason the list route does, through the same function. Anything else is a copy.
    const unexpected = offenders.filter(f => f !== 'server/src/brain/recall.ts');
    assert.deepEqual(unexpected, [],
      `these derive a chrono status themselves rather than through the owning module: ${unexpected.join(', ')}`);
  });

  it('`filter` reaches the SAME derivation, not its own', () => {
    assert.match(src('server/src/brain/list-decorations.ts'), /withDerivedStatusForPage/,
      'the decorator must use chrono.ts\'s own page derivation, or `whenDuePasses` gets a second answer');
  });
});

describe('what the flag does to a page', () => {
  it('OFF leaves the stored status exactly as it is, and the rows identical', async () => {
    const rows = [overdueRow()];
    const out = await decoratePage('chrono', 'space', rows, async () => []);
    assert.equal(out, rows, 'the untouched path must not rebuild the page');
    assert.equal(out[0].status, 'active', 'the stored value is what this door has always returned');
  });

  /*
   * THE 'ON' CASE LIVES IN THE INTEGRATION SUITE, not here, and the reason is the point rather than an
   * inconvenience: the derivation reads the space's meta to resolve `whenDuePasses` per TYPE, which
   * needs a loaded config. Stubbing that would be asserting against a stub of the one thing the rule
   * depends on. `a-convenience-narrows-on-both-doors.test.js` drives it against a real instance, on
   * both doors, with a real overdue entry.
   */

  it('and an empty page is returned untouched either way', async () => {
    const rows = [];
    assert.equal(await decoratePage('chrono', 'space', rows, async () => [], { deriveStatus: true }), rows);
  });
});

/**
 * B-19 — `deriveStatus` reaches the PREDICATE, not just the rows.
 *
 * `B-8` made the displayed status askable. This is the half that changes WHICH RECORDS COME BACK: the
 * chrono list route puts the clock in its status query, so `status: "active"` excludes what is now
 * derived-overdue, while `filter` matched the stored value. Same question, two answers — found starting
 * `B-9` step 2b, and it is what blocked moving the Chrono tab.
 */
describe('the derived status reaches the predicate too', () => {
  let derivedStatusPredicate, chronoStatusPredicate;
  const NOW = new Date('2026-09-18T00:00:00Z');

  before(async () => {
    ({ derivedStatusPredicate } = await import('../../server/dist/brain/list-decorations.js'));
    ({ chronoStatusPredicate } = await import('../../server/dist/brain/chrono.js'));
  });

  it('`active` gains the clock comparison, so a passed entry is excluded', () => {
    const r = derivedStatusPredicate({ status: 'active' }, NOW, []);
    assert.ok(!('error' in r), r.error);
    assert.match(JSON.stringify(r.predicate), /\$expr/,
      'without the clock this matches every stored-active entry, including ones a fortnight overdue');
  });

  it('`overdue` matches the DERIVED ones as well as the stored ones', () => {
    // `overdue` is legal on every write door, so a caller can store it — matching only the derivable
    // ones would hide exactly the entries somebody took the trouble to mark.
    const r = derivedStatusPredicate({ status: 'overdue' }, NOW, []);
    const json = JSON.stringify(r.predicate);
    assert.match(json, /"overdue"/, 'the stored value must still match');
    assert.match(json, /upcoming/, 'and so must the ones that derive to it');
  });

  it('it is the SAME clause the list route builds, not a second one', () => {
    // The whole point of `B-19`: one builder, both doors. A copy here would be a second answer to what
    // a passed due moment means, which `whenDuePasses` makes a per-type decision.
    const viaFilter = derivedStatusPredicate({ status: 'active' }, NOW, []).predicate;
    const viaRoute = chronoStatusPredicate('active', NOW, []).clause;
    assert.deepEqual(viaFilter, viaRoute);
  });

  it('a type whose passed date means NOTHING keeps its stored status', () => {
    // `whenDuePasses: "nothing"`. Applying the clock to an exempt type would make `overdue` mean one
    // thing in a filter and another in the answer.
    const r = derivedStatusPredicate({ status: 'active' }, NOW, ['episode']);
    assert.match(JSON.stringify(r.predicate), /episode/,
      'the exempt type must be admitted without the clock comparison');
  });

  it('a caller predicate beside it is KEPT, not replaced', () => {
    const r = derivedStatusPredicate({ status: 'active', type: 'deadline' }, NOW, []);
    const json = JSON.stringify(r.predicate);
    assert.match(json, /deadline/, "the caller's own clause was dropped");
    assert.match(json, /\$expr/, 'and the derived clause must still be there');
  });

  it('and a caller clause that COLLIDES with the derived one keeps both', () => {
    /*
     * The case a spread passes and an AND does not. The derived clause for `active` carries its own
     * `$expr`, and so may the caller — spreading one onto the other drops whichever is written first,
     * silently and in the widening direction. Asserted with a colliding key because the non-colliding
     * case looks identical either way, which is how a spread would survive review.
     */
    const callerExpr = { $eq: ['$type', 'deadline'] };
    const r = derivedStatusPredicate({ status: 'active', $expr: callerExpr }, NOW, []);
    const json = JSON.stringify(r.predicate);
    assert.match(json, /deadline/, "the caller's own $expr was dropped by the derived one");
    assert.match(json, /\$gte/, 'and the derived comparison must still be there');
  });

  it('a nested `status` is REFUSED rather than half-rewritten', () => {
    /*
     * The replacement clause is itself a disjunction in two of the three cases, so folding it into a
     * caller's `$or` changes what theirs means. A refusal costs one edit; a silent half-rewrite costs
     * the answer.
     */
    const r = derivedStatusPredicate({ $or: [{ status: 'active' }, { type: 'x' }] }, NOW, []);
    assert.ok('error' in r, 'a nested status was rewritten instead of refused');
    assert.match(r.error, /\$or/, 'and the refusal must say where the problem is');
  });

  it('and a predicate with no `status` is returned untouched', () => {
    const base = { type: 'deadline' };
    assert.equal(derivedStatusPredicate(base, NOW, []).predicate, base);
  });
});
