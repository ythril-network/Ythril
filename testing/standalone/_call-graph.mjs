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
 * ## What it deliberately does not see, stated rather than implied
 *
 * - **A namespace import.** `import * as x` then `x.foo()` reads as a method call and is dropped.
 * - **A function passed rather than called.** `router.get('/x', handler)` does not reach `handler`, and
 *   that is the behaviour that makes a boot walk usable at all: `createApp()` WIRES the request handlers
 *   and does not run them, so following references would make every route reachable from boot and drown
 *   the answer.
 * - **A method on an object.** Only bare `name(...)` calls are followed.
 *
 * Each of those is a hole a determined boot migration could hide in. They are named here so a gate built
 * on this module can say what it covers instead of implying it covers everything.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

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
  const out = new Map();

  for (const m of src.matchAll(/(?:^|\n)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/g)) {
    const paren = src.indexOf('(', m.index + m[0].length - 1);
    const close = matchFrom(src, paren, '(', ')');
    if (close < 0) continue;
    const brace = bodyBraceAfter(src, close);
    if (brace < 0) continue;
    const end = matchFrom(src, brace, '{', '}');
    if (end < 0) continue;
    out.set(m[1], src.slice(brace, end + 1));
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
    out.set(m[1], src.slice(brace, end + 1));
  }

  return out;
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
export function callsIn(body) {
  const names = new Set();
  /*
   * A DECLARATION is not a call, and reading one as a call is how a boot walk loses its shape. Scanning
   * `index.ts`'s startup section reads `async function main(…)` and sees `main(` — so `main` became a boot
   * root, and since main calls everything else, every other root sat underneath it. Attributing an offender
   * to the boot entry that reaches it then answered "main" for all of them, and a per-entry exemption
   * covered the whole boot.
   */
  const src = withoutNestedClosures(body).replace(/\bfunction\s*\*?\s*[A-Za-z_$][\w$]*\s*\(/g, 'function (');
  for (const m of src.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*(?:<[^>(;]*>)?\s*\(/g)) {
    if (!NOT_A_CALL.has(m[2])) names.add(m[2]);
  }
  return names;
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
  for (const file of files) {
    const src = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
    for (const [name, body] of topLevelFunctions(src)) bodies.set(`${file}:${name}`, { file, name, body });
    imports.set(file, relativeImports(src, file, has));
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

  return { files, bodies, imports, resolve };
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
export function reachableFrom(index, roots) {
  const seen = new Set();
  const queue = [...roots].filter(k => index.bodies.has(k));

  assert.ok(queue.length > 0,
    'no root resolved to a known function, so the reachable set is empty and every question asked of it '
    + 'answers "no". Re-anchor the roots before trusting the result.');

  while (queue.length > 0) {
    const key = queue.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = index.bodies.get(key);
    for (const name of callsIn(entry.body)) {
      const next = index.resolve(entry.file, name);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}
