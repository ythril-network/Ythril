/**
 * Every route that accepts `typeSchemas` refuses a broken library `$ref`, through the one refusal the package declares.
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
 * ## One refusal, and what this gate keys on (Q-668, 4', B2, S4)
 *
 * The check was written five times — the package's `validateSpaceMeta`, the two planners and the two schema PUTs, the PUTs with the
 * "not found" sentence typed out by hand — because this gate keyed on the finder's name and on a message literal, so a copy of the
 * sequence was the way to satisfy it. The package now declares `libraryRefRefusal(typeSchemas, library?)`, the finders and their
 * wording are package-internal, and this gate requires a call of `libraryRefRefusal(` and a 422 in the route's own handler or in the
 * server-side function it delegates to. Never the package's source: the earlier gate appended `schema/src` to any delegate that imported
 * the package, so a route whose delegate merely imported it passed (B2). A function imported from the schema package or
 * its internal entry is the package's, and a call of it is not the route consulting the refusal.
 *
 * ## Why this is derived rather than a list of four routes
 *
 * A list would have been written against the routes that existed and agreed with itself. This finds every
 * route handler that takes `typeSchemas` from a request and requires each one to consult the refusal — so a
 * fifth route added later is covered on the day it is written, which is the only time it is cheap. The readers it stands on are proved
 * on a planted router whose routes skip the call in each way a route could.
 *
 * Run: node --test testing/standalone/broken-library-ref-refused-everywhere.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';
import { SCHEMA_PACKAGE_NAME, RETIRED_SCHEMA_PACKAGE_NAME, schemaSpecifierSource } from './_relative-specifier.mjs';

const ROOT = process.cwd();
const ROUTER = 'server/src/api/spaces.ts';
/** The package's two entries (named from its manifest through the one specifier source): a name imported from either is the package's, never a server-side delegate. The retired name is neither. */
const PACKAGE_SPECIFIER = new RegExp(`^${schemaSpecifierSource(['', '/internal'])}$`);
/** The one refusal, called. */
const CHECK = /\blibraryRefRefusal\s*\(/;

/** A repo file's source with its comments out, so a comment naming the call neither satisfies nor trips a rule. */
const readRepo = (file) => stripComments(readFileSync(join(ROOT, file), 'utf8'));

/** Route handlers: from one `spacesRouter.<verb>(` to the next. */
function routesOf(src) {
  const starts = [...src.matchAll(/spacesRouter\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)]
    .map(m => ({ verb: m[1], path: m[2], at: m.index }));
  return starts.map((s, i) => ({ ...s, body: src.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : src.length) }));
}

/**
 * `localName -> { file, exported } | { package }` for every named import of `text` (written in `fromFile`), static and dynamic. A
 * relative specifier resolves to the `.ts` file it names; the schema package and its internal entry are the package's.
 */
function importsOf(text, fromFile) {
  const byName = new Map();
  const add = (clause, spec) => {
    const pkg = PACKAGE_SPECIFIER.test(spec);
    if (!pkg && !spec.startsWith('.')) return;
    const file = pkg ? null : posix.join(posix.dirname(fromFile), spec).replace(/\.js$/, '.ts');
    for (const raw of clause.split(',')) {
      const part = raw.trim().replace(/^type\s+/, '');
      const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+|\s*:\s*)?([A-Za-z_$][\w$]*)?$/.exec(part);
      if (!m) continue;
      byName.set(m[2] ?? m[1], pkg ? { package: spec } : { file, exported: m[1] });
    }
  };
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'([^']+)'/g)) add(m[1], m[2]);
  for (const m of text.matchAll(/\{([^{}();]*)\}\s*=\s*await\s+import\s*\(\s*'([^']+)'\s*\)/g)) add(m[1], m[2]);
  return byName;
}

/**
 * Where a handler consults the refusal: `{ where, text }` — its own body, or the body of the ONE server-side function it calls that
 * does. `null` when nothing in reach calls it, which is the defect this file exists to catch. `read(file)` gives a file's source,
 * comments out.
 *
 * The delegate is the called FUNCTION's body, not its module: a module whose other function calls the refusal does not make this one
 * refuse. One hop: at two, the gate would be asserting the shape of a call graph rather than "this route refuses".
 */
function effectiveChecker(handlerBody, imports, read) {
  if (CHECK.test(handlerBody)) return { where: 'the handler', text: handlerBody };
  for (const [name, imp] of imports) {
    if (imp.package) continue;
    if (!new RegExp(`(?<![\\w$.])${name}\\s*\\(`).test(handlerBody)) continue;
    let body;
    try { body = bodyOf(read(imp.file), imp.exported); } catch { continue; }
    if (CHECK.test(body)) return { where: `${imp.file}:${imp.exported}`, text: body };
  }
  return null;
}

/** Text that takes schemas: `typeSchemas` named, or `meta` destructured from a parsed body (the route that had the defect did that). */
const TAKES_SCHEMAS = /typeSchemas|const \{[^}]*\bmeta\b[^}]*\} = parsed\.data/;

/**
 * The mutating handlers that take schemas from the caller: the handler's own text says so, or the server-side function it hands the
 * body to does. The create route names neither `typeSchemas` nor `meta` (`planSpaceCreate(req.body)`); its planner does.
 */
function takingSchemas(routes, imports, read) {
  return routes.filter(r => ['post', 'put', 'patch'].includes(r.verb)).filter(r => {
    if (TAKES_SCHEMAS.test(r.body)) return true;
    for (const [name, imp] of imports) {
      if (imp.package || !new RegExp(`(?<![\\w$.])${name}\\s*\\(`).test(r.body)) continue;
      try { if (TAKES_SCHEMAS.test(bodyOf(read(imp.file), imp.exported))) return true; } catch { /* not a function of that file */ }
    }
    return false;
  });
}

/** The routes among `routes` that take schemas and reach no refusal, as `VERB /path`. */
function offendersOf(routes, imports, read) {
  return takingSchemas(routes, imports, read).filter(r => !effectiveChecker(r.body, imports, read)).map(r => `${r.verb.toUpperCase()} ${r.path}`);
}

describe('the readers this gate stands on (proved on a planted router)', () => {
  const files = new Map([
    ['fx/api/router.ts', `
import { planGood, planSkip } from '../spaces/plans.js';
import { validateSpaceMeta } from '${SCHEMA_PACKAGE_NAME}/internal';
import { parseSpaceMeta } from '${SCHEMA_PACKAGE_NAME}';
import { retiredCheck } from '${RETIRED_SCHEMA_PACKAGE_NAME}';
spacesRouter.post('/', async (req, res) => { const d = planGood(req.body); res.status(d.status).json(d.body); });
spacesRouter.put('/:id/schema', async (req, res) => { const { typeSchemas } = req.body; res.json({ typeSchemas }); });
spacesRouter.patch('/:id', async (req, res) => { const d = planSkip(req.body); res.status(d.status).json(d.body); });
spacesRouter.post('/:id/pkg', async (req, res) => { const { typeSchemas } = req.body; const r = validateSpaceMeta({ typeSchemas }); res.status(r.ok ? 200 : 422).json(r); });
spacesRouter.post('/:id/retired', async (req, res) => { const { typeSchemas } = req.body; const r = retiredCheck({ typeSchemas }); res.status(r.ok ? 200 : 422).json(r); });
spacesRouter.put('/:id/comment', async (req, res) => {
  const { typeSchemas } = req.body;
  // libraryRefRefusal(typeSchemas) would go here
  res.status(422).json({});
});
spacesRouter.put('/:id/inline', async (req, res) => { const r = libraryRefRefusal(req.body.typeSchemas); if (r) return res.status(422).json({ error: r.message }); });
`],
    ['fx/spaces/plans.ts', `
import { libraryRefRefusal } from '${SCHEMA_PACKAGE_NAME}';
export function planGood(body) {
  const refusal = libraryRefRefusal(body.typeSchemas);
  if (refusal) return { status: 422, body: { error: refusal.message } };
  return { ok: true };
}
export function planSkip(body) {
  return { ok: true, typeSchemas: body.typeSchemas };
}
export function neighbour(body) {
  return libraryRefRefusal(body.typeSchemas);
}
`],
  ]);
  const read = (file) => stripComments(files.get(file) ?? '');
  const routerText = read('fx/api/router.ts');
  const imports = importsOf(routerText, 'fx/api/router.ts');

  it('reads both package entries as the package\'s, and a relative import as the file it names', () => {
    assert.deepEqual(imports.get('validateSpaceMeta'), { package: `${SCHEMA_PACKAGE_NAME}/internal` });
    assert.deepEqual(imports.get('parseSpaceMeta'), { package: SCHEMA_PACKAGE_NAME });
    assert.deepEqual(imports.get('planGood'), { file: 'fx/spaces/plans.ts', exported: 'planGood' });
  });

  it('does not read an import of the RETIRED package name as the package\'s or as a server file (the name resolves to nothing)', () => {
    assert.equal(imports.has('retiredCheck'), false);
  });

  it('flags a route that skips the call: inline, through a delegate whose NEIGHBOUR calls it, through the package, or in a comment', () => {
    assert.deepEqual(offendersOf(routesOf(routerText), imports, read).sort(),
      ['PATCH /:id', 'POST /:id/pkg', 'POST /:id/retired', 'PUT /:id/comment', 'PUT /:id/schema']);
  });

  it('accepts a route that calls it inline or through its delegate, and says where', () => {
    const routes = routesOf(routerText);
    assert.equal(effectiveChecker(routes.find(r => r.path === '/').body, imports, read).where, 'fx/spaces/plans.ts:planGood');
    assert.equal(effectiveChecker(routes.find(r => r.path === '/:id/inline').body, imports, read).where, 'the handler');
  });
});

describe('a broken schema-library $ref is refused on every route that accepts one', () => {
  const src = readRepo(ROUTER);
  const all = routesOf(src);
  const imports = importsOf(src, ROUTER);

  it('found the routes to check', () => {
    // Floors the enumeration — a changed router name would otherwise make every check below vacuous.
    assert.ok(all.length >= 10, `only found ${all.length} route handlers in ${ROUTER}`);
    assert.ok(all.some(r => r.verb === 'post' && r.path === '/'), 'the space-create route must be among them');
    const taking = takingSchemas(all, imports, readRepo);
    assert.ok(taking.length >= 4, `only ${taking.length} handlers read as taking schemas: the scope reader is broken`);
  });

  it('every handler that reads typeSchemas from the request calls libraryRefRefusal, itself or in its delegate', () => {
    assert.deepEqual(offendersOf(all, imports, readRepo), [],
      'these accept `typeSchemas` from a request without calling `libraryRefRefusal(` — in the handler or in the server-side function it '
      + 'delegates to. An unresolvable ref degrades to an empty schema, so in a strict space the type silently loses every constraint '
      + 'while the call reports success — and the other routes answer 422 for the same input.');
  });

  it('the create route refuses BEFORE the space exists', () => {
    // Ordering is the guarantee: a check after `createSpace` would leave a space behind whose schema is the thing being rejected.
    // What holds the ordering is the signature: `applySpaceCreate` takes a `SpaceCreatePlan`, and a plan is only ever constructed by
    // `planSpaceCreate`, after the refusal, in the expression that returns `ok: true`.
    const create = all.find(r => r.verb === 'post' && r.path === '/');
    assert.ok(effectiveChecker(create.body, imports, readRepo), 'the create route must reach libraryRefRefusal, directly or by delegation');

    const planner = readRepo('server/src/spaces/space-create.ts');
    assert.match(planner, /export async function applySpaceCreate\(plan: SpaceCreatePlan, creator: SpaceCreator\)/,
      'apply must take a SpaceCreatePlan and nothing looser, or a caller could assemble one without the checks');
    assert.match(planner, /await createSpace\(plan\.args, creator\)/, 'and it must create from the PLAN, not from a body');

    const planFn = bodyOf(planner, 'planSpaceCreate');
    const check = planFn.search(CHECK);
    const built = planFn.indexOf('ok: true');
    assert.ok(check > 0 && built > check, 'libraryRefRefusal must run before a plan is returned');
    assert.equal((planner.match(/ok: true,\s*\n\s*plan: \{/g) ?? []).length, 1,
      'a second place constructing a plan is a second way to reach createSpace without the check');
  });

  it('every route that checks answers 422 from the same place it checks', () => {
    // A delegate reports the status in its refusal rather than by calling `res`, so 422 is matched as a bare status.
    const checking = all.map(r => ({ r, found: effectiveChecker(r.body, imports, readRepo) })).filter(x => x.found);
    assert.ok(checking.length >= 4, `only ${checking.length} routes call libraryRefRefusal; expected the create route plus three editors`);
    for (const { r, found } of checking) {
      assert.match(found.text, /\b422\b/, `${r.verb.toUpperCase()} ${r.path} calls libraryRefRefusal in ${found.where} but answers no 422 there`);
    }
  });
});
