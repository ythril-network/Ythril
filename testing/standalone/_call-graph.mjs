/**
 * What a function actually reaches — resolved through each module's OWN imports.
 *
 * ## The question, and why a name is not enough to answer it
 *
 * Several gates want to ask *"does anything that runs at boot do X"*, and the honest version of that is a
 * call graph. The cheap version is to collect the identifiers a function calls and look each one up in a
 * tree-wide map keyed by NAME — and that version is wrong in the direction that gets a gate deleted.
 *
 * `no-boot-migration-on-synced-data` tried it twice on 2026-09-17 and withdrew both attempts. A name-keyed
 * map cannot tell one module's `start…` from another's, so following a boot callee's calls reported
 * `wipeSpace()` — a destructive operator action that nothing calls at boot — and narrowing the hop to the
 * callee's own imports reported it too, because the lookup was still by bare name. **A gate whose failures
 * are mostly false gets its assertion deleted rather than its subject fixed**, so neither shipped and the
 * limit was written down as a comment instead.
 *
 * So the unit here is `path:name`, never `name`. A call is resolved against the importing file's import
 * list first and its own top-level functions second, and anything that resolves to neither is DROPPED
 * rather than guessed at.
 *
 * ## The guard a hand-written copy drops
 *
 * **The floors.** An index that parses nothing, or a root set that resolves to nothing, produces an empty
 * reachable set — and an empty set passes every loop written over it, so a gate built on one reports a
 * green tick about code it never read. That is the same silent pass these gates exist to end, one level up.
 * `moduleIndex` throws when it finds implausibly few functions and `reachableFrom` throws when no root
 * resolves, so a caller cannot receive the failure quietly.
 *
 * ## What it follows beyond a bare call (`Q-97`)
 *
 * - **A method on an imported module or object.** `x.foo()` resolves when `x` is a namespace import
 *   (`import * as x`, or `const x = await import(…)`), a named import of an exported object literal, or a
 *   top-level object literal in the same file. Every top-level object literal's methods are indexed as
 *   `path:Object.method` — which is also how an MCP tool's `handle` becomes a function the graph can root.
 * - **A door.** `toolHandlerRoot` roots a tool by the name `TOOL_RIGHTS` prices it under, and
 *   `routeHandlerRoots` roots a REST registration's inline handler and middleware — both are closures,
 *   which the top-level index alone never contained, so no read-rung door resolved before this.
 * - **What a call causes, when asked.** `{ closures: true }` walks what a call CAUSES rather than what it
 *   does once: a `.map(async x => { … })` inside a request handler runs because of that request, and so may
 *   a function or an object of functions it hands on (`startIngest(…, productionDeps(…))`). A method called
 *   on a PARAMETER resolves to the same-file top-level objects that carry it — the injected default. The
 *   boot walk keeps the default, for the reason `withoutNestedClosures` gives.
 * - **A dispatch the caller knows.** `edges` lets a gate add what the text does not say, such as a
 *   `callTool({ name: 'recall' })` running the `recall` handler, without this module learning the registry.
 *
 * ## What it deliberately does not see, stated rather than implied
 *
 * - **A function passed rather than called.** `router.get('/x', handler)` does not reach `handler`, and
 *   that is the behaviour that makes a boot walk usable at all: `createApp()` WIRES the request handlers
 *   and does not run them, so following references would make every route reachable from boot and drown
 *   the answer. (`routeHandlerRoots` is the one place a reference IS followed: it is the door itself.)
 * - **A method on a class instance or a value.** `runs.get()` on a `new IngestRuns()`, `this.x()`, and
 *   `handler.handle(ctx)` on a looked-up tool are not resolved — the receiver's type is not in the text.
 *
 * Each of those is a hole a determined boot migration could hide in. They are named here so a gate built
 * on this module can say what it covers instead of implying it covers everything.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { argumentsOf, balancedFrom } from './_structural-window.mjs';

/** Words that are followed by `(` and are not calls. */
const NOT_A_CALL = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'function', 'yield', 'delete',
  'void', 'in', 'of', 'do', 'else', 'new', 'import', 'require', 'super', 'throw', 'case', 'instanceof',
]);

/** The index of a balanced closer, starting from the opener at `at`. */
function matchFrom(src, at, open, close) {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * The index of the brace that opens a function's BODY, starting from its parameter list's `)`.
 *
 * **Not `indexOf('{')`, and the difference is a whole function going missing.** A return type annotation
 * is written between the two and it is allowed to contain braces:
 *
 *     export async function reconcileLinksForDocument(…): Promise<{ added: number; removed: number }> {
 *
 * The naive search stops at the brace inside `Promise<…>`, so the "body" is the type literal — nine
 * characters with no calls in it. `reconcileLinksForDocument` parsed to nothing that way, and the boot walk
 * stopped one hop short of the writer it was following, reporting a clean boot for the link migration it
 * had been written to catch.
 *
 * So the scan tracks angle-bracket depth and ignores a brace inside a generic, then checks whether what it
 * found is a type literal by looking at what follows it: `: { a: number } {` puts one brace group before
 * the body, and a body is never followed immediately by another block.
 */
function bodyBraceAfter(src, close) {
  let angle = 0;
  for (let i = close + 1; i < src.length; i++) {
    const c = src[i];
    if (c === ';') return -1;             // an overload signature or a declaration: there is no body
    if (c === '<') angle++;
    else if (c === '>') { if (angle > 0) angle--; }
    else if (c === '{') {
      const end = matchFrom(src, i, '{', '}');
      if (end < 0) return -1;
      if (angle > 0) { i = end; continue; }
      const next = /\S/.exec(src.slice(end + 1));
      if (next && next[0] === '{') { i = end; continue; }   // that was the return type; the body is next
      return i;
    }
  }
  return -1;
}

/**
 * `name -> body` for every top-level function in one source, declaration and arrow form alike.
 *
 * Both forms, because the distinction is a style choice and a gate that reads only `function f()` is one
 * `const f = async () => {}` away from silence. The parameter list is matched by BALANCE rather than by
 * `[^)]*` — a default value or a typed callback puts a `)` inside the parameters and the cheap pattern
 * stops at it, losing the function entirely.
 */
export function topLevelFunctions(src) {
  return new Map([...topLevelFunctionSpans(src)].map(([name, span]) => [name, span.body]));
}

/**
 * The same functions as `name -> { body, start }`, `start` being the body's offset in `src` — so a caller
 * can ask which function a given position sits inside, which is how a writer is attributed to its function.
 */
export function topLevelFunctionSpans(src) {
  const out = new Map();

  for (const m of src.matchAll(/(?:^|\n)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/g)) {
    const paren = src.indexOf('(', m.index + m[0].length - 1);
    const close = matchFrom(src, paren, '(', ')');
    if (close < 0) continue;
    const brace = bodyBraceAfter(src, close);
    if (brace < 0) continue;
    const end = matchFrom(src, brace, '{', '}');
    if (end < 0) continue;
    out.set(m[1], { body: src.slice(brace, end + 1), start: brace });
  }

  for (const m of src.matchAll(/(?:^|\n)(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*(?:async\s+)?(?:<[^>(]*>)?\s*\(/g)) {
    const paren = src.indexOf('(', m.index + m[0].length - 1);
    const close = matchFrom(src, paren, '(', ')');
    if (close < 0) continue;
    // The brace must follow the `=>` directly. A concise body (`= (x) => x + 1`) has none, and searching
    // forward for one would hand back the next unrelated block in the file as this function's body.
    const tail = /^\s*(?::[^;{}=]*)?=>\s*\{/.exec(src.slice(close + 1, close + 300));
    if (!tail) continue;
    const brace = close + 1 + tail[0].lastIndexOf('{');
    const end = matchFrom(src, brace, '{', '}');
    if (end < 0) continue;
    out.set(m[1], { body: src.slice(brace, end + 1), start: brace });
  }

  return out;
}

/**
 * Every top-level OBJECT LITERAL's members, as `name -> { strings, methods, refs }`.
 *
 * - `strings`: `prop -> value` for a property whose value is a plain string literal (`name: 'recall'`).
 * - `methods`: `prop -> { body, start }` for a method (`async handle(ctx) { … }`) or a function-valued
 *   property (`handle: async (ctx) => { … }`, `handle: function (…) { … }`, and the concise arrow form).
 * - `refs`: `prop -> identifier` for a property that NAMES a function (`handle: handleRecall`).
 *
 * The object is bounded by `balancedFrom` and split by `argumentsOf`, both of which skip strings — a tool's
 * description is full of `{ … }` examples, and a naive brace count ends the object inside one of them.
 */
export function topLevelObjects(src) {
  const out = new Map();
  for (const m of src.matchAll(/(?:^|\n)(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=\n]+)?=\s*\{/g)) {
    const brace = m.index + m[0].length - 1;
    let group;
    let parts;
    try {
      group = balancedFrom(src, brace, `the object ${m[1]}`);
      parts = argumentsOf(src, brace, `the object ${m[1]}`);
    } catch { continue; }
    const strings = new Map();
    const methods = new Map();
    const refs = new Map();
    let cursor = brace;
    for (const part of parts) {
      const at = src.indexOf(part, cursor);
      if (at < 0 || at > brace + group.length) continue;
      cursor = at + part.length;
      const str = /^([A-Za-z_$][\w$]*)\s*:\s*(['"])((?:\\.|(?!\2).)*)\2\s*$/.exec(part);
      if (str) { strings.set(str[1], str[3]); continue; }
      const ref = /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*$/.exec(part);
      if (ref) { refs.set(ref[1], ref[2]); continue; }
      // Method shorthand: `async handle(ctx: ToolContext): Promise<ToolResult> { … }`.
      const method = /^(?:async\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/.exec(part);
      if (method && !['if', 'for', 'while', 'switch'].includes(method[1])) {
        const paren = at + part.indexOf('(', method[0].length - 1);
        const close = matchFrom(src, paren, '(', ')');
        const body = close < 0 ? -1 : bodyBraceAfter(src, close);
        if (body > 0 && body < at + part.length) {
          methods.set(method[1], { body: src.slice(body, at + part.length), start: body });
          continue;
        }
      }
      // A function-valued property: arrow (block or concise) or `function` expression. The whole value is
      // the body — a concise arrow has nothing else to be.
      const fnValue = /^([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\b|(?:<[^>(]*>)?\s*\([^]*?\)\s*(?::[^=]*?)?=>|[A-Za-z_$][\w$]*\s*=>)/.exec(part);
      if (fnValue) {
        const valueAt = at + part.indexOf(':') + 1;
        methods.set(fnValue[1], { body: src.slice(valueAt, at + part.length), start: valueAt });
      }
    }
    out.set(m[1], { strings, methods, refs, start: brace, end: brace + group.length });
  }
  return out;
}

/**
 * `localName -> file` for every relative NAMESPACE import: `import * as x from './…'` and the dynamic
 * `const x = await import('./…')`. `x.foo()` then resolves to `file:foo`.
 */
export function namespaceImports(src, file, has) {
  const map = new Map();
  const add = (local, spec) => {
    const target = resolveSpecifier(spec, file, has);
    if (target) map.set(local, target);
  };
  for (const m of src.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g)) add(m[1], m[2]);
  for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1], m[2]);
  return map;
}

/**
 * `localName -> { file, exported }` for every relative import in one source, static and dynamic alike.
 *
 * The dynamic form is not an exotic case to be thorough about — it is the one the boot walk needed. The
 * 5.0 link migration is reached as `const { convertLinksOnBoot } = await import('./brain/…js')`, so a
 * resolver that read only static imports would have resolved nothing at the very first hop and reported
 * a clean boot.
 */
export function relativeImports(src, file, has) {
  const map = new Map();
  const add = (clause, spec) => {
    const target = resolveSpecifier(spec, file, has);
    if (!target) return;
    for (const part of clause.split(',')) {
      const m = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+|\s*:\s*)?([A-Za-z_$][\w$]*)?\s*$/.exec(part);
      if (!m) continue;
      const exported = m[1];
      const local = m[2] ?? m[1];
      map.set(local, { file: target, exported });
    }
  };

  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) add(m[1], m[2]);
  /*
   * `[^{}();]` on the dynamic clause, not `[^}]`. The loose class matched from the `{` of the enclosing
   * `if` block all the way to the destructuring's own closing brace, so the clause came back as a hundred
   * lines of statements and no local name resolved. It found the import and learned nothing from it —
   * which is worse than missing it, because the walk then reported a clean boot.
   */
  for (const m of src.matchAll(/\{([^{}();]*)\}\s*=\s*await\s+import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1], m[2]);

  return map;
}

/** A relative specifier as a repo path, `.js` read back to the `.ts` it was written as. */
function resolveSpecifier(spec, fromFile, has) {
  if (!spec.startsWith('.')) return null;
  const base = join(dirname(fromFile), spec).replace(/\\/g, '/');
  for (const candidate of [base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}/index.ts`]) {
    if (has(candidate)) return candidate;
  }
  return null;
}

/**
 * A body with every NESTED closure's block removed — what this function does when it is called, once.
 *
 * **This is what makes a boot walk mean anything.** `createApp()` really does run at boot, and its body
 * registers a hundred request handlers written inline: `app.delete('/spaces/:id', async (req, res) => {
 * await wipeSpace(…) })`. Textually that is a call to `wipeSpace` inside the function boot invokes, so a
 * walk that reads the body whole concludes that booting the server wipes a space. It was that conclusion,
 * arriving as `wipeSpace()` from a one-hop expansion, that got two earlier attempts at this withdrawn.
 *
 * A closure written at the call site is PASSED, not run — so its block belongs to whoever calls it later,
 * which for a route handler is a request and not a boot.
 *
 * The concise arrow body (`() => doThing()`, no braces) is deliberately left in place: it is overwhelmingly
 * `.map(x => f(x))` and `.filter(…)`, which do run during the call, and cutting it would need an expression
 * parser to tell those from a deferred one-liner.
 */
export function withoutNestedClosures(body) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const rest = body.slice(i, i + 12);
    const arrow = /^=>\s*\{/.exec(rest);
    const fn = /^function\b/.test(rest) && i > 0 && !/[\w$.]/.test(body[i - 1]);
    if (arrow) {
      const brace = body.indexOf('{', i);
      const end = matchFrom(body, brace, '{', '}');
      if (end < 0) break;
      out += '=>{}';
      i = end;
      continue;
    }
    if (fn) {
      const paren = body.indexOf('(', i);
      const close = paren < 0 ? -1 : matchFrom(body, paren, '(', ')');
      const brace = close < 0 ? -1 : body.indexOf('{', close);
      const end = brace < 0 ? -1 : matchFrom(body, brace, '{', '}');
      if (end < 0) { out += body[i]; continue; }
      out += 'function(){}';
      i = end;
      continue;
    }
    out += body[i];
  }
  return out;
}

/**
 * Every bare `name(` this body calls when it runs — less the keywords, less anything reached through a
 * dot, and less everything inside a closure it merely hands to somebody else.
 */
export function callsIn(body, { closures = false } = {}) {
  const names = new Set();
  for (const m of callableText(body, closures).matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*(?:<[^>(;]*>)?\s*\(/g)) {
    if (!NOT_A_CALL.has(m[2])) names.add(m[2]);
  }
  return names;
}

/**
 * Every `obj.prop(` this body calls, as `[obj, prop]` — `obj` a bare identifier, never itself reached
 * through a dot, so `a.b.c()` is not read as `b.c()`. Optional chaining (`obj?.prop(`) counts.
 */
export function memberCallsIn(body, { closures = false } = {}) {
  const pairs = new Map();
  for (const m of callableText(body, closures).matchAll(/(^|[^.\w$?])([A-Za-z_$][\w$]*)\s*\??\.\s*([A-Za-z_$][\w$]*)\s*(?:<[^>(;]*>)?\s*\(/g)) {
    pairs.set(`${m[2]}.${m[3]}`, [m[2], m[3]]);
  }
  return [...pairs.values()];
}

/**
 * Every bare identifier this body NAMES without calling it — `{ write: writeExtraction }`, `.map(toView)`,
 * `setImmediate(sweep)`. Only the closure walk reads these: a function handed on during a request is one the
 * request may cause to run, and `startIngest(…, productionDeps(…))` writes through exactly such an object.
 * Property keys (`name:`) and member names (`.name`) are not references.
 */
export function referencesIn(body) {
  const names = new Set();
  for (const m of callableText(body, true).matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)(?![\w$])(?!\s*(?:\(|:(?!:)|<[^>(;]*>\s*\())/g)) {
    if (!NOT_A_CALL.has(m[2])) names.add(m[2]);
  }
  return names;
}

/**
 * What a call scan reads: the body, closures cut unless the walk asks for them, declarations neutralised.
 *
 * A DECLARATION is not a call, and reading one as a call is how a boot walk loses its shape. Scanning
 * `index.ts`'s startup section reads `async function main(…)` and sees `main(` — so `main` became a boot
 * root, and since main calls everything else, every other root sat underneath it. Attributing an offender
 * to the boot entry that reaches it then answered "main" for all of them, and a per-entry exemption
 * covered the whole boot.
 */
function callableText(body, closures) {
  return (closures ? body : withoutNestedClosures(body)).replace(/\bfunction\s*\*?\s*[A-Za-z_$][\w$]*\s*\(/g, 'function (');
}

/**
 * Every top-level function under `dirs`, keyed `path:name`, with each file's import map beside it.
 *
 * @param {string|string[]} dirs      as `trackedSources` takes them
 * @param {object}          [opts]    passed through to `trackedSources`; `floor` here is on FUNCTIONS
 */
export function moduleIndex(dirs, opts = {}) {
  const { functionFloor = 500, ...sourceOpts } = opts;
  const files = trackedSources(dirs, { untracked: true, ...sourceOpts });
  const set = new Set(files);
  const has = f => set.has(f);

  const bodies = new Map();
  const imports = new Map();
  const namespaces = new Map();
  const objects = new Map();
  const sources = new Map();
  for (const file of files) {
    const src = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
    sources.set(file, src);
    for (const [name, { body, start }] of topLevelFunctionSpans(src)) {
      bodies.set(`${file}:${name}`, { file, name, body, start, end: start + body.length });
    }
    for (const [name, obj] of topLevelObjects(src)) {
      objects.set(`${file}:${name}`, { file, name, ...obj });
      for (const [prop, { body, start }] of obj.methods) {
        bodies.set(`${file}:${name}.${prop}`, { file, name: `${name}.${prop}`, body, start, end: start + body.length });
      }
    }
    imports.set(file, relativeImports(src, file, has));
    namespaces.set(file, namespaceImports(src, file, has));
  }

  if (bodies.size < functionFloor) {
    // THROWS rather than handing back a thin index. A parser that quietly stops matching produces a small
    // map, a small map produces an empty reachable set, and an empty set passes every assertion written
    // over it — the silent pass this module exists to prevent, arriving inside the module itself.
    throw new Error(
      `the call graph parsed only ${bodies.size} function(s) under ${[dirs].flat().join(', ')} with a floor of `
      + `${functionFloor}. The parse is broken, not the code: a thin index makes every reachability question `
      + 'answer "no" and every gate built on it pass about code it never read.');
  }

  /** The `path:name` a bare call in `file` refers to, or null when it leaves this tree. */
  const resolve = (file, name) => {
    const imported = imports.get(file)?.get(name);
    if (imported && bodies.has(`${imported.file}:${imported.exported}`)) return `${imported.file}:${imported.exported}`;
    if (bodies.has(`${file}:${name}`)) return `${file}:${name}`;
    return null;
  };

  /*
   * A property that NAMES a function (`handle: handleRecall`) becomes an alias of that function's key, so
   * `x.handle()` and a door rooted at `X.handle` both land on the body that runs. Done after every file is
   * read, because the named function may be imported from one parsed later.
   */
  for (const obj of objects.values()) {
    for (const [prop, ref] of obj.refs) {
      const target = resolve(obj.file, ref);
      if (target && !bodies.has(`${obj.file}:${obj.name}.${prop}`)) bodies.set(`${obj.file}:${obj.name}.${prop}`, { ...bodies.get(target), alias: target });
    }
  }

  /**
   * The `path:name` a MEMBER call `obj.prop()` in `file` refers to, or null. `obj` is a namespace import, a
   * named import of an exported object literal, or a top-level object literal of `file` itself.
   */
  const resolveMember = (file, obj, prop) => {
    const ns = namespaces.get(file)?.get(obj);
    if (ns && bodies.has(`${ns}:${prop}`)) return `${ns}:${prop}`;
    const imported = imports.get(file)?.get(obj);
    if (imported && bodies.has(`${imported.file}:${imported.exported}.${prop}`)) return `${imported.file}:${imported.exported}.${prop}`;
    if (bodies.has(`${file}:${obj}.${prop}`)) return `${file}:${obj}.${prop}`;
    return null;
  };

  /**
   * Every method of the top-level objects in `file` that carry `prop` — the answer for `x.prop()` when `x` is
   * a PARAMETER. Dependency injection is written that way here (`writers: ExtractionWriters = DOOR`, then
   * `writers.bulk(…)`), and the default it falls back to is a top-level object in the same file. Same file
   * only: widening it to the tree would make every `.get(` reach every object with a `get`.
   */
  const sameFileMethods = (file, prop) => [...objects.values()]
    .filter(o => o.file === file && bodies.has(`${file}:${o.name}.${prop}`))
    .map(o => `${file}:${o.name}.${prop}`);

  return { files, bodies, imports, namespaces, objects, sources, resolve, resolveMember, sameFileMethods };
}

/**
 * Every `path:name` reachable from `roots`, following calls to exhaustion.
 *
 * Exhaustion rather than a fixed number of hops, and the real case is why: the 5.0 link migration writes
 * three calls deep — the boot entry point calls a local helper, which calls the converter, which calls the
 * reconciler that writes. Any hop limit is a number somebody picked, and the next migration is one call
 * longer than it.
 *
 * @param {ReturnType<typeof moduleIndex>} index
 * @param {Iterable<string>} roots  `path:name` keys
 */
export function reachableFrom(index, roots, opts = {}) {
  return walkFrom(index, roots, opts).seen;
}

/**
 * The same walk, breadth-first, with the edge that first reached each key — so a gate can print HOW a
 * root reaches something (`pathTo`), not only that it does. A finding without its path is a claim the
 * reader has to re-derive by hand, and the one they re-derive wrongly is the one that gets exempted.
 *
 * @param {{closures?: boolean, edges?: (entry: object) => Iterable<string>}} [opts] `closures: true` follows
 *   what a call CAUSES — every closure written inside a reached body, and every function or object of them
 *   it hands on — rather than what it does once. See the module header for why the boot walk must not.
 *   `edges` adds the keys a body reaches in a way the text alone does not say: a caller that knows a
 *   dispatch (`callTool({ name: 'recall' })` runs the `recall` handler) supplies it, so this module does not
 *   learn one registry's shape.
 */
export function walkFrom(index, roots, { closures = false, edges } = {}) {
  const seen = new Set();
  const parent = new Map();
  const queue = [...roots].filter(k => index.bodies.has(k));

  assert.ok(queue.length > 0,
    'no root resolved to a known function, so the reachable set is empty and every question asked of it '
    + 'answers "no". Re-anchor the roots before trusting the result.');

  const visit = (from, next) => {
    if (!next || seen.has(next) || parent.has(next)) return;
    parent.set(next, from);
    queue.push(next);
  };
  while (queue.length > 0) {
    const key = queue.shift();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = index.bodies.get(key);
    for (const name of callsIn(entry.body, { closures })) visit(key, index.resolve(entry.file, name));
    if (edges) for (const next of edges(entry)) visit(key, next);
    for (const [obj, prop] of memberCallsIn(entry.body, { closures })) {
      const member = index.resolveMember(entry.file, obj, prop);
      visit(key, member);
      if (!member && closures) for (const m of index.sameFileMethods(entry.file, prop)) visit(key, m);
    }
    if (!closures) continue;
    // What a request CAUSES includes what it hands on: a named function, or an object of them.
    for (const name of referencesIn(entry.body)) {
      visit(key, index.resolve(entry.file, name));
      const imported = index.imports.get(entry.file)?.get(name);
      const obj = imported ? index.objects.get(`${imported.file}:${imported.exported}`) : index.objects.get(`${entry.file}:${name}`);
      if (obj) for (const prop of obj.methods.keys()) visit(key, `${obj.file}:${obj.name}.${prop}`);
    }
  }
  return { seen, parent };
}

/** The chain of keys from a root to `key`, root first, read off `walkFrom`'s parent map. */
export function pathTo(parent, key) {
  const chain = [key];
  while (parent.has(chain[0])) chain.unshift(parent.get(chain[0]));
  return chain;
}

/**
 * The key of the MCP tool handler registered under `tool` — the name `TOOL_RIGHTS` prices it by.
 *
 * Found by the tool object's own `name:` literal rather than by the variable holding it, because the two
 * differ (`queryTool` is `filter`, `find_similarTool` is `similar`) and the name is what a caller, and the
 * rights table, know it as. Throws when it resolves to anything but exactly one handler: a door that roots
 * nothing makes every question about it answer "no".
 */
export function toolHandlerRoot(index, tool) {
  const hits = [...index.objects.values()]
    .filter(o => o.strings.get('name') === tool && index.bodies.has(`${o.file}:${o.name}.handle`));
  assert.equal(hits.length, 1,
    `the tool '${tool}' resolved to ${hits.length} handler object(s) `
    + `(${hits.map(o => `${o.file}:${o.name}`).join(', ') || 'none'}); expected exactly one with a name: '${tool}' `
    + 'literal and a handle method. Re-anchor toolHandlerRoot before trusting any walk from it.');
  return `${hits[0].file}:${hits[0].name}.handle`;
}

/**
 * The roots of one REST registration: its inline handler and middleware as a function of their own, plus
 * every function the registration NAMES as a handler or middleware.
 *
 * @param {ReturnType<typeof moduleIndex>} index  gains one synthetic body per route, keyed
 *   `file:METHOD /served/path` — a key with a space in it, so it can never collide with a function's.
 * @param {{method: string, path: string, file: string, at: number}} route  as `mountedRoutes` returns it;
 *   `at` is an offset into the comment-stripped source, which is what `index.sources` holds.
 */
export function routeHandlerRoots(index, route) {
  const src = index.sources.get(route.file);
  assert.ok(src, `${route.file} is not in the index, so the route ${route.method} ${route.path} cannot be rooted`);
  const open = src.indexOf('(', route.at);
  const label = `${route.method} ${route.path}: the route registration`;
  const group = balancedFrom(src, open, label);
  const args = argumentsOf(src, open, label).slice(1);
  const key = `${route.file}:${route.method} ${route.path}`;
  index.bodies.set(key, {
    file: route.file, name: `${route.method} ${route.path}`, body: args.join(',\n'),
    start: open, end: open + group.length, synthetic: true,
  });
  const roots = [key];
  for (const arg of args) {
    const bare = /^([A-Za-z_$][\w$]*)$/.exec(arg);
    const member = /^([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)$/.exec(arg);
    const named = bare ? index.resolve(route.file, bare[1]) : member ? index.resolveMember(route.file, member[1], member[2]) : null;
    if (named) roots.push(named);
  }
  return roots;
}
