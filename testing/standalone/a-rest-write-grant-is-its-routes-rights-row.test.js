/**
 * Every `restWriteGrant(req, '<area>', '<needs>')` literal equals the `ROUTE_RIGHTS` row of the route it serves (Q-440).
 *
 * ## What went wrong
 *
 * A REST write resolves its proxy target with the caller's grant, and the grant carries the area and rung the route needs in
 * the MEMBER the write lands in. `restWriteGrant` takes those two as literals at the call, on purpose: a route is a handler
 * that can be driven without its mount, so a lookup by request path could find nothing and would have to refuse or default.
 * The cost of a literal is that nothing tied it to `ROUTE_RIGHTS`, the inventory the area guard enforces on the space the route
 * was addressed through. Its docblock said "the literal must be the route's row"; a docblock is not a gate. A row raised to
 * `admin`, or a route moved to another area, would leave the member check asking a different question than the space check, and
 * nothing would say so.
 *
 * ## The rule
 *
 * For every call of `restWriteGrant`, the route (or routes) it serves is derived, and the call's `area` and `needs` equal that
 * route's `ROUTE_RIGHTS` row. A call inside a route handler serves that route; a call inside a named helper serves every route
 * whose handler reaches the helper, through helpers of helpers (`requireWriteTarget` <- `requireWritePath` <- the file routes).
 * A call that reaches no route is a failure too: a grant nothing is held to is the defect this gate exists to end.
 *
 * ## The subjects are derived, never listed
 *
 * Every tracked non-spec `server/src` source is parsed (comments are trivia, so a commented-out call is no subject), the
 * routes come from the mount graph (`mountedRoutes`, which resolves a router parameter to what is passed it), and a FLOOR is
 * asserted on the calls and on the routes they reach: an empty derivation passes every loop written over it.
 *
 * Run: npm run build -w server && node --test testing/standalone/a-rest-write-grant-is-its-routes-rights-row.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { mountedRoutes } from './_routes.mjs';
import { ts, parseSource, lineOf, walkEveryNode, unwrapExpression, routeBlocksOf } from '../_shared/syntax-tree.mjs';

const { ROUTE_RIGHTS } = await import('../../server/dist/auth/space-rights.js');

const sources = readTrackedSources('server/src', { floor: 300 }).filter(s => !s.file.endsWith('.spec.ts'));
const mounted = mountedRoutes();
const rowFor = new Map(ROUTE_RIGHTS.map(r => [`${r.method} ${r.route}`, r]));

/** The name a call is made by: `f(...)` and `x.f(...)` are both `f`. */
function calleeName(call) {
  const callee = unwrapExpression(call.expression);
  return ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
}

/** The literal text of an argument, or null when it is not a string literal (the gate then cannot judge it and says so). */
const literalOf = (node) => (node && ts.isStringLiteralLike(node) ? node.text : null);

/** Every call of `name`, with where it is and the tree it sits in. */
function callsOf(name) {
  const out = [];
  for (const { file, text } of sources) {
    if (!text.includes(name)) continue;
    const sf = parseSource(file, text);
    walkEveryNode(sf, (n) => {
      if (ts.isCallExpression(n) && calleeName(n) === name) out.push({ file, sf, call: n, where: `${file}:${lineOf(sf, n)}` });
    });
  }
  return out;
}

/** The name a function-like node is known by: a declaration's own, or the variable an arrow is assigned to. */
function nameOfFunction(fn) {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) return fn.name.text;
  if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  return null;
}

/**
 * The routes a call serves, as `{ method, path }` served paths, plus the unresolved reasons. Walks up from the call: the first
 * route registration around it is the route; the first NAMED function around it is a helper, so its callers are asked the same
 * question (`seen` stops a cycle).
 */
function routesServedBy(site, seen = new Set()) {
  const routes = [];
  const unresolved = [];
  const registrations = new Map(routeBlocksOf(site.sf).map(b => [b.node, b]));
  for (let n = site.call.parent; n; n = n.parent) {
    if (registrations.has(n)) {
      const [method, routePath] = registrations.get(n).route.split(' ');
      const hits = mounted.filter(m => m.file === site.file && m.method === method && m.routePath === routePath);
      if (hits.length === 0) unresolved.push(`${site.where} is in ${registrations.get(n).route}, which no router mount serves`);
      for (const h of hits) routes.push({ method: h.method, path: h.path, via: site.where });
      return { routes, unresolved };
    }
    if (ts.isFunctionLike(n)) {
      const name = nameOfFunction(n);
      if (name === null) continue; // an inline callback: keep climbing to the registration around it
      if (seen.has(name)) return { routes, unresolved };
      seen.add(name);
      const callers = callsOf(name);
      if (callers.length === 0) unresolved.push(`${site.where} is in ${name}(), which nothing calls`);
      for (const c of callers) {
        const r = routesServedBy(c, seen);
        routes.push(...r.routes);
        unresolved.push(...r.unresolved);
      }
      return { routes, unresolved };
    }
  }
  unresolved.push(`${site.where} is outside every route and every named function`);
  return { routes, unresolved };
}

describe('a REST write grant is its route\'s ROUTE_RIGHTS row (Q-440)', () => {
  const grants = callsOf('restWriteGrant').filter(s => s.file !== 'server/src/api/write-target-answer.ts');

  it('the derivation found the grants', () => {
    assert.ok(grants.length >= 12, `only ${grants.length} restWriteGrant call(s) found - the derivation reads nothing`);
  });

  it('every grant states its area and rung as literals, and reaches at least one route', () => {
    const bad = [];
    let reached = 0;
    for (const g of grants) {
      if (literalOf(g.call.arguments[1]) === null || literalOf(g.call.arguments[2]) === null) {
        bad.push(`${g.where} passes an area or rung that is not a literal, so no gate can hold it to a row`);
        continue;
      }
      const { routes, unresolved } = routesServedBy(g);
      bad.push(...unresolved);
      if (routes.length === 0 && unresolved.length === 0) bad.push(`${g.where} reaches no route`);
      reached += routes.length;
    }
    assert.deepEqual(bad, []);
    assert.ok(reached >= 15, `the grants reach only ${reached} route(s) - the route derivation reads nothing`);
  });

  it('each grant\'s area and needs equal the row of every route it serves', () => {
    const wrong = [];
    const checked = new Set();
    for (const g of grants) {
      const area = literalOf(g.call.arguments[1]);
      const needs = literalOf(g.call.arguments[2]);
      for (const r of routesServedBy(g).routes) {
        checked.add(`${r.method} ${r.path}`);
        const row = rowFor.get(`${r.method} ${r.path}`);
        if (!row) { wrong.push(`${g.where} serves ${r.method} ${r.path}, which has no ROUTE_RIGHTS row (a route that is not an area view is not a proxy write door)`); continue; }
        if (row.area !== area || row.needs !== needs) {
          wrong.push(`${g.where} grants ${area}/${needs} but ${r.method} ${r.path} is ${row.area}/${row.needs} in ROUTE_RIGHTS`);
        }
      }
    }
    assert.ok(checked.size >= 15, `only ${checked.size} route(s) compared - the derivation reads nothing`);
    assert.deepEqual(wrong, [], 'these grants ask the member a different question than the area guard asks the space the route was addressed through');
  });
});
