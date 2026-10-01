/**
 * The re-embed backfill: the way back from `suppressEmbeddings`.
 *
 * ## Why this file reads TWO modules
 *
 * Q-99 part 2 moved the walk itself — which records of a space to queue — into `brain/queue-embed-sweep.ts`, the
 * one walker reindex and reembed share. `brain/reembed.ts` keeps the backfill's contract: its result shape, its
 * limit, its `remaining`, its snapshot counts. A gate that read only `reembed.ts` would now assert about a file the
 * candidate query has left, and pass on whatever the walker does — which is how the previous version of these
 * excerpt gates came to pass on the defect this change fixes. So every source rule below is asserted over BOTH
 * files, and the file comes with its own floor: both modules must be present, or nothing below means anything.
 *
 * What the rules are about has not changed, only where they look:
 *
 *  - **It filters on `$exists: false`, not on `null`.** The suppressed path `$unset`s the vector, so a released
 *    record has no key at all. A `null` filter would find nothing and report a clean sweep over a space that is
 *    entirely unindexed — a backfill that says "all done" having done nothing.
 *  - **It reuses the write path's suppression rule** rather than re-deriving it, and excludes in the QUERY.
 *  - **It skips a textless derived record** (`derivedHasText`), or it never converges — the behaviour is pinned in
 *    `reembed-converges-db.test.js`; here, only that the shared fragment is what does it.
 *  - **It enqueues in bulk, in the background lane, and never embeds inline.**
 *  - **It never truncates silently.** `remaining` describes the space and not the page.
 *
 * Run: node --test testing/standalone/reembed-backfill.test.js   (the dist cases need `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enclosingBlockFrom } from './_structural-window.mjs';
import { readFileSync } from 'node:fs';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/*
 * `untracked: true` because the walker is a NEW module: while the change is being written it exists on disk and is
 * not committed yet, and a tracked-only listing would report it missing to the person writing it.
 */
const BRAIN = readTrackedSources('server/src/brain', { floor: 10, untracked: true });
const REEMBED_FILE = BRAIN.find(s => s.file === 'server/src/brain/reembed.ts');
const SWEEP_FILE = BRAIN.find(s => s.file === 'server/src/brain/queue-embed-sweep.ts');
const REEMBED = REEMBED_FILE ? stripComments(REEMBED_FILE.text) : '';
const SWEEP = SWEEP_FILE ? stripComments(SWEEP_FILE.text) : '';
/** Both modules' code: a rule about the backfill holds wherever the backfill's code now lives. */
const BOTH = `${REEMBED}\n${SWEEP}`;

describe('the backfill is two modules, and this gate reads both', () => {
  it('brain/reembed.ts is present', () => {
    assert.ok(REEMBED_FILE && REEMBED.length > 1000, 'server/src/brain/reembed.ts is gone or empty — re-anchor this gate');
  });

  it('brain/queue-embed-sweep.ts is present', () => {
    assert.ok(SWEEP_FILE && SWEEP.length > 500,
      'server/src/brain/queue-embed-sweep.ts is missing: the walk reindex and reembed share must live in one module');
  });

  it('reembed delegates its walk to the shared sweep', () => {
    assert.match(REEMBED, /from '\.\/queue-embed-sweep\.js'/,
      'reembed.ts does not import the shared walker; a second walker is a second suppression rule');
  });
});

describe('the candidate query', () => {
  it('filters on $exists: false, never on null', () => {
    // The trap. Suppression `$unset`s the field, so the key is ABSENT rather than null.
    assert.match(BOTH, /embedding:\s*\{\s*\$exists:\s*false\s*\}/);
    assert.ok(!/embedding:\s*null/.test(BOTH), 'a null filter would match nothing and report a clean sweep');
  });

  it('derives the record kinds from the collection map rather than listing them again', () => {
    // A second list is how a new record kind gets silently left out of every backfill.
    assert.match(BOTH, /Object\.keys\(COLLECTION\)/);
  });

  it('uses the same collection map the embed path writes through', () => {
    assert.match(BOTH, /from '\.\/embed-record\.js'/);
    assert.match(BOTH, /COLLECTION\[kind\]/);
  });

  it('excludes a textless derived record with the shared fragment, not a copy of it', () => {
    // A face chunk or a converted doc has no text, the worker leaves it vectorless, and a sweep that queues it
    // re-queues it on every call. The fragment lives beside the text builder so the two cannot disagree.
    assert.match(BOTH, /\bderivedHasText\b/, 'the sweep must exclude textless derived records by `derivedHasText`');
    assert.match(BOTH, /derivedHasText[\s\S]*?from '\.\/embed-record\.js'|from '\.\/embed-record\.js'[\s\S]*?derivedHasText/);
  });

  it('projects the suppression and type fields from their constants, not from literals', () => {
    assert.match(SWEEP, /\bRECORD_SUPPRESS_FIELD\b/, 'the walker\'s projection must name the record flag by its constant');
    assert.match(SWEEP, /\bTYPE_FIELD\b/, 'and the type field per kind by TYPE_FIELD (edges key on `label`)');
  });
});

describe('it does not fight the suppression setting', () => {
  it('imports the shared resolver instead of re-deriving the rule', () => {
    assert.match(BOTH, /from '\.\/suppress-embeddings\.js'/);
    assert.match(BOTH, /suppressionExclusion\(/, 'the sweep must call the exclusion builder');
    assert.match(BOTH, /=== 'all'/, "the space-wide short-circuit must be handled before querying");
  });

  it('still reports what it skipped', () => {
    // Reporting matters as much as skipping: running the backfill before turning suppression off must tell the
    // operator the setting is still on, not look like a no-op. Behaviour in reembed-converges-db.test.js.
    assert.match(REEMBED, /skippedSuppressed: number/);
    assert.match(BOTH, /skippedSuppressed\s*(\+=|\+\+)/);
  });

  it('applies the file asymmetry, narrowed rather than cast', () => {
    // A cast would index `typeSchemas` with `'file'` and miss — here that means re-embedding suppressed files.
    assert.match(BOTH, /kind === 'file' \? undefined : kind/);
    assert.ok(!/kind as KnowledgeType/.test(BOTH), 'the kind is cast rather than narrowed');
  });
});

describe('it enqueues rather than embedding inline', () => {
  it('queues in bulk, in the background lane', () => {
    // A million-record space would time out mid-way, having done partial work with no record of where. And a
    // backfill is background work: it yields to the writes somebody is waiting to search for.
    assert.match(BOTH, /enqueueEmbedJobs\(/, 'the sweep must queue through the bulk enqueue');
    assert.match(REEMBED, /EMBED_PRIORITY\.background\b/, 'reembed queues in the background lane');
    assert.ok(!/enqueueEmbedJob\(/.test(BOTH), 'a per-record enqueue in the walk is one round trip per record');
  });

  it('never embeds', () => {
    assert.ok(!/embedStoredRecord/.test(BOTH), 'embedding inline would time out on a large space');
    assert.ok(!/\bembed\(/.test(BOTH), 'the sweep calls the embedder');
  });
});

describe('nothing is capped silently', () => {
  it('reports the remainder and flags truncation', () => {
    assert.match(REEMBED, /truncated = result\.remaining > 0/);
  });

  it('clamps the limit to a ceiling rather than trusting the caller', () => {
    assert.match(REEMBED, /Math\.min\(Math\.max\(1, Math\.floor\(limit\)\), REEMBED_MAX_LIMIT\)/);
  });

  it('counts from one snapshot', () => {
    // The full rule, and why, is `a-skipped-count-comes-from-one-snapshot.test.js`.
    assert.match(BOTH, /\$facet/);
  });
});

describe('the route stays thin, and out of the god-file', () => {
  // It lives in its own module: inline it was +28 code lines on `api/spaces.ts`, which would have been the second
  // double-digit raise of that file in two PRs. Extracted, only the mount point stays (+2).
  const ROUTE = read('../../server/src/api/spaces-reembed.ts');
  const SPACES = read('../../server/src/api/spaces.ts');

  it('delegates to the module instead of inlining the sweep', () => {
    assert.match(ROUTE, /reembedSpace\(spaceId, \{/);
    assert.ok(!/\$exists: false/.test(ROUTE), 'the query belongs in brain/, not in the route');
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
    assert.match(SPACES, /registerReembedRoute\(spacesRouter\);/);
    assert.ok(!/reembedSpace\(/.test(SPACES), 'the handler is back inside the god-file');
  });

  it('is audited, because it changes what a space is findable by', () => {
    const AUDIT = read('../../server/src/audit/middleware.ts');
    // A WINDOW, converted: the subject is the audit table's ROW, bounded by its own brace.
    const at = AUDIT.indexOf('reembed$/');
    assert.ok(at > -1, 'the reembed audit row is gone — re-anchor this gate');
    assert.match(enclosingBlockFrom(AUDIT, at, 'the reembed audit row'), /space\.embeddings\.reembed/,
      'the reembed route must carry its own audit operation');
  });
});

describe('the comment that promised a sweep that never existed', () => {
  it('states the correction and names the real repair', () => {
    // Asserted POSITIVELY: the old phrase is quoted inside the comment that corrects it, so a search for its
    // absence fails against correct code. A gate that reads source has to survive the source explaining itself.
    const QUEUE = read('../../server/src/brain/embed-queue.ts');
    assert.match(QUEUE, /There was no such sweep/);
    assert.match(QUEUE, /reembed/);
    assert.match(QUEUE, /on demand, not periodic/);
  });
});

/**
 * `suppressionExclusion` is pure and exported precisely so the tiers can be checked without a database. It may
 * live in either module after the walker moved; it is looked up in both, and must exist in one.
 */
async function exclusionBuilder() {
  const mods = [];
  for (const p of ['../../server/dist/brain/reembed.js', '../../server/dist/brain/queue-embed-sweep.js']) {
    try { mods.push(await import(p)); } catch { /* not built, or not there: the other may hold it */ }
  }
  const fn = mods.map(m => m.suppressionExclusion).find(f => typeof f === 'function');
  assert.ok(fn, 'suppressionExclusion is exported from neither brain/reembed.js nor brain/queue-embed-sweep.js');
  return fn;
}

describe('suppression is expressible as a query, which is what makes the sweep terminate', () => {
  it('excludes the record tier with $ne, not $exists', async () => {
    const suppressionExclusion = await exclusionBuilder();
    const { query } = suppressionExclusion(undefined, 'fact');
    assert.deepEqual(query['suppressEmbeddings'], { $ne: true },
      '$exists:false would also exclude a record that carries the flag as FALSE — an explicit opt-in');
  });

  it('excludes suppressed TYPE NAMES, on the right field per kind', async () => {
    const suppressionExclusion = await exclusionBuilder();
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
    const suppressionExclusion = await exclusionBuilder();
    assert.equal(suppressionExclusion({ suppressEmbeddings: true }, 'fact'), 'all',
      'a space that suppresses everything has NO WORK, which is a different report from work left over');
  });

  it('does NOT say ALL when a type schema releases a type', async () => {
    const suppressionExclusion = await exclusionBuilder();
    const meta = { suppressEmbeddings: true, typeSchemas: { fact: { note: { suppressEmbeddings: false } } } };
    const res = suppressionExclusion(meta, 'fact');
    assert.notEqual(res, 'all', 'claiming ALL here would skip the types an operator explicitly released');
    assert.deepEqual(res.query['type'], { $in: ['note'] });
  });

  it('treats a type schema that says NOTHING as falling through, not as false', async () => {
    const suppressionExclusion = await exclusionBuilder();
    const meta = { suppressEmbeddings: true, typeSchemas: { fact: { note: {} } } };
    assert.equal(suppressionExclusion(meta, 'fact'), 'all');
  });

  it('a file has no type tier, so no type field appears in its exclusion', async () => {
    const suppressionExclusion = await exclusionBuilder();
    const meta = { typeSchemas: { fact: { task: { suppressEmbeddings: true } } } };
    const { query } = suppressionExclusion(meta, 'file');
    assert.deepEqual(Object.keys(query).sort(), ['suppressEmbeddings'],
      'indexing typeSchemas with "file" would miss every time and silently exclude nothing');
  });
});
