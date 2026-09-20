/**
 * An extraction is checked against the conversation it claims to describe, not only against itself.
 *
 * ## The failure this is for, and why nothing else can see it
 *
 * The validator reads the extraction alone: types declared, keys resolving, dates parsing, endpoints
 * matching. The merge refuses a run with a part missing. Between them they catch everything except the one
 * thing neither holds the evidence for — **records from a DIFFERENT conversation**.
 *
 * It is not hypothetical. The nine remaining extractions of `B-4` run in separate contexts, and the
 * scratchpad they write their parts into is shared: one agent's `entities.json` was overwritten by another
 * agent's, mid-run, on 2026-09-20. A spliced file is structurally perfect. Every type is declared, every key
 * resolves, every date parses, the writer writes it, and `check` reports full turn coverage — because the
 * foreign part brought its own `sessions` block, so the turns it declares are the turns its claims name.
 * The extraction is internally consistent and describes the wrong conversation.
 *
 * The only witness is the corpus, and a turn id is what carries the evidence: `D7:3` of one conversation is
 * simply absent from another.
 *
 * ## And this is why coverage is asserted BOTH ways
 *
 * `check`'s existing count — how many declared turns no claim names — measures the extraction against its
 * own `sessions` block. A part that declares only the sessions it covered scores 100% on it while missing
 * two thirds of the conversation. Against the corpus the question becomes the one worth asking: how many of
 * the conversation's REAL turns does this file account for.
 *
 * ## A skip has to be loud
 *
 * The corpus is fetched by URL and is never present in CI, so this cannot be a silent pass. The subject is
 * derived from the extractions directory with a floor under it, and an unfetched corpus reports itself
 * rather than producing an empty, green sweep.
 *
 * Run: node --test testing/standalone/an-extraction-describes-the-conversation-it-names.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { extractionMatchesConversation } from '../../benchmarks/writer/extraction-matches-conversation.mjs';
import { loadConversations } from '../../benchmarks/locomo/loader.mjs';

const EXTRACTIONS = 'benchmarks/locomo/extractions';

/** A conversation in the loader's shape, with turn ids that look like the corpus's. */
const conversation = (id, turns) => ({
  id,
  sessions: [{ index: 1, startsAt: '2023-01-20T09:00:00Z', turns: turns.map(t => ({ id: t, speaker: 'A', text: 'x' })) }],
});

describe('the records belong to this conversation', () => {
  it('passes a file whose turn ids are all real', () => {
    const problems = extractionMatchesConversation(
      { conversationId: 'conv-x', sessions: [{ turns: ['D1:1', 'D1:2'] }], claims: [{ sourceTurns: ['D1:1', 'D1:2'] }] },
      conversation('conv-x', ['D1:1', 'D1:2']));
    assert.deepEqual(problems, []);
  });

  it('CATCHES a turn id from another conversation', () => {
    // The spliced part. `D9:4` does not exist here, and nothing but the corpus knows that.
    const problems = extractionMatchesConversation(
      { conversationId: 'conv-x', sessions: [{ turns: ['D1:1', 'D9:4'] }], claims: [{ sourceTurns: ['D1:1', 'D9:4'] }] },
      conversation('conv-x', ['D1:1', 'D1:2']));
    assert.equal(problems.length >= 1, true);
    assert.match(problems.join('\n'), /D9:4/);
    assert.match(problems.join('\n'), /do not exist in conv-x/);
  });

  it('catches a foreign id cited by a claim even when the sessions block is honest', () => {
    // The half that hides: a part can declare the right sessions and still carry a claim whose provenance
    // came from somewhere else, which is what an overwritten working file produces.
    const problems = extractionMatchesConversation(
      { conversationId: 'conv-x', sessions: [{ turns: ['D1:1'] }], claims: [{ sourceTurns: ['D1:1'] }, { sourceTurns: ['D4:7'] }] },
      conversation('conv-x', ['D1:1']));
    assert.match(problems.join('\n'), /D4:7/);
  });

  it('reads sourceTurns on entities and chrono too, not only on claims', () => {
    // Those records may carry it, the validator has a rule about how much of a transcript they may name,
    // and a check that only walked `claims` would call a spliced entity clean.
    const problems = extractionMatchesConversation(
      { conversationId: 'conv-x', sessions: [{ turns: ['D1:1'] }],
        entities: [{ key: 'e', sourceTurns: ['D8:1'] }], chrono: [{ key: 'c', sourceTurns: ['D8:2'] }] },
      conversation('conv-x', ['D1:1']));
    assert.match(problems.join('\n'), /D8:1/);
    assert.match(problems.join('\n'), /D8:2/);
  });

  it('refuses a file whose conversationId is not the conversation it was checked against', () => {
    const problems = extractionMatchesConversation(
      { conversationId: 'conv-y', sessions: [{ turns: ['D1:1'] }] },
      conversation('conv-x', ['D1:1']));
    assert.match(problems.join('\n'), /conv-y.*conv-x|conv-x.*conv-y/);
  });
});

describe('coverage measured against the corpus, not against the file', () => {
  it('a file that declares only part of the conversation is UNDER-COVERED', () => {
    // Against its own sessions block this file is 100% covered, which is what `check` alone reports. The
    // number that means something is against the conversation.
    const problems = extractionMatchesConversation(
      { conversationId: 'conv-x', sessions: [{ turns: ['D1:1'] }], claims: [{ sourceTurns: ['D1:1'] }] },
      conversation('conv-x', ['D1:1', 'D1:2', 'D1:3']));
    assert.match(problems.join('\n'), /only 1 of 3 turns/);
    assert.match(problems.join('\n'), /D1:2, D1:3/);
  });

  it('and a fully covered file reports nothing', () => {
    const problems = extractionMatchesConversation(
      { conversationId: 'conv-x', sessions: [{ turns: ['D1:1', 'D1:2'] }], claims: [{ sourceTurns: ['D1:1'] }, { sourceTurns: ['D1:2'] }] },
      conversation('conv-x', ['D1:1', 'D1:2']));
    assert.deepEqual(problems, []);
  });

  it('refuses a conversation with no turns rather than calling the extraction complete', () => {
    // An empty right-hand side makes every assertion above vacuous: no id is foreign when none is real,
    // and coverage of nothing is total. It is the shape a failed load produces.
    assert.throws(() => extractionMatchesConversation({ conversationId: 'conv-x' }, conversation('conv-x', [])),
      /no turns/);
  });
});

describe('every committed extraction, against the real corpus', () => {
  it('each one describes the conversation it is named for', () => {
    const files = existsSync(EXTRACTIONS) ? readdirSync(EXTRACTIONS).filter(f => f.endsWith('.json')) : [];
    assert.ok(files.length >= 2, `only ${files.length} extractions found — the sweep below would be vacuous`);

    const pin = JSON.parse(readFileSync('benchmarks/locomo/pin.json', 'utf8'));
    const path = pin.datasets.locomo.cachePath;
    if (!existsSync(path)) {
      /*
       * Loud, not silent. The corpus is pulled by URL and is never present in CI, so this sweep has only
       * ever run on a developer machine — and a skip that prints nothing is indistinguishable from a pass.
       */
      console.log(`SKIPPED against the corpus: ${path} is not fetched. The ${files.length} committed `
        + 'extractions were NOT cross-checked. This sweep runs locally only.');
      return;
    }
    const byId = new Map(loadConversations(path).map(c => [c.id, c]));
    for (const file of files) {
      const id = file.replace(/\.json$/, '');
      const conv = byId.get(id);
      assert.ok(conv, `${file} names a conversation the corpus does not have`);
      const problems = extractionMatchesConversation(JSON.parse(readFileSync(`${EXTRACTIONS}/${file}`, 'utf8')), conv);
      assert.deepEqual(problems, [], `${file}:\n  ${problems.join('\n  ')}`);
    }
  });
});
