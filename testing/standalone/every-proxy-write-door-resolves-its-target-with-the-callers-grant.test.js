/**
 * Every door that resolves a proxy WRITE target resolves it with the caller's grant, and every walk that finds a
 * record across a proxy's members walks only what the caller reaches (Q-440, bundle-100, plan rev 2).
 *
 * ## What went wrong
 *
 * `resolveWriteTarget(spaceId, targetSpace)` answered membership, never reach: a token holding write on `qa` only wrote
 * into `secret` through a wildcard proxy (`?targetSpace=secret`, 201) on both doors, and the wildcard branch answered a
 * space the token cannot see differently from one that does not exist. The REST deletes of an edge and a link walked
 * `findFirstAcrossMembers(spaceId, …)` over EVERY member, so the same token deleted an edge in `secret`. Each door
 * answered `wt.error` with its own hard-coded status, so a 403 the resolver could give had nowhere to go.
 *
 * ## The rule, as these cases hold it
 *
 * 1. Every call of `resolveWriteTarget` passes a third argument, the grant (`{ rights, area, needs }`), and the grant
 *    never asserts a matrix present with `!`: an absent matrix is refused INSIDE the resolver, so no site writes one.
 * 2. Every `findFirstAcrossMembers` walks a resolved target (`wt.target`) or a list narrowed to the caller
 *    (`memberSpacesForRequest` / `memberSpacesForToken` / `memberSpacesWithin`) — never a raw space id.
 * 3. No door answers a resolution's `error` itself: the status travels with the refusal and one helper per door says it,
 *    so a site cannot answer a reach refusal as a 400 while another answers it as a 403.
 *
 * ## The subjects are derived, never listed
 *
 * Every tracked `server/src` TypeScript source is parsed (comments are trivia, so a commented-out call is no subject),
 * every call to the two functions is found by its callee, and a FLOOR is asserted on each set: an empty derivation passes
 * every loop written over it.
 *
 * Run: node --test testing/standalone/every-proxy-write-door-resolves-its-target-with-the-callers-grant.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { ts, parseSource, lineOf, walkEveryNode, unwrapExpression } from '../_shared/syntax-tree.mjs';

/** Where the two functions are DEFINED; their own bodies are the rule, not a door. */
const DEFINING_MODULE = 'server/src/spaces/proxy.ts';
/** The narrowings a member walk may take: each answers "the members THIS caller reaches". */
const NARROWINGS = new Set(['memberSpacesForRequest', 'memberSpacesForToken', 'memberSpacesWithin']);

const sources = readTrackedSources('server/src', { floor: 300 }).filter(s => !s.file.endsWith('.spec.ts'));

/** Every call whose callee is the identifier (or a property) `name`, with its file and line. */
function callsOf(name) {
  const out = [];
  for (const { file, text } of sources) {
    if (!text.includes(name)) continue;
    const sf = parseSource(file, text);
    walkEveryNode(sf, (n) => {
      if (!ts.isCallExpression(n)) return;
      const callee = unwrapExpression(n.expression);
      const called = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (called === name) out.push({ file, line: lineOf(sf, n), sf, call: n, where: `${file}:${lineOf(sf, n)}` });
    });
  }
  return out;
}

describe('every proxy write door resolves its target with the caller\'s grant (Q-440)', () => {
  it('every resolveWriteTarget call passes the grant, and no grant asserts a matrix present with `!`', () => {
    const sites = callsOf('resolveWriteTarget');
    // 13 REST brain sites, the files door, three ingest sites, ~23 MCP handlers and the dispatcher's wrapper at 612f50c4.
    assert.ok(sites.length >= 30, `only ${sites.length} resolveWriteTarget call(s) found - the derivation reads nothing`);
    const noGrant = sites.filter(s => s.call.arguments.length < 3).map(s => s.where);
    assert.deepEqual(noGrant, [], 'these resolveWriteTarget calls resolve a write target without the caller\'s grant, so the target is checked for membership and never for reach or rung');
    const asserted = [];
    for (const s of sites.filter(x => x.call.arguments.length >= 3)) {
      let bang = false;
      walkEveryNode(s.call.arguments[2], (n) => { if (ts.isNonNullExpression(n)) bang = true; });
      if (bang) asserted.push(s.where);
    }
    assert.deepEqual(asserted, [], 'these grants assert a rights matrix present with `!`; an absent matrix must be refused inside the resolver');
  });

  it('every findFirstAcrossMembers walks a resolved target or a list narrowed to the caller', () => {
    const sites = callsOf('findFirstAcrossMembers').filter(s => s.file !== DEFINING_MODULE);
    assert.ok(sites.length >= 12, `only ${sites.length} findFirstAcrossMembers call(s) found - the derivation reads nothing`);
    const raw = [];
    for (const s of sites) {
      const first = unwrapExpression(s.call.arguments[0]);
      const text = first ? first.getText(s.sf) : '(none)';
      if (text === 'wt.target') continue;
      if (first && ts.isCallExpression(first)) {
        const callee = unwrapExpression(first.expression);
        if (ts.isIdentifier(callee) && NARROWINGS.has(callee.text)) continue;
      }
      raw.push(`${s.where} walks ${text}`);
    }
    assert.deepEqual(raw, [], 'these walks visit every member of a proxy, including members the caller does not reach - a scoped token deletes or reads a record it cannot see, and 204/404 says whether it exists');
  });

  it('no door answers a write-target refusal itself: the status travels with the refusal', () => {
    const own = [];
    let resolutions = 0;
    for (const { file, text } of sources) {
      if (file === DEFINING_MODULE || !/resolve(Call)?WriteTarget\(/.test(text)) continue;
      const sf = parseSource(file, text);
      const names = new Set();
      walkEveryNode(sf, (n) => {
        if (!ts.isVariableDeclaration(n) || !n.initializer || !ts.isIdentifier(n.name)) return;
        const init = unwrapExpression(n.initializer);
        if (!ts.isCallExpression(init)) return;
        const callee = unwrapExpression(init.expression);
        if (ts.isIdentifier(callee) && /^resolve(Call)?WriteTarget$/.test(callee.text)) { names.add(n.name.text); resolutions++; }
      });
      walkEveryNode(sf, (n) => {
        if (ts.isPropertyAccessExpression(n) && n.name.text === 'error' && ts.isIdentifier(n.expression) && names.has(n.expression.text)) {
          own.push(`${file}:${lineOf(sf, n)} answers ${n.expression.text}.error with a status of its own`);
        }
      });
    }
    assert.ok(resolutions >= 20, `only ${resolutions} file-level resolution variable(s) found - the derivation reads nothing`);
    assert.deepEqual(own, [], 'these sites answer a write-target refusal with their own status, so a reach refusal is a 400 on one door and a 403 on another');
  });
});
