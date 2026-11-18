/**
 * What the REST routes' middleware chains say, and what each guard of `auth/middleware.ts` does: the one reading under the security flow-check
 * probes (rate limits, door parity, cross-space reads).
 *
 * ## What it prevents
 *
 * A probe that asks "is this route guarded" by looking for a guard's NAME in the route's own arguments. Three things make that wrong at once:
 * a router mounts a guard for all its routes (`dataRouter.use(globalRateLimit, requireAdmin)`) and the route line then carries none; a guard's
 * name says nothing of what it does (`requireAdminMfa` meters a token, refuses a non-admin and asks for a second factor); and a limiter
 * defined in one file (`publicRateLimit` in the schema-library router) is a name no list of limiters holds. So:
 *
 * - **Router-level guards are part of every chain.** `routerUseChains` reads each `<router>.use(<middleware>, ...)` whose first argument is
 *   not a path, and `routesWithChains` appends it to the chain of every route of that router in the file.
 * - **What a guard does is read from its body, never from its name.** `guardFacts` takes each top-level function of `auth/middleware.ts`
 *   and asks which of its acts it calls (attach and meter the token, the instance-admin refusal, the admin-or-space-admin refusal,
 *   the space-scope refusal, the create-spaces refusal, the second factor), through every function it calls, so a guard built on another (`requireSpaceAuth` is
 *   `requireSpaceAuthScoped('spaceId')`) has what that one has. A guard that stops calling `attachToken` stops being a meter here, and every
 *   route behind it with no limiter of its own stops being rate-limited.
 * - **A limiter is any `const X = rateLimit(` in the server's code**, found, not listed (`limiterNames`).
 *
 * The routes are `mountedRoutesWithSource` (the project's one route scan); this adds only the chains. Nothing here names a route or a guard to
 * look for beyond the declarations it finds.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mountedRoutesWithSource } from '../../testing/standalone/_routes.mjs';
import { stripComments } from '../../testing/standalone/_strip-comments.mjs';
import { argumentsOf, bodyOf } from '../../testing/standalone/_structural-window.mjs';
import { REPO_ROOT, SERVER_SOURCE_ROOT, SERVER_CODE_ROOTS, readTrackedSources } from '../../testing/standalone/_sources.mjs';
import { CannotAnswer } from './_verdict.mjs';

/** The guard file: every `require*` the routers mount is declared here. */
export const MIDDLEWARE_FILE = `${SERVER_SOURCE_ROOT}/auth/middleware.ts`;

/** The acts a guard may perform, each found by the call that does it. */
const ACTS = {
  metered: /\battachToken\s*\(/,
  instanceAdmin: /\benforceAdmin\s*\(/,
  spaceAdmin: /\b(?:enforceAdminOrSpaceAdmin|isSpaceAdminFor)\s*\(/,
  spaceScope: /\b(?:enforceSpaceScope|spacesForBodyScopedRequest)\s*\(/,
  createsSpaces: /\bcreateSpacesRefusal\s*\(/,
  mfa: /\benforceMfa\s*\(/,
};

/** The read-only refusal is the function of this name; `routeFacts` asks whether a chain names it. */
export const READ_ONLY_GUARD = 'denyReadOnly';

/**
 * `Map<guardName, { metered, instanceAdmin, spaceAdmin, spaceScope, mfa }>` for every top-level function or constant of the guard file,
 * closed over the functions each one calls. `middlewareText` is the file's source, comments in (they are stripped here).
 */
export function guardFacts(middlewareText) {
  const code = stripComments(middlewareText);
  const names = [...new Set([...code.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|const)\s+(\w+)/gm)].map(m => m[1]))];
  if (names.length < 20) throw new CannotAnswer(`only ${names.length} top-level declarations found in ${MIDDLEWARE_FILE}: the guard file was not read`);
  const bodies = new Map(names.map(n => [n, bodyOf(code, n, `${MIDDLEWARE_FILE} ${n}`)]));
  const facts = new Map(names.map(n => [n, Object.fromEntries(Object.entries(ACTS).map(([k, re]) => [k, re.test(bodies.get(n))]))]));
  for (let changed = true; changed;) {
    changed = false;
    for (const n of names) {
      for (const m of names) {
        if (m === n || !new RegExp(`\\b${m}\\s*\\(`).test(bodies.get(n))) continue;
        for (const k of Object.keys(ACTS)) if (facts.get(m)[k] && !facts.get(n)[k]) { facts.get(n)[k] = true; changed = true; }
      }
    }
  }
  return facts;
}

/** Names of every rate limiter the server's code declares (`const X = rateLimit(`), from sources `{ file, text }`. */
export function limiterNames(sources) {
  const out = new Set();
  for (const { text } of sources) for (const m of stripComments(text).matchAll(/\bconst\s+(\w+)\s*(?::[^=\n]+)?=\s*rateLimit\s*\(/g)) out.add(m[1]);
  return out;
}

/** `Map<routerName, middlewareArguments>` for each `<router>.use(...)` of `text` whose first argument is not a path. */
export function routerUseChains(text) {
  const code = stripComments(text);
  const out = new Map();
  for (const m of code.matchAll(/\b(\w*[Rr]outer)\s*\.\s*use\s*\(/g)) {
    const args = argumentsOf(code, m.index + m[0].length - 1, `${m[1]}.use`);
    if (!args.length || /^['"`]/.test(args[0])) continue;
    out.set(m[1], [out.get(m[1]), ...args].filter(Boolean).join(','));
  }
  return out;
}

/** Every mounted route as `{ method, path, file, chain, routerChain, all, source }`; `all` is the router's guards then the route's own. */
export function routesWithChains() {
  if (process.cwd() !== REPO_ROOT) process.chdir(REPO_ROOT);
  const useByFile = new Map();
  return mountedRoutesWithSource().map(r => {
    if (!useByFile.has(r.file)) useByFile.set(r.file, routerUseChains(readFileSync(join(REPO_ROOT, r.file), 'utf8')));
    const routerChain = useByFile.get(r.file).get(r.router) ?? '';
    return { method: r.method, path: r.path, file: r.file, chain: r.chain, routerChain, all: [routerChain, r.chain].filter(Boolean).join(','), source: r.source };
  });
}

/**
 * What a chain does: the union of the acts of every guard it names, the limiters it names and whether it names the read-only refusal.
 *
 * @param {string} chain middleware text of a route
 * @param {Map<string, object>} guards from {@link guardFacts}
 * @param {Set<string>} limiters from {@link limiterNames}
 */
export function chainFacts(chain, guards, limiters) {
  const named = (n) => new RegExp(`\\b${n}\\b`).test(chain);
  const out = { metered: false, instanceAdmin: false, spaceAdmin: false, spaceScope: false, createsSpaces: false, mfa: false, limiters: [], readOnly: named(READ_ONLY_GUARD) };
  for (const [n, f] of guards) if (named(n)) for (const k of Object.keys(ACTS)) out[k] ||= f[k];
  out.limiters = [...limiters].filter(named);
  return out;
}

/**
 * Does the route's handler hand the call to the tool dispatcher? `callTool` is what the MCP door dispatches through and what these REST
 * routes (`/api/brain/recall`, the generic tool door) call, so the guard, the rung, the space narrowing and the read-only refusal are the
 * tool's own: one implementation behind two doors, which cannot differ. `source` is the route's handler window from `routesWithChains`.
 */
export const dispatchesThroughCallTool = (source) => /\bcallTool\s*\(/.test(source ?? '');

/** The server's code, read: every tracked `.ts` of `SERVER_CODE_ROOTS`, specs out. */
export const serverSources = () => readTrackedSources(SERVER_CODE_ROOTS, { ext: ['.ts'], specs: false });

/** The guard file's text from the checkout. */
export const middlewareText = () => readFileSync(join(REPO_ROOT, MIDDLEWARE_FILE), 'utf8');
