/**
 * Every door a peer reaches a space through asks the hold - derived from the routes and the guards, never listed (bundle-106 PR A, section 3.3 v4 (5)
 * and v5, section 6.2; VR2, W13, X17).
 *
 * ## The rule
 *
 * A space whose wipe or deletion is owed or applied on one side is not exchanged with a peer. The data loop is one place that knows it; the OTHER
 * places are every door a peer's request enters by, and a door that does not ask serves or stores what the act is about to delete. The doors are
 * four kinds, and each kind has ONE question it asks and ONE function that answers it:
 *
 * 1. **The sync routes that name a space** (`api/sync/*.ts`): a DATA door asks `refusePeerSpace(` (reach AND hold, `423 space_held`) or, for the push
 *    doors, `pushAllowed(` (which asks `refusePeerSpace(`); the schema door (`GET /meta`) asks `refusePeerReach(` only, and says why in the table below.
 *    Nothing in `api/sync/` calls `spaceAllowed(` but the one function that answers the reach question: a hand-written `spaceAllowed` plus a 403 at a route
 *    is the pair the hold was missing from at every site.
 * 2. **The rights doors** (`auth/middleware.ts`: what resolves a token's reach into a space): the path door `requireSpaceAuthScoped` and the body-scoped
 *    door `requireBodyScopedSpace` ask `refuseHeldPeer(`. The management variants (admin / MFA) are not the exchange and are listed with that reason.
 * 3. **The tool door** (`mcp/tool-rights-guard.ts`): a peer token's tool call asks the same question.
 * 4. **The one question**: `refusePeerSpace` and `refuseHeldPeer` both call `spaceHold(` (`sync/space-exchange-set.ts`) - neither re-derives the hold.
 *
 * ## Why derived, and what the floors are
 *
 * v2 named the doors it knew and passed while `POST /api/brain/recall` (the space in the body) and the whole file door asked nothing. Every set below is
 * read out of the source (the route registrations, the functions of the middleware module), and carries a FLOOR - the count found at 84f0b3cc, below which
 * the derivation is broken and every loop over it is vacuous. Each table entry (a reach-only door, a management guard) must still match a real thing and
 * is itself held to the one property the table claims for it, so an exemption cannot go stale into a hole.
 *
 * ## The instrument
 *
 * The classifier is exercised on snippets before it is trusted: a hand-written reach check, a data door, a reach-only door and a door that asks nothing each
 * get the verdict the rule needs, so a gate that "passes" is not a scan that cannot see.
 *
 * ## Seen red
 *
 * Against 84f0b3cc no door asks a hold: every sync route that names a space asks the hand-written `spaceAllowed(`, `pushAllowed` calls it, the helpers
 * `refusePeerReach`, `refusePeerSpace`, `refuseHeldPeer` and `spaceHold` do not exist, and neither rights door nor the tool guard asks. After the fix, by
 * hand: drop the hold call from `pushAllowed` -> the push doors are listed; register `meta.ts` through `refusePeerSpace` -> the reach-only row red; drop
 * `refuseHeldPeer` from `requireSpaceAuthScoped` -> the rights-door row names it.
 *
 * Run: node --test testing/standalone/every-door-a-peer-reaches-a-space-through-asks-the-hold.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { parseSource, walkEveryNode, lineOf, routeBlocksOf, ts } from '../_shared/syntax-tree.mjs';

const SYNC_DIR = 'server/src/api/sync';
const SHARED = `${SYNC_DIR}/_shared.ts`;
const MIDDLEWARE = 'server/src/auth/middleware.ts';
const TOOL_GUARD = 'server/src/mcp/tool-rights-guard.ts';
const HOLD_MODULE = 'server/src/sync/space-exchange-set.ts';

/** The sync route files that carry routes: `_shared.ts` is the helpers' home, `index.ts` mounts, `space-alias.ts` is the alias middleware. */
const NOT_ROUTE_FILES = new Set(['_shared.ts', 'index.ts', 'space-alias.ts']);
/** The sync route blocks that name a space at 84f0b3cc (record pages and by id, the push doors, manifest, merkle, meta, tombstones). A smaller number means the derivation stopped seeing routes. */
const SYNC_DOOR_FLOOR = 24;
/** The functions of the middleware module that resolve a token's reach into a space, at 84f0b3cc: five. */
const RIGHTS_DOOR_FLOOR = 5;

/** The schema door asks reach only: a wipe changes no schema, and a subscriber takes its type schemas through it (section 3.3 v5, X17, INT S14). */
const REACH_ONLY = [
  { file: 'meta.ts', route: 'GET /meta', why: 'schema propagation is not data: a wipe changes no schema and a subscriber pulls its type schemas from its upstream through it' },
];
/** Guards that resolve a space for a caller but are space MANAGEMENT behind an admin flag or a second factor, not one of the three rights doors the design names. */
const NOT_THE_EXCHANGE = [
  { fn: 'requireSpaceAuthMfaScoped', why: 'space management behind the MFA second factor; the design names three rights doors (path, body, tool) and this is none of them' },
  { fn: 'requireAdminMfaScoped', why: 'instance-admin management of one space (wipe, export, import): an admin token is the operator\'s own tooling, not the exchange' },
  { fn: 'requireAdminOrSpaceAdminMfaScoped', why: 'admin or space-admin management of one space (rename): not the exchange' },
];

const source = (file) => stripComments(readFileSync(`${REPO_ROOT}/${file}`, 'utf8'));
const parsed = (file, text = source(file)) => ({ file, sf: parseSource(file, text) });

/** `x.get('/path', ...)` registrations on a router or the app, each with its text. */
export const routeBlocks = (sf) => routeBlocksOf(sf).map(b => ({ ...b, name: null }));

/**
 * What a route block asks about the space it names. `hold` is a data door (reach and hold), `reach` asks reach only, `hand-written` is the
 * `spaceAllowed(` plus a hand-written refusal, and `none` asks nothing at all.
 */
export function askedBy(blockText) {
  if (/\b(?:refusePeerSpace|pushAllowed)\s*\(/.test(blockText)) return 'hold';
  if (/\brefusePeerReach\s*\(/.test(blockText)) return 'reach';
  if (/\bspaceAllowed\s*\(/.test(blockText)) return 'hand-written';
  return 'none';
}

/**
 * A route block's text WITH the text of the module-level functions it calls, one level: a route registered as `pageBySeq('facts', 'fact')` reads its
 * space and asks about it inside the factory, and a gate that read only the registration would see a door that names no space.
 */
function blockWithItsFactories(p, block, functions) {
  let text = block.text;
  for (const [name, body] of functions) if (name !== block.name && new RegExp(`\\b${name}\\s*[<(]`).test(block.text)) text += `\n${body}`;
  return text;
}

/** The sync route blocks that name a space (`spaceId` in the block or in a factory it calls), with the file they are in. */
function syncDoors() {
  const out = [];
  for (const file of trackedSources(SYNC_DIR, { untracked: true, floor: 8 }).filter(f => f.endsWith('.ts') && !NOT_ROUTE_FILES.has(f.split('/').at(-1)))) {
    const p = parsed(file);
    const functions = functionsOf(p);
    for (const b of routeBlocks(p.sf)) {
      const text = blockWithItsFactories(p, b, functions);
      if (/\bspaceId\b/.test(text)) out.push({ ...b, text, file, name: file.split('/').at(-1), asks: askedBy(text) });
    }
  }
  return out;
}

/** A named function (declaration, or a const bound to a function) in a parsed file, with its text. */
function functionNamed(p, name) {
  let found = null;
  walkEveryNode(p.sf, (n) => {
    if (found) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer && ts.isFunctionLike(n.initializer)) found = n.initializer;
  });
  return found ? { node: found, text: found.getText(p.sf) } : null;
}
/** Every function (declaration or const-bound) of a parsed file: `[name, text]`. */
function functionsOf(p) {
  const out = [];
  walkEveryNode(p.sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name) out.push([n.name.text, n.getText(p.sf)]);
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isFunctionLike(n.initializer)) out.push([n.name.text, n.initializer.getText(p.sf)]);
  });
  return out;
}
const calls = (text, name) => new RegExp(`\\b${name}\\s*\\(`).test(text);

/**
 * Every call of `name(` in a parsed file with the top-level function it is written in (`null` at module scope or inside a route registration):
 * the outermost NAMED function, so a call inside an arrow inside a function reads as that function's.
 */
export function callSitesIn(p, name) {
  const out = [];
  const fnNameOf = (stmt) => {
    if (ts.isFunctionDeclaration(stmt)) return stmt.name?.text ?? null;
    if (ts.isVariableStatement(stmt)) {
      const d = stmt.declarationList.declarations.find(x => x.initializer && ts.isFunctionLike(x.initializer));
      return d && ts.isIdentifier(d.name) ? d.name.text : null;
    }
    return null;
  };
  for (const stmt of p.sf.statements) {
    const fn = fnNameOf(stmt);
    walkEveryNode(stmt, (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) out.push({ fn, line: lineOf(p.sf, n) });
    });
  }
  return out;
}

describe('the classifier is exercised before it is trusted', () => {
  const classify = (src) => routeBlocks(parseSource('snippet.ts', src)).map(b => `${b.route}=${askedBy(b.text)}`);
  it('a data door, a reach-only door, a hand-written reach check and a door that asks nothing each get their own verdict', () => {
    assert.deepEqual(classify(`
      r.post('/a', (req, res) => { const s = pushAllowed(res, req.query.spaceId, n, t); });
      r.get('/b', (req, res) => { if (refusePeerSpace(res, req.query.spaceId, n, t)) return; });
      r.get('/c', (req, res) => { if (refusePeerReach(res, req.query.spaceId, n, t)) return; });
      r.get('/d', (req, res) => { if (!spaceAllowed(req.query.spaceId, n, t)) { res.status(403).end(); } });
      r.get('/e', (req, res) => { res.json({ spaceId: req.query.spaceId }); });
    `.replaceAll(/\br\./g, 'syncRouter.')), ['POST /a=hold', 'GET /b=hold', 'GET /c=reach', 'GET /d=hand-written', 'GET /e=none']);
  });
  it('a call is attributed to the outermost named function it is written in, and a route registration is none', () => {
    const p = { sf: parseSource('snippet.ts', `
      export function refusePeerReach() { if (!spaceAllowed(a, b, c)) return true; }
      const wrap = () => { [1].forEach(() => { spaceAllowed(a, b, c); }); };
      syncRouter.get('/x', (req, res) => { spaceAllowed(a, b, c); });
    `) };
    assert.deepEqual(callSitesIn(p, 'spaceAllowed').map(s => s.fn), ['refusePeerReach', 'wrap', null]);
  });
  it('a route registered through a factory is judged by what the factory reads and asks', () => {
    const p = parsed('snippet.ts', `
      function pageOf(key) { return async (req, res) => { if (!spaceAllowed(req.query.spaceId, n, t)) return; }; }
      function oneOf(key) { return async (req, res) => { if (refusePeerSpace(res, req.query.spaceId, n, t)) return; }; }
      syncRouter.get('/facts', rl, pageOf('facts'));
      syncRouter.get('/facts/:id', rl, oneOf('facts'));
    `);
    const functions = functionsOf(p);
    assert.deepEqual(routeBlocks(p.sf).map(b => `${b.route}=${askedBy(blockWithItsFactories(p, b, functions))}`), ['GET /facts=hand-written', 'GET /facts/:id=hold']);
  });
  it('a mention in a comment is not a call (the sources are read comment-stripped)', () => {
    const text = stripComments('syncRouter.get(\'/x\', (req, res) => {\n  // refusePeerSpace( would go here\n  res.json({ spaceId: req.query.spaceId });\n});');
    assert.deepEqual(routeBlocks(parseSource('snippet.ts', text)).map(b => askedBy(b.text)), ['none']);
  });
});

describe('every sync route that names a space asks the hold (or says why it asks reach only)', () => {
  it('the derivation found the doors, at or above the floor', () => {
    const found = syncDoors();
    assert.ok(found.length >= SYNC_DOOR_FLOOR, `only ${found.length} sync route block(s) name a space (floor ${SYNC_DOOR_FLOOR}): ${found.map(d => `${d.name} ${d.route}`).join(', ')}`);
  });

  it('every data door asks refusePeerSpace or pushAllowed; none asks the hand-written spaceAllowed or nothing', () => {
    const reachOnly = new Set(REACH_ONLY.map(r => `${r.file} ${r.route}`));
    const offenders = syncDoors().filter(d => !reachOnly.has(`${d.name} ${d.route}`) && d.asks !== 'hold')
      .map(d => `${d.file}:${d.line} ${d.route} asks ${d.asks === 'none' ? 'nothing' : d.asks === 'reach' ? 'reach only (not in the reach-only table)' : 'the hand-written spaceAllowed'}`);
    assert.deepEqual(offenders, [], `these doors let a peer into a space without asking whether the space is held:\n  ${offenders.join('\n  ')}`);
  });

  it('each reach-only door exists, asks reach and NOT the hold, and states why', () => {
    const doors = syncDoors();
    for (const entry of REACH_ONLY) {
      assert.ok(entry.why.split(/\s+/).length >= 4, `${entry.file} ${entry.route}: the reason is not a reason`);
      const hit = doors.find(d => d.name === entry.file && d.route === entry.route);
      assert.ok(hit, `${entry.file} ${entry.route} is in the reach-only table and no such route names a space: the table went stale`);
      assert.equal(hit.asks, 'reach', `${entry.file} ${entry.route} must ask refusePeerReach( only (${entry.why}); it asks '${hit.asks}'`);
    }
  });

  it('no spaceAllowed( call in api/sync/ but the function that answers the reach question', () => {
    let scanned = 0; let callsFound = 0; const offenders = [];
    for (const file of trackedSources(SYNC_DIR, { untracked: true, floor: 8 }).filter(f => f.endsWith('.ts'))) {
      scanned++;
      for (const site of callSitesIn(parsed(file), 'spaceAllowed')) {
        callsFound++;
        const allowed = file === SHARED && (site.fn === 'refusePeerReach' || site.fn === 'spaceAllowed');
        if (!allowed) offenders.push(`${file}:${site.line} in ${site.fn ?? 'a route or module scope'}`);
      }
    }
    assert.ok(scanned >= 8, `only ${scanned} file(s) scanned under api/sync`);
    assert.ok(callsFound >= 1, 'no spaceAllowed( call found anywhere under api/sync: the scan cannot see calls, or the reach question has no answer');
    assert.deepEqual(offenders, [], `spaceAllowed( is called outside the one reach function: a door that asks it by hand is a door the hold cannot reach:\n  ${offenders.join('\n  ')}`);
  });
});

describe('the helpers ask the one hold question', () => {
  const need = (file, name) => {
    assert.ok(existsSync(`${REPO_ROOT}/${file}`), `${file} does not exist`);
    const fn = functionNamed(parsed(file), name);
    assert.ok(fn, `${file} has no function '${name}': the door has nothing to ask`);
    return fn.text;
  };

  it('the hold module exists and exports the one answer', () => {
    assert.ok(existsSync(`${REPO_ROOT}/${HOLD_MODULE}`), `${HOLD_MODULE} does not exist: no door has a hold to ask`);
    const text = source(HOLD_MODULE);
    for (const name of ['spaceHold', 'exchangeVerdicts', 'mayExchangeNow']) assert.match(text, new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`), `${HOLD_MODULE} does not export ${name}`);
  });

  it('refusePeerSpace asks reach and then the hold; pushAllowed asks refusePeerSpace and no hand-written reach', () => {
    const space = need(SHARED, 'refusePeerSpace');
    assert.ok(calls(space, 'refusePeerReach') && calls(space, 'spaceHold'), 'refusePeerSpace must be the reach question plus spaceHold (reach is one question, the hold another)');
    const push = need(SHARED, 'pushAllowed');
    assert.ok(calls(push, 'refusePeerSpace'), 'pushAllowed does not ask refusePeerSpace: every push door lets a peer into a held space');
    assert.ok(!calls(push, 'spaceAllowed'), 'pushAllowed still asks the hand-written spaceAllowed');
  });

  it('refuseHeldPeer exists once and asks spaceHold', () => {
    const owners = trackedSources('server/src', { untracked: true, floor: 100 }).filter(f => f.endsWith('.ts'))
      .filter(f => functionNamed(parsed(f), 'refuseHeldPeer'));
    assert.equal(owners.length, 1, `refuseHeldPeer is defined in ${owners.length} place(s) (${owners.join(', ')}): the rights doors need exactly one`);
    assert.ok(calls(functionNamed(parsed(owners[0]), 'refuseHeldPeer').text, 'spaceHold'), `${owners[0]}: refuseHeldPeer does not call spaceHold(`);
  });
});

describe('every rights door a peer token passes asks refuseHeldPeer', () => {
  it('the guards of the middleware module that resolve a space number at least the floor', () => {
    const guards = functionsOf(parsed(MIDDLEWARE)).filter(([, text]) => calls(text, 'enforceSpaceScope') || calls(text, 'spacesForBodyScopedRequest'));
    assert.ok(guards.length >= RIGHTS_DOOR_FLOOR, `only ${guards.length} guard(s) resolve a token's reach into a space (floor ${RIGHTS_DOOR_FLOOR}): ${guards.map(g => g[0]).join(', ')}`);
  });

  it('each guard asks refuseHeldPeer, or is space management listed with its reason', () => {
    const exempt = new Map(NOT_THE_EXCHANGE.map(e => [e.fn, e.why]));
    const guards = functionsOf(parsed(MIDDLEWARE)).filter(([, text]) => calls(text, 'enforceSpaceScope') || calls(text, 'spacesForBodyScopedRequest'));
    const names = new Set(guards.map(g => g[0]));
    for (const [fn, why] of exempt) {
      assert.ok(names.has(fn), `${fn} is in the not-the-exchange table and is no guard of ${MIDDLEWARE}: the table went stale`);
      assert.ok(why.split(/\s+/).length >= 4, `${fn}: the reason is not a reason`);
    }
    const offenders = guards.filter(([name, text]) => !exempt.has(name) && !calls(text, 'refuseHeldPeer')).map(([name]) => name);
    assert.deepEqual(offenders, [], `these guards let a peer token into a space without asking whether it is held: ${offenders.join(', ')}`);
    for (const required of ['requireSpaceAuthScoped', 'requireBodyScopedSpace']) assert.ok(names.has(required), `${required} is not found among the guards: the derivation stopped seeing it`);
  });

  it('the tool guard asks the same question for a peer token\'s tool call', () => {
    assert.ok(existsSync(`${REPO_ROOT}/${TOOL_GUARD}`), `${TOOL_GUARD} does not exist`);
    const text = source(TOOL_GUARD);
    assert.ok(calls(text, 'refuseHeldPeer') || calls(text, 'spaceHold'), `${TOOL_GUARD} never asks the hold: a peer token's MCP call reads a held space`);
  });
});
