/**
 * "Was this row written here?" is asked through ONE predicate, `sync/written-here.ts` (bundle-81, design rev 8 §6d, decisions 3 and 36).
 *
 * ## The finding this holds
 *
 * The question was spelled at twelve sites as `'author.instanceId': <something>`, each correct for the rows its author had in
 * mind and each about to be wrong in a different way: a peer's `author` is the sender's text (`upsert-plan.ts`), so a spelling
 * that asks the author alone lets a peer push rows naming the receiver as author and have them re-pushed as the receiver's own
 * (security S2). The predicate asks `deliveredBy` first. A site that spells the question itself is the weaker copy, and the
 * weaker copy wins silently.
 *
 * ## What counts as the question
 *
 * Read out of the source with comments blanked (a docblock says these words all the time):
 *   - the key `'author.instanceId':` in an object (a filter, a projection, a stamp);
 *   - the author-less clause `author: { $exists: false }` (the other half of the question: "no author, so nobody else's");
 *   - a comparison of `author.instanceId` / `author?.instanceId` with this instance's id, however spelled.
 *
 * ## Derived, with a floor
 *
 * The sites are every hit in every tracked file of `server/src`. The module and the named exemptions are the only places a hit
 * may stand; each exemption is a (file, line-shape) the gate reads again, so one that stops matching anything fails as stale.
 * The plan's "floor 10" counts the twelve hits at 9a7ab3f7; after the change the hits are the module's and the exemptions', so
 * the floor here is on what the gate has CLASSIFIED (module plus exemptions), and a gate that classifies fewer than the named
 * exemptions has stopped reading the source.
 *
 * ## Decision 36
 *
 * The module's author-less clause is `author: { $exists: false }`. The dotted spelling `'author.instanceId': { $exists: false }`
 * (or `: null`) also admits `author: null` and `author: {}`, which a malformed arrival can store.
 *
 * ## Seen red
 *
 * Red on 9a7ab3f7: the module does not exist, and seven sites outside it spell the question (`brain/link-adjacency.ts:422`,
 * `files/derived-fields.ts:578`, `files/file-stamp-report.ts:501/:517`, `sync/peer-sidecar-retirement.ts:63`,
 * `sync/space-exchange.ts:299`). Mutation for the newly covered part: write `{ author: { $exists: false } }` into any file
 * but the module (`link-adjacency.ts:422` is the plan's) and the case names it.
 *
 * Run: node --test testing/standalone/every-written-here-question-goes-through-one-predicate.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const MODULE = 'server/src/sync/written-here.ts';

/** The three shapes of the question. `name` says which, for the message. */
const SHAPES = [
  { name: "the key 'author.instanceId':", re: /['"]author\.instanceId['"]\s*:/g },
  { name: 'the author-less clause author: { $exists: false }', re: /\bauthor\s*:\s*\{\s*\$exists\s*:\s*false\s*\}/g },
  { name: "a comparison of an author's instanceId with this instance's id",
    re: /\bauthor\??\.instanceId\s*[!=]==?\s*(?:self\b|selfId\b|cfg\.instanceId\b|getConfig\(\)\.instanceId\b|authorRef\(\)\.instanceId\b)/g },
];

/**
 * Sites that ask ANOTHER question with the same spelling. Each is a file and a fragment of the line, read again so an
 * exemption that no longer matches fails as stale. Reasons are the plan's (§6d, "named exemptions").
 */
const EXEMPT = [
  ['server/src/sync/deletion-authority.ts', "'author.instanceId': { $in:", "D-14's question: whose deletion governs"],
  ['server/src/sync/deletion-authority.ts', "'author.instanceId': { $ne: p.selfId }", "D-14's question: whose deletion governs"],
  ['server/src/sync/delivered-by-backfill.ts', "'author.instanceId': author", 'stamps who delivered, by author, once'],
  ['server/src/sync/arrivals.ts', "'author.instanceId': d.author?.instanceId", "reads a peer's author to compare copies"],
  ['server/src/sync/tombstone-apply.ts', "'author.instanceId': 1", 'a projection, not a comparison'],
  ['server/src/sync/fill-file-meta.ts', "'author.instanceId':", '`receiverMade`: a placeholder this receiver made'],
  ['server/src/sync/fill-file-meta.ts', 'author: { $exists: false }', '`receiverMade`, its author-less half'],
];

const sources = trackedSources('server/src', { floor: 200 });
const codeOf = (file) => blankComments(readFileSync(join(REPO_ROOT, file), 'utf8'));

/** Every hit of every shape in `text`, as `{ shape, line, text }`. */
function questionsIn(text) {
  const out = [];
  for (const { name, re } of SHAPES) {
    for (const m of text.matchAll(new RegExp(re.source, 'g'))) {
      const line = text.slice(0, m.index).split('\n').length;
      out.push({ shape: name, line, text: text.split('\n')[line - 1].trim() });
    }
  }
  return out;
}

describe('the detector finds the three shapes of the question and nothing a comment says', () => {
  const flagged = {
    'the dotted key': "const f = { 'author.instanceId': self };",
    'the author-less clause': 'const f = { $or: [{ author: { $exists: false } }, x] };',
    'a comparison with the configured id': 'const same = doc.author?.instanceId === cfg.instanceId;',
    'a comparison with the author reference': 'if (a.author.instanceId !== authorRef().instanceId) return;',
  };
  for (const [name, src] of Object.entries(flagged)) {
    it(`flags ${name}`, () => assert.equal(questionsIn(blankComments(src)).length, 1, src));
  }
  it('does not flag a comment, or an author compared with a peer', () => {
    assert.deepEqual(questionsIn(blankComments("// { 'author.instanceId': self } and author: { $exists: false }\nconst x = 1;")), []);
    assert.deepEqual(questionsIn(blankComments('const same = a.author?.instanceId === b.author?.instanceId;')), []);
  });
});

describe('"written here" is asked through sync/written-here.ts', () => {
  it('the module exists and exports the filter and the row predicate', () => {
    assert.ok(existsSync(join(REPO_ROOT, MODULE)),
      `${MODULE} does not exist: "written here" is still spelled at each site, and a peer's author text decides it`);
    const code = codeOf(MODULE);
    assert.match(code, /export\s+(?:function|const)\s+writtenHereFilter\b/, 'the module exports no writtenHereFilter');
    assert.match(code, /export\s+(?:function|const)\s+isWrittenHere\b/, 'the module exports no isWrittenHere');
  });

  it('the module asks delivery first, and spells the author-less clause as author: { $exists: false } (decision 36)', () => {
    assert.ok(existsSync(join(REPO_ROOT, MODULE)), `${MODULE} does not exist`);
    const code = codeOf(MODULE);
    assert.match(code, /\bnotDeliveredByAPeer\b/, 'the predicate does not ask `notDeliveredByAPeer` (decision 3: delivery first)');
    assert.match(code, /\bauthor\s*:\s*\{\s*\$exists\s*:\s*false\s*\}/,
      'the author-less clause is not spelled `author: { $exists: false }`');
    assert.doesNotMatch(code, /['"]author\.instanceId['"]\s*:\s*(?:null\b|\{\s*\$exists\s*:\s*false)/,
      "the dotted spelling 'author.instanceId': null / { $exists: false } also admits `author: null` and `author: {}` (decision 36)");
    assert.doesNotMatch(code, /\bcfg\.instanceId\b/,
      'self is spelled once, as `authorRef().instanceId` read inside the module, never `cfg.instanceId`');
  });

  it('every site that spells the question is the module or a named exemption, and each exemption still matches', () => {
    const found = [];
    for (const file of sources) found.push(...questionsIn(codeOf(file)).map(q => ({ file, ...q })));
    const classified = [];
    const offending = [];
    for (const f of found) {
      if (f.file === MODULE) { classified.push(f); continue; }
      const ex = EXEMPT.find(([file, frag]) => file === f.file && f.text.includes(frag));
      if (ex) classified.push(f); else offending.push(`${f.file}:${f.line} ${f.shape}: ${f.text}`);
    }
    const stale = EXEMPT.filter(([file, frag]) => !found.some(f => f.file === file && f.text.includes(frag)))
      .map(([file, frag]) => `${file}: ${frag}`);
    assert.deepEqual(stale, [], 'these exemptions no longer match a line: the gate is reading something that is not there, or the exemption outlived its site');
    assert.ok(classified.length >= EXEMPT.length, `only ${classified.length} site(s) classified; the derivation is broken`);
    assert.deepEqual(offending, [],
      'a "written here" question spelled outside sync/written-here.ts: ask `writtenHereFilter` / `isWrittenHere`, which ask delivery first '
      + '(a peer\'s author is the sender\'s text)\n  ' + offending.join('\n  '));
  });
});
