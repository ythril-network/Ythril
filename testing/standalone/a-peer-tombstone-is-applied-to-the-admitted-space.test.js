/**
 * A peer's tombstone is applied to the space its door ADMITTED — never to the space the tombstone names
 * (`Q-236`, bundle-46 plan row 9). The source half of `a-peer-tombstone-is-applied-where-it-was-admitted-db`.
 *
 * ## Why a source gate as well as the -db rows
 *
 * The -db rows prove the two doors that exist today. This holds the SHAPE that keeps a third door honest: the apply
 * takes the admitted space as a parameter and routes every collection it touches by that parameter, and every caller
 * hands it a space that traces back to an admission — `req.query.spaceId` read after the alias middleware on the push
 * route, the engine's loop over the spaces its network carries on the pull. A caller that passes the tombstone's own
 * `spaceId`, or the network's id for the space instead of the local one, fails here by name.
 *
 * ## What is derived
 *
 *  - **The doors**: `POST /api/sync/tombstones` (from the mounted routes) and every function of the pull engine
 *    `sync/engine.ts`, rooted through the call graph with `closures: true` exactly as
 *    `an-arrival-is-written-by-one-writer` roots them.
 *  - **The apply**: every function the push door reaches that writes a space's `tombstones` collection
 *    (`_space-writers.mjs`). The pull engine must reach every one of them — one apply, two doors.
 *  - **Its space parameter**: the name its collection names are built from (`spaceCollection(x, …)`, `` `${x}_…` ``),
 *    which must be one of its own parameters.
 *  - **Each caller's argument**, traced binding by binding through the door-reached functions to a terminal: a
 *    destructure of `req.query` in a route that admits that name, or a `for (… of <network>.spaces)` loop.
 *
 * ## Seen red
 *
 * Red on b569c464: `applyRemoteTombstone(tombstone, auth)` routes by `const { spaceId } = tombstone`, and both doors
 * call it with the element. After the fix, seen red by mutation: the pull's call handed `remoteSpaceId`, and the apply
 * routing one collection by `t.spaceId`.
 *
 * Run: node --test testing/standalone/a-peer-tombstone-is-applied-to-the-admitted-space.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moduleIndex, routeHandlerRoots, walkFrom } from './_call-graph.mjs';
import { mountedRoutes } from './_routes.mjs';
import { spaceWriters } from './_space-writers.mjs';
import { argumentsOf } from './_structural-window.mjs';

const ENGINE = 'server/src/sync/engine.ts';
const PUSH_PATH = '/api/sync/tombstones';
const SYNC_INDEX = 'server/src/api/sync/index.ts';

const INDEX = moduleIndex('server/src');
const ROUTES = mountedRoutes();
const PUSH_ROUTE = ROUTES.find(r => r.method === 'POST' && r.path === PUSH_PATH);
const PUSH_ROOTS = PUSH_ROUTE ? routeHandlerRoots(INDEX, PUSH_ROUTE) : [];
const ENGINE_ROOTS = [...INDEX.bodies.keys()].filter(k => k.startsWith(`${ENGINE}:`));
const WRITERS = spaceWriters(INDEX);

const reach = (roots) => walkFrom(INDEX, roots, { closures: true }).seen;
const PUSH_REACHED = PUSH_ROOTS.length ? reach(PUSH_ROOTS) : new Set();
const PULL_REACHED = reach(ENGINE_ROOTS);
const DOOR_REACHED = new Set([...PUSH_REACHED, ...PULL_REACHED]);

/** The functions the push door reaches that write a space's tombstones collection. */
const APPLIES = [...PUSH_REACHED].filter(k => (WRITERS.byKey.get(k) ?? []).some(s => s.collection === 'tombstones'));

/** The parameter names of a top-level function, in order (a destructured parameter is kept as its text). */
function paramsOf(key) {
  const e = INDEX.bodies.get(key);
  const src = INDEX.sources.get(e.file);
  const name = e.name.split('.').pop();
  const at = src.lastIndexOf(name, e.start);
  assert.ok(at > -1, `${key}: its declaration was not found before its body — re-anchor paramsOf`);
  return argumentsOf(src, src.indexOf('(', at), `${key} parameters`)
    .map(a => a.trim()).filter(Boolean).map(a => /^([A-Za-z_$][\w$]*)/.exec(a)?.[1] ?? a);
}

/** The names a collection name is built from in `body`: `spaceCollection(x, …)` and `` `${x}_…` ``. */
function routedBy(body) {
  return new Set([...body.matchAll(/spaceCollection\(\s*([^,()]+?)\s*,/g), ...body.matchAll(/`\$\{\s*([^}]+?)\s*\}_/g)]
    .map(m => m[1]));
}

/** How `name` is bound in `body`, or null. */
function bindingOf(body, name) {
  const forOf = new RegExp(`for\\s*\\(\\s*(?:const|let)\\s+${name}\\s+of\\s+([^)]+)\\)`).exec(body);
  if (forOf) return { kind: 'forOf', from: forOf[1].trim() };
  for (const m of body.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=\s*([^;\n]+)/g)) {
    const names = m[1].split(',').map(p => p.trim().split(/\s*[:=]\s*/)[0]);
    const renamed = m[1].split(',').map(p => p.trim()).find(p => new RegExp(`^\\w+\\s*:\\s*${name}\\b`).test(p));
    if (names.includes(name) || renamed) {
      return { kind: 'destructure', from: m[2].replace(/\s+as\s+[\s\S]*$/, '').trim(), prop: renamed ? renamed.split(':')[0].trim() : name };
    }
  }
  const alias = new RegExp(`(?:const|let)\\s+${name}\\s*(?::[^=]+)?=\\s*([^;\\n]+)`).exec(body);
  if (alias) return { kind: 'alias', from: alias[1].trim() };
  return null;
}

/** Every call of `key` from a door-reached function: the caller and its argument list. */
function callersOf(key) {
  const name = key.split(':').pop();
  const out = [];
  for (const caller of DOOR_REACHED) {
    const e = INDEX.bodies.get(caller);
    for (const m of e.body.matchAll(new RegExp(`(?<![\\w$.])${name}\\s*\\(`, 'g'))) {
      if (INDEX.resolve(e.file, name) !== key) continue;
      out.push({ caller, args: argumentsOf(e.body, m.index + m[0].length - 1, `${caller} -> ${name}`).map(a => a.trim()) });
    }
  }
  return out;
}

/**
 * Trace `name` in `key` back to an admitted space. Returns the findings: an empty list means every path reached a
 * terminal that admits the space.
 */
function trace(key, name, depth = 0, path = []) {
  const here = [...path, `${key.split(':').pop()}(${name})`];
  const fail = (why) => [`${here.join(' <- ')}: ${why}`];
  if (depth > 8) return fail('gave up after 8 hops');
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return fail(`the space is the expression \`${name}\`, not a binding that traces to an admission`);
  const e = INDEX.bodies.get(key);
  const b = bindingOf(e.body, name);
  if (b?.kind === 'forOf') {
    return /\.spaces$/.test(b.from) ? [] : fail(`iterates \`${b.from}\`, not the spaces a network carries`);
  }
  if (b?.kind === 'destructure') {
    if (/^req\.query$/.test(b.from)) {
      if (!e.synthetic) return fail('reads req.query outside a route registration');
      return new RegExp(`(?:pushAllowed\\(\\s*res\\s*,|spaceAllowed\\()\\s*${name}\\b`).test(e.body)
        ? [] : fail(`reads \`${name}\` from req.query but the route never admits it`);
    }
    const params = paramsOf(key);
    const at = params.indexOf(b.from);
    if (at === -1) return fail(`taken from \`${b.from}\` — ${b.from === name ? '' : 'not a parameter, '}a value the door was handed, not an admission`);
    return viaCallers(key, at, here, depth, b.prop);
  }
  if (b?.kind === 'alias') return trace(key, b.from, depth + 1, here);
  if (!e.synthetic) {
    const at = paramsOf(key).indexOf(name);
    if (at > -1) return viaCallers(key, at, here, depth);
  }
  return fail('not bound to a parameter, a req.query destructure or a loop over network spaces');
}

/** Follow parameter `at` (optionally its property `prop`) of `key` to every door-reached caller. */
function viaCallers(key, at, here, depth, prop) {
  const calls = callersOf(key);
  if (calls.length === 0) return [`${here.join(' <- ')}: no door-reached caller to trace it through`];
  return calls.flatMap(({ caller, args }) => {
    const arg = args[at] ?? '';
    if (prop === undefined) return trace(caller, arg, depth + 1, here);
    if (!arg.startsWith('{')) return [`${here.join(' <- ')}: ${caller} passes \`${arg.slice(0, 40)}\`, not an object literal naming ${prop}`];
    const props = argumentsOf(arg, 0, `${caller} options`).map(p => p.trim());
    const hit = props.find(p => p === prop || p.startsWith(`${prop}:`));
    if (!hit) return [`${here.join(' <- ')}: ${caller} hands no \`${prop}\``];
    return trace(caller, hit === prop ? prop : hit.slice(prop.length + 1).trim(), depth + 1, here);
  });
}

describe('the derivation works', () => {
  it('found both doors and the apply (floors)', () => {
    assert.ok(PUSH_ROUTE, `no POST ${PUSH_PATH} among the mounted routes — re-anchor`);
    assert.ok(ENGINE_ROOTS.length >= 10, `only ${ENGINE_ROOTS.length} function(s) in ${ENGINE} — re-anchor`);
    assert.ok(APPLIES.length >= 1, `POST ${PUSH_PATH} reaches no write to a tombstones collection — the walk is broken`);
  });

  it('the alias middleware runs before the tombstone router, so req.query names the LOCAL space', () => {
    const src = INDEX.sources.get(PUSH_ROUTE.file);
    const router = /export const (\w+)\s*=\s*Router\(\)/.exec(src)?.[1];
    assert.ok(router, `${PUSH_ROUTE.file} exports no Router — re-anchor`);
    const index = INDEX.sources.get(SYNC_INDEX);
    const alias = index.indexOf('.use(resolveNetworkSpaceAlias)');
    const mount = index.indexOf(`.use(${router})`);
    assert.ok(alias > -1 && mount > -1, `${SYNC_INDEX} mounts neither the alias middleware nor ${router} where expected — re-anchor`);
    assert.ok(alias < mount, 'the tombstone router is mounted before the alias middleware: req.query holds the network id');
  });

  it('the tracer accepts both admissions and refuses the network id (fixtures: the engine and route as they stand)', () => {
    // A tracer that answers [] for everything would pass the rule below; one that answers a finding for everything
    // would fail it for the wrong reason. Both terminals, and one refusal, on code that does not change in the fix.
    const routeKey = PUSH_ROOTS[0];
    assert.deepEqual(trace(routeKey, 'spaceId'), [], 'the push route\'s admitted spaceId does not trace to req.query');
    const pull = `${ENGINE}:pullFromPeer`;
    assert.ok(INDEX.bodies.has(pull), `${pull} is gone — re-anchor this fixture`);
    assert.deepEqual(trace(pull, 'spaceId'), [], 'the engine\'s local spaceId does not trace to its loop over network spaces');
    assert.notDeepEqual(trace(pull, 'remoteSpaceId'), [], 'the network\'s id for the space traced as an admission');
  });
});

describe('a peer tombstone is applied to the admitted space', () => {
  it('both doors reach the same apply', () => {
    const notPulled = APPLIES.filter(k => !PULL_REACHED.has(k));
    assert.deepEqual(notPulled, [], 'the push applies tombstones through a function the pull never reaches: two applies');
  });

  it('the apply routes every collection by a parameter, never by the tombstone\'s own spaceId', () => {
    const wrong = [];
    for (const key of APPLIES) {
      const params = paramsOf(key);
      const by = routedBy(INDEX.bodies.get(key).body);
      assert.ok(by.size >= 1, `${key} builds no collection name — re-anchor routedBy`);
      for (const name of by) {
        if (params.includes(name)) continue;
        const b = bindingOf(INDEX.bodies.get(key).body, name);
        wrong.push(`${key} routes by \`${name}\`${b ? `, taken from \`${b.from}\`` : ''} — its parameters are (${params.join(', ')})`);
      }
    }
    assert.deepEqual(wrong, [], 'the apply chooses the space from what arrived, so a peer admitted to one space writes another');
  });

  it('every caller hands the apply a space that traces to an admission', () => {
    const findings = [];
    for (const key of APPLIES) {
      const params = paramsOf(key);
      const spaceParams = [...routedBy(INDEX.bodies.get(key).body)].filter(n => params.includes(n));
      if (spaceParams.length === 0) { findings.push(`${key} takes no space parameter at all`); continue; }
      for (const p of spaceParams) {
        const calls = callersOf(key);
        assert.ok(calls.length >= 2, `${key} has ${calls.length} door-reached caller(s) — expected the push and the pull`);
        for (const { caller, args } of calls) findings.push(...trace(caller, args[params.indexOf(p)] ?? '(missing)'));
      }
    }
    assert.deepEqual(findings, [], 'a door hands the apply a space that is not the one it admitted');
  });
});
