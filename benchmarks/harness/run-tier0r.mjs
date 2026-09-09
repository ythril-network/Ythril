/**
 * Tier 0-R — evidence recall, no model anywhere.
 *
 * Defined in `PROTOCOL.md` (Amendment 4) BEFORE this file ran, which is the ordering the whole protocol exists
 * to make checkable. Read that section before reading this one: what the metric is, and — more usefully — the
 * four things it explicitly cannot say.
 *
 * ## What it does
 *
 * For each conversation, for each model-free ingestion rung, write the records into a fresh space; then for each
 * sampled question run every retrieval method and every grid cell and ask one question of the result:
 * **did the turns the gold answer is evidenced by come back?**
 *
 * No answerer, no judge, no API key, no money. Ythril's embeddings run in-process, so the only cost is time.
 *
 * ## Why the evidence ids are allowed here when the ingest may not see them
 *
 * The blindness rule is about INGESTION: shaping what you store around the answer key is overfitting, and a gate
 * refuses it. Grading is the opposite activity — a benchmark that could not look at the gold answer could not
 * score anything. The separation is enforced structurally: this file imports the questions, and nothing under
 * `ingest/` can.
 *
 * Run: node benchmarks/harness/run-tier0r.mjs --base-url http://localhost:3260 --token <admin> [--questions 200]
 */
import { turnRanks } from './turn-ranks.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConversations, loadQuestions } from './dataset/locomo.mjs';
import { makeYthril } from './ythril.mjs';
import * as s0 from './ingest/s0-raw-turns.mjs';
import * as s0plus from './ingest/s0plus-deterministic-structure.mjs';
import * as s0g from './ingest/s0g-turns-as-graph-nodes.mjs';
import * as s0l from './ingest/s0l-linked-memories.mjs';
import * as s0w from './ingest/s0w-windowed-turns.mjs';
import * as s0e from './ingest/s0e-entity-anchored.mjs';
import * as s0wd from './ingest/s0wd-dated-windows.mjs';
import * as s0wl from './ingest/s0wl-linked-windows.mjs';
import * as s0f from './ingest/s0f-full-decomposition.mjs';
import * as s0m from './ingest/s0m-multi-scale-windows.mjs';
import * as s0c from './ingest/s0c-clean-windows.mjs';
import * as s0cd from './ingest/s0cd-clean-dated-windows.mjs';

const RUNGS = [s0, s0plus, s0g, s0l, s0w, s0wd, s0wl, s0f, s0m, s0c, s0cd, s0e];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * A stratified sample, seeded, so the SAME questions serve every rung and every cell.
 *
 * Stratified by category because the categories are wildly unequal — one is 42% of the release and another 22% —
 * so a uniform sample would report a number dominated by whichever happens to be largest. Seeded because a
 * re-run that grades different questions produces different numbers for no reason anybody can see.
 */
function stratifiedSample(questions, n, seed) {
  const byCat = new Map();
  for (const q of questions) {
    const k = String(q.category);
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k).push(q);
  }
  // A tiny deterministic PRNG. `Math.random()` would make the sample unreproducible, which is the one thing a
  // sample must not be.
  let x = seed >>> 0 || 1;
  const rnd = () => ((x ^= x << 13, x ^= x >>> 17, x ^= x << 5, x >>> 0) / 4294967296);
  const out = [];
  for (const [cat, list] of [...byCat].sort()) {
    const want = Math.max(1, Math.round(n * (list.length / questions.length)));
    const pool = [...list];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    out.push(...pool.slice(0, want).map(q => ({ ...q, _stratum: cat })));
  }
  return out;
}


async function main() {
  const baseUrl = arg('base-url', 'http://localhost:3260');
  const token = arg('token', process.env['YTHRIL_TOKEN'] ?? '');
  const nQuestions = Number(arg('questions', '200'));
  const seed = Number(arg('seed', '1'));
  const dataPath = arg('data', 'C:/Users/Menne/AppData/Local/Temp/claude/'
    + 'o--Projects-Ythril/05520b39-5061-4b20-aa16-5910a7bfe7f7/scratchpad/locomo.json');
  if (!token) throw new Error('--token or YTHRIL_TOKEN required — the harness talks over the real REST door');

  const ythril = makeYthril({ baseUrl, token });
  /*
   * `--conversations` takes the first N, for proving a new rung ingests at all before spending an hour on it.
   *
   * FIRST N and not a sample, deliberately: a smoke run is not a measurement and must not look like one. A
   * stratified subset would produce a number that reads as comparable to a full pass and is not, which is a
   * more expensive mistake than an unrepresentative smoke test.
   */
  const maxConversations = Number(arg('conversations', '0'));
  const allConversations = await loadConversations(dataPath);
  const conversations = maxConversations > 0 ? allConversations.slice(0, maxConversations) : allConversations;
  const questions = await loadQuestions(dataPath);

  // Excluded, with the count printed rather than a total that quietly does not add up.
  const answerable = questions.filter(q => (q.evidence ?? []).length > 0);
  const excludedNoEvidence = questions.length - answerable.length;
  const sample = stratifiedSample(answerable, nQuestions, seed);

  console.log(`Tier 0-R — evidence recall, no model anywhere`);
  console.log(`  conversations   ${conversations.length}`);
  console.log(`  questions       ${sample.length} sampled from ${answerable.length} answerable `
    + `(${excludedNoEvidence} excluded: no evidence cited)`);
  console.log(`  rungs           ${RUNGS.map(r => r.rung).join(', ')}`);

  /*
   * `--rungs s0+` re-runs one rung without redoing the others.
   *
   * Not a convenience. The rungs are independent measurements over independent spaces, and a defect found in
   * one of them should cost that rung's ingestion time and no more — the first run of this file lost nothing
   * only because the intact rung had already finished. A results file assembled from separate invocations
   * carries each rung's own commit, which the reporter prints, so a mixed file is legible rather than silently
   * pooled.
   */
  const traverseDepth = Number(arg('traverse', '0'));
  /*
   * A rung may declare the shallowest walk at which it measures anything, and this REFUSES rather than warns.
   *
   * The failure it prevents has happened: a rung whose records link to a shared subject entity was run at
   * depth 1, where hop 1 reaches the entity and hop 2 — the one that comes back out to the other records —
   * never runs. Every response was well-formed, `_graph` was non-empty so the walk had plainly executed, and
   * the score was a plausible number close to the unlinked rung's. It would have been published as "linking
   * does not help", which is a true-looking conclusion about an experiment that did not take place.
   *
   * **A configuration that measures nothing must not be able to produce a number.** A warning would not do:
   * the run takes half an hour and the warning scrolls past in the first second.
   */
  const tooShallow = RUNGS.filter(r => typeof r.minTraverseDepth === 'number'
    && traverseDepth > 0 && traverseDepth < r.minTraverseDepth
    && (arg('rungs', '').split(',').filter(Boolean).length === 0
      || arg('rungs', '').split(',').includes(r.rung)));
  if (tooShallow.length > 0) {
    throw new Error(`--traverse ${traverseDepth} is too shallow for `
      + `${tooShallow.map(r => `${r.rung} (needs ${r.minTraverseDepth})`).join(', ')}. `
      + 'At this depth the walk reaches the linking entity and stops, so not one extra record comes back — '
      + 'the run would complete, look healthy, and report a number for an experiment that never ran.');
  }
  /*
   * `--max-chars` gives every rung the SAME answer budget, which is the only way a chunking strategy can be
   * compared with one record per turn.
   *
   * Without it, a rung whose records are ten turns long returns ten times the text for the same `topK` and
   * scores accordingly — the protocol's own warning that "a configuration that returns everything scores
   * perfectly and is useless", arriving through the record SIZE rather than through `topK`. With a budget,
   * a windowed rung has to give up records to fit, and what is left is the question actually worth asking:
   * per byte returned, which shape of record finds more of the evidence?
   */
  const maxChars = arg('max-chars', '');
  /*
   * `--topk` exists so two rungs can be compared at equal BYTES rather than at equal record counts.
   *
   * Measured, and it is why the first equal-budget run settled nothing: one record per turn returned 20
   * records for 10 435 characters and was truncated on NONE of the 199 questions — it never reached the
   * budget, because `topK` bound it first. The windowed rung spent 24 138 and was truncated on ALL of them.
   * Calling that an equal-cost comparison would have credited chunking with an advantage it was simply
   * being handed.
   */
  const topK = Number(arg('topk', '20'));
  // Skip the ingest and ask against what is already stored — see the guard at the call site.
  const reuse = process.argv.includes('--reuse-spaces');
  const only = arg('rungs', '').split(',').filter(Boolean);
  const selected = only.length === 0 ? RUNGS : RUNGS.filter(r => only.includes(r.rung));
  if (selected.length === 0) {
    throw new Error(`--rungs '${only.join(',')}' matched none of: ${RUNGS.map(r => r.rung).join(', ')}`);
  }

  const rows = [];
  for (const rung of selected) {
    for (const conv of conversations) {
      const space = `bench-${rung.rung.replace('+', 'plus')}-${conv.id}`.toLowerCase();
      process.stdout.write(`\n[${rung.rung}] ${conv.id}: `);
      /*
       * `--reuse-spaces` skips the ingest and asks against what is already stored.
       *
       * ## Why it exists, and why it is guarded rather than trusted
       *
       * Ingest is the expensive half — ~2 minutes per conversation per rung, so a full pass is over an hour —
       * and it is IDENTICAL at every traverse depth. Without this flag, measuring traverse 0 against 1 and 2
       * means paying for the same records three times, which is why the traverse axis had never been swept
       * for a rung that needs it.
       *
       * The guard is the point. A reused space that is missing, empty or half-written produces a LOW score
       * that looks like a finding about retrieval — the most expensive way to be wrong here. So the space is
       * required to exist and to hold records, and the run stops naming the space if it does not, rather than
       * quietly measuring an empty store.
       */
      let records = null;
      let modelCalls = 0;
      const t0 = Date.now();
      if (reuse) {
        const stats = await ythril.spaceStats(space).catch(() => null);
        const held = stats ? (stats.memories ?? 0) + (stats.entities ?? 0) + (stats.chrono ?? 0) : 0;
        if (held === 0) {
          throw new Error(
            `--reuse-spaces was given but '${space}' holds no records (${stats ? 'empty' : 'absent'}). `
            + 'Re-run without the flag to ingest it; measuring an empty space reports a low score that reads '
            + 'as a finding about retrieval.');
        }
        records = held;
        process.stdout.write(`${records} records REUSED `);
      } else {
        await ythril.deleteSpace(space).catch(() => {});
        /*
         * The rung's own declaration of what its corpus may contain, enforced by the instance.
         *
         * A space defaults to strict validation, and a declared collection's keys are an allowlist — so a
         * rung that writes a type it did not declare, or omits a property it declared required, is refused
         * at the first write instead of producing a corpus that is quietly missing something. A benchmark
         * reports a NUMBER rather than an exception, so a silently wrong corpus is read as a finding about
         * retrieval; this converts that into a failure at ingest.
         *
         * A rung with no `typeSchemas` is still allowed and validates nothing, which is what every rung did
         * before this existed — the gate is what stops that being the quiet default forever.
         */
        await ythril.createSpace(space, rung.typeSchemas ? { typeSchemas: rung.typeSchemas } : {});
        /*
         * `conversations` is the whole corpus, and a rung that needs it says so. `s0wl` does: telling a
         * topic word from an ordinary English word is not possible inside one conversation, because both
         * appear in several of its sessions. A term in most of the TEN conversations is English.
         *
         * It carries no question data — `loadConversations` returns objects that have none — so this
         * keeps the ingest question-blind exactly as before.
         */
        ({ records, modelCalls } = await rung.ingest({ conversation: conv, conversations, ythril, space }));
        process.stdout.write(`${records} records (${modelCalls} model calls) `);
      }
      await ythril.waitForEmbeddings(space, { timeoutMs: 20 * 60_000 });
      const ingestMs = Date.now() - t0;
      process.stdout.write(`embedded in ${(ingestMs / 1000).toFixed(0)}s, `);

      /*
       * A rung whose coverage lives OUTSIDE the corpus cannot be scored against a space it did not just
       * write, because the map is built during the ingest and this process never ran one.
       *
       * Refused rather than tolerated: with an empty map every question scores zero, the run completes, and
       * the report says the strategy finds nothing. That is a wrong number rather than a low one, and it is
       * exactly the shape of failure this harness has produced twice already.
       */
      const covers = ythril.coverage(space);
      if (rung.coversOutOfBand === true && covers.size === 0) {
        throw new Error(`${rung.rung} keeps its turn coverage outside the records, so it cannot be scored `
          + 'with --reuse-spaces: the map is built while ingesting and no ingest ran in this process. '
          + 'Re-run this rung without the flag.');
      }

      const qs = sample.filter(q => q.conversationId === conv.id);
      let asked = 0;
      for (const q of qs) {
        // The default configuration only, at this stage: the grid multiplies this by 14 and the point of the
        // first run is to prove the pipeline end to end and MEASURE what a cell costs before ordering 14 of them.
        const started = Date.now();
        const res = await ythril.recall(space, {
          query: q.question,
          topK,
          // The rung says which record types carry its content; see `recallTypes` on each ingest module.
          ...(rung.recallTypes ? { types: rung.recallTypes } : {}),
          /*
           * `traverseExtra` is the rung's OWN traverse options, merged in — see `s0l`, where it carries
           * `includeMemories: true`.
           *
           * Without it that rung measures NOTHING. The walk starts correctly from a matched memory's
           * `entityIds` and reaches the session entity at hop 1, then cannot bring the sibling turns back,
           * because returning non-entity records is opt-in and defaults to false. The recall would look
           * expanded and report `graphNodes > 0` while containing no additional evidence — a plausible
           * number measuring the wrong thing, which is worse than a failure.
           */
          ...(maxChars ? { maxChars: Number(maxChars) } : {}),
          ...(traverseDepth > 0
            ? { traverse: { depth: traverseDepth, ...(rung.traverseExtra ?? {}) } }
            : {}),
        });
        const ranks = turnRanks(res.results, covers);
        const got = new Set(ranks.keys());
        const want = q.evidence;
        const hit = want.filter(e => got.has(e));
        /*
         * How far down the list a caller had to read before holding ALL the evidence — the deepest rank over
         * the wanted turns, and null when even one never came back. This is the number the coverage metric
         * hides: a rung can take `allEvidence` from 66% to 90% while pushing this from 4 to 18, which is
         * worse retrieval sold as better.
         */
        const depth = hit.length === want.length ? Math.max(...want.map(e => ranks.get(e))) : null;
        const firstHit = hit.length > 0 ? Math.min(...hit.map(e => ranks.get(e))) : null;
        rows.push({
          rung: rung.rung,
          conversationId: conv.id,
          category: q.category,
          evidenceCount: want.length,
          allEvidence: hit.length === want.length,
          anyEvidence: hit.length > 0,
          /*
           * The rank-sensitive half, and the half that cannot be won by returning more.
           *
           * `allAtRank1` is the strictest thing this tier can ask: the single top-ranked record held every
           * turn the answer cites. `depth` and `firstHitRank` are null on a miss rather than defaulted,
           * because a 0 here would average in as a perfect score.
           */
          /*
           * The size of the top-ranked record, which is what stops `allAtRank1` becoming the next thing to
           * brute-force. A rung that put the whole conversation in one record would hold every evidence turn
           * at rank 1 and score perfectly — and this column would read 40 000 characters, which is not a
           * retriever answering a question, it is a transcript being handed back.
           */
          topChars: (res.results?.[0]?.fact ?? res.results?.[0]?.text ?? '').length || null,
          allAtRank1: depth === 1,
          anyAtRank1: firstHit === 1,
          depth,
          firstHitRank: firstHit,
          /*
           * TWO different numbers, and conflating them flatters any rung whose records cover more than one
           * turn. `records` is what the retriever actually returned and what a byte budget holds; `retrieved`
           * is how many distinct source turns those records account for. They are equal only when a record is
           * one turn, which was true of every rung until `s0w`.
           */
          records: (res.results ?? []).length,
          chars: res.charsReturned ?? null,
          truncated: res.truncated ?? false,
          retrieved: got.size,
          ms: Date.now() - started,
          /*
           * The scores of the records that actually came back, which is what PROTOCOL.md Amendment 5 pins
           * `minScore` from: the 25th percentile of this, pooled across conversations and rungs.
           *
           * Recorded HERE rather than derived later because this cell applies no threshold, and that is the
           * property that makes the pin honest — the distribution cannot be selected by how well a threshold
           * performs on it. A run that filtered first could not be used, so the unfiltered run has to carry it.
           */
          scores: (res.results ?? []).map(r => r.score).filter(s => typeof s === 'number'),
        });
        asked++;
      }
      process.stdout.write(`${asked} questions`);
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const dir = join(arg("out", join("benchmarks", "results")), `${stamp}-tier0r${only.length ? "-" + only.join("_").replace("+", "plus") : ""}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rows.json'), JSON.stringify(rows, null, 2));
  console.log(`\n\nwrote ${rows.length} rows to ${dir}`);
}

await main();
