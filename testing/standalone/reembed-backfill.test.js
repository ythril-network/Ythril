/**
 * The re-embed backfill: the way back from `suppressEmbeddings`.
 *
 * ## What is worth asserting here
 *
 * The sweep itself is a Mongo query and a loop. The three things that make it correct or useless are none of
 * that, and all three are visible without a database:
 *
 *  - **It filters on `$exists: false`, not on `null`.** The suppressed path `$unset`s the vector, so a released
 *    record has no key at all. A `null` filter would find nothing and report a clean sweep over a space that is
 *    entirely unindexed — a backfill that says "all done" having done nothing.
 *  - **It reuses the write path's suppression resolver.** Re-deriving the rule would let a backfill re-index
 *    exactly what an operator asked to keep out of recall.
 *  - **It never truncates silently.** `remaining` is counted before the cap, so it describes the space and not
 *    the page.
 *
 * Run: node --test testing/standalone/reembed-backfill.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enclosingBlockFrom } from './_structural-window.mjs';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const strip = (t) => t.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

const SRC = read('../../server/src/brain/reembed.ts');
const CODE = strip(SRC);

describe('the candidate query', () => {
  it('filters on $exists: false, never on null', () => {
    // The trap. Suppression `$unset`s the field, so the key is ABSENT rather than null.
    assert.match(CODE, /embedding:\s*\{\s*\$exists:\s*false\s*\}/);
    assert.ok(!/embedding:\s*null/.test(CODE), 'a null filter would match nothing and report a clean sweep');
  });

  it('derives the record kinds from the collection map rather than listing them again', () => {
    // A second list is how a new record kind gets silently left out of every backfill.
    assert.match(CODE, /Object\.keys\(COLLECTION\)/);
  });

  it('uses the same collection map the embed path writes through', () => {
    assert.match(CODE, /from '\.\/embed-record\.js'/);
    assert.match(CODE, /COLLECTION\[kind\]/);
  });
});

describe('it does not fight the suppression setting', () => {
  it('imports the shared resolver instead of re-deriving the rule', () => {
    assert.match(CODE, /embeddingSuppressed/);
    assert.match(CODE, /from '\.\/suppress-embeddings\.js'/);
  });

  it('skips a still-suppressed record and REPORTS it', () => {
    // Reporting matters as much as skipping: running the backfill before turning suppression off must tell the
    // operator the setting is still on, not look like a no-op.
    assert.match(CODE, /skippedSuppressed\+\+/);
    assert.match(CODE, /skippedSuppressed: number/);
  });

  it('applies the file asymmetry, narrowed rather than cast', () => {
    // A cast would index `typeSchemas` with `'file'` and miss — here that means re-embedding suppressed files.
    assert.match(CODE, /kind === 'file' \? undefined : kind/);
    assert.ok(!/kind as KnowledgeType/.test(CODE), 'the kind is cast rather than narrowed');
  });

  it('passes the record flag as undefined when absent, never false', () => {
    // The rule moved into `recordSuppression`, which is exercised directly in
    // `one-switch-three-tiers-is-documented.test.js`. What matters HERE is that the backfill asks it
    // rather than keeping a second copy — that copy is how a sweep starts disagreeing with the write path
    // about what a stored `false` means, and about whether the pre-3.1.0 spelling still counts.
    assert.match(CODE, /record:\s*recordSuppression\(doc\)/);
  });
});

describe('it enqueues rather than embedding inline', () => {
  it('calls the queue, not the embedder', () => {
    // A million-record space would time out mid-way, having done partial work with no record of where.
    assert.match(CODE, /enqueueEmbedJob\(spaceId, kind, id\)/);
    assert.ok(!/embedStoredRecord/.test(CODE), 'embedding inline would time out on a large space');
  });
});

describe('nothing is capped silently', () => {
  it('counts the total BEFORE applying the cap', () => {
    // Otherwise `remaining` describes the page rather than the space, and a truncated sweep reads as complete.
    const countAt = CODE.indexOf('countDocuments');
    const limitAt = CODE.indexOf('.limit(budget)');
    assert.ok(countAt > 0 && limitAt > 0, 'expected both a count and a limited find');
    assert.ok(countAt < limitAt, 'the total must be counted before the page is fetched');
  });

  it('reports the remainder and flags truncation', () => {
    assert.match(CODE, /truncated = result\.remaining > 0/);
  });

  it('clamps the limit to a ceiling rather than trusting the caller', () => {
    assert.match(CODE, /Math\.min\(Math\.max\(1, Math\.floor\(limit\)\), REEMBED_MAX_LIMIT\)/);
  });

  it('still counts a kind it had no budget left for', () => {
    // Skipping the count would under-report `remaining` for every kind after the budget ran out, which is the
    // silent-truncation failure wearing a different hat.
    assert.match(CODE, /if \(budget <= 0\) \{ result\.remaining \+= total; continue; \}/);
  });
});

describe('the route stays thin, and out of the god-file', () => {
  // It lives in its own module: inline it was +28 code lines on `api/spaces.ts`, which would have been the second
  // double-digit raise of that file in two PRs. Extracted, only the mount point stays (+2).
  const ROUTE = read('../../server/src/api/spaces-reembed.ts');
  const SPACES = read('../../server/src/api/spaces.ts');

  it('delegates to the module instead of inlining the sweep', () => {
    assert.match(ROUTE, /reembedSpace\(spaceId, \{/);
    assert.ok(!/\$exists: false/.test(ROUTE), 'the query belongs in brain/reembed.ts, not in the route');
  });

  it('is gated at knowledge admin, scoped to the space in the path, and closed to a read-only token', () => {
    // It was `requireAdminMfaScoped` — instance admin — until 2026-09-08, when its `ROUTE_RIGHTS` row was
    // corrected to `knowledge` / `admin` and the guard was changed to the one that actually consults it.
    // `denyReadOnly` is named here because the admin guard used to imply it and this one does not: a
    // read-only token holding the rung would otherwise have been able to re-embed the space.
    assert.match(ROUTE,
      /post\('\/:id\/reembed', globalRateLimit, requireSpaceAuthMfaScoped\('id'\), denyReadOnly/);
  });

  it('rejects an unknown body key rather than silently sweeping everything', () => {
    // A caller who meant to narrow and got a full sweep would be told they had narrowed it.
    assert.match(ROUTE, /const ReembedBody = z\.object\(\{[\s\S]*?\}\)\.strict\(\)/);
  });

  it('spaces.ts only MOUNTS it — the body did not come back', () => {
    // The whole point of the extraction. If a later edit inlines the handler again, this fails rather than the
    // ratchet quietly absorbing another raise.
    assert.match(SPACES, /registerReembedRoute\(spacesRouter\);/);
    assert.ok(!/reembedSpace\(/.test(SPACES), 'the handler is back inside the god-file');
  });

  it('is audited, because it changes what a space is findable by', () => {
    const AUDIT = read('../../server/src/audit/middleware.ts');
    // A WINDOW, converted: the subject is the audit table's ROW, bounded by its own brace. The claim is that
    // THIS route's row names that operation, and 80 characters is enough to reach the NEXT row's `operation` —
    // under which a route with no audit operation of its own would have borrowed its neighbour's.
    const at = AUDIT.indexOf('reembed$/');
    assert.ok(at > -1, 'the reembed audit row is gone — re-anchor this gate');
    assert.match(enclosingBlockFrom(AUDIT, at, 'the reembed audit row'), /space\.embeddings\.reembed/,
      'the reembed route must carry its own audit operation');
  });
});

describe('the comment that promised a sweep that never existed', () => {
  it('states the correction and names the real repair', () => {
    // The old comment justified swallowing the enqueue error with "the periodic backfill sweep will find it".
    // There was no sweep, so a swallowed error meant a record silently missing from recall forever.
    //
    // Asserted POSITIVELY, and that is the lesson rather than a detail: the first version of this test searched
    // for the absence of the old phrase and failed against correct code, because the phrase is quoted inside the
    // comment that corrects it. A gate that reads source has to survive the source explaining itself.
    const QUEUE = read('../../server/src/brain/embed-queue.ts');
    assert.match(QUEUE, /There was no such sweep/);
    assert.match(QUEUE, /reembed/);
    assert.match(QUEUE, /on demand, not periodic/);
  });
});

/**
 * ── The convergence property, and why it is a BEHAVIOURAL test rather than a source-reading one ──
 *
 * The first version of this sweep filtered on "has no vector" alone and skipped suppressed documents inside
 * the loop. That does not terminate, and the failure is worse than a misleading counter:
 *
 *  - a suppressed record matches "has no vector" BY CONSTRUCTION — suppression is what removed the vector;
 *  - `find(filter).limit(n)` carries no sort, so the same first `n` documents come back on every call;
 *  - the sweep never writes to a suppressed record, so they never leave the result set.
 *
 * So a page of suppressed records at the front of a collection blocked every embeddable record behind it,
 * permanently, while `truncated: true` documented "call again to continue".
 *
 * `suppressionExclusion` is pure and exported precisely so this can be checked without a database.
 */
describe('suppression is expressible as a query, which is what makes the sweep terminate', () => {
  it('excludes the record tier with $ne, not $exists', async () => {
    const { suppressionExclusion } = await import('../../server/dist/brain/reembed.js');
    const { query } = suppressionExclusion(undefined, 'fact');
    assert.deepEqual(query['suppressEmbeddings'], { $ne: true },
      '$exists:false would also exclude a record that carries the flag as FALSE — an explicit opt-in');
    // That the retired spelling is NOT in the exclusion is asserted, for every kind, in
    // `the-legacy-suppression-spelling-is-gone.test.js`.
  });

  it('excludes suppressed TYPE NAMES, on the right field per kind', async () => {
    const { suppressionExclusion } = await import('../../server/dist/brain/reembed.js');
    const meta = {
      typeSchemas: {
        fact: { note: { suppressEmbeddings: false }, task: { suppressEmbeddings: true } },
        edge: { blocks: { suppressEmbeddings: true } },
      },
    };
    assert.deepEqual(suppressionExclusion(meta, 'fact').query['type'], { $nin: ['task'] });
    // Edges key on `label`. Reading `type` for an edge finds no schema, looks like it worked, and excludes
    // nothing — for the one record kind suppression was specifically widened to cover.
    assert.deepEqual(suppressionExclusion(meta, 'edge').query['label'], { $nin: ['blocks'] });
    assert.equal(suppressionExclusion(meta, 'edge').query['type'], undefined);
  });

  it('says ALL when the space-wide tier is on and nothing can override it', async () => {
    const { suppressionExclusion } = await import('../../server/dist/brain/reembed.js');
    assert.equal(suppressionExclusion({ suppressEmbeddings: true }, 'fact'), 'all',
      'a space that suppresses everything has NO WORK, which is a different report from work left over');
  });

  it('does NOT say ALL when a type schema releases a type', async () => {
    // `record > schema > space`: a schema saying false lifts its type back out, so the sweep still has work.
    const { suppressionExclusion } = await import('../../server/dist/brain/reembed.js');
    const meta = { suppressEmbeddings: true, typeSchemas: { fact: { note: { suppressEmbeddings: false } } } };
    const res = suppressionExclusion(meta, 'fact');
    assert.notEqual(res, 'all', 'claiming ALL here would skip the types an operator explicitly released');
    assert.deepEqual(res.query['type'], { $in: ['note'] });
  });

  it('treats a type schema that says NOTHING as falling through, not as false', async () => {
    // The tier rule is "absent means not stated". A silent type under space-wide suppression stays suppressed.
    const { suppressionExclusion } = await import('../../server/dist/brain/reembed.js');
    const meta = { suppressEmbeddings: true, typeSchemas: { fact: { note: {} } } };
    assert.equal(suppressionExclusion(meta, 'fact'), 'all');
  });

  it('a file has no type tier, so no type field appears in its exclusion', async () => {
    const { suppressionExclusion } = await import('../../server/dist/brain/reembed.js');
    const meta = { typeSchemas: { fact: { task: { suppressEmbeddings: true } } } };
    const { query } = suppressionExclusion(meta, 'file');
    // One key since `D-6` retired the pre-3.1.0 spelling. A WHOLE-object comparison rather than a
    // presence check, deliberately: the property is that a file's exclusion has the record tier and
    // NOTHING else, and only comparing the full key list catches a type clause appearing.
    assert.deepEqual(Object.keys(query).sort(), ['suppressEmbeddings'],
      'indexing typeSchemas with "file" would miss every time and silently exclude nothing');
  });

  it('the sweep applies the exclusion to the QUERY, not only to the loop', () => {
    // The mutation that reintroduces the bug is moving this back into the loop, which no pure test can see.
    const src = readFileSync('server/src/brain/reembed.ts', 'utf8')
      .replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(src, /suppressionExclusion\(/, 'the sweep must call the exclusion builder');
    assert.match(src, /\.\.\.vectorless,\s*\.\.\.exclusion\.query/,
      'the exclusion must be spread INTO the find filter — skipping in the loop alone never advances the cursor');
    assert.match(src, /=== 'all'/, "the space-wide short-circuit must be handled before querying");
  });
});
