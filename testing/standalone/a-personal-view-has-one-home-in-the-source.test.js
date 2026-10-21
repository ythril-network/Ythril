/**
 * A personal view has one home in the source, and every path that changes spaces or tokens keeps views right (Q-531, bundle-100,
 * plan rev 3.2).
 *
 * ## The rules, each over a set derived from the source (never listed), each with a floor
 *
 * 1. **No reader of `config.spaces` treats an entry as a proxy or a view.** A view is its own record outside `config.spaces`; a
 *    function that reads the spaces and also names `proxyFor`, `isProxy*`, `.views` or `isView` is mixing the two. Exempt: the
 *    view store (`config/views.ts`, where a `'*'` member list is every space) and the migration (`config/migrate-proxies-to-views.ts`).
 * 2. **One function computes the members a view reads**: `viewReadMembers` in `config/views.ts`. Derived by BEHAVIOUR: every
 *    function that narrows a member list (`.members`, `proxyFor`, `resolveMemberSpaces`, `memberSpaces*(`) by the caller's reach or
 *    rung (`holdsRung`, `reachesSpace`, `reachableSpaceIds`, `spacesWhereTokenMay`) is a computer of view members; there is one.
 * 3. **Every creation site refuses a retired id** (`assertNotRetiredSpaceId`): every function that pushes a new entry into
 *    `config.spaces`, rewrites a space entry's id, or initialises the spaces a reload added.
 * 4. **Every place a space leaves config drops it from every view** (`dropSpaceFromViews`): every filter that takes an entry out of
 *    `config.spaces`, and the reload's `removeSpaces`.
 * 5. **One function removes tokens from `config.tokens`**, in `auth/tokens.ts`, and `revokeToken` and `createOAuthToken` (rotation
 *    and cap eviction) both go through it, so the views cascade has one place to live. No writer of `oauthClients` deletes views
 *    (a client eviction is forced by any low-privilege registrar; its owners' views fall to the 30-day grace sweep).
 * 6. **No MCP string and no doc page says "proxy" in the space sense**, outside the CHANGELOG and the upgrade page (02b), which must
 *    name what was removed. The HTTP sense (a reverse proxy in front of the instance) is not this rule's subject.
 *
 * `viewReadMembers`, `assertNotRetiredSpaceId` and `dropSpaceFromViews` are the names the plan (rev 3.2, "module homes", "one
 * function") gives or implies; the implementation adopts them or renames them here in the same commit.
 *
 * ## Seen red
 *
 * At 18e8d598 every rule is red for its stated reason (the sites lack the call, proxy symbols are read beside config.spaces, six
 * functions narrow members by reach, two functions remove tokens, 180 proxy sentences). Each rule was ALSO seen to name exactly the
 * one site a mutation left uncovered, on a scratch copy of the source text handed to the same function (no file in server/src edited):
 * see the bundle's return for the mutation per rule.
 *
 * Run: node --test testing/standalone/a-personal-view-has-one-home-in-the-source.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  serverSources, configSpacesReadersThatMentionViews, viewMemberComputers, THE_VIEW_MEMBER_FUNCTION,
  creationSites, creationSitesWithoutTheCheck, RETIRED_CHECK, leaveSites, leaveSitesWithoutTheDrop, DROP_FROM_VIEWS,
  tokenWriters, proxyWordFindings, mcpToolSources, callerDocs, VIEW_HOMES,
} from './_view-gates.mjs';

const sources = serverSources();
const list = (xs) => xs.map(x => `\n  ${x}`).join('');

describe('a personal view has one home in the source (Q-531)', () => {
  it('no reader of config.spaces names a proxy or a view', () => {
    const { readers, findings } = configSpacesReadersThatMentionViews(sources);
    assert.ok(readers.length >= 60, `only ${readers.length} function(s) read config.spaces; the scan is broken`);
    assert.deepEqual(findings, [], `a reader of config.spaces mixes spaces and views/proxies (only ${VIEW_HOMES.join(' and ')} may):${list(findings)}`);
  });

  it('one function computes the members a view reads, and it is viewReadMembers', () => {
    const found = viewMemberComputers(sources);
    assert.deepEqual(found, [THE_VIEW_MEMBER_FUNCTION],
      `the functions that narrow a member list by reach or rung are:${list(found)}\nThere must be exactly one, ${THE_VIEW_MEMBER_FUNCTION}; every door asks it.`);
  });

  it('a view id is written by viewIdOf alone (b100 row 10b)', () => {
    // Seen red at 743562a5: the migration, create, rename, copy and claim each wrote `@${name}`, and validateViews compared against its own.
    const HOME = 'server/src/config/view-shape.ts';
    assert.ok(sources.some(s => s.file === HOME && /export const viewIdOf\b/.test(s.text)), `${HOME} no longer defines viewIdOf`);
    const built = sources.filter(s => s.file !== HOME && /`@\$\{/.test(s.text)).map(s => s.file);
    assert.deepEqual(built, [], `sites that build a view id themselves; ask viewIdOf:${list(built)}`);
  });

  it(`every site that brings a space id into config calls ${RETIRED_CHECK}`, () => {
    const sites = creationSites(sources);
    assert.ok(sites.length >= 3, `only ${sites.length} creation site(s) found; the scan is broken`);
    const missing = creationSitesWithoutTheCheck(sites);
    assert.deepEqual(missing, [], `these bring a space id into config without refusing a retired proxy id:${list(missing)}`);
  });

  it(`every place a space leaves config calls ${DROP_FROM_VIEWS}`, () => {
    const sites = leaveSites(sources);
    assert.ok(sites.length >= 3, `only ${sites.length} leave site(s) found; the scan is broken`);
    const missing = leaveSitesWithoutTheDrop(sites);
    assert.deepEqual(missing, [], `these take a space out of config and leave it in every view's member list (a recreated id would silently rejoin):${list(missing)}`);
  });

  it('one function removes tokens, revoke and the connector rotation/eviction both use it, and no client eviction deletes views', () => {
    const { removers, writers, oauthClientWriters } = tokenWriters(sources);
    assert.ok(writers.length >= 2, `only ${writers.length} writer(s) of config.tokens found; the scan is broken`);
    const names = removers.map(r => `${r.file}#${r.fn}`);
    assert.equal(names.length, 1, `functions that take a token out of config.tokens:${list(names)}\nThere must be one, so the views cascade has one home.`);
    assert.match(names[0], /^server\/src\/auth\/tokens\.ts#/, 'the token-removal function lives in auth/tokens.ts');
    const remover = removers[0].fn;
    /** A top-level function's text in auth/tokens.ts, to its closing brace at column 0. */
    const caller = (fn) => {
      const all = sources.find(s => s.file === 'server/src/auth/tokens.ts');
      const at = all.text.search(new RegExp(String.raw`(?:function|const)\s+${fn}\b`));
      assert.ok(at >= 0, `${fn} is not in auth/tokens.ts; re-anchor this rule`);
      // To the NEXT top-level declaration, not to the first `}` at column 0: a signature whose parameter type is written over several lines
      // also closes with a `}` at column 0 (`}): Promise<...> {`), and cutting there never reaches the body (createOAuthToken's).
      const next = all.text.slice(at + 1).search(/^(?:export\s+)?(?:async\s+)?(?:function|const)\s/m);
      return all.text.slice(at, next < 0 ? all.text.length : at + 1 + next);
    };
    for (const fn of ['revokeToken', 'createOAuthToken']) {
      assert.match(caller(fn), new RegExp(String.raw`\b${remover}\s*\(`), `${fn} removes tokens without going through ${remover}`);
    }
    const deleting = oauthClientWriters.filter(w => /\bdeleteViewsOf\s*\(/.test(w.fnText)).map(w => `${w.file}:${w.line} ${w.fn}`);
    assert.deepEqual(deleting, [], 'an OAuth client eviction deletes views; it must leave them to the grace sweep');
  });

  it('no MCP string and no doc page says "proxy" in the space sense, outside the CHANGELOG and the upgrade page', () => {
    const toolSources = mcpToolSources();
    const docs = callerDocs();
    assert.ok(toolSources.length >= 30 && docs.length >= 40, `scanned ${toolSources.length} MCP source(s) and ${docs.length} page(s); the scan is broken`);
    const findings = proxyWordFindings({ toolSources, docs });
    assert.deepEqual(findings, [], `${findings.length} place(s) a caller reads still describe proxies:${list(findings.slice(0, 60))}`);
  });
});
