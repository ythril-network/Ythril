#!/usr/bin/env node
/**
 * Q-763: does a label's vocabulary meaning in an edge's embedding text improve recall? Two arms over one RDF-enabled space
 * holding BSBM 1 000, the same model, a reembed between them:
 *
 * - **arm A** is today's `edgeEmbedText` (server/src/brain/embed-text.ts): tags, from-name, label, to-name, type, description,
 *   properties.
 * - **arm B** appends the label's meaning ({@link labelMeaning}): the description of the label's declaration in the space
 *   schema (`meta.typeSchemas.edge[label].description`), else the `rdfs:comment` the data states on the label's vocabulary
 *   term (`meta.typeSchemas.edge[label].iri`). It is made without a server change: every edge of a label gets the meaning as
 *   its description, which arm A's text appends after the type ({@link descriptionFor}; BSBM edges have no description, tags,
 *   type or properties), then the space is reembedded. The arm checks a sample of stored texts against {@link armBText}.
 *
 * Queries come from fixed per-label templates that leave the label's words out ({@link generateQueries}), the target edge the
 * one relevant answer. Each is asked through `POST /api/brain/recall` with `types: ['edge']` and `topK: 10`; recall@10 and
 * MRR@10 per arm and seed, the verdict by the margin of design-return Q-763 ({@link verdict}).
 *
 *   node benchmarks/rdf/embed-meaning.mjs prepare  --size 1000 [--work <dir>]    edge-only embedding, label meanings into the schema
 *   node benchmarks/rdf/embed-meaning.mjs arm      --arm A --size 1000 [--seeds 1,2,3] [--queries 200]
 *   node benchmarks/rdf/embed-meaning.mjs meaning  --size 1000                     descriptions in, reembed, wait, check texts
 *   node benchmarks/rdf/embed-meaning.mjs arm      --arm B --size 1000 [--seeds 1,2,3] [--queries 200]
 *   node benchmarks/rdf/embed-meaning.mjs report   --size 1000                     both arms, the means and the verdict
 *
 * Needs the scratch instance of `load.mjs ythril-up` and a finished `load.mjs ythril --size 1000`. Everything it writes goes to
 * `<work>/embed-meaning/`.
 *
 * ## What this prevents
 *
 * - **Measuring the label instead of its meaning.** A template holding a word of its label is refused.
 * - **A second right answer scored as a miss.** A query is made only for an edge its filled slots name alone.
 * - **Unpinned queries.** The queries are a function of the edges, the names, the templates and the seed; their sha256 is
 *   recorded per seed, and arm B is refused unless it asks the very queries arm A asked.
 * - **An arm B that is not arm A plus the meaning.** An edge that has a description of its own is refused, and stored texts
 *   are compared with {@link armBText} before arm B is measured.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, sleep, workDir } from './env.mjs';
import { waitForDrain } from './embed-wait.mjs';
import { statePath } from './oxigraph.mjs';
import { spaceCounts } from './ythril.mjs';

// ── The pinned inputs ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The meaning written into each BSBM label's declaration, phrased after the BSBM 3.1 specification's data model (section 2).
 * Written before the templates and not tuned to them.
 */
export const MEANINGS = Object.freeze({
  producer: 'Links a product to the producer that manufactures it.',
  productFeature: 'Links a product to a feature it has.',
  product: 'Links an offer to the product it offers.',
  vendor: 'Links an offer to the vendor that sells the product.',
  reviewFor: 'Links a review to the product it reviews.',
  reviewer: 'Links a review to the person who wrote it.',
});

/**
 * The query templates per label. `{from}` and `{to}` are filled with the endpoints' names. A label whose edges are many per
 * `from` (productFeature) names both ends, so the slots name one edge.
 */
export const TEMPLATES = Object.freeze({
  producer: ['which company manufactures {from}', 'who makes {from}', 'the maker of {from}'],
  productFeature: ['does {from} have {to}', 'is {to} a characteristic of {from}', '{from} comes with {to}'],
  product: ['what is sold in {from}', 'which item does {from} sell', 'the article on sale in {from}'],
  vendor: ['which shop sells {from}', 'who is the seller of {from}', 'the retailer behind {from}'],
  reviewFor: ['what item does {from} talk about', 'which thing is {from} about', 'the article {from} evaluates'],
  reviewer: ['who wrote {from}', 'the author of {from}', 'which person rated {from}'],
});

export const TOP_K = 10;
export const MARGIN_POINTS = 3;

// ── The pure parts ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A label's words: the local name split at case changes, lower-cased; words under four letters ("for") are not counted. */
export function labelWords(label) {
  const local = String(label).split(/[:#/]/).pop();
  return local.split(/(?=[A-Z])|[^A-Za-z]+/).map(w => w.toLowerCase()).filter(w => w.length >= 4);
}

/** A small seeded generator (mulberry32): the same seed gives the same draws on every machine. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const slotsOf = template => [...template.matchAll(/\{(from|to)\}/g)].map(m => m[1]);

/**
 * The queries for one seed: per label (sorted), at most `perLabel` edges drawn by the seed from those whose filled slots name
 * that edge alone among the label's edges, the templates used in turn. Each query is `{ label, template, text, target }`.
 * A template holding a word of its label is refused. The input order of `edges` does not matter.
 */
export function generateQueries({ edges, names, templates, seed, perLabel }) {
  const out = [];
  for (const label of Object.keys(templates).sort()) {
    const words = labelWords(label);
    const list = templates[label];
    for (const t of list) {
      const tokens = t.replace(/\{(from|to)\}/g, ' ').toLowerCase().match(/[a-z]+/g) ?? [];
      const hit = tokens.find(tok => words.some(w => tok.startsWith(w)));
      if (hit) throw new Error(`the template "${t}" names its label ${label} ("${hit}"): it would measure the label, not its meaning`);
    }
    const ofLabel = edges.filter(e => e.label === label).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    // An edge is eligible for a template when every slot has a name and the slot values name it alone.
    const keyOf = (e, slots) => slots.map(s => e[s]).join('\u0000');
    const eligibleFor = list.map(t => {
      const slots = slotsOf(t);
      const count = new Map();
      for (const e of ofLabel) count.set(keyOf(e, slots), (count.get(keyOf(e, slots)) ?? 0) + 1);
      return new Set(ofLabel.filter(e => count.get(keyOf(e, slots)) === 1 && slots.every(s => names.get(e[s]))).map(e => e.id));
    });
    const pool = ofLabel.filter(e => eligibleFor.some(s => s.has(e.id)));
    const rand = seeded(seed);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    let made = 0;
    for (const e of pool) {
      if (made >= perLabel) break;
      // The template in turn; an edge it cannot name alone takes the next one that can.
      let k = made % list.length;
      for (let step = 0; step < list.length && !eligibleFor[k].has(e.id); step++) k = (k + 1) % list.length;
      if (!eligibleFor[k].has(e.id)) continue;
      const text = list[k].replace(/\{(from|to)\}/g, (_, s) => names.get(e[s]));
      out.push({ label, template: k, text, target: e.id });
      made++;
    }
  }
  return out;
}

/** The 1-based position of `target` in `ids`, or null when it is not there. */
export function rankOf(ids, target) {
  const i = ids.indexOf(target);
  return i < 0 ? null : i + 1;
}

/** The share of queries whose target ranked at `k` or better. */
export function recallAt(ranks, k) {
  return ranks.filter(r => r !== null && r <= k).length / ranks.length;
}

/** The mean of 1/rank over the queries, a rank past `k` or none counting 0 (MRR@k). */
export function meanReciprocalRank(ranks, k) {
  return ranks.reduce((sum, r) => sum + (r !== null && r <= k ? 1 / r : 0), 0) / ranks.length;
}

/**
 * What a label means: the trimmed description of its declaration in the space schema, else the comment its vocabulary term
 * carries (`comments`, by IRI), else null.
 */
export function labelMeaning(meta, label, comments) {
  const decl = meta?.typeSchemas?.edge?.[label];
  const own = typeof decl?.description === 'string' ? decl.description.trim() : '';
  if (own) return own;
  const comment = decl?.iri ? comments.get(decl.iri) : undefined;
  return typeof comment === 'string' && comment.trim() ? comment.trim() : null;
}

/** Arm B's text: arm A's text with the meaning appended; a label without a meaning keeps arm A's text. */
export function armBText(armAText, meaning) {
  return meaning ? `${armAText} ${meaning}` : armAText;
}

/** The description arm B gives an edge: its label's meaning. An edge with a description of its own is refused. */
export function descriptionFor(edge, meaning) {
  if (typeof edge.description === 'string' && edge.description.trim() && edge.description !== meaning) {
    throw new Error(`edge ${edge.id} already has a description: arm B would not be arm A plus the meaning`);
  }
  return meaning;
}

/**
 * The flag ships only when arm B's recall@10 is at least {@link MARGIN_POINTS} points above arm A's and its MRR is not below.
 * Compared in points rounded to a millionth, so 0.33 - 0.30 counts as 3.
 */
export function verdict(a, b, marginPoints = MARGIN_POINTS) {
  const recallGainPoints = Math.round((b.recall - a.recall) * 100 * 1e6) / 1e6;
  const mrrChange = Math.round((b.mrr - a.mrr) * 1e9) / 1e9;
  return { recallGainPoints, mrrChange, ships: recallGainPoints >= marginPoints && mrrChange >= 0 };
}

// ── The instance ─────────────────────────────────────────────────────────────────────────────────────────────────────

const DB = 'ythril_bench';
const sha256 = text => createHash('sha256').update(text).digest('hex');

/** Runs a script in the scratch database's container and answers the JSON it prints (no container is started). */
function mongo(state, script) {
  // `--eval`, not stdin: fed a script on stdin, mongosh prints its prompt after the answer.
  const r = spawnSync('docker', ['exec', state.mongo, 'mongosh', '--quiet', DB, '--eval', script], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`mongosh in ${state.mongo} failed (${r.status}): ${r.stderr || r.stdout}`);
  const line = r.stdout.trim().split('\n').pop();
  return JSON.parse(line);
}

async function api(state, method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${state.origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${state.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (res.status === 429 && attempt < 20) { await sleep(5000); continue; }
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (res.status >= 300) throw new Error(`${method} ${path} answered ${res.status}: ${text.slice(0, 400)}`);
    return json;
  }
}

function loadState(work, size) {
  const s = JSON.parse(readFileSync(statePath(work, `ythril-${size}`), 'utf8'));
  return { ...s, origin: new URL(s.url).origin };
}

/** Every edge of the space with its endpoints, and every entity's name. */
function readGraph(state) {
  const edges = mongo(state, `print(JSON.stringify(db.getCollection(${JSON.stringify(`${state.spaceId}_edges`)}).find({}, {from:1,to:1,label:1,description:1,tags:1,type:1,properties:1}).toArray().map(e => ({ id: e._id, from: e.from, to: e.to, label: e.label, description: e.description ?? null, extra: (e.tags?.length ?? 0) + (e.type ? 1 : 0) + Object.keys(e.properties ?? {}).length }))))`);
  const names = mongo(state, `print(JSON.stringify(db.getCollection(${JSON.stringify(`${state.spaceId}_entities`)}).find({}, {name:1}).toArray().map(e => [e._id, e.name])))`);
  return { edges, names: new Map(names) };
}

/** The `rdfs:comment` the variant states on a subject, by IRI: the comments a vocabulary term may carry. */
function commentsInVariant(work, size) {
  const comments = new Map();
  const file = join(work, 'data', String(size), 'variant.nt');
  const re = /^<([^>]+)> <http:\/\/www\.w3\.org\/2000\/01\/rdf-schema#comment> "((?:[^"\\]|\\.)*)"/;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = re.exec(line);
    if (m) comments.set(m[1], JSON.parse(`"${m[2]}"`));
  }
  return comments;
}

async function drain(state, label) {
  const result = await waitForDrain({
    probe: async () => (await spaceCounts({ ...state, url: state.origin }, state.spaceId)).embedQueue,
    sleep, pollMs: 15_000, deadlineMs: 4 * 3600_000,
  });
  console.log(`${label}: embed queue waited ${Math.round(result.waitedMs / 1000)} s, ${result.pending} left`);
  if (!result.drained) throw new Error('the embed queue did not drain');
  return result;
}

async function recallIds(state, query) {
  const answer = await api(state, 'POST', '/api/brain/recall', { query, space: state.spaceId, types: ['edge'], topK: TOP_K });
  return (answer.results ?? []).map(r => r.record?._id ?? r.record?.id ?? r.id);
}

// ── The steps ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function prepare(state, out) {
  // Only edges are asked for, so only edges are embedded: the space suppresses, each edge label releases its own.
  const space = await api(state, 'GET', `/api/spaces/${state.spaceId}/meta`);
  const meta = space.meta ?? space;
  const labels = Object.keys(meta.typeSchemas?.edge ?? {}).sort();
  for (const label of labels) {
    const got = await api(state, 'GET', `/api/spaces/${state.spaceId}/meta/typeSchemas/edge/${encodeURIComponent(label)}`);
    const schema = { ...(got.schema ?? {}), suppressEmbeddings: false };
    if (MEANINGS[label]) schema.description = MEANINGS[label];
    await api(state, 'PUT', `/api/spaces/${state.spaceId}/meta/typeSchemas/edge/${encodeURIComponent(label)}`, schema);
  }
  await api(state, 'PATCH', `/api/spaces/${state.spaceId}`, { meta: { suppressEmbeddings: true } });
  await api(state, 'POST', `/api/spaces/${state.spaceId}/reembed`, {});
  writeFileSync(join(out, 'prepare.json'), `${JSON.stringify({ labels, meanings: MEANINGS }, null, 2)}\n`);
  console.log(`edge labels ${labels.join(', ')}: meanings written, embeddings suppressed for everything but edges`);
}

/**
 * A drained queue is not a ready index: every edge must hold its embedded text, and an edge's own text, asked back, must find
 * it within the top 10 (retried for up to ten minutes while the vector index catches up).
 */
async function probeIndex(state) {
  const coll = JSON.stringify(`${state.spaceId}_edges`);
  const missing = mongo(state, `print(JSON.stringify(db.getCollection(${coll}).countDocuments({matchedText:{$exists:false}})))`);
  if (missing !== 0) throw new Error(`${missing} edges hold no embedded text: the arm would measure a partial index`);
  const probes = mongo(state, `print(JSON.stringify(db.getCollection(${coll}).aggregate([{$sample:{size:5}},{$project:{matchedText:1}}]).toArray()))`);
  for (let i = 0; i < 40; i++) {
    let found = 0;
    for (const p of probes) if (rankOf(await recallIds(state, p.matchedText), p._id) !== null) found++;
    if (found === probes.length) return;
    await sleep(15_000);
  }
  throw new Error('the index does not answer an edge\'s own text with that edge');
}

async function runArm(state, out, arm, seeds, queries) {
  const queue = await drain(state, `arm ${arm}`);
  await probeIndex(state);
  const { edges, names } = readGraph(state);
  const labels = Object.keys(TEMPLATES).filter(l => edges.some(e => e.label === l));
  const perLabel = Math.ceil(queries / labels.length);
  const perSeed = [];
  for (const seed of seeds) {
    const qs = generateQueries({ edges, names, templates: Object.fromEntries(labels.map(l => [l, TEMPLATES[l]])), seed, perLabel });
    const querySha256 = sha256(JSON.stringify(qs));
    if (arm === 'B') {
      const a = JSON.parse(readFileSync(join(out, 'arm-A.json'), 'utf8')).perSeed.find(s => s.seed === seed);
      if (!a || a.querySha256 !== querySha256) throw new Error(`seed ${seed}: arm B would not ask the queries arm A asked`);
    }
    const ranks = [];
    const rows = [];
    for (const q of qs) {
      const ids = await recallIds(state, q.text);
      const rank = rankOf(ids, q.target);
      ranks.push(rank);
      rows.push({ ...q, rank });
    }
    const s = { seed, queries: qs.length, querySha256, recallAt10: recallAt(ranks, TOP_K), mrrAt10: meanReciprocalRank(ranks, TOP_K) };
    perSeed.push(s);
    writeFileSync(join(out, `arm-${arm}-seed-${seed}-queries.json`), `${JSON.stringify(rows, null, 1)}\n`);
    console.log(`arm ${arm} seed ${seed}: ${qs.length} queries, recall@10 ${s.recallAt10.toFixed(4)}, MRR@10 ${s.mrrAt10.toFixed(4)}`);
  }
  const record = { arm, model: await embeddingModel(state), labels, perLabel, embedQueue: queue, perSeed, end: 'END-OF-RECORD' };
  writeFileSync(join(out, `arm-${arm}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

async function embeddingModel(state) {
  const sample = mongo(state, `print(JSON.stringify(db.getCollection(${JSON.stringify(`${state.spaceId}_edges`)}).distinct('embeddingModel')))`);
  return sample;
}

async function applyMeaning(state, out, work, size) {
  const space = await api(state, 'GET', `/api/spaces/${state.spaceId}/meta`);
  const meta = space.meta ?? space;
  const comments = commentsInVariant(work, size);
  const { edges, names } = readGraph(state);
  const labels = [...new Set(edges.map(e => e.label))].sort();
  const meanings = Object.fromEntries(labels.map(l => [l, labelMeaning(meta, l, comments)]));
  for (const e of edges) {
    if (e.extra !== 0) throw new Error(`edge ${e.id} has tags, a type or properties: arm A's text would not end at its description`);
    descriptionFor(e, meanings[e.label]);
  }
  // Arm A's text of an edge with no tags, type, description or properties is `from label to` (edgeEmbedText), rebuilt here
  // from the names, so the check after the reembed does not lean on a text read before it (a rerun finds arm B's there).
  const sample = edges.filter((_, i) => i % 997 === 0);
  for (const label of labels) {
    if (!meanings[label]) continue;
    mongo(state, `print(JSON.stringify(db.getCollection(${JSON.stringify(`${state.spaceId}_edges`)}).updateMany({label:${JSON.stringify(label)}},{$set:{description:${JSON.stringify(meanings[label])}}}).modifiedCount))`);
  }
  // A reembed call queues at most 50 000 records and walks from the start, so it is called again after each drain until
  // nothing is owed.
  for (;;) {
    const r = await api(state, 'POST', `/api/spaces/${state.spaceId}/reembed`, { kinds: ['edge'], limit: 50_000 });
    console.log(`reembed: ${r.enqueued} queued, ${r.remaining} remaining`);
    if (r.enqueued === 0 && r.remaining === 0) break;
    await drain(state, 'meaning');
  }
  const after = new Map(mongo(state, `print(JSON.stringify(db.getCollection(${JSON.stringify(`${state.spaceId}_edges`)}).find({_id:{$in:${JSON.stringify(sample.map(e => e.id))}}},{matchedText:1}).toArray().map(e=>[e._id,e.matchedText])))`));
  let checked = 0;
  for (const e of sample) {
    const id = e.id;
    const expected = armBText(`${names.get(e.from)} ${e.label} ${names.get(e.to)}`, meanings[e.label]);
    if (after.get(id) !== expected) throw new Error(`edge ${id}: stored text "${after.get(id)}" is not arm B's "${expected}"`);
    checked++;
  }
  writeFileSync(join(out, 'meaning.json'), `${JSON.stringify({ meanings, source: 'meta.typeSchemas.edge[label].description, else the variant\'s rdfs:comment on the label iri', checkedTexts: checked, names: names.size }, null, 2)}\n`);
  console.log(`meanings applied to ${edges.length} edges; ${checked} stored texts are arm A's plus the meaning`);
}

function report(out) {
  const a = JSON.parse(readFileSync(join(out, 'arm-A.json'), 'utf8'));
  const b = JSON.parse(readFileSync(join(out, 'arm-B.json'), 'utf8'));
  const mean = (r, key) => r.perSeed.reduce((s, x) => s + x[key], 0) / r.perSeed.length;
  const means = { A: { recall: mean(a, 'recallAt10'), mrr: mean(a, 'mrrAt10') }, B: { recall: mean(b, 'recallAt10'), mrr: mean(b, 'mrrAt10') } };
  const v = verdict(means.A, means.B);
  const lines = ['| arm | seed | queries | recall@10 | MRR@10 |', '|---|---|---|---|---|'];
  for (const r of [a, b]) {
    for (const s of r.perSeed) lines.push(`| ${r.arm} | ${s.seed} | ${s.queries} | ${s.recallAt10.toFixed(4)} | ${s.mrrAt10.toFixed(4)} |`);
    lines.push(`| ${r.arm} | mean | | ${means[r.arm].recall.toFixed(4)} | ${means[r.arm].mrr.toFixed(4)} |`);
  }
  lines.push('', `model: ${JSON.stringify(a.model)}; recall@10 gain ${v.recallGainPoints.toFixed(2)} points, MRR change ${v.mrrChange.toFixed(4)}: the flag ${v.ships ? 'ships' : 'does not ship'} (margin ${MARGIN_POINTS} points, MRR not below)`);
  const text = lines.join('\n');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(out, `results-${stamp}.json`);
  if (existsSync(file)) throw new Error(`${file} exists`);
  writeFileSync(file, `${JSON.stringify({ question: 'Q-763', topK: TOP_K, marginPoints: MARGIN_POINTS, armA: a, armB: b, means, verdict: v, end: 'END-OF-RECORD' }, null, 2)}\n`);
  console.log(text);
  console.log(`\nresults: ${file}`);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const work = workDir(flags);
  const size = Number(flags.size ?? 1000);
  const out = join(work, 'embed-meaning');
  mkdirSync(out, { recursive: true });
  const seeds = String(flags.seeds ?? '1,2,3').split(',').map(Number);
  const queries = Number(flags.queries ?? 200);
  const cmd = positional[0];
  if (cmd === 'report') return report(out);
  const state = loadState(work, size);
  if (cmd === 'prepare') return prepare(state, out);
  if (cmd === 'arm') {
    const arm = String(flags.arm);
    if (arm !== 'A' && arm !== 'B') throw new Error('--arm A or --arm B');
    return runArm(state, out, arm, seeds, queries);
  }
  if (cmd === 'meaning') return applyMeaning(state, out, work, size);
  throw new Error('prepare, arm, meaning or report');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err.stack ?? err.message); process.exit(1); });
}
