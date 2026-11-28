/**
 * Every route a server message names is a route this server mounts (Q-428, bundle-41, round-1 finding F5).
 *
 * ## The defect
 *
 * `files/file-embed-work.ts` told an operator, in a warning, to repair a move's stale vectors with `POST /api/spaces/:id/reindex`: a route no
 * router declares (the reindex is `POST /api/brain/spaces/:spaceId/reindex`). `every-route-a-rights-comment-names-is-mounted` holds the routes
 * a COMMENT names; a route named in a string the server SAYS (a log line, an error, a tool's description) is the one the operator acts on, and
 * nothing read it.
 *
 * ## What it reads, and what it holds
 *
 * The string and template literals of every tracked server source (comments are not read: the other gate holds them), each `METHOD /api/...`
 * pair in them (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`). Each must resolve through `_route-match.mjs`, the matcher the client and comment gates use:
 * a `:param` or `${...}` is one segment, and `POST /api/:tool` resolves only for a tool in the registry. A path a template part ends on (the route
 * continues in the next part) is held to the weaker question that some route begins so. A pair written to say a route is gone
 * is a row of `MEANT_TO_MISS` with its reason. At least a dozen pairs have to be read, and one has to resolve, before a clean result means anything.
 *
 * Seen red on f3cd49548: `POST /api/spaces/:id/reindex` in `files/file-embed-work.ts`.
 *
 * Run: node --test testing/standalone/a-route-a-server-message-names-is-mounted.test.js   (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources, SERVER_CODE_ROOTS } from './_sources.mjs';
import { parseSource, walkEveryNode, ts } from '../_shared/syntax-tree.mjs';
import { resolves, shape, ROUTES, HOLE } from './_route-match.mjs';

/** A route a message names on purpose although no route serves it, as `METHOD path`, with the reason. */
const MEANT_TO_MISS = new Map([]);

const PAIR = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/[^\s`'"),;|]*)/g;

/** The path of a pair as the matcher reads it: `<tool>` is a name the caller fills in. */
const pathOf = (raw) => raw.replace(/[.:]+$/, '').replace(/<[^>]*>/g, ':x');

/**
 * Does some mounted route under `method` start with these segments? A path a template part ends on (`.../spaces/` then `${id}/entities`) is the
 * front of a route written across several parts, so it is held to the weaker question: a route begins like this.
 */
function resolvesAsFront(path, method) {
  const segs = shape(path).split('/');
  return ROUTES.some(r => r.method === method && r.segs.length >= segs.length && segs.every((s, i) => s === r.segs[i] || s === HOLE || r.segs[i] === HOLE));
}

/** The text of every string and template literal in a source, in order, with the line it starts on. */
function literalsOf(file) {
  const text = readFileSync(join(REPO_ROOT, file), 'utf8');
  const tree = parseSource(file, text);
  const out = [];
  walkEveryNode(tree, (n) => {
    const part = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n);
    if (part) out.push({ text: n.text, open: ts.isTemplateHead(n) || ts.isTemplateMiddle(n), line: tree.getLineAndCharacterOfPosition(n.getStart(tree)).line + 1 });
  });
  return out;
}

/** Every `METHOD /api/path` a literal of `file` names: `{ file, line, method, path }`. A trailing sentence mark is not part of the path. */
function pairsIn(file) {
  const found = [];
  for (const { text, open, line } of literalsOf(file)) {
    for (const m of text.matchAll(PAIR)) found.push({ file, line, method: m[1], path: pathOf(m[2]), front: open && m.index + m[0].length === text.length });
  }
  return found;
}

const FILES = trackedSources(SERVER_CODE_ROOTS, { floor: 100 }).filter(f => f.endsWith('.ts'));
const PAIRS = FILES.flatMap(pairsIn);

describe('every route a server message names is mounted', () => {
  it('reads the messages before it concludes', () => {
    assert.ok(PAIRS.length >= 12, `only ${PAIRS.length} \`METHOD /api/...\` pairs were read from the server's strings; the extraction broke`);
    assert.ok(PAIRS.some(p => resolves(p.path, p.method)), 'no pair resolved at all, so the matcher or the route list is broken rather than the messages');
  });

  it('the detector reads a pair out of a log line the way a reader does', () => {
    const line = 'They keep the vectors of their old paths until the space is reindexed (POST /api/spaces/:id/reindex).';
    const got = [...line.matchAll(PAIR)].map(m => `${m[1]} ${pathOf(m[2])}`);
    assert.deepEqual(got, ['POST /api/spaces/:id/reindex']);
    assert.equal(pathOf('/api/<tool>'), '/api/:x', 'a <name> is a hole');
    assert.equal(resolvesAsFront('/api/brain/spaces/', 'GET'), true, 'the front of a route written across template parts');
    assert.equal(resolvesAsFront('/api/brain/spacez/', 'GET'), false, 'a front no route begins with');
    assert.equal(resolves('/api/spaces/:id/reindex', 'POST'), false, 'the route the warning named exists: this case no longer holds the gate');
    assert.equal(resolves('/api/brain/spaces/:spaceId/reindex', 'POST'), true, 'the real reindex route does not resolve');
  });

  it('each `METHOD /api/path` in a string the server says resolves to a route', () => {
    const offenders = PAIRS.filter(p => !MEANT_TO_MISS.has(`${p.method} ${p.path}`) && !(p.front ? resolvesAsFront(p.path, p.method) : resolves(p.path, p.method)))
      .map(p => `${p.file}:${p.line} says ${p.method} ${p.path}, which no mounted route serves`);
    assert.deepEqual(offenders, [],
      'a message names a route that does not exist:\n  ' + offenders.join('\n  ')
      + '\n\nAn operator acts on these sentences. Name the route that is there (one constant per route, as EMBED_REPAIR_ROUTE is), '
      + 'or, for a route said to be gone on purpose, add its `METHOD path` to MEANT_TO_MISS with the reason.');
  });
});
