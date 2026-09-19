/**
 * What parameters does a REST route accept? Read from the route, never from a list beside it.
 *
 * ## Why this exists
 *
 * `Q-9`: parameter parity between an MCP tool and its REST route was gated on FOUR pairs out of forty-six,
 * because only four routes export an accepted-key set. The blocker was priced as "give forty-two routes an
 * exported list" — a refactor of the routes. Measured, that price was wrong: a route with no exported list
 * still STATES what it accepts, in one of a handful of shapes, and reading them is a parser.
 *
 * ## The shapes, and what each is worth
 *
 * | shape | the keys |
 * |---|---|
 * | `unknownBodyFields(req.body, QUERY_BODY_FIELDS)` | the exported list — what the original four use |
 * | `Schema.safeParse(req.body)` | the zod object's keys, including one declared locally in the file |
 * | `const { a, b } = req.body` **and no other body read** | the destructured names, as written |
 * | the handler never mentions `req.body` | the accepted set is EMPTY, which is an answer |
 * | anything else | `unresolved`, WITH the reason |
 *
 * A destructure is a BETTER source than an exported constant when it is the whole of the reading, because
 * it cannot drift from what the handler does — it IS what the handler does. `*_BODY_KEYS` shows the other
 * case: its own docblock says the shared write options are "NOT listed: they are read by helpers".
 *
 * ## EIGHT wrong answers came before this was right, and four of them read as findings
 *
 * Recorded because the next parser over this surface will hit a ninth, and because every one of them was
 * caught by the SHAPE of the output rather than by reading the route.
 *
 *  1. **Half the API invisible.** Ten brain routers mount as `brainRouter.use(memoriesRouter)` with no
 *     prefix argument — 117 registrations found against a real 216. Now `_router-mounts.mjs` (`Q-19`).
 *  2. **A row matched to another router's registration**, by asking whether the row's route ended with the
 *     registration's path. Four routers declare `/:id`. Also `_router-mounts.mjs`.
 *  3. **A partial destructure read as the whole contract.** `POST /facts` destructures six keys and then
 *     reads the body five more times through helpers, so taking the destructure as authoritative reported
 *     twelve gaps on `remember` alone. The tell: the same two keys missing from EVERY subject is a shared
 *     option behind a helper, never eleven independent defects.
 *  4. **Query parameters compared against body keys.** A tool argument can arrive in the query string on
 *     any method, not only `GET`.
 *  5. **A query key read through a helper.** `POST /:spaceId/mkdir` gets its `path` from
 *     `requireQueryPath(req, res)`, so reading `req.query` directly is still not enough.
 *  6. **A helper's body slid to end-of-file**, so `accessibleSpaces` — which reads `req.authToken` and
 *     nothing else — looked like it read `req.body`, and twelve routes were disqualified by it.
 *  7. **A tool compared against a SIBLING route** because the right one was unreadable, and path parameters
 *     counted as missing.
 *  8. **The worst of them: a negated-comma class inside a generic.** `unknownBodyFields((req.body ?? {}) as
 *     Record<string, unknown>, RECALL_BODY_FIELDS)` yielded the set name `unknown`, so the four pairs the
 *     PREVIOUS gate covered — `recall`, `query`, `traverse`, `similar` — were silently skipped while
 *     this one reported a much bigger number. A new instrument that drops the old one's coverage is the
 *     worst way to be wrong here, and it is why those four now have a case of their own.
 *
 * The last two are why {@link routeAcceptKeys} returns a `queryKeys` set AND refuses to answer for a
 * handler that hands `req` to a helper. A guessed answer here becomes a parity finding somebody has to
 * disprove, which costs more than the gap.
 */
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { mountedRoutesWithSource } from './_routes.mjs';
import { argumentsOf } from './_structural-window.mjs';

/** From the `{` at `open`, the matching `}`. Depth-counted, so a nested object does not end it early. */
function literalAt(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

/**
 * The TOP-LEVEL keys of a `z.object({ … })` declared in this file.
 *
 * Most route bodies are validated by a schema declared beside the route rather than exported, so without
 * this thirty routes would come back unresolved for no better reason than the symbol being file-local.
 *
 * Returns `null` for anything that is not a plain object literal — a union, an `.extend()` chain, a schema
 * built from another. Those stay unresolved, which is the honest answer.
 */
function localZodKeys(src, name) {
  const decl = new RegExp(`\\bconst\\s+${name}\\s*(?::[^=]*)?=\\s*z\\.object\\(\\s*\\{`).exec(src);
  if (!decl) return null;
  const lit = literalAt(src, src.indexOf('{', decl.index + decl[0].length - 1));
  if (!lit) return null;
  const keys = [];
  let depth = 0;
  for (const m of lit.matchAll(/\{|\}|(?:^|[,{])\s*['"]?([A-Za-z_$][\w$]*)['"]?\s*:/gm)) {
    if (m[0] === '{') { depth++; continue; }
    if (m[0] === '}') { depth--; continue; }
    if (depth === 1 && m[1]) keys.push(m[1]);
  }
  return keys;
}

/** The query-string keys a handler reads directly. */
const queryKeysFrom = body =>
  [...new Set([...body.matchAll(/req\.query(?:\.(\w+)|\['([^']+)'\])/g)].map(m => m[1] || m[2]))];

/**
 * Which helpers take the whole `req` AND read parameters out of it.
 *
 * A handler passing `req` to one of these has keys that are not all in the handler — `requireQueryPath(req,
 * res)` reads `req.query['path']` one hop away, which is instrument error 5. But most helpers taking `req`
 * read `req.authToken` and nothing else (`accessibleSpaces`, `memberSpacesForRequest`, `requestActor`), and
 * disqualifying those left two thirds of the surface unreadable for no reason.
 *
 * So the hop is resolved exactly far enough to answer *can this contribute a parameter at all* — does the
 * callee's own source mention `req.body` or `req.query`. It does NOT extract keys across the hop: a helper
 * that reads either still leaves the route unresolved. Whether a door exists is a safer question than what
 * is behind it.
 */
function requestReadingHelpers(sources) {
  const names = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(/(?:export )?(?:async )?function (\w+)\s*\(/g)) {
      /*
       * The function's OWN braces, not "up to the next `function` keyword".
       *
       * The crude version slid to end-of-file whenever the next top-level thing was a route registration
       * rather than another function, so `accessibleSpaces` in `duplicates.ts` inherited every `req.body`
       * below it and twelve routes were disqualified by a helper that only ever reads `req.authToken`.
       * A window that guesses where its subject ends is this repo's most-repeated instrument bug.
       */
      const open = src.indexOf('{', src.indexOf(')', m.index));
      const fnBody = open === -1 ? '' : (literalAt(src, open) ?? '');
      if (/req\.(body|query)/.test(fnBody)) names.add(m[1]);
    }
  }
  return names;
}

/** The helper this handler hands the whole request to, if it is one that reads parameters. */
const handsOffTheRequest = (body, readers) => {
  const masked = body.replace(/\breq\.\w+/g, 'X');
  for (const m of masked.matchAll(/\b(\w+)\(\s*req\s*[,)]/g)) if (readers.has(m[1])) return m[1];
  return null;
};

/** The body keys a handler accepts, or why they could not be read. */
export function bodyKeysFrom(body, exportedSets, fileSrc = '') {
  const refusalAt = body.indexOf('unknownBodyFields(');
  if (refusalAt > -1) {
    /*
     * BALANCED arguments, not `[^,]*` up to the first comma.
     *
     * The call is written `unknownBodyFields((req.body ?? {}) as Record<string, unknown>, RECALL_BODY_FIELDS)`
     * and a negated-comma class stops inside the GENERIC, so the set name came back as `unknown` — an
     * exported set nobody supplied, so the route came back unresolved and its tool was skipped. That
     * silently un-covered `recall`, `query`, `traverse` and `similar`: the only four pairs the gate
     * before this one did check. A new instrument that drops the old one's coverage while reporting a
     * bigger number is the worst way to be wrong here, and this is instrument error 8.
     */
    const args = argumentsOf(body, body.indexOf('(', refusalAt), 'unknownBodyFields');
    const name = (args[args.length - 1] ?? '').trim();
    const set = exportedSets?.[name];
    return set ? { keys: [...set], via: name } : { unresolved: `exported set ${name || '?'} not supplied` };
  }

  const named = body.match(/(\w+)\s*\.\s*(?:safeParse|parse)\s*\(\s*req\.body/);
  if (named && named[1] !== 'z') {
    const supplied = exportedSets?.[named[1]];
    if (supplied) return { keys: [...supplied], via: named[1] };
    const local = localZodKeys(fileSrc, named[1]);
    if (local && local.length) return { keys: local, via: `${named[1]} (declared in this file)` };
    return { unresolved: `zod schema ${named[1]} is neither supplied nor a plain z.object literal here` };
  }

  const de = body.match(/const\s*\{([^}]*)\}\s*=\s*\(?\s*req\.body/);
  if (de) {
    // Only when it is the WHOLE of the reading — see instrument error 3 in this file's docblock.
    const reads = [...body.matchAll(/req\.body/g)].length;
    if (reads > 1) {
      return { unresolved: `destructured, but the body is read ${reads - 1} more time(s) — the shared write `
        + 'options go through helpers, so the destructure is partial' };
    }
    return { keys: de[1].split(',').map(k => k.trim().split(/[:=]/)[0].trim()).filter(Boolean), via: 'destructure' };
  }

  /*
   * A route that hands the whole body to `callTool` and reads none of it itself.
   *
   * This is not an unresolved route and it is not an exempt one — it is the ANSWER the parity gate is
   * looking for. `callTool` validates the arguments against the named tool's published `inputSchema`, which
   * has `additionalProperties: false`, so the route's accepted keys ARE the tool's parameters and cannot
   * drift from them: there is no second list to update. `POST /api/brain/recall` became one of these when
   * its four hundred lines collapsed onto the shared module.
   *
   * **The condition that makes it true is the single `req.body`**, and it is the whole of the check. A
   * delegating route that also peeks at one field — a `space` read for a log line, a `topK` clamped "just
   * here" — is back to two implementations of one contract, with the second one invisible because the
   * route looks delegated. So the count is asserted rather than the shape.
   */
  const viaTool = body.match(/callTool\(\s*\{\s*name:\s*'([a-z_0-9]+)'/);
  if (viaTool && [...body.matchAll(/req\.body/g)].length === 1) {
    return { delegatesTo: viaTool[1], via: 'callTool' };
  }

  const fwd = body.match(/\b(\w+)\s*\(\s*req\.body\s*(?:as [^)]*)?\)/);
  if (fwd) return { unresolved: `the body is forwarded whole to ${fwd[1]}()` };
  if (/req\.body/.test(body)) return { unresolved: 'the body is read field by field rather than gathered' };
  return { keys: [], via: 'takes no body' };
}

/**
 * Every route registration in the API tree, with its full path and what it accepts.
 *
 * A row is `{ keys, queryKeys, via }`, `{ delegatesTo, via }` or `{ unresolved }`. **Never two of them, and
 * never an empty `keys` standing in for "we could not tell"** — that equivalence is how a sweep reports
 * clean about something nobody checked.
 *
 * `delegatesTo` names the tool a route hands its whole body to. It is the strongest row of the three: the
 * route has no parameter list of its own to compare, because the tool's `inputSchema` IS its parameter
 * list. A caller must treat it as covered, not as exempt — an exemption is a promise nobody re-reads,
 * while this one is re-derived from the route's source on every run.
 *
 * `exportedSets` maps a symbol name to an iterable of keys, for schemas the caller can import and this
 * cannot see. A symbol that is not supplied comes back unresolved.
 */
/*
 * `apiRoot` DEFAULTS TO EVERY ROUTE, and it used to default to `server/src/api`.
 *
 * That default was a caller's narrowing baked into the module, and it hid fifteen routes from every
 * question asked here — the five admin ones on the app, the three MCP transport routes, the two setup
 * routes, and the health probes. A module answering *what does this route accept* should answer for
 * every route; a caller that wants a subset says so.
 */
export function routeAcceptKeys({ apiRoot = null, exportedSets = {} } = {}) {
  const readers = requestReadingHelpers(
    trackedSources(['server/src'], { floor: 50 }).map(f => stripComments(readFileSync(f, 'utf8'))));
  const out = [];
  const sources = new Map();
  /*
   * THE SUBJECT COMES FROM `mountedRoutes` NOW, and the scan it replaces was the fourth copy of one pattern.
   *
   * This walked `server/src/api` with its own `(\w*[Rr]outer).(get|post|…)` regex and its own
   * next-registration window. Both halves were wrong in the same way as the other copies: a route declared
   * straight on the express app matches neither the pattern nor the directory, so the five heaviest admin
   * routes — wipe, import, export, reload-config, rotate-signing-key — were never asked which keys they
   * accept. Not reported as accepting an undocumented one. Absent from the question.
   *
   * `apiRoot` still narrows which FILES are asked about, which is what its callers want; it no longer
   * decides what counts as a route.
   */
  for (const r of mountedRoutesWithSource()) {
    if (apiRoot && !r.file.startsWith(apiRoot)) continue;
    const f = r.file;
    if (!sources.has(f)) sources.set(f, stripComments(readFileSync(f, 'utf8')));
    const src = sources.get(f);
    const body = r.source;
    const row = { file: f, method: r.method, route: r.path };
    const hop = handsOffTheRequest(body, readers);
    if (hop) {
      out.push({ ...row, unresolved: `the handler hands \`req\` to ${hop}(), which reads parameters from it` });
      continue;
    }
    const read = bodyKeysFrom(body, exportedSets, src);
    out.push(read.unresolved ? { ...row, ...read } : { ...row, ...read, queryKeys: queryKeysFrom(body) });
  }
  if (out.length < 150) {
    throw new Error(`only ${out.length} registrations found — the sweep is wrong, not the code`);
  }
  return out;
}
