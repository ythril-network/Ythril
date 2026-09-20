#!/usr/bin/env node
/**
 * The four things `B-4` does, nine more times.
 *
 * ## Why this exists rather than a note saying how
 *
 * `conv-30` was extracted with four throwaway scripts — dump the conversation, merge the parts, validate,
 * write it to a space — each written at the keyboard and deleted afterwards. There are nine conversations
 * left and each is extracted in a fresh context by `B-4`'s own rule, so without this every one of them
 * begins by rewriting those four scripts slightly differently. The threshold for extracting a module is the
 * SECOND site; this is the second through the tenth.
 *
 * ## The part a rewritten copy would drop
 *
 * **Reading the conversation through the LOADER.** The raw release is right there and `JSON.parse` is one
 * line shorter, and it carries the questions, the answers and the evidence ids. `loadConversations` is the
 * only door that returns a conversation with none of that, which is what
 * `the-extractor-cannot-see-the-questions.test.js` enforces — and enforces on the loader, not on whoever
 * opens the file next. So `dump` goes through it, and nothing here imports `loadQuestions` or reads a
 * cache path directly.
 *
 * That is the whole reason this is a committed script rather than a paragraph in the row.
 *
 * ## Usage
 *
 *   node benchmarks/bench.mjs status
 *   node benchmarks/bench.mjs dump conv-49 [> somewhere.md]
 *   node benchmarks/bench.mjs check path/to/extraction.json
 *   node benchmarks/bench.mjs merge part1.json part2.json [> conv-49.json]
 *   node benchmarks/bench.mjs write benchmarks/locomo/extractions/conv-49.json <space-id>
 *
 * `write` needs `YTHRIL_URL` and `YTHRIL_TOKEN`. It is the only verb that talks to an instance.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';

import { loadConversations } from './locomo/loader.mjs';
import { validateExtraction } from './writer/validate-extraction.mjs';
import { mergeExtractionParts } from './writer/merge-extraction.mjs';
import { extractionMatchesConversation } from './writer/extraction-matches-conversation.mjs';
import { writeSpace, loadSpaceDefinition } from './writer/write-space.mjs';
import { makeYthril } from './writer/ythril-client.mjs';

const EXTRACTIONS = 'benchmarks/locomo/extractions';

const die = (msg) => { console.error(msg); process.exit(1); };

/** Every conversation, through the door that carries no question data. */
function conversations() {
  const pin = JSON.parse(readFileSync('benchmarks/locomo/pin.json', 'utf8'));
  const path = pin.datasets.locomo.cachePath;
  if (!existsSync(path)) {
    die(`the pinned corpus is not fetched (${path}).\nIt is pulled by URL and not vendored — see benchmarks/locomo/pin.json.`);
  }
  return loadConversations(path);
}

/** Which conversations still need extracting, read off the directory rather than a list. */
function status() {
  const done = new Set(existsSync(EXTRACTIONS)
    ? readdirSync(EXTRACTIONS).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''))
    : []);
  const all = conversations();
  console.log(`${done.size} of ${all.length} extracted\n`);
  for (const c of all) {
    const turns = c.sessions.reduce((n, s) => n + s.turns.length, 0);
    const mark = done.has(c.id) ? 'done   ' : 'TO DO  ';
    console.log(`  ${mark} ${c.id.padEnd(9)} ${String(c.sessions.length).padStart(2)} sessions, ${String(turns).padStart(4)} turns`);
  }
  /*
   * A paragraph naming conv-26 stood here until 2026-09-20, because its extraction had been written by hand
   * with the retrieval scores visible and nothing on disk said so. B-4 replaced it, so the paragraph expired
   * — and the gap it was covering did not. Nothing in a file, this directory or any gate distinguishes an
   * extraction produced unattended from one tuned against a scoreboard; what caught conv-26 was somebody
   * remembering. That is B-15, and it is a field the writer cannot omit rather than a note here.
   */
}

/** One conversation as readable text, for the model that is about to extract it. */
function dump(id) {
  const c = conversations().find(x => x.id === id);
  if (!c) die(`no conversation '${id}'. Try: node benchmarks/bench.mjs status`);
  const out = [`# ${c.id} — ${c.speakers.join(' and ')}`, ''];
  for (const s of c.sessions) {
    out.push(`## session ${s.index} — ${s.startsAt.slice(0, 10)}`, '');
    for (const t of s.turns) {
      out.push(`${t.id} ${t.speaker}: ${t.text}${t.imageCaption ? `  [image: ${t.imageCaption}]` : ''}`);
    }
    out.push('');
  }
  console.log(out.join('\n'));
}

/** Every problem at once, or silence. */
function check(path) {
  const extraction = JSON.parse(readFileSync(path, 'utf8'));
  const { entries } = loadSpaceDefinition();
  const problems = validateExtraction(extraction, entries);
  /*
   * Against the CORPUS, and this is the half the validator structurally cannot do: it reads the file alone,
   * so a file carrying another conversation's records is internally perfect to it. See
   * extraction-matches-conversation.mjs — the parts of one extraction are written into a scratch directory
   * that turned out to be shared between runs.
   */
  problems.push(...againstTheCorpus(extraction));
  if (problems.length === 0) {
    const turns = new Set((extraction.sessions ?? []).flatMap(s => s.turns ?? []));
    const covered = new Set((extraction.claims ?? []).flatMap(c => c.sourceTurns ?? []));
    const missing = [...turns].filter(t => !covered.has(t));
    console.log(`valid — ${extraction.claims?.length ?? 0} claims, ${extraction.entities?.length ?? 0} entities, `
      + `${extraction.chrono?.length ?? 0} chrono, ${extraction.edges?.length ?? 0} edges`);
    /*
     * Reported here as well as refused by the validator, because it is the number a person checks by eye
     * before committing. An extraction that drops the quiet turns covered 34.6% of a conversation and
     * scored worse than storing raw turns.
     */
    console.log(missing.length === 0
      ? `all ${turns.size} declared turns are named by a claim`
      : `WARNING: ${missing.length} of ${turns.size} turns are named by no claim: ${missing.slice(0, 10).join(', ')}`);
    return;
  }
  console.error(`${problems.length} problem(s):`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

/**
 * The corpus's verdict on this file, or a loud line saying there was none.
 *
 * A silent skip is the failure mode here: the corpus is pulled by URL and is absent on any machine that has
 * not fetched it, so a check that quietly dropped this test would report `valid` on a spliced file and look
 * exactly like one that had done the work.
 */
function againstTheCorpus(extraction) {
  const pin = JSON.parse(readFileSync('benchmarks/locomo/pin.json', 'utf8'));
  const path = pin.datasets.locomo.cachePath;
  if (!existsSync(path)) {
    console.error(`NOT CROSS-CHECKED against the corpus: ${path} is not fetched, so nothing here can tell `
      + 'whether these records belong to this conversation.');
    return [];
  }
  const conversation = loadConversations(path).find(c => c.id === extraction.conversationId);
  if (!conversation) {
    return [`the corpus has no conversation '${extraction.conversationId}'`];
  }
  return extractionMatchesConversation(extraction, conversation);
}

/** Join parts into one file, on stdout. Refuses an incomplete run — see merge-extraction.mjs. */
function merge(paths) {
  if (paths.length === 0) die('merge needs at least one part');
  console.log(JSON.stringify(mergeExtractionParts(paths.map(p => JSON.parse(readFileSync(p, 'utf8')))), null, 2));
}

/** Replay an extraction into a space. The only verb that talks to an instance. */
async function write(path, space) {
  if (!space) die('write needs a space id');
  const baseUrl = process.env.YTHRIL_URL;
  const token = process.env.YTHRIL_TOKEN;
  if (!baseUrl || !token) die('write needs YTHRIL_URL and YTHRIL_TOKEN in the environment');
  const extraction = JSON.parse(readFileSync(path, 'utf8'));
  const { records, sourceTurns } = await writeSpace({ extraction, ythril: makeYthril({ baseUrl, token }), space });
  console.log(`wrote ${records} records into ${space}; sourceTurns held for ${sourceTurns.size} of them, stored for none`);
}

const [verb, ...rest] = process.argv.slice(2);
switch (verb) {
  case 'status': status(); break;
  case 'dump': dump(rest[0]); break;
  case 'check': check(rest[0] ?? die('check needs a path')); break;
  case 'merge': merge(rest); break;
  case 'write': await write(rest[0] ?? die('write needs a path'), rest[1]); break;
  default:
    die(`usage: node benchmarks/bench.mjs <status|dump|check|merge|write>\n`
      + `  status                       which conversations still need extracting\n`
      + `  dump <id>                    one conversation as readable text, through the loader\n`
      + `  check <extraction.json>      every problem at once, or silence\n`
      + `  merge <part.json>...         join parts; refuses an incomplete run\n`
      + `  write <extraction.json> <space>   replay into an instance (YTHRIL_URL, YTHRIL_TOKEN)`);
}
