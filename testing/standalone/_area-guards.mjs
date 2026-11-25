/**
 * The guards that ask a route's area rung, derived from the source that defines them: the question two gates ask
 * (`every-space-route-has-an-area`, `every-space-route-outside-the-api-has-auth-and-an-area-rung`), answered once.
 *
 * ## What it prevents
 *
 * A list of guard names written into a gate misses the next guard, which is exactly the route the gate exists to see. So the names are read
 * from the code: every exported function of `server/src/auth/middleware.ts` whose body calls `enforceAreaRung(`, and every exported const
 * bound to one of those (`requireSpaceAuth = requireSpaceAuthScoped('spaceId')`); and, for a route whose space is not its path segment (a
 * Linked Data address resolved by base, bundle-271 Q-758), every function of the route's own file whose body asks the inventory
 * (`rungFor(`) and a rung (`mayReadArea(` or `holdsRung(`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

/** The exported guards of `server/src/auth/middleware.ts` that ask the area rung. */
export function areaGuards() {
  const src = stripComments(read('server/src/auth/middleware.ts'));
  const names = new Set();
  for (const m of src.matchAll(/^export (?:async )?function (\w+)\s*\(/gm)) {
    if (/\benforceAreaRung\(/.test(bodyOf(src, m[1]))) names.add(m[1]);
  }
  for (const m of src.matchAll(/^export const (\w+)\s*=\s*(\w+)\(/gm)) if (names.has(m[2])) names.add(m[1]);
  return names;
}

/** The functions declared at the top level of `file` (a repo path) whose body asks the inventory (`rungFor(`) and a rung. */
export function resolvedRungGuards(file) {
  const src = stripComments(read(file));
  const names = new Set();
  for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+function|function)\s+(\w+)\s*\(/gm)) {
    const body = bodyOf(src, m[1]);
    if (/\brungFor\(/.test(body) && /\b(mayReadArea|holdsRung)\(/.test(body)) names.add(m[1]);
  }
  return names;
}
