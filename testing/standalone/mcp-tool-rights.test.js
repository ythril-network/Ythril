/**
 * MCP enforces the rights matrix, using the ROUTE's own requirement rather than a second opinion about it.
 *
 * ## The defect
 *
 * Until 3.0 the MCP dispatcher gated on two BOOLEANS — `readOnly`, and the tool's `admin` flag — while REST
 * enforced a per-space, per-area RUNG through `effectiveRung`/`satisfies`. One policy, two implementations,
 * and the weaker one was reachable.
 *
 * That is not a reading of the code. It was measured against a running instance: a token whose matrix said
 * `perSpace.general.knowledge = 'write'` was refused `DELETE /api/brain/spaces/general/facts/:id` with a
 * **403**, and the identical delete through the `delete_fact` tool answered **"Memory deleted"**.
 *
 * ## Why the table is derived and not written
 *
 * A second hand-written copy of one rule is the defect this repo produces most — a proxy lens computed and
 * discarded on three routes, an empty allowlist read as unrestricted on three more. So `TOOL_RIGHTS` is
 * DERIVED from `ROUTE_RIGHTS` via the capability map, and this file re-derives it independently and fails if
 * the two disagree. A rung changed on a route moves its tool in the same commit, or this goes red.
 *
 * Run: node --test testing/standalone/mcp-tool-rights.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { blockAfter } from './_structural-window.mjs';
import { readFileSync } from 'node:fs';
import { CAPABILITIES } from './_capability-map.mjs';

let TOOL_RIGHTS, ROUTE_RIGHTS, ALL_TOOLS, effectiveRung, satisfies, toolRightsRefusal;

/**
 * The capability map: one MCP tool and the REST route that does the same thing.
 *
 * IMPORTED. This used to read `scripts/surface-matrix.mjs` as text, slice out `const MAP = [...]` and
 * `eval` it — which worked until the map moved into a module and left this gate asserting nothing it could
 * find. Reading another file's source to recover a value it could have exported is a copy with extra steps,
 * and the copy broke the moment the original improved.
 */
const capabilityMap = () => CAPABILITIES;

before(async () => {
  ({ TOOL_RIGHTS, ROUTE_RIGHTS } = await import('../../server/dist/auth/space-rights.js'));
  ({ ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js'));
  ({ effectiveRung } = await import('../../server/dist/auth/mint-cap.js'));
  ({ satisfies } = await import('../../server/dist/auth/required-rung.js'));
  ({ toolRightsRefusal } = await import('../../server/dist/mcp/tool-rights-guard.js'));
});

describe('TOOL_RIGHTS agrees with ROUTE_RIGHTS, row for row', () => {
  it('every area-scoped tool needs exactly what its route needs', () => {
    const byRoute = new Map(ROUTE_RIGHTS.map(r => [`${r.method} ${r.route}`, r]));
    const byTool = new Map(TOOL_RIGHTS.map(r => [r.tool, r]));
    const disagreements = [];

    for (const [, tool, route] of capabilityMap()) {
      if (!route) continue;                       // instance-level: no space, no area
      const expected = byRoute.get(route);
      if (!expected) continue;                    // not area-scoped (spaces/tokens/networks CRUD)
      const actual = byTool.get(tool);
      if (!actual) {
        /*
         * A tool with no row is governed by its `admin` flag, and for a CROSS-AREA tool that is the only
         * way it can be governed: `TOOL_RIGHTS` is one row per tool, so `delete_space_data` — which empties
         * knowledge collections AND the file-meta collection — has no single area to name.
         *
         * THE ASYMMETRY THIS LEAVES IS REAL AND IS NOT A ROW HERE. `admin: true` means INSTANCE admin,
         * while the routes need `<area>: admin` for ONE space — so a space administrator can empty their
         * own space over REST and cannot over MCP. `space-rights.ts` records these two doors as agreeing;
         * they agree on the WORD admin and not on its scope. Filed rather than fixed, because narrowing a
         * flag to a rung is a change to who can wipe a space.
         */
        const handler = ALL_TOOLS.find(t => t.name === tool);
        assert.ok(handler?.admin,
          `${tool}: absent from TOOL_RIGHTS, and not flag-governed either — its route ${route} is `
          + 'area-scoped, so nothing prices it on the MCP door at all');
        continue;
      }
      if (actual.area !== expected.area || actual.needs !== expected.needs) {
        disagreements.push(
          `${tool}: holds ${actual.area}:${actual.needs}, route ${route} needs ${expected.area}:${expected.needs}`);
      }
    }
    assert.deepEqual(disagreements, [],
      'one capability priced differently depending on which door the caller picked');
  });

  it('names only tools that exist', () => {
    // A row for a renamed or deleted tool enforces nothing and reads like coverage.
    const live = new Set(ALL_TOOLS.map(t => t.name));
    const ghosts = TOOL_RIGHTS.filter(r => !live.has(r.tool)).map(r => r.tool);
    assert.deepEqual(ghosts, []);
  });

  it('covers every tool that takes a space', () => {
    // `spaceRequired` is the tool's own statement that it operates inside one space, so it is the honest
    // definition of "must be area-scoped" — independent of the map this file derives its rungs from, so
    // the two cannot be wrong together.
    const covered = new Set(TOOL_RIGHTS.map(r => r.tool));
    const uncovered = ALL_TOOLS
      .filter(t => t.spaceRequired && !covered.has(t.name) && !t.admin)
      .map(t => t.name);
    assert.deepEqual(uncovered, [],
      'a space-scoped tool with no rights row is ungoverned on MCP');
  });
});

describe('the guard REFUSES and ALLOWS — behaviourally, not by reading the source', () => {
  // The first version of this block was a source grep, and it SURVIVED a mutation that made the refusal
  // unreachable (`if (false && !satisfies(...))`) — the strings it matched were still there. That is why the
  // decision was moved into a pure function: this now runs the code instead of reading it.
  const rights = over => ({ instanceAdmin: false, createSpaces: false, floor: 'none', perSpace: {}, ...over });

  it('refuses a delete the token only holds write-below-admin for', () => {
    // Nothing to refuse at `write`, since S-1 levelled single-record deletes DOWN to write.
    const r = rights({ perSpace: { general: { knowledge: 'read' } } });
    const refusal = toolRightsRefusal('delete_fact', r, 'general');
    assert.ok(refusal, 'read must not reach a delete');
    assert.match(refusal, /knowledge: write/, 'the refusal must name what was needed');
    assert.match(refusal, /holds knowledge: read/, 'and what the token actually holds');
  });

  it('allows the same call once the rung is there', () => {
    assert.equal(toolRightsRefusal('delete_fact', rights({ perSpace: { general: { knowledge: 'write' } } }), 'general'), null);
  });

  it('a grant in one space does not carry into another', () => {
    const r = rights({ perSpace: { general: { knowledge: 'admin' } } });
    assert.ok(toolRightsRefusal('save_fact', r, 'other'), 'a per-space grant is per space');
  });

  it('areas do not leak into each other', () => {
    // `files: admin` must not buy a knowledge write. Separate areas is the whole point of the matrix.
    const r = rights({ perSpace: { general: { files: 'admin' } } });
    assert.ok(toolRightsRefusal('save_fact', r, 'general'));
    assert.equal(toolRightsRefusal('write_file', r, 'general'), null);
  });

  it('does nothing for a tool with no row — and REFUSES a token with no matrix', () => {
    /*
     * HALF INVERTED by `Q-5`. This asserted both as *"deliberate pass-throughs"*, on the grounds that
     * *"OIDC records carry no matrix, and instance-level tools are governed by `instanceAdmin`"*. The second
     * clause is still true. The first stopped being true two releases ago — an OIDC session carries `rights`
     * as a REQUIRED field, derived per request from its claim mapping — so what it was describing as
     * deliberate had become the absent-means-permission hole the owner ruled out on 2026-09-05: *"no matrix
     * = refuse - no fallback no backwards compatibility anymore."*
     *
     * The two halves are kept in one case on purpose, because the ORDER between them is the whole fix: the
     * row lookup has to come first. Refusing on an absent matrix before it would have 403'd every
     * instance-level tool, which is the same mistake pointing the other way.
     */
    assert.ok(toolRightsRefusal('delete_fact', undefined, 'general'),
      'an MCP tool call with no rights matrix was allowed');
    assert.equal(toolRightsRefusal('list_spaces', rights({ floor: 'none' }), 'general'), null,
      'an instance-level tool has no rights row and is governed by `instanceAdmin` — still a pass-through');
    assert.equal(toolRightsRefusal('list_spaces', undefined, ''), null,
      'the row lookup must run BEFORE the matrix check, or every instance-level tool is refused');
    assert.ok(toolRightsRefusal('delete_fact', rights({ floor: 'none' }), ''),
      'a tool that needs an area rung cannot be checked without a space, and cannot-be-checked is not passes');
  });

  it('the dispatcher RETURNS the refusal rather than computing and dropping it', () => {
    // A lens computed and discarded is this repo's signature defect — it happened on three routes at once.
    const src = readFileSync('server/src/mcp/router.ts', 'utf8')
      .replace(/(^|[^:])\/\/.*/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(src, /const rightsRefusal = toolRightsRefusal\(name, rights, rawSpace\);/);
    // TWO WINDOWS in one pattern, converted: the subject is the BRANCH, bounded by its own brace, and the
    // claim is that the refusal is RETURNED from inside it. Neither cap could tell "inside the branch" from
    // "160 characters after it" — and "computed and dropped" versus "computed and returned" is exactly that
    // distinction. It is also the defect the test's own comment names as this repo's signature.
    const at = src.indexOf('if (rightsRefusal) {');
    assert.ok(at > -1, 'the refusal branch is gone — re-anchor this gate');
    const branch = blockAfter(src, at, 'the rightsRefusal branch');
    assert.match(branch, /return \{/, 'the branch must RETURN, not fall through');
    assert.match(branch, /text: rightsRefusal/, 'and the returned object must carry the refusal text');
  });
});

describe('the rung comparison itself', () => {
  const rights = over => ({ instanceAdmin: false, createSpaces: false, floor: 'none', perSpace: {}, ...over });

  it('write does not satisfy admin, and admin satisfies write', () => {
    assert.equal(satisfies('write', 'admin'), false);
    assert.equal(satisfies('admin', 'write'), true);
    assert.equal(satisfies('read', 'write'), false);
    assert.equal(satisfies('write', 'read'), true);
  });

  it('a per-space grant is what the tool is measured against', () => {
    const r = rights({ perSpace: { general: { knowledge: 'write' } } });
    assert.equal(effectiveRung(r, 'general', 'knowledge'), 'write');
    // The S-1 case in one line: this is the token that could delete over MCP and not over REST.
    assert.equal(satisfies(effectiveRung(r, 'general', 'knowledge'), 'write'), true);
    assert.equal(satisfies(effectiveRung(r, 'general', 'knowledge'), 'admin'), false);
    // And it reaches nothing in a space it was not granted.
    assert.equal(satisfies(effectiveRung(r, 'other', 'knowledge'), 'read'), false);
  });
});
