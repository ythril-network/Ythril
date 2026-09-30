/**
 * Two more scoping decisions that read the DEAD allowlist, and so answered "unrestricted" for every modern
 * token.
 *
 * ## The class, third and fourth instances
 *
 * `spaces` is `undefined` on every token minted since the rights matrix — the editor writes
 * `rights.perSpace`, the mint body has `spaces` optional, `createToken` stores it verbatim, and the mint
 * route's own refusal map tells a caller to use `rights.perSpace` instead. So any check shaped
 * `!tokenSpaces` or `if (token.spaces)` silently means "no restriction" on a token that is in fact scoped.
 *
 * The sync routes had it (19 copies of one line). These two are the same defect on different surfaces:
 *
 * | Site | Read as | Actually |
 * | --- | --- | --- |
 * | cross-space `recall` | search every space | search only what the token reaches |
 * | signing-key rotation | unrestricted admin | a space-restricted admin was let through |
 *
 * The second is the sharper one: the instance signing key is the credential every peer pins, and continuity
 * proofs are signed with it.
 *
 * ## Why these use two different helpers
 *
 * They ask different questions. Cross-space recall wants the SET of spaces to search, at `knowledge: read` —
 * once `spacesWhereTokenMay` in the REST route, now `toolReach` in the MCP dispatcher, which both search doors
 * delegate to (`Q-89`). Rotation wants a yes/no about being unrestricted — `editorScopeFor`, which returns
 * `undefined` for a token that reaches everything and a list for one that does not. Using the set-builder for
 * the boolean would have meant comparing lengths against the config, making the answer depend on how many
 * spaces happen to exist.
 *
 * Run: node --test testing/standalone/cross-space-and-unrestricted-read-the-matrix.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let editorScopeFor;
before(async () => {
  ({ editorScopeFor } = await import('../../server/dist/auth/editor-scope.js'));
});

const ALL = (r) => ({ knowledge: r, files: r, schema: r, dataQuality: r });
const rights = (over = {}) => ({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, ...over });

describe('"unrestricted" is answered from the matrix', () => {
  it('a matrix-scoped token is NOT unrestricted', () => {
    // The bug: this token has no `spaces` array, so `if (token.spaces)` was false and it read as
    // unrestricted — with the instance signing key behind that check.
    const scope = editorScopeFor({ rights: rights({ perSpace: { qa: ALL('admin') } }) });
    assert.notEqual(scope, undefined, 'a token scoped to one space must not read as unrestricted');
    assert.deepEqual([...scope], ['qa']);
  });

  it('a floor that grants something IS unrestricted', () => {
    // The floor applies to every space including ones created later, which is what unrestricted means here.
    assert.equal(editorScopeFor({ rights: rights({ floor: ALL('read') }) }), undefined);
  });

  it('a MISSING RECORD is not a scope question', () => {
    /*
     * That a record with NO MATRIX — or only the pre-3.0 allowlist — answers `[]` rather than unrestricted
     * is asserted, for every guard, in `no-matrix-reaches-nothing-not-everything.test.js` (`Q-45.4`).
     *
     * `undefined` for a missing record is a different question: there is no token to scope, which is the
     * caller having nothing rather than a token having everything.
     */
    assert.equal(editorScopeFor(undefined), undefined, 'no record at all is still not a scope question');
  });

  it('and the rotation route really asks it that way', () => {
    const src = stripComments(readFileSync('server/src/app.ts', 'utf8'));
    assert.match(src, /editorScopeFor\(req\.authToken\) !== undefined/,
      'signing-key rotation must not test the dead allowlist for truthiness');
    assert.doesNotMatch(src, /if \(req\.authToken\?\.spaces\)/,
      'the old truthiness check must be gone, not merely joined');
  });
});

describe('cross-space recall searches only what the token reaches', () => {
  /*
   * The set used to be built in the REST route, with `spacesWhereTokenMay(rights, 'knowledge', 'read')`. Both
   * search routes now delegate to `callTool` (`/recall`, then `/similar` at `Q-89`), and the dispatcher builds
   * the set once for every door: `toolReach` narrows the handler's spaces to where the token holds the tool's
   * area at `read`, read from the matrix through `effectiveRung`. So the property is asserted where it lives.
   */
  const guard = () => stripComments(readFileSync('server/src/mcp/tool-rights-guard.ts', 'utf8'));
  const bodyOfToolReach = () => {
    const src = guard();
    const at = src.indexOf('export function toolReach(');
    assert.ok(at >= 0, 'toolReach is gone from tool-rights-guard.ts — re-anchor this gate');
    return src.slice(at, src.indexOf('\nexport ', at + 1));
  };

  it('the set is built from the matrix, in the dispatcher, for both doors', () => {
    const body = bodyOfToolReach();
    assert.match(body, /effectiveRung\(rights, id, need\.area\)/, 'not a hand-rolled filter over cfg.spaces');
    assert.doesNotMatch(body, /\.spaces\b/, 'the dead allowlist must not be consulted — it kept every space for a modern token');
    assert.match(body, /if \(!rights\) return \[\];/, 'a token with no matrix reaches nothing, not everything');
    const call = stripComments(readFileSync('server/src/mcp/call-tool.ts', 'utf8'));
    assert.match(call, /accessibleSpaceIds: handlerSpaceIds/, 'callTool must hand the handler the narrowed set');
    // And the REST doors take it: a route that searched on its own would need its own narrowing again.
    const routes = stripComments(readFileSync('server/src/api/brain/search.ts', 'utf8'));
    for (const [path, tool] of [['/recall', 'recall'], ['/similar', 'similar']]) {
      const at = routes.indexOf(`searchRouter.post('${path}'`);
      assert.ok(at >= 0, `${path} is no longer registered — re-anchor this gate`);
      const body = routes.slice(at, routes.indexOf('searchRouter.', at + 20));
      assert.match(body, new RegExp(`callTool\\(\\{\\s*name: '${tool}'`),
        `${path} no longer delegates to the ${tool} tool, so the dispatcher's narrowing does not reach it`);
    }
  });

  it('and asks for knowledge:read, which is what a recall is — and every read tool asks for its own area', async () => {
    const { TOOL_RIGHTS } = await import('../../server/dist/auth/space-rights.js');
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    const { effectiveRung } = await import('../../server/dist/auth/mint-cap.js');
    const { toolReach } = await import('../../server/dist/mcp/tool-rights-guard.js');
    for (const tool of ['recall', 'similar']) {
      const row = TOOL_RIGHTS.find(r => r.tool === tool);
      assert.deepEqual(row && { area: row.area, needs: row.needs }, { area: 'knowledge', needs: 'read' },
        `${tool} must need knowledge:read — a token holding files-only in a space should not have its records ranked`);
    }
    // The rule, over every read row rather than the two searches: a space held for some OTHER area only is dropped.
    const reads = TOOL_RIGHTS.filter(r => r.needs === 'read');
    assert.ok(reads.length >= 2, `only ${reads.length} read rows in TOOL_RIGHTS — the derivation is broken`);
    const none = Object.fromEntries(SPACE_AREAS.map(a => [a, 'none']));
    for (const row of reads) {
      const other = SPACE_AREAS.find(a => a !== row.area
        && effectiveRung(rights({ perSpace: { x: { ...none, [a]: 'read' } } }), 'x', row.area) === 'none');
      assert.ok(other, `no area leaves ${row.area} unheld — the fixture cannot express this row`);
      const r = rights({ perSpace: { k: { ...none, [row.area]: 'read' }, x: { ...none, [other]: 'read' } } });
      assert.deepEqual(toolReach(row.tool, r, ['k', 'x']), ['k'],
        `${row.tool} searches a space held only for ${other}, not ${row.area}`);
    }
  });

  // That the helper it uses has no allowlist left, and closes the absent-matrix case explicitly, is asserted
  // in `no-matrix-reaches-nothing-not-everything.test.js` (`Q-45.4`).
});

describe('the legacy reads that remain are deliberate', () => {
  it('they are matrix-first with the allowlist only as a fallback', () => {
    // Not every `record.spaces` is a defect. The middleware and `editorScopeFor` read it only when there is
    // no matrix, which keeps a pre-matrix token working; those go with the field itself in D-8d. What must
    // not exist is a read that consults the allowlist FIRST, or instead.
    for (const f of ['server/src/auth/middleware.ts', 'server/src/auth/editor-scope.ts']) {
      const src = stripComments(readFileSync(f, 'utf8'));
      assert.match(src, /rights/, `${f} must consult the matrix`);
      assert.doesNotMatch(src, /const \w+ = record\.spaces;\s*if \(/,
        `${f} must not branch on the allowlist before the matrix`);
    }
  });
});
