/**
 * An `iterates` rights row is enforced by its handler's SPACE LOOP, so the loop must run at the rung the row names.
 *
 * ## The defect (`Q-304`)
 *
 * A `scope: 'iterates'` route names no space. It walks the spaces the token can reach and resolves the space from
 * the record, so the middleware cannot gate it (`auth/middleware.ts` passes every non-`path` row) and the ITERATION
 * SET is the whole enforcement point — `auth/space-rights.ts` says so above the Data quality rows: *"narrow the loop
 * to spaces holding `needs`, do not gate the call"*.
 *
 * `POST /api/duplicates/:id/merge` carries `dataQuality` / `write`, and resolved its candidate through
 * `findCandidate`, whose loop ran at `read`. `denyReadOnly` in front of it asks only whether the token may write
 * ANYWHERE. So a token holding `dataQuality: read` in space S and `write` in any other space listed S's candidates
 * (GET, at read) and merged one — deleting an entity in S, a space where it may only read. Its siblings, dismiss and
 * reopen, narrowed at `write` all along; the row was right and one loop was not.
 *
 * Nothing saw it, because the gate for rights rows (`a-rights-row-is-reachable-at-the-rung-it-names`) exempts every
 * `iterates` row — correctly, since its question is about a path — and nothing asked the loop's question instead.
 *
 * ## The rule, over every `iterates` row
 *
 * The rows are DERIVED from `ROUTE_RIGHTS` and each is matched to its real registration (`mountedRoutes`). From the
 * handler, every call is followed through the module index with its string arguments BOUND — so a wrapper such as
 * `accessibleSpaces(req, needs = 'read')` or `findCandidate(id, rights)` resolves to the rung it actually passes,
 * default included — down to the rung primitives of `auth/reachable-spaces.ts`. Those primitives are read from
 * that module too: every export taking an `area` and a `needs`, the one returning `string[]` being the iteration set.
 *
 * - **A row whose handler reaches the iteration set at its area loops at exactly its rung.** Below it is the leak
 *   above; above it is a row advertising a rung that cannot open the door. A loop whose area or rung does not
 *   resolve to a literal is reported, never assumed.
 * - **A row whose handler has no such loop is governed per space instead** — today the Networks rows, which check
 *   every space a network carries (`auth/network-rights.ts`). This gate does not judge THAT rung (the refusal is a
 *   decision with several rungs in it, owned and tested where it is made), but it fails a row that reaches neither
 *   shape: an `iterates` row with no rung check at its area is a row nothing enforces.
 *
 * Run: node --test testing/standalone/an-iterates-row-loops-at-its-rung.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mountedRoutes } from './_routes.mjs';
import { moduleIndex } from './_call-graph.mjs';
import { argumentsOf } from './_structural-window.mjs';

const { ROUTE_RIGHTS } = await import('../../server/dist/auth/space-rights.js');
const { RUNGS } = await import('../../server/dist/config/rights-shape.js');

const PRIMITIVES_FILE = 'server/src/auth/reachable-spaces.ts';

/** Words followed by `(` that are not calls — the same exclusions the call graph makes. */
const NOT_A_CALL = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'function', 'yield', 'delete',
  'void', 'in', 'of', 'do', 'else', 'new', 'import', 'require', 'super', 'throw', 'case', 'instanceof',
]);

const index = moduleIndex(['server/src']);

/**
 * The parameter list of a top-level function, as `[{ name, dflt }]` — `dflt` the string literal a parameter
 * defaults to, when it has one. `null` when the key is not a named top-level function (an object method, a
 * synthetic route body): nothing is bound then, and an argument read through it stays unresolved.
 */
function paramsOf(key) {
  const entry = index.bodies.get(key);
  if (!entry || entry.synthetic || entry.name.includes('.')) return null;
  const src = index.sources.get(entry.file);
  const name = entry.name.replace(/[$]/g, '\\$');
  const decl = new RegExp(
    `(?:^|\\n)(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${name}\\s*(?:<[^>(]*>)?\\s*\\(`
    + `|(?:^|\\n)(?:export\\s+)?(?:const|let)\\s+${name}\\s*(?::[^=\\n]*)?=\\s*(?:async\\s+)?(?:<[^>(]*>)?\\s*\\(`,
  ).exec(src);
  if (!decl) return null;
  const paren = decl.index + decl[0].length - 1;
  return argumentsOf(src, paren, `${key}: its parameters`).map(p => {
    const n = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(p);
    const d = /=\s*(['"])([^'"]*)\1\s*$/.exec(p);
    return { name: n ? n[1] : null, dflt: d ? d[2] : null };
  });
}

/** A call argument's value: a string literal, or a parameter bound to one. Anything else is `null` — unknown. */
function valueOf(expr, env) {
  if (expr === undefined) return undefined;
  const lit = /^(['"])([^'"]*)\1$/.exec(expr.trim());
  if (lit) return lit[2];
  const id = /^([A-Za-z_$][\w$]*)$/.exec(expr.trim());
  if (id && Object.hasOwn(env, id[1])) return env[id[1]];
  return null;
}

/**
 * The rung primitives, read from `auth/reachable-spaces.ts`: every export with an `area` and a `needs` parameter.
 * The one that answers with a LIST of spaces is the iteration set; the rest are per-space predicates.
 */
function primitives() {
  const src = index.sources.get(PRIMITIVES_FILE);
  assert.ok(src, `${PRIMITIVES_FILE} is not in the index — re-anchor the primitives`);
  const out = new Map();
  for (const m of src.matchAll(/(?:^|\n)export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const key = `${PRIMITIVES_FILE}:${m[1]}`;
    const params = paramsOf(key) ?? [];
    const areaAt = params.findIndex(p => p.name === 'area');
    const needsAt = params.findIndex(p => p.name === 'needs');
    if (areaAt < 0 || needsAt < 0) continue;
    const paren = m.index + m[0].length - 1;
    const close = src.indexOf('{', paren);
    const signature = src.slice(paren, close);
    out.set(key, { name: m[1], areaAt, needsAt, loop: /\)\s*:\s*string\[\]\s*$/.test(signature) });
  }
  return out;
}

const PRIMS = primitives();

/**
 * Every rung check a key reaches, with its area and rung resolved through the bindings of the path that reached it.
 *
 * Exhaustive and environment-sensitive: the same wrapper reached with `'read'` and with `'write'` is two visits,
 * because they are two different checks. A primitive is a leaf — what it does inside is not this gate's question.
 */
function checksFrom(rootKey) {
  const found = [];
  const seen = new Set();
  const visit = (key, env, chain) => {
    const prim = PRIMS.get(key);
    if (prim) return;  // reached only through a call site below, where its arguments are known
    const memo = `${key}|${JSON.stringify(Object.entries(env).sort())}`;
    if (seen.has(memo)) return;
    seen.add(memo);
    const entry = index.bodies.get(key);
    if (!entry) return;
    // A declaration is not a call: `function x(` inside a body would otherwise read as calling `x`.
    const body = entry.body.replace(/\bfunction\s*\*?\s*[A-Za-z_$][\w$]*\s*\(/g, 'function (');
    /*
     * LOOKBEHIND, not a consumed prefix character. `(^|[^.\w$])name\(` eats the `(` before a call, so in
     * `new Set(accessibleSpaces(req, 'write'))` the match for `Set(` swallows the very character the inner call
     * needs, and the call that IS the loop is never seen — `POST /api/duplicates/scan` read as enforced by nothing.
     */
    const calls = [];
    for (const m of body.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*(?:<[^>(;]*>)?\s*\(/g)) {
      if (NOT_A_CALL.has(m[1])) continue;
      calls.push({ target: index.resolve(entry.file, m[1]), paren: m.index + m[0].length - 1, label: m[1] });
    }
    for (const m of body.matchAll(/(?<![.\w$?])([A-Za-z_$][\w$]*)\s*\??\.\s*([A-Za-z_$][\w$]*)\s*(?:<[^>(;]*>)?\s*\(/g)) {
      calls.push({ target: index.resolveMember(entry.file, m[1], m[2]), paren: m.index + m[0].length - 1, label: `${m[1]}.${m[2]}` });
    }
    for (const c of calls) {
      if (!c.target) continue;
      let args;
      try { args = argumentsOf(body, c.paren, `${key}: ${c.label}(`); } catch { continue; }
      const prim = PRIMS.get(c.target);
      if (prim) {
        found.push({
          primitive: prim.name, loop: prim.loop,
          area: valueOf(args[prim.areaAt], env), rung: valueOf(args[prim.needsAt], env),
          via: [...chain, `${prim.name}(${args.join(', ')})`].join(' -> '),
        });
        continue;
      }
      const params = paramsOf(c.target);
      const next = {};
      if (params) {
        params.forEach((p, i) => {
          if (!p.name) return;
          const v = args[i] === undefined || args[i] === 'undefined' ? (p.dflt ?? undefined) : valueOf(args[i], env);
          if (v !== undefined) next[p.name] = v;
        });
      }
      visit(c.target, next, [...chain, c.label]);
    }
  };
  visit(rootKey, {}, []);
  return found;
}

/** The handler of one registration, as a key the walk can start from: the LAST argument — the middleware is not the loop. */
function handlerRoot(route) {
  const src = index.sources.get(route.file);
  assert.ok(src, `${route.file} is not in the index`);
  const open = src.indexOf('(', route.at);
  const args = argumentsOf(src, open, `${route.method} ${route.path}: the registration`);
  const handler = args[args.length - 1];
  const named = /^([A-Za-z_$][\w$]*)$/.exec(handler);
  if (named) {
    const key = index.resolve(route.file, named[1]);
    assert.ok(key, `${route.method} ${route.path}: its handler \`${named[1]}\` resolves to no function`);
    return key;
  }
  const key = `${route.file}:${route.method} ${route.path} (handler)`;
  index.bodies.set(key, { file: route.file, name: key, body: handler, start: open, end: open, synthetic: true });
  return key;
}

describe('an iterates row is enforced by its loop at the rung it names', () => {
  const rows = ROUTE_RIGHTS.filter(r => r.scope === 'iterates');
  const regs = mountedRoutes();

  it('derived the rows, the primitives and the registrations', () => {
    // Floors, not counts: an empty derivation passes every loop below while checking nothing.
    assert.ok(rows.length >= 20, `only ${rows.length} iterates rows derived from ROUTE_RIGHTS — the filter is wrong`);
    assert.ok([...PRIMS.values()].some(p => p.loop), `no iteration-set primitive found in ${PRIMITIVES_FILE}`);
    assert.ok([...PRIMS.values()].some(p => !p.loop), `no per-space predicate found in ${PRIMITIVES_FILE}`);
    const unmatched = rows.filter(row => !regs.some(r => r.method === row.method && r.path === row.route))
      .map(row => `${row.method} ${row.route}`);
    assert.deepEqual(unmatched, [], `these iterates rows match no registration, so nothing below reads them:\n  ${unmatched.join('\n  ')}`);
  });

  const judged = rows.map(row => {
    const reg = regs.find(r => r.method === row.method && r.path === row.route);
    const checks = reg ? checksFrom(handlerRoot(reg)) : [];
    return { row, key: `${row.area}/${row.needs}  ${row.method} ${row.route}`, checks };
  });
  const atArea = (j, loop) => j.checks.filter(c => c.loop === loop && (c.area === j.row.area || c.area === null));

  it('the walk resolves a loop for the Data quality rows', () => {
    // The instrument, shown to work: `GET /api/duplicates` loops through a wrapper with a DEFAULT rung, which is
    // the binding a careless resolver gets wrong. If this does not resolve, every verdict below is about nothing.
    const list = judged.find(j => j.row.method === 'GET' && j.row.route === '/api/duplicates');
    assert.ok(list, 'GET /api/duplicates has no iterates row — re-anchor this instrument check');
    assert.deepEqual([...new Set(atArea(list, true).map(c => c.rung))], ['read'],
      `the walk did not resolve GET /api/duplicates to a loop at 'read': ${JSON.stringify(list.checks)}`);
    assert.ok(judged.filter(j => atArea(j, true).length > 0).length >= 12,
      'fewer than twelve iterates rows resolved to a space loop — the walk has stopped following the wrappers');
  });

  it('every space loop an iterates handler runs at its area is at exactly the row\'s rung', () => {
    const offenders = [];
    for (const j of judged) {
      for (const c of atArea(j, true)) {
        if (c.area === null || c.rung === null) offenders.push(`${j.key}: a loop whose area or rung does not resolve — ${c.via}`);
        else if (c.rung !== j.row.needs) {
          const dir = RUNGS.indexOf(c.rung) < RUNGS.indexOf(j.row.needs) ? 'BELOW' : 'above';
          offenders.push(`${j.key}: loops at '${c.rung}', ${dir} the row — ${c.via}`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      'an iterates row is enforced by its loop and nothing else; a loop below the row reaches spaces the grid '
      + 'excludes, one above it makes the row a rung that cannot open the door:\n  ' + offenders.join('\n  '));
  });

  it('an iterates row with no space loop is governed per space instead, never by nothing', () => {
    const ungoverned = judged
      .filter(j => atArea(j, true).length === 0)
      .filter(j => !j.checks.some(c => !c.loop && c.area === j.row.area))
      .map(j => j.key);
    assert.deepEqual(ungoverned, [],
      'these iterates rows reach no rung check at their area — no loop narrowed to it and no per-space '
      + `predicate — so the row is enforced nowhere:\n  ${ungoverned.join('\n  ')}`);
  });
});
