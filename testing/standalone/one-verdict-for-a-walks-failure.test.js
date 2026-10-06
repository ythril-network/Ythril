/**
 * A walk's failure is judged ONCE, by `walkVerdict` — nothing a walk's caller writes asks the question again (`Q-274`, bundle-53 G25).
 *
 * ## The defect it keeps from coming back
 *
 * "Is this failure a hung space, or a dead store?" has two honest answers and they stop a walk differently: a hung space ends THAT space (its
 * next unit would only pay another bound against it), a store that does not answer ends the WALK. The first version of the walk answered it in
 * two places — the runner and a caller's catch that tested `isWriteTimeout(err)` itself — and the places disagreed about a bound that ended
 * on a store that was only slow: the caller read a hung space as a dead store and stopped every space after it. So the question is asked in
 * one function (`util/space-failure.ts` `walkVerdict`), by the walk's own helpers, awaited, and a caller learns the answer from the walk's
 * result, never by asking.
 *
 * ## What is held, derived
 *
 * 1. **No caller of a walk asks the verdict's questions.** A caller is any function whose text calls a walk entry (`eachSpace`, `walkSpaces`,
 *    `eachUnit`, `claimAcross` — `_housekeeping-walks.mjs`, read out of the runner) or a function that takes a verdict for the walk
 *    (`sweepCollection`, the one function outside the runner that calls `walkVerdict`). Its text, callbacks included, may not call an ASKER:
 *    `isWriteTimeout`, `isStoreCondition`, or any function of `db/store-condition.ts` / `db/write-timeout.ts` that mentions one — the set is
 *    derived from those two files, so `isStoreUnreachable` and `storeIsNotAnswering` are in it, and so is the next one.
 * 2. **`walkVerdict` is called only by the walk's own helpers, and always awaited.** An un-awaited call reads a Promise as a verdict, which is
 *    always truthy: the failure is then never `'space-failure'` and nothing looks wrong. The callers are the runner's functions plus the named
 *    row for `sweepCollection`.
 * 3. **No function spells the pair.** Outside `db/store-condition.ts`, no function calls two different askers: that is `isWriteTimeout(e) ||
 *    isStoreUnreachable(e)` by another spelling (an `if` chain, a `.some`), and the one question for code with no walk above it is
 *    `storeIsNotAnswering` (`the-store-is-not-answering-is-one-question` refuses the literal `||` pair; this reads the calls, so a rewritten
 *    spelling does not slip past it).
 * 4. **The modules the walk is built on import nothing from `brain/`.** The value-import closure of the walk core (the owners of `eachSpace`,
 *    `walkVerdict`, `intervalJob`, `storeAnswers`, `mongoClientOptions`, `isStoreUnreachable`, `cachedProbe`, `declareStep`, found by what they
 *    export) holds no file under `server/src/brain/`: a `util/` module that reaches `brain/` closes a cycle the first time `brain/` imports it.
 *    Scoped to this closure on purpose — `db/` imports `brain/` in several older places, and a gate that was red on main for those would be
 *    deleted.
 *
 * ## What it does not conclude
 *
 * It reads function TEXT. A caller that hands an error to a helper which asks (`classify(err)`) is not read, and a walk written WITHOUT
 * the runner has no verdict to duplicate (the isolation gate is what refuses such a walk).
 *
 * ## Seen red
 *
 * By hand, put back by hand: an `isWriteTimeout(err)` inside an `eachSpace` callback; the `await` removed from a `walkVerdict(` call; an
 * `import { … } from '../brain/…'` added to `util/housekeeping-walk.ts`; a function that calls both `isWriteTimeout` and `isStoreUnreachable`.
 *
 * Run: node --test testing/standalone/one-verdict-for-a-walks-failure.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moduleIndex, indexSources, callsIn, intervalJobRuns } from './_call-graph.mjs';
import { walkEntryNames, walkCallsIn } from './_housekeeping-walks.mjs';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { statementUpTo } from './_structural-window.mjs';
import { posix } from 'node:path';

const VERDICT_FILE = 'server/src/util/space-failure.ts';
const WALK_FILE = 'server/src/util/housekeeping-walk.ts';
const QUESTION_FILES = ['server/src/db/store-condition.ts', 'server/src/db/write-timeout.ts'];
const SEEDS = ['isWriteTimeout', 'isStoreCondition'];

/** Functions outside the runner that take a verdict for a walk, each with the reason that is its whole argument. */
const VERDICT_TAKERS = [
  {
    key: 'server/src/brain/ttl-sweep.ts:sweepCollection',
    why: 'The TTL sweep\'s per-record delete loop runs INSIDE a space\'s walk callback and has to tell one record\'s failure (skip it, go on) from a '
      + 'hung space or a dead store (stop), so it asks `walkVerdict` — the same function, awaited, and rethrows what the walk is to decide.',
  },
];

/** The askers: the seeds, and every function of the two question files that mentions one, read from those files. */
function askersOf(index) {
  const names = new Set(SEEDS);
  for (const [key, entry] of index.bodies) {
    if (!QUESTION_FILES.includes(entry.file) || entry.synthetic) continue;
    if (SEEDS.some(seed => new RegExp(`\\b${seed}\\b`).test(entry.body))) names.add(key.replace(/^.*:/, ''));
  }
  assert.ok(names.size >= 4 && names.has('isStoreUnreachable') && names.has('storeIsNotAnswering'),
    `the askers derive as ${[...names]}: the question files were read wrong`);
  return names;
}

/** Functions (and registered closures) whose text calls one of `names` — a "caller of a walk". */
function callersOf(index, names) {
  const out = [];
  for (const [key, entry] of index.bodies) {
    if (entry.file === WALK_FILE || entry.file === 'server/src/util/work-signal.ts') continue;
    if (walkCallsIn(entry.body, names).length > 0) out.push(key);
  }
  return out;
}

/** `{ key, ask }` for every asker a caller's text calls directly. */
function directAsks(index, callers, askers) {
  const out = [];
  for (const key of callers) {
    const entry = index.bodies.get(key);
    for (const ask of callsIn(entry.body, { closures: true })) if (askers.has(ask)) out.push({ key, ask });
  }
  return out;
}

/** Every `walkVerdict(` call in comment-stripped sources, as `{file, awaited, line}`. */
function verdictCalls(sources) {
  const out = [];
  for (const { file, text } of sources) {
    const code = stripComments(text);
    for (const m of code.matchAll(/(?<![\w$.])walkVerdict\s*\(/g)) {
      const before = statementUpTo(code, m.index, 'the statement a walkVerdict call sits in');
      if (/\bfunction\s*\*?\s*$/.test(before)) continue;   // the declaration
      out.push({ file, awaited: /\bawait\s*$/.test(before) || /\bawait\s*\(\s*$/.test(before), line: code.slice(0, m.index).split('\n').length, at: m.index });
    }
  }
  return out;
}

const index = moduleIndex('server/src');
intervalJobRuns(index);   // registers the closures handed to intervalJob, so a walk written inside one is a caller too
const ENTRY_NAMES = walkEntryNames(index);
const ASKERS = askersOf(index);
const sources = readTrackedSources('server/src', { floor: 300 });

describe('the question and its callers are read from the tree', () => {
  it('derives the askers from the two question files, with a floor', () => {
    assert.ok(ASKERS.has('isWriteTimeout') && ASKERS.has('isStoreCondition') && ASKERS.has('isStoreUnreachable') && ASKERS.has('storeIsNotAnswering'));
  });

  it('finds the callers of a walk (floor), and the verdict takers outside the runner', () => {
    const callers = callersOf(index, ENTRY_NAMES);
    assert.ok(callers.length >= 15, `only ${callers.length} caller(s) of a walk entry: the scan is broken`);
    const takers = [...index.bodies].filter(([, e]) => e.file !== VERDICT_FILE && e.file !== WALK_FILE && /\bwalkVerdict\s*\(/.test(e.body)).map(([k]) => k);
    assert.deepEqual(takers.sort(), VERDICT_TAKERS.map(t => t.key).sort(),
      'a function outside the walk runner calls walkVerdict: the question is asked in a second place. Let the walk helpers ask it, or name the function in VERDICT_TAKERS with the argument');
    for (const t of VERDICT_TAKERS) assert.ok(t.why.length > 60, `${t.key}: the reason is not an argument`);
  });
});

describe('a walk\'s failure is judged once', () => {
  it('no caller of a walk (or of a verdict taker) asks isWriteTimeout / isStoreCondition / isStoreUnreachable / storeIsNotAnswering', () => {
    const names = new Set([...ENTRY_NAMES, ...VERDICT_TAKERS.map(t => t.key.replace(/^.*:/, ''))]);
    const callers = callersOf(index, names);
    const asks = directAsks(index, callers, ASKERS);
    assert.deepEqual(asks.map(a => `${a.key}: asks ${a.ask}(…) itself`), [],
      'a function that starts a walk asks whether the failure is a timeout or the store\'s condition. The verdict is `walkVerdict`\'s, once: let the walk '
      + 'decide (`eachUnit` rethrows what it is to decide; the result says `storeDown` / `stalled`), do not test the error in the caller.');
  });

  it('walkVerdict is only called from the runner, and every call is awaited', () => {
    const calls = verdictCalls(sources);
    assert.ok(calls.length >= 3, `only ${calls.length} walkVerdict call(s) found: the scan is broken`);
    const unawaited = calls.filter(c => !c.awaited).map(c => `${c.file}:${c.line}`);
    assert.deepEqual(unawaited, [], 'walkVerdict is async: an un-awaited call reads a Promise as the verdict, which is never \'space-failure\' and never throws');
    const outsideRunner = [...new Set(calls.filter(c => c.file !== WALK_FILE).map(c => c.file))]
      .filter(f => !VERDICT_TAKERS.some(t => t.key.startsWith(`${f}:`)));
    assert.deepEqual(outsideRunner, [], 'walkVerdict is called outside the walk runner');
  });

  it('no function outside db/store-condition.ts calls two different askers (the pair, however it is spelled)', () => {
    const offenders = [];
    for (const [key, entry] of index.bodies) {
      if (QUESTION_FILES.includes(entry.file) || entry.synthetic) continue;
      const calls = callsIn(entry.body, { closures: true });
      const asked = [...ASKERS].filter(a => calls.has(a));
      if (asked.length >= 2) offenders.push(`${key} asks ${asked.join(' and ')}`);
    }
    assert.deepEqual(offenders, [], 'two askers in one function is `isWriteTimeout || isStoreUnreachable` by another spelling: use storeIsNotAnswering (db/store-condition.ts), or a walk');
  });
});

describe('the modules the walk is built on import nothing from brain/', () => {
  /** What a file imports as VALUES (`import type` and `export type` cost nothing at run time), resolved to repo paths. */
  const valueImports = (file, text = sources.find(s => s.file === file)?.text ?? '') => {
    const code = stripComments(text);
    const out = [];
    for (const m of code.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      out.push(posix.normalize(posix.join(posix.dirname(file), m[1])).replace(/\.js$/, '.ts'));
    }
    for (const m of code.matchAll(/(?:^|\n)\s*import\s*['"](\.{1,2}\/[^'"]+)['"]/g)) out.push(posix.normalize(posix.join(posix.dirname(file), m[1])).replace(/\.js$/, '.ts'));
    return out;
  };

  /** The file that exports `name`, found by the declaration — never by the file's name. */
  const ownerOf = (name) => {
    const owners = sources.filter(({ text }) => new RegExp(`(?:^|\\n)export\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`).test(stripComments(text))).map(s => s.file);
    assert.equal(owners.length, 1, `\`${name}\` is exported by ${owners.length} file(s) (${owners.join(', ')}): re-anchor the walk core`);
    return owners[0];
  };

  /** The walk core, by what it exports: the one runner, the one verdict, the one job, the one ping, the one client builder. */
  const CORE_SYMBOLS = ['eachSpace', 'walkVerdict', 'intervalJob', 'storeAnswers', 'mongoClientOptions', 'isStoreUnreachable', 'cachedProbe', 'declareStep'];

  const closureOf = (entries) => {
    const seen = new Map();
    const queue = entries.map(e => [e, null]);
    while (queue.length > 0) {
      const [file, via] = queue.pop();
      if (seen.has(file)) continue;
      seen.set(file, via);
      for (const dep of valueImports(file)) queue.push([dep, file]);
    }
    return seen;
  };

  it('the closure of the walk core holds no file under brain/', () => {
    const entries = [...new Set(CORE_SYMBOLS.map(ownerOf))];
    assert.ok(entries.length >= 6, `the walk core resolved to ${entries.length} file(s)`);
    const closure = closureOf(entries);
    assert.ok(closure.size >= 20, `the closure holds ${closure.size} file(s): the import scan is broken`);
    const reaches = [...closure.keys()].filter(f => f.startsWith('server/src/brain/')).map(f => `${f} (via ${closure.get(f)})`);
    assert.deepEqual(reaches, [], 'a module the walk is built on reaches brain/ through its value imports: move what it needs down into util/ or db/, or take it as a parameter');
  });

  it('the scan sees an import from brain/ when there is one (fixture)', () => {
    const text = "import { x } from '../brain/b.js';\nimport type { T } from '../brain/c.js';\nexport { y } from '../brain/d.js';\nexport type { U } from '../brain/e.js';";
    assert.deepEqual(valueImports('server/src/util/a.ts', text), ['server/src/brain/b.ts', 'server/src/brain/d.ts'],
      'a value import and a value re-export are found, and a type import and a type re-export are not');
  });
});

describe('the detector sees what it claims to', () => {
  const fixture = (text) => indexSources(new Map([['server/src/a.ts', text.replace(/^[ \t]+/gm, '')]]), { functionFloor: 1, label: 'the fixture' });
  const askers = new Set(['isWriteTimeout', 'isStoreUnreachable']);

  it('an ask inside a walk callback is found; the same walk with no ask is not', () => {
    const bad = fixture(`import { eachSpace } from './walk.js';
      export async function tick() { await eachSpace('s', ids, async (space) => { try { await w(space); } catch (e) { if (isWriteTimeout(e)) throw e; } }); }`);
    const good = fixture(`import { eachSpace } from './walk.js';
      export async function tick() { await eachSpace('s', ids, async (space) => { await w(space); }); }`);
    assert.equal(directAsks(bad, callersOf(bad, ENTRY_NAMES), askers).length, 1);
    assert.equal(directAsks(good, callersOf(good, ENTRY_NAMES), askers).length, 0);
  });

  it('an un-awaited walkVerdict is found, an awaited one and the declaration are not', () => {
    const calls = verdictCalls([{ file: 'x.ts', text: 'export async function walkVerdict() {}\nconst a = await walkVerdict(e);\nconst b = walkVerdict(e);\nconst c = (await walkVerdict(e)) === 1;' }]);
    assert.deepEqual(calls.map(c => c.awaited), [true, false, true]);
  });
});
