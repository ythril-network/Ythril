/**
 * Every route a rights comment names is a route this server mounts.
 *
 * ## Why this, and what it found
 *
 * `auth/space-rights.ts` is where an operator's question "what does a token need for this call" is answered, and
 * the reasoning for each row lives in comments beside it. A comment that names a route is a claim that the route
 * exists, and nothing checks it: the code around it compiles whatever the sentence says. The header of
 * `ROUTE_RIGHTS` explains which rows were levelled down to `write` and which deliberately stayed `admin`, and it
 * did so by naming `DELETE /facts`, `/entities`, `/edges` and `/chrono` — collection wipes that the generic tool
 * door replaced — and `DELETE /api/brain/spaces/:spaceId/files`, a route no router declares. A reader weighing
 * "should this stay admin" was told about a door that is not there. `Q-448` filed the first of them; this gate
 * is what finds the rest, because **a comment is the one part of a rights file that no test has to pass through.**
 *
 * ## What it reads
 *
 * Comments only, taken with the tokenizer the strippers use (`commentsOnly`), so a route in code or in a string
 * is not read as prose. In them, a `METHOD path` pair: `GET`, `POST`, `PUT`, `PATCH` or `DELETE` followed by an
 * absolute `/api/...` path, or by a RELATIVE one (`/facts/:id`, `.../validate-schema`).
 *
 * - **An absolute path** must resolve through `_route-match.mjs`, the matcher the client gate uses, tool door
 *   narrowed to the registry: `POST /api/:tool` resolves, `POST /api/no_such_tool` does not.
 * - **A relative path** must name the END of a mounted route under that verb. A comment gives no base to resolve
 *   it against, so this is the question it can be held to; a tail common to several routes is satisfied by any.
 * - **A line saying a route is gone carries `(removed)`** and is counted and skipped. `used to sit here` is
 *   history and history is allowed to name a route that no longer exists, but only when it says so in a form a
 *   gate can read; the number skipped is bounded so the marker cannot become the way past.
 *
 * ## Stated limit
 *
 * A bare relative path with no verb word is not read: `/facts/:id` on a line of its own, or the `/entities`,
 * `/edges`, `/chrono` that follow `DELETE /facts` in a list. Reading those would mean guessing which verb and
 * base a fragment inherits. A verb on the same line is what makes a mention checkable, and the rule for writing
 * one is therefore to put it there.
 *
 * ## Derived, and floored
 *
 * The files are every tracked `*rights*` module under `server/src/auth`, not a named one; the routes are
 * `mountedRoutes()`. At least a dozen mentions have to be read, and at least one has to resolve, before a clean
 * result means anything: a comment scan that matches nothing passes.
 *
 * ## Seen red
 *
 * On the base this was written against: the relative collection wipes in the `ROUTE_RIGHTS` header, and the
 * `DELETE .../files` route named beside them. Seen red by mutation for the part that was already clean: a
 * comment's `POST /api/:tool` changed to a tool name that does not exist, restored by hand.
 *
 * Run: node --test testing/standalone/every-route-a-rights-comment-names-is-mounted.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { commentsOnly } from './_strip-comments.mjs';
import { resolves, resolvesBySuffix } from './_route-match.mjs';

const MENTION = /\b(GET|POST|PUT|PATCH|DELETE)\s+`?([^\s`'",;)]+)/g;

/** A route mentioned in a comment: where, with which verb, as written, and how it is to be resolved. */
function mentionsIn(file) {
  const lines = commentsOnly(readFileSync(join(REPO_ROOT, file), 'utf8')).split('\n');
  const out = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(MENTION)) {
      // A sentence's own punctuation rides on the token: `DELETE /api/files/:spaceId.` is that route.
      const path = m[2].replace(/[.:]+$/, '');
      const relative = path.startsWith('.../') || (path.startsWith('/') && !path.startsWith('/api/') && path !== '/api');
      if (!path.startsWith('/') && !path.startsWith('.../')) continue;
      out.push({ file, line: i + 1, method: m[1], path, relative, removed: /\(removed\)/i.test(line) });
    }
  });
  return out;
}

const FILES = trackedSources('server/src/auth', { floor: 5 }).filter(f => /rights/.test(f.split('/').pop()));
const MENTIONS = FILES.flatMap(mentionsIn);
const CHECKED = MENTIONS.filter(m => !m.removed);
const SKIPPED = MENTIONS.filter(m => m.removed);
const OK = m => (m.relative ? resolvesBySuffix(m.path, m.method) : resolves(m.path, m.method));

describe('the comment scan reads before it concludes', () => {
  it('finds rights modules and the routes comments name in them', () => {
    assert.ok(FILES.some(f => f.endsWith('/space-rights.ts')), 'the space rights module was not found under server/src/auth');
    assert.ok(MENTIONS.length >= 12, 'too few `METHOD path` mentions were read from the rights comments; the extraction broke');
    assert.ok(CHECKED.some(OK), 'no mention resolved at all, so the matcher or the route list is broken rather than the comments');
  });

  it('a `(removed)` marker is a few lines of history, not the way past', () => {
    assert.ok(SKIPPED.length <= CHECKED.length,
      'more mentions are skipped as removed than are checked; the marker has become the gate');
  });
});

describe('every route a rights comment names is mounted', () => {
  it('each `METHOD path` in a comment resolves to a route', () => {
    const offenders = CHECKED.filter(m => !OK(m))
      .map(m => `${m.file}:${m.line} names ${m.method} ${m.path}${m.relative ? ' (relative)' : ''}, which no mounted route serves`);
    assert.deepEqual(offenders, [],
      'a rights comment names a route that does not exist:\n  ' + offenders.join('\n  ')
      + '\n\nA reader weighing a rung reads these sentences as a description of the door. Name the route that is there, '
      + 'or, if the sentence is history, say `(removed)` on its line.');
  });
});
