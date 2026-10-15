/**
 * Every peer route that names a network asks the caller's standing in it through ONE middleware, after authentication (Q-454; design v5
 * sections 3.7 and 6.2).
 *
 * ## What it prevents
 *
 * The standing question — is this caller a member of the network the path names, a joiner whose round is open, or an administrator — was written
 * where somebody remembered it. `GET …/votes` and `GET …/members` carried `requireAuth` and nothing else, the relays asked WHO and never WHETHER,
 * and `warm.ts` has a membership check of its own inline. A route added next year to `/networks/:networkId` that forgets it is a governance read
 * open to every token; the behaviour test (`a-governance-route-asks-the-callers-standing-in-the-network`) drives the routes it knows, and this
 * one finds the routes it does not.
 *
 * ## What it holds, over the routes DERIVED from the source
 *
 * A route is every `<router>.<verb>('<path>', …)` registration under `server/src/api/sync/` whose path names `:networkId`, or whose handler reads a
 * `networkId` from the request (the data routes). Each is exactly one of:
 *
 * - **GATED** — `requireNetworkStanding(…)` is in its argument list, AFTER `requireAuth` (a standing question asked of an unauthenticated caller
 *   reads no token), and before the handler;
 * - **DATA** — a data route: its handler asks the space-reach question (`spaceAllowed(`, `pushAllowed(`, `refusePeerSpace(` or the scoped space
 *   guards), which asks the network's membership as part of reach;
 * - **EXEMPT** — in the table below, with the reason, and the entry must still match a real route.
 *
 * `requireNetworkStanding` is asserted to be defined once and imported where it is called (no dead import). The predicates are shown to fire on a
 * fixture first.
 *
 * Run: node --test testing/standalone/every-governance-route-asks-membership-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { parseSource, ts, walkEveryNode } from '../_shared/syntax-tree.mjs';

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);
const GATE = 'requireNetworkStanding';
const REACH = /\b(?:spaceAllowed|pushAllowed|refusePeerSpace|requireSpaceAuthScoped|requireBodyScopedSpace)\s*\(/;

/** Routes that name a network and are neither gated nor a data route, each with the reason, keyed `VERB path`. */
const EXEMPT = Object.freeze({
  'POST /networks/:networkId/members': 'the member announce: the caller may report only its own record and `peerRelayCaller` decides who it is; a candidate announcing before admission is the case it exists for',
  'POST /networks/:networkId/pair': 'the pairing handshake is unauthenticated by design: the pairing code is the proof, and the caller is not a member of anything yet',
  'POST /networks/:networkId/pair/confirm': 'pairing confirmation checks the pairing record it created (`confirmPairing`), which is the standing a pairing caller can have before admission',
  'POST /warm': 'a data route that warms a network\'s collections and checks the peer\'s membership inline with the uniform 404 (Q-133); it reads no round and no member list',
});

const nameOf = (e) => ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : ts.isCallExpression(e) ? nameOf(e.expression) : '';

/** Every route registration of one source: verb, path, the layers before the handler, and the handler's text. */
export function routesIn(file, text) {
  const sf = parseSource(file, text);
  const out = [];
  walkEveryNode(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && VERBS.has(n.expression.name.text)) {
      const [first, ...rest] = n.arguments;
      if (first && ts.isStringLiteralLike(first) && rest.length > 0) {
        const handler = rest[rest.length - 1];
        const layers = rest.slice(0, -1).map(nameOf);
        out.push({ file, verb: n.expression.name.text.toUpperCase(), path: first.text, layers, handler: handler.getText(sf) });
      }
    }
  });
  return out;
}

/** Does this route name a network: in its path, or in a `networkId` its handler reads off the request? */
export const namesANetwork = (r) => r.path.includes(':networkId') || /\bnetworkId\b/.test(r.handler);

/** `GATED`, `DATA` or `EXEMPT`, or `null` for a route that names a network and is none of them. */
export function classify(r) {
  const key = `${r.verb} ${r.path}`;
  const gate = r.layers.indexOf(GATE);
  if (gate > -1) return r.layers.indexOf('requireAuth') > -1 && r.layers.indexOf('requireAuth') < gate ? 'GATED' : null;
  if (key in EXEMPT) return 'EXEMPT';
  if (REACH.test(r.handler)) return 'DATA';
  return null;
}

describe('the predicates fire on a fixture first', () => {
  const src = (layers) => `export const r = Router();\nr.get('/networks/:networkId/secret', ${layers}async (req, res) => { res.json({}); });\n`;
  it('an un-tabled route that names a network and asks nothing is not classified', () => {
    const [route] = routesIn('f.ts', src('syncRateLimit, requireAuth, '));
    assert.ok(namesANetwork(route));
    assert.equal(classify(route), null);
  });
  it('the gate counts only after requireAuth, and a data route is told by its reach question', () => {
    assert.equal(classify(routesIn('f.ts', src('syncRateLimit, requireAuth, requireNetworkStanding(ROW), '))[0]), 'GATED');
    assert.equal(classify(routesIn('f.ts', src('requireNetworkStanding(ROW), requireAuth, '))[0]), null, 'a gate before authentication reads no token');
    const [data] = routesIn('f.ts', `r.get('/facts', requireAuth, async (req, res) => { const { networkId } = req.query; if (!spaceAllowed(s, networkId, t)) return; });`);
    assert.ok(namesANetwork(data));
    assert.equal(classify(data), 'DATA');
  });
  it('a route that does not name a network is not in the set', () => {
    const [route] = routesIn('f.ts', `r.get('/facts', requireAuth, async (req, res) => { res.json({}); });`);
    assert.ok(!namesANetwork(route));
  });
});

describe('every sync route that names a network is gated, a data route, or exempt with a reason', () => {
  const files = trackedSources('server/src/api/sync', { untracked: true, floor: 5 });
  const routes = files.flatMap(f => routesIn(f, readFileSync(f, 'utf8'))).filter(namesANetwork);

  it('the derivation found the routes, above the floor, including the path-scoped governance ones', () => {
    assert.ok(routes.length >= 20, `only ${routes.length} network-naming routes found under server/src/api/sync`);
    const pathScoped = routes.filter(r => r.path.includes(':networkId'));
    assert.ok(pathScoped.length >= 7, `only ${pathScoped.length} routes name :networkId in their path`);
  });

  it('no route that names a network is left unclassified — an un-tabled governance route is open to every token', () => {
    const open = routes.filter(r => classify(r) === null).map(r => `${r.verb} ${r.path} (${r.file.split('/').pop()}, layers: ${r.layers.join(', ')})`);
    assert.deepEqual(open, [], `these name a network and neither carry ${GATE} after requireAuth, nor ask the space-reach question, nor have an EXEMPT row with a reason`);
  });

  it('every EXEMPT row still matches a real route, and says why in a sentence', () => {
    const real = new Set(routes.map(r => `${r.verb} ${r.path}`));
    assert.deepEqual(Object.keys(EXEMPT).filter(k => !real.has(k)), [], 'an exemption for a route that is gone is a hole kept open');
    for (const [k, why] of Object.entries(EXEMPT)) assert.ok(why.split(/\s+/).length >= 8, `${k}: the reason is not a reason`);
  });

  it('the middleware is defined once, and every file that calls it imports it', () => {
    const owners = trackedSources('server/src', { untracked: true, floor: 100 })
      .filter(f => new RegExp(`export (?:async )?function ${GATE}\\b`).test(readFileSync(f, 'utf8')));
    assert.equal(owners.length, 1, `${GATE} must be defined exactly once; found in: ${owners.join(', ') || 'no file'}`);
    const importers = files.filter(f => new RegExp(`\\b${GATE}\\(`).test(readFileSync(f, 'utf8')));
    for (const f of importers) assert.match(readFileSync(f, 'utf8'), new RegExp(`import\\s*\\{[^}]*\\b${GATE}\\b[^}]*\\}\\s*from`), `${f} calls ${GATE} without importing it`);
  });
});
