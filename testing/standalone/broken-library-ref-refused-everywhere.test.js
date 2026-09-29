/**
 * Every route that accepts `typeSchemas` refuses a broken library `$ref`.
 *
 * ## The report
 *
 * An operator setting up a NEW space declared a type as `{"$ref": "library:cross-space-reference"}` and it
 * came back as `{}` — while the create reported success. Their words: *"in a `strict` space, one mistyped ref
 * removes every constraint from a type and reports success"*, and they noted the behaviour is inconsistent
 * with the full-replace route, which returns 422.
 *
 * They were right, and the asymmetry was narrower than they could see from outside: the three routes that
 * EDIT meta — `PATCH /:id`, `PUT /:id/schema`, `PUT /:id/meta/typeSchemas/:kt/:name` — all answered 422
 * already. Only `POST /` did not, so the identical mistake was loud on every path except the one people make
 * it on, which is the one where the space and its schema arrive together.
 *
 * It matters most in a `strict` space, and `POST /` is the handler that SEEDS `validationMode: 'strict'`: one
 * mistyped ref leaves that type with no constraints, and the space then accepts anything for it while its
 * schema looks authored.
 *
 * ## Why this is derived rather than a list of four routes
 *
 * A list would have been written against the routes that existed and agreed with itself. This finds every
 * route handler that takes `typeSchemas` from a request and requires each one to consult the checker — so a
 * fifth route added later is covered on the day it is written, which is the only time it is cheap.
 *
 * Run: node --test testing/standalone/broken-library-ref-refused-everywhere.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = process.cwd();
const SRC = 'server/src/api/spaces.ts';
const src = readFileSync(join(ROOT, SRC), 'utf8');

/** Split the file into route handlers: from one `spacesRouter.<verb>(` to the next. */
function routes() {
  const starts = [];
  const re = /spacesRouter\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) starts.push({ verb: m[1], path: m[2], at: m.index });
  return starts.map((s, i) => ({
    ...s,
    body: src.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : src.length),
  }));
}

/**
 * Local name → source text, for every module this router imports from `../…`.
 *
 * Needed because a handler is allowed to DELEGATE the check. `PATCH /:id` now calls `planSpaceMetaUpdate`, which
 * owns the whole refusal chain so an MCP tool can reach the same rules — and a gate that only accepted an inline
 * call would have to be weakened for every such extraction, one route at a time.
 *
 * The delegate is RESOLVED and READ rather than named in an allowlist. That is the difference between following
 * the check and taking a route's word for it: `effectiveChecker` below only accepts a delegate whose own source
 * calls the checker, so "I call a function" is not an escape hatch — the function has to do the work.
 */
function resolveImports(text, fromDir) {
  const byName = new Map();
  const re = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'(\.\.?\/[^']+)\.js'/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const file = join(fromDir, `${m[2]}.ts`);
    let body;
    try { body = readFileSync(file, 'utf8'); } catch { continue; }
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim();
      if (name) byName.set(name, { text: body, dir: dirname(file) });
    }
  }
  return byName;
}

const ROUTER_IMPORTS = resolveImports(src, join(ROOT, 'server/src/api'));

/**
 * The source that actually performs the ref check for a handler: its own body, plus — when it delegates — the
 * delegate's source and the source of whatever the delegate calls to build the message.
 *
 * **Two hops, and no more.** The check and its wording are allowed to live one module apart: `planSpaceMetaUpdate`
 * calls `findBrokenLibraryRefs` and answers with `brokenRefsError`, which is declared beside the schema it reads.
 * A third hop would mean this gate no longer reads as "this route refuses"; at that distance it is asserting the
 * shape of a call graph rather than a guarantee, and it would start passing for reasons nobody intended.
 *
 * `null` means nothing in reach checks, which is the defect this file exists to catch.
 */
function effectiveChecker(handlerBody) {
  if (/findBrokenLibraryRefs\(/.test(handlerBody)) return handlerBody;
  for (const [name, mod] of ROUTER_IMPORTS) {
    if (!new RegExp(`\\b${name}\\s*\\(`).test(handlerBody)) continue;
    if (!/findBrokenLibraryRefs\(/.test(mod.text)) continue;
    // Second hop: whatever this delegate calls, so the 422 and its message count wherever they are declared.
    let bundle = mod.text;
    for (const [, dep] of resolveImports(mod.text, mod.dir)) bundle += `\n${dep.text}`;
    return bundle;
  }
  return null;
}

describe('a broken schema-library $ref is refused on every route that accepts one', () => {
  const all = routes();

  it('found the routes to check', () => {
    // Floors the enumeration — a changed router name would otherwise make every check below vacuous.
    assert.ok(all.length >= 10, `only found ${all.length} route handlers in ${SRC}`);
    assert.ok(all.some(r => r.verb === 'post' && r.path === '/'), 'the space-create route must be among them');
  });

  it('every handler that reads typeSchemas from the request consults the ref checker', () => {
    const offenders = [];
    for (const r of all) {
      // Only mutating handlers that take schemas from the CALLER. A read route returning them is not
      // accepting a ref and has nothing to reject.
      if (!['post', 'put', 'patch'].includes(r.verb)) continue;
      // `meta` counts, not just a literal `typeSchemas`. The route that had the defect destructured `meta`
      // from the body and never named `typeSchemas` at all — a detector keyed on that word would have
      // reported the tree clean on the day the bug was live, which is the one day it needed to speak.
      const takesSchemas = /typeSchemas/.test(r.body)
        || /const \{[^}]*\bmeta\b[^}]*\} = parsed\.data/.test(r.body)
        // A handler that hands the whole body to a planner names neither `typeSchemas` nor `meta`. It still
        // accepts schemas — via `req.body` — so it is in scope, and the delegate is what has to check.
        || /planSpaceMetaUpdate\(/.test(r.body);
      if (!takesSchemas) continue;
      if (!effectiveChecker(r.body)) offenders.push(`${r.verb.toUpperCase()} ${r.path}`);
    }
    assert.deepEqual(offenders, [],
      'these accept `typeSchemas` from a request without checking its library refs — directly or through a '
      + 'delegate that checks. An unresolvable ref degrades to an empty schema, so in a strict space the type '
      + 'silently loses every constraint while the call reports success — and the other routes answer 422 for '
      + 'the same input.');
  });

  it('the create route refuses BEFORE the space exists', () => {
    // Ordering is the guarantee: a check after `createSpace` would leave a space behind whose schema is the thing
    // being rejected, and the caller would have to clean it up.
    //
    // The route delegates now, and the two halves live in different functions of `spaces/space-create.ts` — so a
    // position test would be comparing two things that have no order at runtime. What actually holds the ordering is
    // the signature: `applySpaceCreate` takes a `SpaceCreatePlan`, and a plan is only ever constructed by
    // `planSpaceCreate`, after the `$ref` check, in the expression that returns `ok: true`. A caller cannot reach
    // `createSpace` without having passed the check, which is stronger than what this assertion used to say.
    const create = all.find(r => r.verb === 'post' && r.path === '/');
    assert.ok(effectiveChecker(create.body), 'the create route must reach the checker, directly or by delegation');

    const planner = readFileSync(join(ROOT, 'server/src/spaces/space-create.ts'), 'utf8');
    // The second argument is who the space is credited to (Q-134) — it carries no body, so the plan is still the
    // only way in.
    assert.match(planner, /export async function applySpaceCreate\(plan: SpaceCreatePlan, creator: SpaceCreator\)/,
      'apply must take a SpaceCreatePlan and nothing looser, or a caller could assemble one without the checks');
    assert.match(planner, /await createSpace\(plan\.args, creator\)/, 'and it must create from the PLAN, not from a body');

    const planFn = planner.slice(planner.indexOf('export function planSpaceCreate'));
    const check = planFn.indexOf('findBrokenLibraryRefs(');
    const built = planFn.indexOf('ok: true');
    assert.ok(check > 0 && built > check, 'the ref check must run before a plan is returned');
    assert.equal((planner.match(/ok: true,\s*\n\s*plan: \{/g) ?? []).length, 1,
      'a second place constructing a plan is a second way to reach createSpace without the check');
  });

  it('all four answer with the same status and a message naming what is missing', () => {
    // Read from the EFFECTIVE checker, so a route that delegates is held to the same two requirements as one that
    // checks inline. A delegate reports the status in its refusal rather than by calling `res`, which is why 422
    // is matched as a bare status here rather than as `res.status(422)`.
    const checking = all.map(r => ({ r, src: effectiveChecker(r.body) })).filter(x => x.src);
    assert.ok(checking.length >= 4, `only ${checking.length} routes check refs; expected the create route plus three editors`);
    for (const { r, src: checker } of checking) {
      assert.match(checker, /422/, `${r.verb.toUpperCase()} ${r.path} must answer 422`);
      assert.match(checker, /Schema library[^\n]*not found/,
        `${r.verb.toUpperCase()} ${r.path} must name the missing entry — "invalid schema" sends the caller looking in the wrong place`);
    }
  });
});
