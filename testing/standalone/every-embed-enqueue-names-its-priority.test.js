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

// Untracked-but-not-ignored too: a new arrival writer must not be outside this gate on its own commit.
const SOURCES = readTrackedSources('server/src', { floor: 100, specs: false, untracked: true })
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

/*
 * The ENQUEUE DOORS, derived: every exported `enqueue…EmbedJob(s)` of embed-queue.ts. Since Q-99 part 3 the brain
 * writers no longer call `enqueueEmbedJob` one record at a time — the write commit queues a whole plan through
 * `enqueueWriteEmbedJobs` — so a gate that scanned only the single-record door would conclude about every enqueue
 * while reading fewer and fewer of them. Each door takes its lane in a trailing `{ priority }` options object.
 * (The `enqueueIngested…` functions are not doors here: each fixes its own lane, asserted below.)
 */
const QUEUE_SRC = SOURCES.find(s => s.file === 'server/src/brain/embed-queue.ts');
const DOORS = QUEUE_SRC
  ? [...QUEUE_SRC.code.matchAll(/^export\s+async\s+function\s+(enqueue\w*EmbedJobs?)\(/gm)].map(m => m[1])
  : [];

const CALLS = SOURCES.flatMap(s => DOORS.flatMap(d => callsOf(s.code, s.file, d).map(c => ({ ...c, door: d }))));

/** The trailing options argument carries the lane, by name. */
const namesPriority = (arg) => arg !== undefined && /\bpriority\b|EMBED_PRIORITY\./.test(arg);

describe('every embed-job enqueue names its lane', () => {
  it('the enqueue doors were found (floor)', () => {
    for (const d of ['enqueueEmbedJob', 'enqueueEmbedJobs', 'enqueueWriteEmbedJobs']) {
      assert.ok(DOORS.includes(d), `${d} is no longer an exported door of embed-queue.ts — re-anchor this gate`);
    }
  });

  it('the scan found the call sites (floor)', () => {
    // 15 before Q-99 part 3. Six single-record enqueues legitimately left: the create and converge paths of
    // saveFact, upsertEntity (2), createChrono and upsertEdge (2) are now ONE `enqueueWriteEmbedJobs` call in
    // write-plan/commit.ts, which this scan now also reads.
    assert.ok(CALLS.length >= 12,
      `found ${CALLS.length} call site(s) of ${DOORS.join('/')} in server/src; expected at least 12 — the scan is broken`);
    assert.ok(CALLS.some(c => c.file === 'server/src/brain/write-plan/commit.ts' && c.door === 'enqueueWriteEmbedJobs'),
      'the write commit no longer enqueues through enqueueWriteEmbedJobs — re-anchor this gate');
  });

  it('every call passes a priority as its last argument', () => {
    const missing = CALLS.filter(c => !namesPriority(c.args[c.args.length - 1]));
    assert.deepEqual(missing.map(c => `${c.file}:${c.line} ${c.door} (${c.args.length} args)`), [],
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

  /*
   * The INGEST enqueues, derived like the doors: every exported `enqueueIngested…` of embed-queue.ts. Since
   * `Q-107` part 1 there are two — the single record, and the batched twin `enqueueIngestedRecords` the arrival
   * writer queues a landed chunk with. A lane asserted of one by name is a lane the other may get wrong, and the
   * batched one carries a whole page of a peer's records.
   */
  const INGESTED = QUEUE
    ? [...QUEUE.code.matchAll(/^export\s+async\s+function\s+(enqueueIngested\w*)\s*[<(]/gm)].map(m => m[1])
    : [];

  it('the ingest enqueues were found — the single record and its batched twin (floor)', () => {
    for (const name of ['enqueueIngestedRecord', 'enqueueIngestedRecords']) {
      assert.ok(INGESTED.includes(name), `embed-queue.ts exports no ${name}`);
    }
  });

  it('every ingest enqueue queues with EMBED_PRIORITY.background', () => {
    for (const name of INGESTED) {
      const body = bodyOf(QUEUE.code, name);
      const calls = DOORS.flatMap(d => callsOf(body, QUEUE.file, d));
      assert.ok(calls.length >= 1, `${name} no longer enqueues through a door — re-anchor this gate`);
      for (const c of calls) {
        assert.match(c.args[c.args.length - 1] ?? '', /EMBED_PRIORITY\.background\b/,
          `${name}'s enqueue passes ${c.args[c.args.length - 1] ?? 'no priority'}; a sync arrival is background work`);
      }
    }
  });

  /*
   * The ARRIVAL WRITERS: every exported `ingest…` of api/sync/_shared.ts (file metadata keeps its own merge), and
   * `writeArrivals` of sync/arrivals.ts, which stores every other family (`Q-107` part 1). Read from both files,
   * so the writer that replaced `ingestBrainDoc` cannot leave the lane rule behind with it.
   */
  const ARRIVALS = SOURCES.find(s => s.file === 'server/src/sync/arrivals.ts');
  const WRITERS = [
    ...(SYNC ? [...SYNC.code.matchAll(/^export\s+async\s+function\s+(ingest\w*)/gm)].map(m => ({ src: SYNC, name: m[1] })) : []),
    ...(ARRIVALS ? [...ARRIVALS.code.matchAll(/^export\s+async\s+function\s+(writeArrivals)\b/gm)].map(m => ({ src: ARRIVALS, name: m[1] })) : []),
  ];

  it('the arrival writers were found (floor)', () => {
    assert.ok(ARRIVALS, 'server/src/sync/arrivals.ts does not exist — the arrival writer is not where this gate looks');
    assert.ok(WRITERS.some(w => w.name === 'writeArrivals'), 'sync/arrivals.ts exports no writeArrivals');
    assert.ok(WRITERS.length >= 2, `found ${WRITERS.length} arrival writer(s); expected at least 2`);
  });

  it('every arrival writer enqueues only through the background lane', () => {
    for (const { src, name } of WRITERS) {
      const body = bodyOf(src.code, name);
      // bodyOf returns whole lines, so the body's first line is found by its text and the count is exact.
      const base = src.code.slice(0, src.code.indexOf(body)).split('\n').length - 1;
      const viaIngested = INGESTED.flatMap(n => callsOf(body, src.file, n, base));
      const direct = DOORS.flatMap(d => callsOf(body, src.file, d, base));
      assert.ok(viaIngested.length + direct.length >= 1,
        `${name} queues nothing — an arriving record would never be embedded on this instance`);
      for (const c of direct) {
        assert.match(c.args[c.args.length - 1] ?? '', /EMBED_PRIORITY\.background\b/,
          `${name} (line ${c.line}) enqueues a sync arrival outside the background lane`);
      }
    }
  });
});
