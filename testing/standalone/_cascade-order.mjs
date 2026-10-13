/**
 * Does a cascade ask its guard BEFORE the call that reaches its first irreversible step — read by following the call.
 *
 * ## The question it answers
 *
 * "In this source, does `entry` call `guard` before anything it calls can change something?" Asked by the two gates that hold the
 * move cascade's destination check (`every-door-that-places-bytes-checks-its-destination`,
 * `file-mutation-tools-state-their-cascade`), which each carried their own copy of a text-order scan over the entry's body.
 *
 * ## What it prevents
 *
 * The copies looked for the irreversible steps (`holdJobsForMove`, `writePendingFileTombstones`, `moveFile`, ...) INSIDE the entry's
 * body. When the cascade was split, those calls moved into `beginMove`, the body held none of the names, and one gate passed
 * because nothing preceded the guard while the other passed because a missing step was read as "not before the guard". Both said
 * "ordered" about a function whose order they could no longer see.
 *
 * So the steps are searched where they are: a callee defined in the same source holds a step when its body calls it, or calls a
 * callee that does (followed transitively), and a call of such a callee in the entry counts as the step at that position.
 * **A step that no call after the guard reaches is a failure**, never a pass: the gate has lost the thing it holds.
 *
 * ## What counts as "before"
 *
 * A step-reaching call must not stand earlier than the guard IN THE BLOCK THAT HOLDS THE GUARD. A sibling branch is another path: the
 * cascade's finishing branch (a move whose bytes already moved) reaches `completeMove` without the guard, because that move was
 * guarded when it began, and the guard's own block is the path of a move that begins now.
 */
import assert from 'node:assert/strict';
import { blankComments } from './_strip-comments.mjs';
import { bodyOf, enclosingBlockAround } from './_structural-window.mjs';

const callOf = (name) => new RegExp(`(?<![.\\w$])${name}\\s*\\(`, 'g');
const hasCall = (text, name) => new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(text);

/** The names of the functions declared at the top level of `src`, each with its body. */
function declaredFunctions(src) {
  const out = new Map();
  for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)) {
    if (out.has(m[1])) continue;
    try { out.set(m[1], bodyOf(src, m[1], m[1])); } catch { /* an overload or an odd shape: not followed */ }
  }
  return out;
}

/**
 * @param {string} source the module that holds `entry`
 * @param {{ entry: string, guard: string, steps: readonly string[] }} what
 *   `steps` are the names of what changes something (a tombstone written, a job held, bytes moved). They are what the gate is ABOUT,
 *   not a derived set; where each is called from is derived.
 * @returns {{ guards: boolean, why: string, reached: string[] }} `reached` are the steps some call after the guard reaches.
 */
export function guardPrecedesIrreversibleSteps(source, { entry, guard, steps }) {
  const src = blankComments(source);
  const functions = declaredFunctions(src);
  const body = functions.get(entry);
  assert.ok(body, `${entry}: no top-level function of that name in the source — re-anchor this gate`);
  const guardAt = body.search(new RegExp(`(?<![.\\w$])${guard}\\s*\\(`));
  if (guardAt < 0) return { guards: false, why: `${entry} never calls ${guard}`, reached: [] };

  // The steps a call of `name` reaches: itself when it is one, else what its body (transitively) calls.
  const cache = new Map();
  const reach = (name, trail = new Set()) => {
    if (steps.includes(name)) return new Set([name]);
    if (cache.has(name)) return cache.get(name);
    const fn = functions.get(name);
    const found = new Set();
    if (fn !== undefined && !trail.has(name) && name !== entry) {
      const next = new Set(trail).add(name);
      for (const step of steps) if (hasCall(fn, step)) found.add(step);
      for (const other of functions.keys()) if (other !== name && other !== entry && hasCall(fn, other)) for (const s of reach(other, next)) found.add(s);
    }
    if (trail.size === 0) cache.set(name, found);
    return found;
  };

  const calls = [];
  for (const name of new Set([...steps, ...functions.keys()])) {
    if (name === entry) continue;
    const reached = reach(name);
    if (reached.size === 0) continue;
    for (const m of body.matchAll(callOf(name))) calls.push({ name, at: m.index, reached });
  }

  // The guard's own block: the path of an act that begins now. Where the guard is at the top of the body, that is the body.
  let from = 0;
  let to = body.length;
  try {
    const block = enclosingBlockAround(body, guardAt, `${entry}'s guard`);
    const at = body.indexOf(block);
    if (at >= 0 && at <= guardAt && guardAt < at + block.length) { from = at; to = at + block.length; }
  } catch { /* the guard is not inside a block of the body: the whole body is its block */ }

  const before = calls.filter(c => c.at >= from && c.at < to && c.at < guardAt);
  if (before.length > 0) {
    const c = before.sort((a, b) => a.at - b.at)[0];
    return { guards: false, why: `${guard} comes after ${c.name}, which reaches ${[...c.reached].join(', ')}`, reached: [] };
  }
  const reached = new Set();
  for (const c of calls) if (c.at >= from && c.at < to && c.at > guardAt) for (const s of c.reached) reached.add(s);
  const missing = steps.filter(s => !reached.has(s));
  if (missing.length > 0) {
    return { guards: false, why: `nothing ${entry} calls after ${guard} reaches ${missing.join(', ')}, so the gate no longer follows the code that holds ${missing.length === 1 ? 'it' : 'them'}`, reached: [...reached] };
  }
  return { guards: true, why: '', reached: [...reached] };
}

/** What the move cascade does that cannot be undone: a job held, a tombstone written, bytes moved. */
export const MOVE_CASCADE_STEPS = Object.freeze(['holdJobsForMove', 'writePendingFileTombstones', 'actUnderPendingTombstones', 'moveFile']);

/**
 * The one instance both destination gates ask: does `moveFileCascade` (`files/move-cascade.ts`, passed as `source`) ask
 * `assertDestinationReachable` before the call that reaches its first irreversible step? One spelling of the entry, the guard and the
 * steps, so the two gates cannot hold the cascade to two different orders.
 */
export const moveCascadeAsksDestinationFirst = (source) =>
  guardPrecedesIrreversibleSteps(source, { entry: 'moveFileCascade', guard: 'assertDestinationReachable', steps: MOVE_CASCADE_STEPS });
