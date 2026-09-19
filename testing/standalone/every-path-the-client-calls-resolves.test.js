/**
 * Every `/api/…` path the client calls must be a route this server mounts.
 *
 * ## Why this, and why now
 *
 * The client reaches the server by writing paths into template strings. There is no type between the two,
 * so **a renamed route is a runtime 404 rather than a build error** — and 5.0 renames almost every public
 * name. The failure is quiet in the worst way: the page renders, the request fails, and what the operator
 * sees is a panel that is empty rather than an error that says which call was wrong. It is the one row of
 * the pre-5.0 audit (`Q-22`) with a runtime failure behind it.
 *
 * ## The subject, and the two exclusions that are derived rather than listed
 *
 * **Specs are excluded**, via `trackedSources`' own `specs: false`. A `.spec.ts` writes a URL to configure
 * an HTTP mock, and the three that would be reported here are `/api/x/recall` and friends in the
 * rights-matrix spec — `x` is a space id in a fixture, not a route anybody calls.
 *
 * **Comments are blanked**, not stripped, so a reported line is the line in the file. The one non-spec
 * mention this found on its first run was `/api/brain/spaces/x/undefined/y` inside a comment explaining a
 * bug that a `switch` prevents — a gate that reported it would be asking for that explanation to be
 * deleted.
 *
 * ## Matching is by SHAPE, because a caller fills the parameters in
 *
 * A route declares `/api/files/:spaceId`; the client writes `` `/api/files/${spaceId}` `` and a spec writes
 * `/api/files/work`. All three are the same path, so a parameter on either side is a hole that matches any
 * one segment. Segment count still has to agree, which is what keeps this from matching everything.
 *
 * ## The floor
 *
 * A scan that stops matching finds no paths and reports a clean client. Both halves are floored: the route
 * list throws below its own floor inside `mountedRoutes`, and this asserts that the client really does name
 * a lot of paths before concluding anything about them.
 *
 * ## Seen red
 *
 * By mutation: renaming one segment of a real call in `spaces-api.service.ts`.
 *
 * Run: node --test testing/standalone/every-path-the-client-calls-resolves.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { mountedRoutes } from './_routes.mjs';

/** A parameter, on either side, is a hole that matches exactly one segment. */
const HOLE = '\u0001';
const shape = p => p
  // The QUERY STRING is not part of the route. `GET /api/spaces/${id}/meta?resolve=1` is the meta route
  // with an argument on it, and six such calls read as unmatched until this line existed.
  .split('?')[0]
  .replace(/\$\{[^}]*\}/g, HOLE)
  .replace(/:[A-Za-z0-9_]+/g, HOLE)
  .replace(/\/+$/, '');

const ROUTES = mountedRoutes().map(r => ({ method: r.method, segs: shape(r.path).split('/') }));
const ROUTE_SHAPES = ROUTES.map(r => r.segs);

/** `method` narrows it when the call site gave one; without it, any verb will do. */
function resolves(path, method) {
  const segs = shape(path).split('/');
  return ROUTES.some(r => (method === undefined || r.method === method)
    && r.segs.length === segs.length
    && r.segs.every((s, i) => s === HOLE || segs[i] === HOLE || s === segs[i]));
}

/**
 * Every `/api/…` call the shipped client makes, with its VERB where the verb is on the same expression.
 *
 * **The verb is what turns this from a shape check into a real one.** `POST /api/:tool` is a live route, so
 * path alone resolves every two-segment `/api/x` and the gate cannot tell a real tool from a typo. Matched
 * with the method, the question is exact — and on its first run with the verb it found a dead one:
 * `updateSyncSchedule` PATCHed `/api/networks/:id/members/:memberId`, which the server has never served
 * (members takes POST, PUT on the signing key, and DELETE). Nothing called it, so nothing had 404d yet.
 *
 * A path the client builds from a nested template is UNREADABLE here rather than wrong — `` `/api/x${a ?
 * `?b=${c}` : ''}` `` ends the outer literal early — so those are counted and skipped, and the count is
 * asserted below so the skip cannot quietly grow to cover everything.
 */
function clientCalls() {
  const out = [];
  const VERB = /\bhttp\s*\.\s*(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*['"`](\/api\/[^'"`]*)['"`]/g;
  const BARE = /['"`](\/api\/[A-Za-z0-9_\-/.:${}?=&]*)['"`]/g;
  for (const file of trackedSources('client/src', { floor: 100, specs: false })) {
    const text = blankComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
    text.split(/\r?\n/).forEach((line, i) => {
      const withVerb = new Map();
      for (const m of line.matchAll(VERB)) withVerb.set(m[2], m[1].toUpperCase());
      for (const m of line.matchAll(BARE)) {
        out.push({ file, line: i + 1, path: m[1], method: withVerb.get(m[1]) });
      }
    });
  }
  return out;
}

/** A path whose template is not closed on this line cannot be read statically. */
const unreadable = p => (p.match(/\$\{/g) ?? []).length !== (p.match(/\}/g) ?? []).length;

describe('the sweep reads both sides before concluding', () => {
  it('finds the server\'s routes', () => {
    assert.ok(ROUTE_SHAPES.length >= 200,
      `only ${ROUTE_SHAPES.length} routes — every client path would be reported, which is a broken scan `
      + 'rather than a broken client');
  });

  it('finds the client\'s calls', () => {
    const calls = clientCalls();
    assert.ok(calls.length >= 80,
      `only ${calls.length} client API paths found; a short list makes the assertion below vacuous`);
  });

  it('and the matcher accepts a filled-in parameter', () => {
    // The whole reason for matching by shape. If this stops holding, every parameterised call is reported
    // and the gate is deleted within the week.
    assert.ok(resolves('/api/files/${spaceId}'), 'a template hole must match a route parameter');
    assert.ok(resolves('/api/files/work'), 'a literal segment must match a route parameter');
    assert.ok(!resolves('/api/files/work/extra/deep/nope'), 'segment count must still have to agree');
    assert.ok(!resolves('/api/no/such/path/at/all/here'), 'an invented path must not resolve');

    /*
     * AND THE BLIND SPOT, asserted so it is a stated limit rather than a surprise.
     *
     * `POST /api/:tool` is a real route — the REST door onto the tool surface — so EVERY two-segment
     * `/api/x` resolves, whatever `x` is. The gate cannot tell a mistyped one from a tool name, because
     * the client writes the path and the verb in different places and only the path is in the literal.
     * Nothing else in the API has a parameter that shallow, so the hole is exactly one segment deep.
     */
    assert.ok(resolves('/api/anything-at-all'),
      'if this stops resolving, `POST /api/:tool` has gone and the note above should go with it');
  });
});

describe('every path the client calls resolves', () => {
  it('no call names a route this server does not mount', () => {
    const offenders = clientCalls().filter(c => !unreadable(c.path) && !resolves(c.path, c.method))
      .map(c => `${c.file}:${c.line} calls ${c.method ?? '(any verb)'} ${c.path}`);
    assert.deepEqual(offenders, [],
      'the client calls a path no route serves:\n  ' + offenders.join('\n  ')
      + '\n\nThere is no type between a template string and a router, so this is a runtime 404 — and what '
      + 'the operator sees is an empty panel rather than an error naming the call.');
  });

  it('and the paths it cannot read stay a handful', () => {
    /*
     * The skip has to be visible or it becomes the gate. A path built from a NESTED template ends its own
     * literal early, so it cannot be read here and is passed over — one call does that today
     * (`/api/duplicates/scan` with an optional query string). If that number climbs, the reason to look is
     * that the sweep is quietly covering less, not that the client got cleverer.
     */
    const skipped = clientCalls().filter(c => unreadable(c.path));
    assert.ok(skipped.length <= 3,
      `${skipped.length} client paths cannot be read statically; it was 1 when measured:\n  `
      + skipped.map(c => `${c.file}:${c.line} ${c.path}`).join('\n  '));
  });
});
