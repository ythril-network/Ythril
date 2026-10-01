/**
 * Every enqueue of an embed job says which lane it belongs to, and a record arriving by sync says BACKGROUND.
 *
 * ## The rule (Q-99 part 2, design v3 item 4)
 *
 * `enqueueEmbedJob(spaceId, type, id, { priority })` takes the lane as a REQUIRED fourth argument: 0 = a local
 * write, 1 = a sync arrival or a reembed backfill, 2 = a reindex rebuild (`EMBED_PRIORITY`). It is required rather
 * than defaulted because a default is a decision nobody made: a new call site that forgot the argument would land
 * silently in whichever lane the default named, and the cost of the wrong lane is invisible — a sync arrival
 * jumping every local write, or a local write queued behind a whole reindex.
 *
 * TypeScript enforces the arity of a required parameter, so the half of this gate that can rot is the half the
 * compiler cannot see: the sync ingest sites must choose BACKGROUND, not just any lane. A peer pushing ten
 * thousand records must not take the claim away from the operator's own writes.
 *
 * ## How the set is found, and why it is derived
 *
 * The call sites are every `enqueueEmbedJob(` in tracked `server/src` sources, the declaration excluded, comments
 * BLANKED rather than deleted so a reported line is the real line — read out of `git ls-files`, with a floor,
 * never listed. The ingest functions are every exported `ingest*` function of `api/sync/_shared.ts`, also with a floor. A hand-written list of either is the defect
 * `a gate concludes about MORE than it checks` describes.
 *
 * ## Seen red
 *
 * On the base, by construction: no call passes a fourth argument. And by mutation — see the commit that adds this.
 *
 * Run: node --test testing/standalone/every-embed-enqueue-names-its-priority.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { argumentsOf, bodyOf } from './_structural-window.mjs';

const SOURCES = readTrackedSources('server/src', { floor: 100, specs: false })
  .map(s => ({ file: s.file, code: blankComments(s.text) }));

/** Every call of `name(` in the code, with its argument list, excluding the function's own declaration. */
function callsOf(code, file, name, lineBase = 0) {
  const out = [];
  const re = new RegExp(`(?<![\\w.$])${name}\\(`, 'g');
  for (let m; (m = re.exec(code));) {
    // The declaration, not a call: bounded by the line the match sits on, never by a character count.
    const lineStart = code.lastIndexOf('\n', m.index) + 1;
    if (/\bfunction\s*$/.test(code.slice(lineStart, m.index))) continue;
    const args = argumentsOf(code, m.index + name.length, `${file}: ${name}(`);
    const line = lineBase + code.slice(0, m.index).split('\n').length;
    out.push({ file, line, args });
  }
  return out;
}

const CALLS = SOURCES.flatMap(s => callsOf(s.code, s.file, 'enqueueEmbedJob'));

/** The fourth argument carries the lane, by name. */
const namesPriority = (arg) => arg !== undefined && /\bpriority\b|EMBED_PRIORITY\./.test(arg);

describe('every enqueueEmbedJob call names its lane', () => {
  it('the scan found the call sites (floor)', () => {
    assert.ok(CALLS.length >= 15,
      `found ${CALLS.length} enqueueEmbedJob( call site(s) in server/src; expected at least 15 — the scan is broken`);
  });

  it('every call passes a priority as its fourth argument', () => {
    const missing = CALLS.filter(c => !namesPriority(c.args[3]));
    assert.deepEqual(missing.map(c => `${c.file}:${c.line} (${c.args.length} args)`), [],
      'these enqueues do not say which lane they belong to; pass `{ priority: EMBED_PRIORITY.<lane> }`');
  });
});

describe('a record arriving by sync is queued in the BACKGROUND lane', () => {
  const QUEUE = SOURCES.find(s => s.file === 'server/src/brain/embed-queue.ts');
  const SYNC = SOURCES.find(s => s.file === 'server/src/api/sync/_shared.ts');

  it('the files this gate reads are where it thinks they are', () => {
    assert.ok(QUEUE, 'server/src/brain/embed-queue.ts is gone — re-anchor this gate');
    assert.ok(SYNC, 'server/src/api/sync/_shared.ts is gone — re-anchor this gate');
  });

  it('enqueueIngestedRecord queues with EMBED_PRIORITY.background', () => {
    const body = bodyOf(QUEUE.code, 'enqueueIngestedRecord');
    const calls = callsOf(body, QUEUE.file, 'enqueueEmbedJob');
    assert.ok(calls.length >= 1, 'enqueueIngestedRecord no longer enqueues — re-anchor this gate');
    for (const c of calls) {
      assert.match(c.args[3] ?? '', /EMBED_PRIORITY\.background\b/,
        `enqueueIngestedRecord's enqueue passes ${c.args[3] ?? 'no priority'}; a sync arrival is background work`);
    }
  });

  it('every exported ingest* function of api/sync/_shared.ts enqueues only through the background lane', () => {
    const names = [...SYNC.code.matchAll(/^export\s+async\s+function\s+(ingest\w*)/gm)].map(m => m[1]);
    assert.ok(names.length >= 2, `found ${names.length} ingest function(s) in api/sync/_shared.ts; expected at least 2`);
    for (const name of names) {
      const body = bodyOf(SYNC.code, name);
      // bodyOf returns whole lines, so the body's first line is found by its text and the count is exact.
      const base = SYNC.code.slice(0, SYNC.code.indexOf(body)).split('\n').length - 1;
      const viaIngested = callsOf(body, SYNC.file, 'enqueueIngestedRecord', base);
      const direct = callsOf(body, SYNC.file, 'enqueueEmbedJob', base);
      const bulk = callsOf(body, SYNC.file, 'enqueueEmbedJobs', base);
      assert.ok(viaIngested.length + direct.length + bulk.length >= 1,
        `${name} queues nothing — an arriving record would never be embedded on this instance`);
      for (const c of [...direct, ...bulk]) {
        assert.match(c.args[c.args.length - 1] ?? '', /EMBED_PRIORITY\.background\b/,
          `${name} (line ${c.line}) enqueues a sync arrival outside the background lane`);
      }
    }
  });
});
