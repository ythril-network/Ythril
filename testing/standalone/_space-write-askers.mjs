/**
 * Every function in the server that asks the space write gate — derived from the source, never listed — and what each does with the
 * fence (bundle-106 PR A, X2, §2.6b, §3.3a).
 *
 * ## The question it answers
 *
 * *"Which functions admit a write to a space, and which of them count it?"* Two gates ask it from opposite ends — `every-space-writer-asks-the-write-gate`
 * (does a writer ask?) and `every-transfer-enters-the-fence` (is what was admitted counted?) — and each needs the same subject: the functions
 * that call `assertSpaceTakesWrites(` or an asking wrapper. One derivation, so the two cannot disagree about who the askers are, and so a
 * gate that starts from "functions that already enter the fence" (which could not see a writer that asks and enters nothing) is not written a second time.
 *
 * ## What a hand-written copy drops
 *
 * - **A function written as a closure or a const arrow** is still a function: the asker is the NEAREST enclosing function-like, and a name is
 *   found through the const it is bound to; an anonymous one is named `(anonymous)` and keyed that way, never skipped.
 * - **The wrapper is an asker too.** A function that goes through {@link ASKING_WRAPPERS} asks and enters by that call; the wrapper itself
 *   asks and enters in its own body, which the fence gate holds to "no await between".
 * - **A floor.** An empty derivation passes every loop written over it, so callers assert how many askers they found.
 */
import { readFileSync } from 'node:fs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { parseSource, walkEveryNode, lineOf, ts } from '../_shared/syntax-tree.mjs';

/**
 * The functions that ADMIT a write unit — ask the gate and count it in one step (`spaces/space-write-gate.ts`): `admitSpaceWrite` runs the
 * caller's body inside the unit, `admitSpaceWriteUnit` hands the release back for a writer whose unit is not one closure. A writer that goes
 * through one asks AND enters. The chain must end in a function that asks directly and enters with no await between (held by the fence gate).
 */
export const ASKING_WRAPPERS = ['admitSpaceWrite', 'admitSpaceWriteUnit'];

/** The call that IS the check. */
export const ASKS_DIRECTLY = 'assertSpaceTakesWrites';
/** The call that counts a write unit. */
export const ENTERS_FENCE = 'enterSpaceWrite';

/** The function a node is written in directly (a closure is its own function), or null at module scope. */
export const nearestFunctionOf = (node) => { for (let p = node.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p; return null; };

/** The name of a function node: its own, or the const it is bound to; `(anonymous)` otherwise. */
export function nameOfFunction(fn) {
  if (fn?.name && ts.isIdentifier(fn.name)) return fn.name.text;
  if (fn?.parent && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  return '(anonymous)';
}

/**
 * Every function under `server/src` that calls the gate or an asking wrapper, with the call nodes it makes: `asks` (the gate), `wraps` (an asking
 * wrapper) and `enters` (the fence). Keyed `<file>:<name>`, with the file relative to the repo root.
 */
export function askingFunctions() {
  const out = [];
  for (const file of trackedSources(['server/src'], { untracked: true, floor: 100 }).filter(f => f.endsWith('.ts'))) {
    const sf = parseSource(file, readFileSync(`${REPO_ROOT}/${file}`, 'utf8'));
    const byFn = new Map();
    walkEveryNode(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return;
      const callee = n.expression.text;
      const slot = callee === ASKS_DIRECTLY ? 'asks' : ASKING_WRAPPERS.includes(callee) ? 'wraps' : callee === ENTERS_FENCE ? 'enters' : null;
      if (!slot) return;
      const fn = nearestFunctionOf(n);
      if (!byFn.has(fn)) byFn.set(fn, { file, sf, fn, name: nameOfFunction(fn), asks: [], wraps: [], enters: [] });
      byFn.get(fn)[slot].push(n);
    });
    for (const entry of byFn.values()) {
      if (entry.asks.length === 0 && entry.wraps.length === 0) continue;   // enters without asking: not an asker
      // The wrapper calls anywhere INSIDE the function, closures included: a writer whose store write is a closure it hands the gate
      // (`const write = () => admitSpaceWrite(...)`) counts its unit although the call sits one function down.
      const inside = [];
      if (entry.fn) walkEveryNode(entry.fn, (n) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ASKING_WRAPPERS.includes(n.expression.text)) inside.push(n); });
      out.push({ ...entry, wrapsInside: inside, key: `${file}:${entry.name}`, line: lineOf(sf, [...entry.asks, ...entry.wraps][0]) });
    }
  }
  return out;
}
