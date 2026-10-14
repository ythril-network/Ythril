/**
 * Every path that STORES a schema parses it through the one body schema first (`Q-216`).
 *
 * ## What was found
 *
 * `body-schemas.ts` said *"EVERY write of a type schema parses through here"*, and that was true of the doors a caller reaches and
 * false of the two the network reaches: a passed `meta_change` round went `applyMetaRound` -> `commitOwnMetaEdit` /
 * `storeNetworkLayer` with no parse (`sync/governance.ts`), and `effectiveMeta` then re-parsed the stored layer and SILENTLY dropped
 * one that no longer parsed, so a member could hold a layer it did not run. The stores themselves (`storeNetworkLayer`,
 * `commitOwnMetaEdit`, `updateSpace`'s meta write) parse nothing: what they hold is whatever their caller handed them.
 *
 * ## The rule this holds, and how its subjects are derived
 *
 * A *writer* is any function that hands a meta to a store or writes one itself:
 *
 * - a call of `commitOwnMetaEdit` / `storeNetworkLayer`, or of `updateSpace` with a `meta` in its second argument;
 * - an assignment to a `.schemaLayers`, `.ownMeta` or a space's `.meta`.
 *
 * Every writer outside the two files that ARE the stores (`spaces/effective-meta.ts`, `spaces/spaces.ts`) must parse what it stores:
 * its own body parses through a schema the body-schemas module (or the library door) exports, or it calls a function that does, through
 * a call chain that does not pass through a store. The sets are read from the tree: the schemas from the modules' exports, the writers
 * from the syntax tree, the parsing functions by a fixed point over the call graph. A hand list of doors would agree with itself on
 * the day it was written, which is how a second path came to store a meta unparsed in the first place.
 *
 * ## The exemptions, each with the reason it is safe
 *
 * A writer that stores only what was ALREADY stored (a deletion, a re-keying under a renamed space) or a server-written string
 * parses nothing and needs nothing. Each is listed with that reason; an exemption whose writer disappears fails, so the list cannot
 * outlive its subjects. (The brand the plan adds, `ParsedSpaceMeta`, makes this a type error at the store; this gate is what finds
 * the caller BEFORE the type does, and what keeps a cast around the brand from going unseen — see the mint gate below.)
 *
 * ## Seen red
 *
 * On the unchanged base this is red for the passed-round path in `sync/governance.ts` and for nothing else. {@link scan} is also run
 * over synthetic sources, so the file proves it flags an unparsed store and passes a parsed one without touching the real tree.
 *
 * Run: node --test testing/standalone/every-schema-storing-path-parses-through-the-one-body-schema.test.js
 * (requires a prior server build)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { parseSource, lineOf, ts } from '../_shared/syntax-tree.mjs';

/** The two files that are the stores: they write what they are handed, and their callers are the subjects. */
const STORE_FILES = new Set(['server/src/spaces/effective-meta.ts', 'server/src/spaces/spaces.ts']);

/** The calls that hand a meta to a store. `updateSpace` only counts with a `meta` in its second argument. */
const STORE_CALLS = new Set(['commitOwnMetaEdit', 'storeNetworkLayer']);

/**
 * Writers that store only what was already stored, or a server-written value. The key is `file#unit`, the unit being the function's
 * name or `METHOD /path` for a route handler; the value is why it parses nothing.
 */
const EXEMPT = new Map([
  ['server/src/config/loader.ts#migrateSpaceDescriptionToPurpose', 'a boot migration of a legacy text into meta.purpose, a string cut to 4 000 characters'],
  ['server/src/config/migrate-network-space-keys.ts#migrateNetworkSpaceKeys', 're-keys layers already stored under a renamed space id; every layer is what was stored'],
  ['server/src/spaces/rename.ts#applySpaceRenameToConfig', 'moves a stored layer to the renamed space id; the layer is what was stored'],
  ['server/src/spaces/meta-update.ts#applySpaceMetaUpdate', 'stores plan.mergedMeta, which planSpaceMetaUpdate built from the parsed body and the stored meta (the brand carries that through the plan)'],
]);

/** A schema body's `safeParse`/`parse` call, or one of the two mint functions the plan names. */
const mintCall = /^parse(?:SpaceMeta|TypeSchema)$/;

/** Is `node` a function-like thing that can be a unit? */
const isUnit = (n) => ts.isFunctionLike(n) && !ts.isConstructorDeclaration(n);

/** A readable name for the unit a node sits in: the function's name, or `VERB path` for a route handler argument. */
function unitName(unit, sf) {
  if ((ts.isFunctionDeclaration(unit) || ts.isMethodDeclaration(unit)) && unit.name) return unit.name.text;
  const parent = unit.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression;
    if (ts.isPropertyAccessExpression(callee) && /^(get|post|put|patch|delete)$/.test(callee.name.text)) {
      const first = parent.arguments[0];
      if (first && ts.isStringLiteralLike(first)) return `${callee.name.text.toUpperCase()} ${first.text}`;
    }
  }
  return `<anonymous:${lineOf(sf, unit)}>`;
}

/** The innermost function-like ABOVE `node` (a call's own argument closures are below it, so they are not it). */
function enclosingUnit(node) {
  for (let p = node.parent; p; p = p.parent) if (isUnit(p)) return p;
  return null;
}

/** The text of `node` without its type assertions, so `(x as Y).meta` reads as `x.meta`. */
const plain = (node, sf) => node.getText(sf).replace(/\s+/g, '');

/**
 * Every writer unit in one source, and what it does.
 *
 * @returns {{unit: string, line: number, why: string, parses: boolean, callees: string[]}[]}
 */
function writersIn(file, text, parserNames) {
  const sf = parseSource(file, stripComments(text));
  const found = new Map();
  const note = (unitNode, why, node) => {
    if (!unitNode) return;
    const key = `${file}#${unitName(unitNode, sf)}`;
    if (!found.has(key)) found.set(key, { key, file, node: unitNode, line: lineOf(sf, node), why: new Set(), sf });
    found.get(key).why.add(why);
  };
  (function walk(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (STORE_CALLS.has(name)) note(enclosingUnit(node), `${name}()`, node);
      if (name === 'updateSpace' && node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1])
          && node.arguments[1].properties.some(p => p.name && p.name.getText(sf) === 'meta')) {
        note(enclosingUnit(node), 'updateSpace({ meta })', node);
      }
    }
    if (ts.isBinaryExpression(node)
        && (node.operatorToken.kind === ts.SyntaxKind.EqualsToken || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken)) {
      const left = plain(node.left, sf);
      if (/\.schemaLayers\b|\.ownMeta$|\b(?:space|held)\.meta$/.test(left)) note(enclosingUnit(node), `assigns ${left}`, node);
    }
    ts.forEachChild(node, walk);
  })(sf);

  return [...found.values()].map(w => {
    let parses = false;
    const callees = [];
    (function walk(node) {
      if (ts.isCallExpression(node)) {
        const e = node.expression;
        if (ts.isPropertyAccessExpression(e) && /^(safeParse|parse|safeParseAsync)$/.test(e.name.text)
            && ts.isIdentifier(e.expression) && parserNames.has(e.expression.text)) parses = true;
        if (ts.isIdentifier(e)) {
          if (mintCall.test(e.text)) parses = true;
          callees.push(e.text);
        }
      }
      ts.forEachChild(node, walk);
    })(w.node);
    return { unit: w.key, file, line: w.line, why: [...w.why].join(', '), parses, callees, sf: w.sf };
  });
}

/**
 * The writers of a source set that parse nothing, directly or through a function that does.
 *
 * `parsingFunctions` is a fixed point: a top-level function whose body contains a schema parse, then any function calling one — never
 * through a store, whose own recompute parses the layers it merges (that parse is of the OTHER side of the merge, and counting it would
 * make every caller of a store "parsing" by construction).
 */
export function scan(sources, parserNames) {
  const bodies = new Map();   // name -> { file, parses, callees }
  for (const [file, text] of sources) {
    const sf = parseSource(file, stripComments(text));
    sf.forEachChild(function visit(node) {
      const named = (ts.isFunctionDeclaration(node) && node.name) ? node.name.text
        : (ts.isVariableStatement(node) ? node.declarationList.declarations.map(d => d.name.getText(sf))[0] : null);
      if (named && !STORE_FILES.has(file)) {
        let parses = false;
        const callees = [];
        (function walk(n) {
          if (ts.isCallExpression(n)) {
            const e = n.expression;
            if (ts.isPropertyAccessExpression(e) && /^(safeParse|parse|safeParseAsync)$/.test(e.name.text)
                && ts.isIdentifier(e.expression) && parserNames.has(e.expression.text)) parses = true;
            if (ts.isIdentifier(e)) { if (mintCall.test(e.text)) parses = true; callees.push(e.text); }
          }
          ts.forEachChild(n, walk);
        })(node);
        bodies.set(named, { file, parses, callees });
      }
    });
  }
  const parsing = new Set([...bodies].filter(([, b]) => b.parses).map(([n]) => n));
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, b] of bodies) {
      if (!parsing.has(name) && b.callees.some(c => parsing.has(c))) { parsing.add(name); grew = true; }
    }
  }

  const out = [];
  for (const [file, text] of sources) {
    if (STORE_FILES.has(file)) continue;
    for (const w of writersIn(file, text, parserNames)) {
      if (w.parses || w.callees.some(c => parsing.has(c))) continue;
      out.push(w);
    }
  }
  return { unparsed: out, parsing };
}

/** Every writer unit (parsing or not), for the floor and for the exemption check. */
function allWriters(sources, parserNames) {
  const out = [];
  for (const [file, text] of sources) {
    if (STORE_FILES.has(file)) continue;
    out.push(...writersIn(file, text, parserNames));
  }
  return out;
}

describe('every path that stores a schema parses it through the one body schema', () => {
  let parserNames, sources;
  before(async () => {
    const bodies = await import('../../server/dist/spaces/body-schemas.js');
    const library = await import('../../server/dist/api/schema-library.js');
    parserNames = new Set([...Object.entries(bodies), ...Object.entries(library)]
      .filter(([, v]) => v && typeof v === 'object' && typeof v.safeParse === 'function').map(([k]) => k));
    sources = new Map(trackedSources('server/src', { floor: 400 }).map(f => [f, readFileSync(join(REPO_ROOT, f), 'utf8')]));
  });

  it('the schemas are read from the modules that export them (a scan of nothing would pass)', () => {
    for (const name of ['SpaceMetaBody', 'TypeSchemaZ', 'TypeSchemasZ', 'UpdateSpaceBody', 'PutSchemaBody', 'LibraryTypeSchemaZ']) {
      assert.ok(parserNames.has(name), `${name} is no longer an exported schema: re-anchor this gate`);
    }
  });

  it('finds the writers it must judge (floor), including the two the network reaches', () => {
    const writers = allWriters(sources, parserNames);
    assert.ok(writers.length >= 8, `only ${writers.length} writer unit(s) found — the scan has lost its subjects`);
    const names = writers.map(w => w.unit);
    assert.ok(names.some(n => n.startsWith('server/src/sync/governance.ts#')), 'the passed-round writer in sync/governance.ts was not found');
    assert.ok(names.some(n => n.startsWith('server/src/sync/space-meta-pull.ts#')), 'the meta-pull writer was not found');
    assert.ok(names.some(n => n.startsWith('server/src/api/spaces.ts#')), 'no schema route was found');
  });

  it('every writer parses what it stores, directly or through a function that does', () => {
    const { unparsed } = scan(sources, parserNames);
    const real = unparsed.filter(w => !EXEMPT.has(w.unit));
    assert.deepEqual(real.map(w => `${w.unit} (line ${w.line}: ${w.why})`), [],
      'these hand a meta to a store, or write one, without parsing it through a body schema. A schema that arrived by '
      + 'the network or a vote is exactly as untrusted as one a caller sends: parse it, then store it (parseSpaceMeta / parseTypeSchema in body-schemas.ts).');
  });

  it('an exemption names a writer that still exists and still parses nothing', () => {
    const { unparsed } = scan(sources, parserNames);
    const live = new Set(unparsed.map(w => w.unit));
    const stale = [...EXEMPT.keys()].filter(k => !live.has(k));
    assert.deepEqual(stale, [], 'these exemptions name a writer that is gone, or that now parses (delete the row): the list may not outlive its subjects');
  });

  describe('the scan itself, over synthetic sources (it must see a bad store and pass a good one)', () => {
    const names = new Set(['SpaceMetaBody']);
    const run = (body) => scan(new Map([['server/src/x/fixture.ts', body]]), names).unparsed.map(w => w.unit);
    it('flags a store call whose argument was never parsed', () => {
      assert.deepEqual(run('export function apply(meta: unknown) { storeNetworkLayer("n", "s", meta as never); }'), ['server/src/x/fixture.ts#apply']);
    });
    it('flags a commitOwnMetaEdit inside a route handler, naming the route', () => {
      assert.deepEqual(run('router.put("/:id", async (req, res) => { commitOwnMetaEdit(req.params.id, b => b); });'), ['server/src/x/fixture.ts#PUT /:id']);
    });
    it('flags an updateSpace write of a meta, and not one of another field', () => {
      assert.deepEqual(run('export function a(m: unknown) { updateSpace("s", { meta: m }); }'), ['server/src/x/fixture.ts#a']);
      assert.deepEqual(run('export function b() { updateSpace("s", { label: "x" }); }'), []);
    });
    it('passes a writer that parses first', () => {
      assert.deepEqual(run('export function apply(meta: unknown) { const p = SpaceMetaBody.safeParse(meta); if (p.success) storeNetworkLayer("n", "s", p.data as never); }'), []);
    });
    it('passes a writer that calls a function that parses', () => {
      assert.deepEqual(run('function checked(m: unknown) { return SpaceMetaBody.safeParse(m); }\nexport function apply(meta: unknown) { checked(meta); storeNetworkLayer("n", "s", meta as never); }'), []);
    });
    it('does not count a parse that only the store itself performs', () => {
      const sources = new Map([
        ['server/src/spaces/effective-meta.ts', 'export function storeNetworkLayer() { SpaceMetaBody.safeParse({}); }'],
        ['server/src/x/fixture.ts', 'export function apply(meta: unknown) { storeNetworkLayer(); }'],
      ]);
      assert.deepEqual(scan(sources, names).unparsed.map(w => w.unit), ['server/src/x/fixture.ts#apply']);
    });
    it('is not fooled by a parse written in a comment', () => {
      assert.deepEqual(run('export function apply(meta: unknown) {\n  // SpaceMetaBody.safeParse(meta)\n  storeNetworkLayer("n", "s", meta as never);\n}'), ['server/src/x/fixture.ts#apply']);
    });
  });
});

describe('the brand a parsed schema carries is minted in one place', () => {
  it('body-schemas exports the two parsers that mint it', async () => {
    const bodies = await import('../../server/dist/spaces/body-schemas.js');
    assert.equal(typeof bodies.parseSpaceMeta, 'function', 'body-schemas.ts does not export parseSpaceMeta (mints ParsedSpaceMeta)');
    assert.equal(typeof bodies.parseTypeSchema, 'function', 'body-schemas.ts does not export parseTypeSchema (mints ParsedTypeSchema)');
  });

  it('no file but body-schemas.ts casts a value to a parsed brand, and the brand types are declared there', () => {
    const files = trackedSources('server/src', { floor: 400 });
    const cast = /\bas\s+(?:unknown\s+as\s+)?Parsed(?:SpaceMeta|TypeSchema)\b|<\s*Parsed(?:SpaceMeta|TypeSchema)\s*>/;
    const casters = files.filter(f => f !== 'server/src/spaces/body-schemas.ts'
      && cast.test(stripComments(readFileSync(join(REPO_ROOT, f), 'utf8'))));
    assert.deepEqual(casters, [], 'these mint a parsed brand by assertion, which is what the brand exists to prevent');
    const home = stripComments(readFileSync(join(REPO_ROOT, 'server/src/spaces/body-schemas.ts'), 'utf8'));
    assert.ok(/\bParsedSpaceMeta\b/.test(home), 'ParsedSpaceMeta is not declared in body-schemas.ts');
    assert.ok(/\bParsedTypeSchema\b/.test(home), 'ParsedTypeSchema is not declared in body-schemas.ts');
  });
});
