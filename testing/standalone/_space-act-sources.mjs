/**
 * The server's source as the space-act gates read it: comment-stripped, derived from the tree, with the floor inside.
 *
 * ## The question it answers
 *
 * *"What does `server/src` say, with its comments out, about space acts"* — asked by `every-space-act-goes-through-the-runner`,
 * `one-standing-predicate`, `every-space-writer-asks-the-write-gate` and `every-act-entry-is-cleared-with-its-post-steps`, each of
 * which would otherwise spell the same four lines: list the tracked-or-written sources, read them, strip the comments, assert a floor.
 *
 * ## What a hand-written copy drops
 *
 * **The comment strip.** A docblock that NAMES `pendingSpaceActs` or `runSpaceAct(` is the first thing a source gate matches, and a
 * gate that matches prose concludes about prose. Everything here is read through `stripComments`.
 * **The floor.** An empty listing passes every loop written over it; `trackedSources` carries it, and {@link requireSource} throws
 * (never returns an empty string) for a file the rule is ABOUT, so a gate over a module that does not exist yet is red for that
 * absence and not silently green.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { topLevelFunctionSpans } from './_call-graph.mjs';

/** The runner module the design names (§2.5). */
export const RUNNER = 'server/src/spaces/space-act-runner.ts';

let cache;

/** `path -> comment-stripped text` for every source under `server/src`, including files not committed yet. */
export function serverSources() {
  if (!cache) {
    const files = trackedSources('server/src', { untracked: true, floor: 100 });
    cache = new Map(files.map(f => [f, stripComments(readFileSync(join(REPO_ROOT, f), 'utf8'))]));
  }
  return cache;
}

/** The stripped text of a file the rule is about; THROWS when it is not in the tree (the rule's own red, not a quiet pass). */
export function requireSource(file) {
  const src = serverSources().get(file);
  if (src === undefined) throw new Error(`${file} is not in the tree — the rule this gate holds is about it`);
  return src;
}

/** The body (braces included) of a top-level function; THROWS when it is not there. */
export function bodyOf(file, name) {
  const span = topLevelFunctionSpans(requireSource(file)).get(name);
  if (!span) throw new Error(`${file} has no top-level function '${name}'`);
  return span.body;
}

/** Every file under `server/src` whose stripped text matches `re`, as `[file, matchCount]`. */
export function filesMatching(re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const out = [];
  for (const [file, src] of serverSources()) {
    const n = [...src.matchAll(g)].length;
    if (n > 0) out.push([file, n]);
  }
  return out;
}
