/**
 * `If-Match` preconditions on space-meta writes.
 *
 * `space.meta.version` was incremented on every write and every previous version kept in
 * `previousVersions` — but nothing ever compared it. Two admins editing one space was last-write-wins
 * on the whole meta object: the second save silently discarded the first, and the only trace was a
 * history entry nobody reads. The counter RECORDED collisions; it never prevented one.
 *
 * These tests pin the decision function and, structurally, that both meta-writing routes consult it
 * before doing anything. The second half matters as much as the first: a precondition evaluated after
 * a side effect is not a precondition. `PUT /:id/schema` writes a timestamped backup file, so a check
 * placed below it would reject the write and still litter the space with a backup of a change that
 * never happened.
 *
 * Run: node --test testing/standalone/meta-precondition.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let checkMetaPrecondition, preconditionErrorBody;

before(async () => {
  ({ checkMetaPrecondition, preconditionErrorBody } =
    await import('../../server/dist/spaces/meta-precondition.js'));
});

describe('If-Match — absent means no precondition', () => {
  it('allows a write when no header was sent', () => {
    // Opt-in by absence. Making the header mandatory would break every existing client and script to
    // protect against a race most never hit; a client that wants the guarantee asks for it.
    assert.deepEqual(checkMetaPrecondition(undefined, 7), { ok: true });
  });

  it('allows a write for `*` on any version', () => {
    // RFC 9110: `*` matches any current representation. It asserts the space EXISTS, which the route
    // has already established by this point.
    assert.deepEqual(checkMetaPrecondition('*', 0), { ok: true });
    assert.deepEqual(checkMetaPrecondition('*', 99), { ok: true });
  });
});

describe('If-Match — version comparison', () => {
  it('allows the write when the version matches', () => {
    assert.deepEqual(checkMetaPrecondition('4', 4), { ok: true });
  });

  it('accepts all three spellings of the same version', () => {
    // set-claim: the ETag spellings HTTP allows, an external grammar. Same list as `brain-if-match`, and
    // deliberately so: both doors parse the same header.
    // Bare, quoted entity-tag, and weak. A client library that quotes automatically must not have
    // every write rejected, and one that does not quote must not either.
    for (const spelling of ['4', '"4"', 'W/"4"', ' 4 ']) {
      assert.deepEqual(checkMetaPrecondition(spelling, 4), { ok: true }, `spelling: ${spelling}`);
    }
  });

  it('REJECTS with 412 when the space moved on', () => {
    // The whole point: this is the edit that used to be silently discarded.
    const v = checkMetaPrecondition('3', 5);
    assert.equal(v.ok, false);
    assert.equal(v.status, 412, 'a failed If-Match is 412 Precondition Failed, not 409');
    assert.equal(v.reason, 'mismatch');
    assert.deepEqual([v.expected, v.actual], [3, 5]);
  });

  it('rejects a STALE-in-either-direction version, not just an older one', () => {
    // A client that somehow reports a future version is equally out of sync; matching is equality,
    // not "at least".
    assert.equal(checkMetaPrecondition('9', 5).ok, false);
    assert.equal(checkMetaPrecondition('1', 5).ok, false);
  });

  it('treats a space that has never had meta as version 0', () => {
    // `If-Match: 0` is how a caller says "only if nobody has configured this yet".
    assert.deepEqual(checkMetaPrecondition('0', 0), { ok: true });
    assert.equal(checkMetaPrecondition('0', 1).ok, false);
  });
});

describe('If-Match — malformed values are refused, never ignored', () => {
  it('rejects a non-numeric value with 400', () => {
    // Ignoring an unparseable precondition would hand back exactly the false safety the header was
    // asked for — the client believes it is protected and is not.
    for (const bad of ['abc', '"abc"', '', '   ', '4.5', '-1', 'null', 'undefined']) {
      const v = checkMetaPrecondition(bad, 4);
      assert.equal(v.ok, false, `should reject: ${JSON.stringify(bad)}`);
      assert.equal(v.status, 400, `should be 400: ${JSON.stringify(bad)}`);
    }
  });

  it('does not accept a numeric PREFIX as the version', () => {
    // The `parseInt` trap: it reads "4-and-a-half" as 4 and lets a nonsense precondition pass.
    const v = checkMetaPrecondition('4-and-a-half', 4);
    assert.equal(v.ok, false);
    assert.equal(v.status, 400);
  });
});

describe('If-Match — the error tells the caller what to do', () => {
  it('names both versions and the recovery step on a mismatch', () => {
    const body = preconditionErrorBody(checkMetaPrecondition('3', 5));
    assert.match(body.error, /re-read/i, 'should say how to recover, not just that it failed');
    assert.equal(body.expectedVersion, 3);
    assert.equal(body.currentVersion, 5);
  });

  it('shows the offending value on a malformed header', () => {
    const body = preconditionErrorBody(checkMetaPrecondition('bogus', 5));
    assert.match(body.error, /bogus/);
  });
});

describe('If-Match — both meta-writing routes check it, and check it FIRST', () => {
  const src = readFileSync(new URL('../../server/src/api/spaces.ts', import.meta.url), 'utf8');

  /**
   * Imported functions that consult the precondition THEMSELVES — a guard may be delegated, not only inline.
   *
   * `PATCH /:id` hands its whole decision to `planSpaceMetaUpdate`, which owns the refusal chain so an MCP tool
   * reaches the same rules instead of a weaker copy (B-2). Each candidate's module is read and required to call
   * `checkMetaPrecondition` itself, so "the handler calls a function" is not an escape hatch: the function has to
   * do the checking. A delegate that stopped checking drops out of this set and every write it guards fails below.
   */
  const DELEGATES = (() => {
    const names = [];
    const re = /import\s+\{([^}]+)\}\s+from\s+'(\.\.?\/[^']+)\.js'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      let text;
      try { text = readFileSync(new URL(`../../server/src/api/${m[2]}.ts`, import.meta.url), 'utf8'); } catch { continue; }
      if (!/checkMetaPrecondition\(/.test(text)) continue;
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/).pop().trim();
        if (name) names.push(name);
      }
    }
    return names;
  })();

  /** Every place a handler consults the precondition, inline or through a verified delegate. */
  const guardPattern = new RegExp(
    ['checkMetaPrecondition\\(', ...DELEGATES.map(n => `\\b${n}\\s*\\(`)].join('|'), 'g');

  it('the delegate that owns the chain was found — or every check below is vacuous', () => {
    assert.ok(DELEGATES.includes('planSpaceMetaUpdate'),
      `no imported module checks the precondition; found ${JSON.stringify(DELEGATES)}. If the planner was `
      + 're-pointed or stopped checking, fix that rather than this list.');
  });

  it('PATCH /:id consults the precondition, and hands it the header', () => {
    // Two halves, and the second is the one a delegation can quietly lose: the planner treats an absent header as
    // "no precondition asked for", so a route that stopped passing `If-Match` would keep answering 200 and the
    // guarantee would be gone with no call site missing.
    const patchStart = src.indexOf("spacesRouter.patch('/:id',");
    const patchBody = src.slice(patchStart, src.indexOf('spacesRouter.', patchStart + 20));
    assert.match(patchBody, guardPattern, 'PATCH /:id neither checks the precondition nor delegates to something that does');
    assert.match(patchBody, /ifMatch:\s*req\.get\('If-Match'\)|checkMetaPrecondition\(req\.get\('If-Match'\)/,
      'PATCH /:id must pass the If-Match header on; an absent header means NO precondition');
  });

  it('EVERY route that writes meta consults it — derived, not counted', () => {
    // This is the check that was missing when the feature first shipped, and the gap it would have
    // caught is the one that actually happened: `If-Match` went onto PATCH /:id and PUT /:id/schema,
    // and the single-type upsert and delete routes — which write meta just as much — were left
    // unguarded. A caller could hold a precondition on one route and lose an edit through another.
    //
    // Asserting a COUNT would rot the moment a fifth route appeared. So derive the set: every
    // `updateSpace(..., { meta })` call is a meta write, and each must sit in a handler that checked
    // the precondition first.
    const planner = readFileSync(new URL('../../server/src/spaces/meta-update.ts', import.meta.url), 'utf8');
    // A meta write is `updateSpace(…, { meta })` or, since F-39.2, `commitOwnMetaEdit(` — the edit that survives
    // the network layers. Both must sit behind the precondition.
    const writeSites = [...src.matchAll(/updateSpace\([^)]*\{\s*[^}]*\bmeta\b|commitOwnMetaEdit\(id,/g)].map(m => m.index);
    const plannerWrites = [...planner.matchAll(/updateSpace\([^)]*\{[\s\S]{0,120}?\bmeta\b/g)].map(m => m.index);

    // The floor spans BOTH files, because one of the four writes moved. `PATCH /:id` no longer writes meta itself —
    // `applySpaceMetaUpdate` does — so counting only the router would have quietly dropped a site from the sweep,
    // and the sweep would have reported the tree clean because it was looking at three of four places.
    assert.ok(writeSites.length + plannerWrites.length >= 4,
      `expected at least 4 meta-write sites across the router and the planner, found `
      + `${writeSites.length} + ${plannerWrites.length} — has the shape changed?`);
    assert.ok(plannerWrites.length >= 1, 'the planner module must hold the write that left the router');

    // Inline calls AND verified delegates: a handler that hands the decision to something which checks is guarded.
    const checkSites = [...src.matchAll(new RegExp(guardPattern.source, 'g'))].map(m => m.index);

    for (const write of writeSites) {
      // The handler containing this write starts at the nearest preceding `spacesRouter.<verb>(`.
      const handlerStart = Math.max(
        ...[...src.matchAll(/spacesRouter\.(get|post|put|patch|delete)\(/g)]
          .map(m => m.index)
          .filter(i => i < write),
      );
      const guarded = checkSites.some(c => c > handlerStart && c < write);
      assert.ok(guarded,
        `a meta write at index ${write} is in a handler that never calls checkMetaPrecondition — ` +
        `that route can silently discard a concurrent edit. Handler starts at ${handlerStart}: ` +
        JSON.stringify(src.slice(handlerStart, handlerStart + 90)));
    }
  });

  it("the planner's own meta write cannot be reached without the precondition — by TYPE, not by position", () => {
    // The write that left the router is in `applySpaceMetaUpdate`, a different function from the one that checks.
    // Asserting "the check appears earlier in the file" would be true and would prove nothing: two functions in one
    // file have no order at runtime.
    //
    // What actually guarantees it is the signature. `applySpaceMetaUpdate` takes a `MetaUpdatePlan`, and a plan is
    // only ever constructed by `planSpaceMetaUpdate` — after the precondition, in the same expression that returns
    // `ok: true`. So a caller cannot obtain the argument without having passed the check. That is what is asserted
    // here, and it is the reason the extraction did not weaken the guarantee.
    const planner = readFileSync(new URL('../../server/src/spaces/meta-update.ts', import.meta.url), 'utf8');

    assert.match(planner, /export async function applySpaceMetaUpdate\(plan: MetaUpdatePlan\)/,
      'apply must take a MetaUpdatePlan and nothing looser — an `unknown` or a spread of fields would let a caller '
      + 'assemble one without going through the planner');

    // Exactly one place builds the plan, and the precondition precedes it *within that function*.
    const planFn = planner.slice(planner.indexOf('export function planSpaceMetaUpdate'));
    const checkAt = planFn.indexOf('checkMetaPrecondition(');
    const buildAt = planFn.indexOf('ok: true');
    assert.ok(checkAt > 0 && buildAt > checkAt,
      'planSpaceMetaUpdate must evaluate the precondition before it returns a plan');
    assert.equal((planner.match(/ok: true,\s*\n\s*plan: \{/g) ?? []).length, 1,
      'a second place constructing a plan is a second way to reach the write without a precondition');
  });

  it('the schema route checks BEFORE writing its backup file', () => {
    // A precondition evaluated after a side effect is not a precondition. This route writes a
    // timestamped schema backup into the space; checking below it would reject the write and still
    // leave a backup of a change that never happened.
    const checkAt = src.indexOf("checkMetaPrecondition(req.get('If-Match'), space.meta?.version ?? 0)",
      src.indexOf("spacesRouter.put('/:id/schema'"));
    const backupAt = src.indexOf('backup of the previous schema', src.indexOf("spacesRouter.put('/:id/schema'"));
    assert.ok(checkAt > 0, 'the schema route should check the precondition');
    assert.ok(backupAt > 0, 'expected the schema-backup step to still exist');
    assert.ok(checkAt < backupAt, 'the precondition must be evaluated before the backup is written');
  });

  it('PATCH checks before taking the audit snapshot', () => {
    // The audit middleware records on any <400 response. A precondition checked after the snapshot would still be
    // correct, but this keeps the ordering explicit: rejected writes record nothing.
    //
    // Both halves are asserted where each now lives. In the ROUTE: the plan is obtained and the refusal returned
    // before `req.auditSnapshots` is set, so a refused request cannot have left a snapshot behind. In the PLANNER:
    // the precondition is evaluated before the snapshot is built at all. Splitting the assertion this way is the
    // point — a delegation that reordered either half would fail here rather than in whichever suite noticed the
    // audit log had grown an entry for a write that never happened.
    const patchAt = src.indexOf("spacesRouter.patch('/:id',");
    const planAt = src.indexOf('planSpaceMetaUpdate(', patchAt);
    const refusalAt = src.indexOf('decision.refusal.status', patchAt);
    const snapshotAt = src.indexOf('req.auditSnapshots', patchAt);
    assert.ok(planAt > 0 && refusalAt > 0 && snapshotAt > 0, 'the PATCH handler no longer has the shape this reads');
    assert.ok(planAt < refusalAt && refusalAt < snapshotAt,
      'the refusal must be returned before the audit snapshot is set, or a rejected write records a change');

    const planner = readFileSync(new URL('../../server/src/spaces/meta-update.ts', import.meta.url), 'utf8');
    const checkAt = planner.indexOf('checkMetaPrecondition(');
    const auditAt = planner.indexOf('const audit = {');
    assert.ok(checkAt > 0 && auditAt > 0, 'the planner no longer has the shape this reads');
    assert.ok(checkAt < auditAt, 'the precondition must be evaluated before the audit snapshot is built');
  });
});
