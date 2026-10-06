/**
 * Where the housekeeping walks are, what they hand their callbacks, and which loops iterate spaces — read out of the source.
 *
 * ## The question it answers
 *
 * Three gates over the walk (`every-housekeeping-space-walk-is-isolated`, `no-housekeeping-catch-logs-a-space-failure-except-through-
 * the-reporter`, `one-verdict-for-a-walks-failure`) each need the same two facts: *which calls are a walk* (`eachSpace`,
 * `walkSpaces`, `eachUnit`, `claimAcross`) and *which text sits inside a walk's callback*, because the walk runner owns the
 * isolation, the bound and the verdict for exactly that text. Written three times the sets would drift, and the drift runs one
 * way: a walk entry the third gate did not know reads as an ordinary call, and the code inside its callback is judged as if it
 * were unprotected.
 *
 * ## What it prevents
 *
 * - **A hand-written list of entry names.** {@link walkEntryNames} reads them out of `util/housekeeping-walk.ts` (every exported
 *   member that takes a callback `fn:`) and out of every function of `util/work-signal.ts` that calls one of those — which is how
 *   `claimAcross` is found, and how a second claim-style wrapper would be. It throws below its floor, because an empty set makes
 *   every call "not a walk" and every loop "unprotected" or, worse, the other way round.
 * - **A callback judged as the code around it.** {@link blankWalkCallbacks} replaces a walk's closure arguments with spaces
 *   (offsets and lines preserved), so a walk over the rest of a body reads only what is NOT protected.
 *
 * ## What it does not decide
 *
 * Which loops matter is the gate's judgement, not this module's: {@link loopsIn} finds loops and what they bind, and
 * {@link firstParameterName} says what a function calls its first parameter; the gate decides that a loop whose variable is passed
 * as a `space…` parameter iterates spaces.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { argumentsOf, balancedFrom, statementFrom } from './_structural-window.mjs';
import { callSitesIn, callsIn, memberCallSitesIn, intervalJobRuns, intervalJobEdges, walkFrom } from './_call-graph.mjs';

const WALK_FILE = 'server/src/util/housekeeping-walk.ts';
const SIGNAL_FILE = 'server/src/util/work-signal.ts';

/** The fewest walk entry names that may be found before this throws (`eachSpace`, `walkSpaces`, `eachUnit`, `claimAcross`). */
export const WALK_ENTRY_FLOOR = 4;

/**
 * A callback parameter that is handed a unit: `fn: (space, ctx) => …`. NOT `fn: () => …`: `withWalkBudget` takes a callback too,
 * and it is the tick's scope, not a walk — what it runs is not a per-space callback.
 */
const PER_UNIT_CALLBACK = /\bfn\s*:\s*\(\s*[A-Za-z_$]/;

/** The comment-stripped text of a tracked source, read through the index when it has one. */
const sourceOf = (index, file) => index?.sources?.get(file) ?? stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));

/**
 * The names that START a walk: what a caller hands a per-space (or per-unit) callback to.
 *
 * @param {ReturnType<import('./_call-graph.mjs').moduleIndex>} [index]
 * @returns {Set<string>}
 */
export function walkEntryNames(index) {
  const names = new Set();
  const src = sourceOf(index, WALK_FILE);

  // Members of `interface HousekeepingWalk`: one that declares a callback parameter starts a walk.
  const iface = /\binterface\s+HousekeepingWalk\s*\{/.exec(src);
  assert.ok(iface, `${WALK_FILE} has no \`interface HousekeepingWalk\` — re-anchor the walk-entry derivation`);
  const body = balancedFrom(src, iface.index + iface[0].length - 1, 'the HousekeepingWalk interface').slice(1, -1);
  const members = [...body.matchAll(/(?:^|\n)[ ]{2}(?! )([A-Za-z_$][\w$]*)\s*[<(:]/g)];
  members.forEach((m, i) => {
    const text = body.slice(m.index, i + 1 < members.length ? members[i + 1].index : body.length);
    if (PER_UNIT_CALLBACK.test(text)) names.add(m[1]);
  });

  // An exported function of the same module with a callback parameter (`eachUnit`).
  for (const m of src.matchAll(/(?:^|\n)export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/g)) {
    const open = src.indexOf('(', m.index + m[0].length - 1);
    if (PER_UNIT_CALLBACK.test(balancedFrom(src, open, `the parameters of ${m[1]}`))) names.add(m[1]);
  }

  // A function of `work-signal.ts` that calls one of those with a callback is a walk of its own kind (`claimAcross`).
  const signal = sourceOf(index, SIGNAL_FILE);
  for (const m of signal.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/g)) {
    const open = signal.indexOf('(', m.index + m[0].length - 1);
    const params = balancedFrom(signal, open, 'parameters');
    // Only a function that is HANDED a per-unit callback (`tryClaim: (spaceId, pass) => …`) wraps a walk; a factory that merely
    // holds a runner (`createWorkSignal`) does not.
    if (!/:\s*\(\s*[A-Za-z_$][^)]*\)\s*=>/.test(params)) continue;
    const close = open + params.length;
    const brace = signal.indexOf('{', close);
    if (brace < 0) continue;
    const fnBody = balancedFrom(signal, brace, `the body of ${m[1]}`);
    const callsAWalk = [...callSitesIn(fnBody, { closures: true }), ...memberCallSitesIn(fnBody, { closures: true }).map(s => ({ name: s.prop }))]
      .some(s => names.has(s.name));
    if (callsAWalk) names.add(m[1]);
  }

  assert.ok(names.size >= WALK_ENTRY_FLOOR,
    `only ${names.size} walk entry name(s) derived (${[...names].join(', ') || 'none'}), below the floor of ${WALK_ENTRY_FLOOR}. `
    + 'The derivation is broken, not the code — with no entry names every walk reads as an ordinary call.');
  return names;
}

const isClosure = (text) => /=>|^(?:async\s+)?function\b/.test(text);

/**
 * Every call of a walk entry in `body`, with the closure arguments it hands over, as offsets into `body`.
 *
 * @param {string} body
 * @param {Iterable<string>} names  from {@link walkEntryNames}
 * @returns {{name: string, at: number, paren: number, callbacks: {at: number, end: number, text: string}[]}[]}
 */
export function walkCallsIn(body, names) {
  const wanted = new Set(names);
  const calls = [];
  const re = /(?<![\w$.])(?:[A-Za-z_$][\w$]*\s*\??\.\s*)?([A-Za-z_$][\w$]*)\s*(?:<[^>(;]*>)?\s*\(/g;
  for (const m of body.matchAll(re)) {
    if (!wanted.has(m[1])) continue;
    // The declaration `function eachUnit(` is not a call.
    if (/\bfunction\s*\*?\s*$/.test(body.slice(Math.max(0, m.index - 16), m.index))) continue;
    const paren = m.index + m[0].length - 1;
    let args;
    try { args = argumentsOf(body, paren, `the call of ${m[1]}`); } catch { continue; }
    let cursor = paren + 1;
    const callbacks = [];
    for (const arg of args) {
      const at = body.indexOf(arg, cursor);
      if (at < 0) continue;
      cursor = at + arg.length;
      if (isClosure(arg)) callbacks.push({ at, end: at + arg.length, text: arg });
    }
    calls.push({ name: m[1], at: m.index, paren, callbacks });
  }
  return calls;
}

/** `body` with every walk callback replaced by spaces (line breaks kept), so offsets and lines are unchanged. */
export function blankWalkCallbacks(body, names) {
  let out = body;
  for (const call of walkCallsIn(body, names)) {
    for (const cb of call.callbacks) out = out.slice(0, cb.at) + out.slice(cb.at, cb.end).replace(/[^\r\n]/g, ' ') + out.slice(cb.end);
  }
  return out;
}

/**
 * A copy of `index` whose bodies have their walk callbacks blanked: what the code does OUTSIDE any walk. The same keys, starts and
 * ends, so a walk over it reaches exactly what is reachable without passing through a callback.
 */
export function indexWithoutWalkCallbacks(index, names) {
  const bodies = new Map();
  for (const [key, entry] of index.bodies) bodies.set(key, { ...entry, body: blankWalkCallbacks(entry.body, names) });
  return { ...index, bodies };
}

/**
 * The loops in a body, as `{ kind, at, head, vars, body }`: `for` / `for await` / `while`, an array iteration (`.map` / `.forEach` /
 * `.flatMap` with a closure) and `mapLimit(…)`. `vars` are the names the loop binds (`for (const [a, b] of …)` -> a, b; a closure's
 * first parameter), `body` the text the loop repeats, `at` its offset in `text`.
 */
export function loopsIn(text) {
  const out = [];
  for (const m of text.matchAll(/(?<![\w$.])(for\s*(?:await\s*)?\(|while\s*\()/g)) {
    const open = m.index + m[0].length - 1;
    let head;
    try { head = balancedFrom(text, open, 'a loop head'); } catch { continue; }
    const after = open + head.length;
    const lead = /^\s*/.exec(text.slice(after))[0].length;
    let body = '';
    try {
      body = text[after + lead] === '{' ? balancedFrom(text, after + lead, 'a loop body') : statementFrom(text, after + lead, 'a loop statement');
    } catch { /* a head with no body is not a loop worth reading */ }
    const binding = /^\(\s*(?:const|let|var)\s+([^]*?)\s+(?:of|in)\b/.exec(head);
    const vars = binding ? [...binding[1].matchAll(/[A-Za-z_$][\w$]*/g)].map(v => v[0]) : [];
    out.push({ kind: m[1].replace(/\s*\($/, '').replace(/\s+/g, ' '), at: m.index, head, vars, body });
  }
  for (const m of text.matchAll(/\.\s*(map|forEach|flatMap)\s*\(\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*(?::[^=)]*)?=>/g)) {
    const open = text.indexOf('(', m.index);
    let group;
    try { group = balancedFrom(text, open, 'an iteration'); } catch { continue; }
    const params = (m[2] ?? m[3] ?? '').split(',')[0];
    const first = /[A-Za-z_$][\w$]*/.exec(params)?.[0];
    const before = text.slice(Math.max(0, m.index - 120), m.index);
    out.push({ kind: m[1], at: m.index, head: `${before.replace(/\s+/g, ' ').slice(-70)}.${m[1]}`, vars: first ? [first] : [], body: group });
  }
  for (const m of text.matchAll(/(?<![.\w$])mapLimit\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    let group;
    try { group = balancedFrom(text, open, 'a mapLimit'); } catch { continue; }
    // mapLimit(items, limit, async (item, index) => …): the closure's first parameter is what each slot iterates.
    const cb = /(?:async\s+)?\(\s*([A-Za-z_$][\w$]*)[^)]*\)\s*(?::[^=)]*)?=>/.exec(group);
    out.push({ kind: 'mapLimit', at: m.index, head: group.slice(0, 80).replace(/\s+/g, ' '), vars: cb ? [cb[1]] : [], body: group });
  }
  return out;
}

/**
 * What the function at `key` calls its first parameter (`sweepSpace(spaceId, …)` -> `spaceId`), or null: read from the declaration's
 * own parameter list. The gate's second way of knowing a loop iterates spaces: it hands its variable to a `space…` parameter.
 */
export function firstParameterName(index, key) {
  const entry = index.bodies.get(key);
  if (!entry || entry.synthetic) return null;
  const src = index.sources.get(entry.file);
  const name = entry.name.replace(/^.*\./, '');
  const decl = new RegExp(`(?:function\\s*\\*?\\s*${name}\\s*(?:<[^>(]*>)?\\s*|(?:const|let)\\s+${name}\\s*(?::[^=\\n]*)?=\\s*(?:async\\s+)?(?:<[^>(]*>)?\\s*)\\(`).exec(src);
  if (!decl) return null;
  const open = decl.index + decl[0].length - 1;
  if (Math.abs(open - entry.start) > 600) return null;   // the first declaration of that name is some other function
  let args;
  try { args = argumentsOf(src, open, `the parameters of ${key}`); } catch { return null; }
  return /^\s*(?:readonly\s+)?(?:\{[^}]*\}|[A-Za-z_$][\w$]*)/.exec(args[0] ?? '')?.[0]?.trim() ?? null;
}

/** Where a start form is read from, and how many roots each yields at the fewest; a form that yields fewer throws. */
export const ROOT_FLOORS = Object.freeze({ boot: 20, 'after-listening': 1, 'slot-pool': 1 });

const registerSynthetic = (index, key, file, name, body, start) => {
  if (!index.bodies.has(key)) index.bodies.set(key, { file, name, body, start, end: start + body.length, synthetic: true });
  return key;
};

/** Every call of `callee` (as a bare name) in the index, with the text of its whole argument list, as `{file, at, text}`. */
function callSitesOf(index, callee) {
  const out = [];
  for (const [file, src] of index.sources) {
    for (const m of src.matchAll(new RegExp(`(?<![.\\w$])${callee}\\s*\\(`, 'g'))) {
      if (/\bfunction\s*\*?\s*$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
      const open = m.index + m[0].length - 1;
      let text;
      try { text = balancedFrom(src, open, `the call of ${callee}`); } catch { continue; }
      out.push({ file, at: m.index, open, text });
    }
  }
  return out;
}

/**
 * Every way work is STARTED outside a request, as roots: `{ form, label, key, closures }`.
 *
 * - `interval` / `cron`: the jobs `_scheduled-jobs.mjs` found, rooted at their `run` (a closure is entered, a reference followed; an
 *   unfollowable one has `key: null` and is the caller's to name or fail on);
 * - `boot`: what `bootstrap.ts`'s `startConfiguredInstanceServices` calls, and what `index.ts`'s `main` calls before it listens;
 * - `after-listening`: the closure handed to `afterListening(…)`;
 * - `slot-pool`: the option object handed to `runSlotPool(…)` (its `claim:` and `run:` members are closures).
 *
 * `void loop()` needs no form of its own: it is a call in a start function's body, and the boot walk follows calls.
 * `closures` says how the walk from the root treats nested closures: a timer's run is followed THROUGH its closures (`.map(async …)`
 * runs because the tick runs), boot is not (`createApp()` wires handlers and runs none).
 */
export function housekeepingRoots(index, jobs) {
  const roots = [];
  for (const j of jobs) roots.push({ form: j.kind, label: j.label, key: j.runKey, closures: true });

  const entry = (file, fn, until) => {
    const e = index.bodies.get(`${file}:${fn}`);
    assert.ok(e, `${file}:${fn} is not in the index — re-anchor the boot roots`);
    let body = e.body;
    if (until) { const i = body.search(until); if (i > 0) body = body.slice(0, i); }
    for (const name of callsIn(body, { closures: false })) {
      const key = index.resolve(file, name);
      if (key) roots.push({ form: 'boot', label: `${fn} -> ${name}`, key, closures: false });
    }
  };
  entry('server/src/bootstrap.ts', 'startConfiguredInstanceServices');
  entry('server/src/index.ts', 'main', /\.listen\(/);

  for (const [form, callee] of [['after-listening', 'afterListening'], ['slot-pool', 'runSlotPool']]) {
    for (const site of callSitesOf(index, callee)) {
      const key = registerSynthetic(index, `${site.file}:${callee}@${site.at}`, site.file, `${callee}@${site.at}`, site.text, site.open);
      roots.push({ form, label: key, key, closures: true });
    }
  }

  for (const [form, floor] of Object.entries(ROOT_FLOORS)) {
    const n = roots.filter(r => r.form === form && r.key).length;
    assert.ok(n >= floor, `only ${n} '${form}' root(s) derived, below the floor of ${floor}. The start form moved or the derivation broke: `
      + 'with no roots of that form every walk it starts is read as never started.');
  }
  return roots;
}

/**
 * Every key reachable from the roots WITHOUT passing through a walk callback: the code that runs unprotected. (What a callback runs
 * is the walk runner's to isolate, bound and judge.) Returns the reached keys and the callback-blanked index they index into.
 */
export function reachOutsideWalks(index, roots, names) {
  const blanked = indexWithoutWalkCallbacks(index, names);
  const edges = intervalJobEdges(intervalJobRuns(index));
  const keys = (closures) => roots.filter(r => r.key && r.closures === closures).map(r => r.key);
  const seen = new Set();
  for (const closures of [true, false]) {
    const start = keys(closures);
    if (start.length > 0) for (const k of walkFrom(blanked, start, { closures, edges }).seen) seen.add(k);
  }
  return { blanked, seen };
}

/**
 * The `edges` option of `walkFrom` that makes a function which STARTS a walk reach what its callbacks call.
 *
 * ## Why a boot walk needs it
 *
 * The boot walk follows what a function does when it is CALLED, and cuts every nested closure with a block body (`withoutNestedClosures`),
 * because `createApp()` registers a hundred handlers it never runs. A walk callback is the opposite case: `eachSpace(step, spaces, async () => {
 * await convertSpaceInWalk(id); })` RUNS its callback, immediately and once per space, as part of the call. Read as a cut closure, a
 * boot migration written inside one is invisible — `no-boot-migration-on-synced-data` could not see it, and the code that avoided the gap
 * did so by putting the work in a named helper called from a concise arrow. This edge makes the callback's calls part of the caller's.
 *
 * Only a WALK's callbacks are followed this way (the names from {@link walkEntryNames}): a closure handed to anything else is not known to
 * run, and following it would put every request handler back into the boot walk.
 *
 * @param {ReturnType<import('./_call-graph.mjs').moduleIndex>} index
 * @param {Iterable<string>} names  from {@link walkEntryNames}
 */
export function walkCallbackEdges(index, names) {
  return (entry) => {
    const out = [];
    for (const call of walkCallsIn(entry.body, names)) {
      for (const cb of call.callbacks) {
        for (const name of callsIn(cb.text, { closures: true })) {
          const key = index.resolve(entry.file, name);
          if (key) out.push(key);
        }
      }
    }
    return out;
  };
}

/**
 * The walk runner's OWN work: every function of `util/housekeeping-walk.ts`, and every function it imports (the store ping, the
 * bound scope, the reporter). It runs on behalf of every walk, so it belongs to what runs "inside a walk" even though no callback
 * calls it — the ping is reached through a parameter default, which no call scan follows.
 */
export function walkRunnerKeys(index) {
  // The runner's file and every file it imports: `storeAnswers` is a const built by a factory, so the function that pings is
  // `createStoreAnswers`, which no import names. Whole files, because that is the grain the runner depends on.
  const files = new Set([WALK_FILE, ...[...(index.imports.get(WALK_FILE)?.values() ?? [])].map(i => i.file)]);
  const keys = new Set([...index.bodies.keys()].filter(k => files.has(k.slice(0, k.indexOf(':')))));
  assert.ok(keys.size >= 5, `only ${keys.size} function(s) in the walk runner and what it imports: the derivation is broken`);
  return [...keys];
}

/**
 * The text of every walk callback in the index as a synthetic body of its own, `owner#walkcb@<offset>`, and the keys it reaches
 * through calls (closures followed): what runs INSIDE a walk. `extraRoots` are walk-runner functions whose own work is part of
 * every walk (the verdict's ping).
 */
export function insideWalks(index, names, extraRoots = []) {
  const callbacks = [];
  for (const [key, e] of [...index.bodies]) {
    if (e.synthetic && key.includes('#walkcb@')) continue;
    for (const call of walkCallsIn(e.body, names)) {
      for (const cb of call.callbacks) {
        callbacks.push(registerSynthetic(index, `${key}#walkcb@${call.at}`, e.file, `${e.name}#walkcb@${call.at}`, cb.text, e.start + cb.at));
      }
    }
  }
  const edges = intervalJobEdges(intervalJobRuns(index));
  const seen = walkFrom(index, [...callbacks, ...extraRoots.filter(k => index.bodies.has(k))], { closures: true, edges }).seen;
  return { callbacks, seen };
}

/** A per-space primitive: a name built for a space's collection, or a path under its file tree. */
const SPACE_PRIMITIVE = /\bspaceCollection\s*\(|\bspaceRoot\s*\(|\bchunksRoot\s*\(|\bgetSpaceFilesRoot\s*\(|`\$\{[^}]*\}_[a-z_]*`/;

/** Every function that opens a per-space primitive or calls one that does, to exhaustion: what REACHES a space's data. */
export function spaceReachers(index) {
  const reachers = new Set([...index.bodies].filter(([, e]) => SPACE_PRIMITIVE.test(e.body)).map(([k]) => k));
  for (let grew = true; grew;) {
    grew = false;
    for (const [k, e] of index.bodies) {
      if (reachers.has(k)) continue;
      for (const name of callsIn(e.body, { closures: true })) {
        const target = index.resolve(e.file, name);
        if (target && reachers.has(target)) { reachers.add(k); grew = true; break; }
      }
    }
  }
  return reachers;
}

/**
 * The loops that ITERATE SPACES, in one body, and whether they reach a space's data. A loop iterates spaces when
 *  - its header names them (`spaceIds`, `concreteSpaces()`, `net.spaces`, `spaceDirs`), or
 *  - it hands its own variable to a function whose first parameter is a `space…` (`sweepSpace(spaceId)`) — the spelling of the
 *    iterable does not matter, which is how a loop over `probe` or `candidates` is found.
 * It is a SUBJECT when it also reaches a per-space primitive (directly or through {@link spaceReachers}).
 *
 * @returns {{loop: object, header: boolean, hands: boolean, reaches: boolean}[]}  every space-iterating loop, reaching or not
 */
export function spaceLoopsIn(index, entry, reachers) {
  const out = [];
  for (const loop of loopsIn(entry.body)) {
    const header = /\bspaces?\b|\bspaceIds?\b|\bspaceDirs?\b|concreteSpace|\.spaces\b/i.test(loop.head);
    let hands = false;
    for (const site of callSitesIn(loop.body, { closures: true })) {
      const target = index.resolve(entry.file, site.name);
      const param = target ? firstParameterName(index, target) : null;
      if (!param || !/space/i.test(param)) continue;
      let args;
      try { args = argumentsOf(loop.body, site.paren, `the call of ${site.name}`); } catch { continue; }
      if (loop.vars.some(v => new RegExp(`^${v}(?:\\.\\w+)?$`).test((args[0] ?? '').trim()))) hands = true;
    }
    if (!header && !hands) continue;
    const reaches = SPACE_PRIMITIVE.test(loop.body)
      || [...callsIn(loop.body, { closures: true })].some(n => { const t = index.resolve(entry.file, n); return t && reachers.has(t); });
    out.push({ loop, header, hands, reaches });
  }
  return out;
}

/** Every `catch` block in a text, as `{at, param, body}`. */
export function catchesIn(text) {
  const out = [];
  for (const m of text.matchAll(/\bcatch\s*(?:\(([^)]*)\))?\s*\{/g)) {
    let body;
    try { body = balancedFrom(text, m.index + m[0].length - 1, 'a catch block'); } catch { continue; }
    out.push({ at: m.index, param: m[1] ?? null, body });
  }
  return out;
}
