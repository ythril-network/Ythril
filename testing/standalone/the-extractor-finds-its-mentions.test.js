/**
 * Phase 4.1 of the conversation extractor: candidate mentions (`F-31`, DECOMPOSITION.md 4.1).
 *
 * The spans come from the NLP sidecar (spaCy, `sidecars/doc-nlp`); the server adds only whose *"my"* is. The
 * first two blocks run everywhere against a stand-in sidecar. The third measures RECALL against the ten
 * committed LoCoMo extractions with the real sidecar — the benchmark as a test input, never a shape in the
 * code — because 4.12 can only accept what was proposed.
 *
 * ## A skip has to be loud
 *
 * The transcripts are not in CI and the sidecar is not in the CI stack, so the recall gate runs where both exist and says
 * so where they do not.
 *
 * Run: node --test testing/standalone/the-extractor-finds-its-mentions.test.js
 * (requires a prior `npm run build` in server/; the recall gate needs the `doc-nlp` sidecar running)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { loadConversations } from '../../benchmarks/locomo/loader.mjs';

let findMentions, spansOf, isNlpAvailable, NlpUnavailableError, splitCaptions;
before(async () => {
  ({ findMentions } = await import('../../server/dist/extractor/conversation/mentions.js'));
  ({ spansOf, isNlpAvailable, NlpUnavailableError } = await import('../../server/dist/extractor/conversation/nlp-client.js'));
  ({ splitCaptions } = await import('../../server/dist/extractor/conversation/classify.js'));
});

/** A stand-in sidecar: every occurrence of each listed phrase is a span. */
const fake = (phrases) => async (texts) => texts.map(t => phrases.flatMap(p => {
  const at = t.indexOf(p);
  return at < 0 ? [] : [{ text: p, start: at, end: at + p.length, kind: 'phrase' }];
}));

describe('whose it is — the one thing the conversation knows and the library does not', () => {
  it('"my" is the speaker\'s', async () => {
    const m = await findMentions([[{ id: 't1', speaker: 'Ada', speech: 'We stayed at my mom\'s place.' }]], fake(["my mom"]));
    assert.deepEqual(m.get('t1').map(x => x.name), ["Ada's mom"]);
  });

  it('"your" is the other speaker only when there is exactly one', async () => {
    const two = await findMentions([[{ id: 't1', speaker: 'Ada', speech: 'How is your sister?' },
      { id: 't2', speaker: 'Bo', speech: 'fine' }]], fake(['your sister']));
    assert.equal(two.get('t1')[0].name, "Bo's sister");
    const three = await findMentions([[{ id: 't1', speaker: 'Ada', speech: 'How is your sister?' },
      { id: 't2', speaker: 'Bo', speech: 'fine' }, { id: 't3', speaker: 'Cy', speech: 'hi' }]], fake(['your sister']));
    assert.equal(three.get('t1')[0].name, 'your sister', 'unresolved, kept as said');
  });

  it('a phrase\'s head noun is proposed too, and nothing twice', async () => {
    const m = await findMentions([[{ id: 't1', speaker: 'Ada', speech: 'I saw a local church, a local church!' }]],
      async () => [[{ text: 'a local church', start: 6, end: 20, kind: 'phrase', head: { start: 14, end: 20 } },
        { text: 'a local church', start: 22, end: 36, kind: 'phrase', head: { start: 30, end: 36 } }]]);
    assert.deepEqual(m.get('t1').map(x => [x.name, x.kind]), [['a local church', 'phrase'], ['church', 'head']]);
  });

  it('spans are matched to their turns across sessions, in order', async () => {
    const m = await findMentions([[{ id: 'a', speaker: 'Ada', speech: 'Luna' }], [{ id: 'b', speaker: 'Ada', speech: 'Oscar' }]],
      fake(['Luna', 'Oscar']));
    assert.deepEqual([m.get('a')[0].name, m.get('b')[0].name], ['Luna', 'Oscar']);
  });
});

describe('the sidecar client', () => {
  const ok = (calls) => async (_url, body) => {
    const { texts } = JSON.parse(body);
    calls.push(texts.length);
    return new Response(JSON.stringify({ model: 'm', results: texts.map(() => ({ spans: [] })) }));
  };

  it('splits a long conversation into requests the sidecar accepts', async () => {
    const calls = [];
    const r = await spansOf(Array.from({ length: 300 }, () => 'hello'), ok(calls));
    assert.equal(r.length, 300);
    assert.ok(calls.every(n => n <= 128), JSON.stringify(calls));
    const big = [];
    await spansOf(Array.from({ length: 5 }, () => 'x'.repeat(40_000)), ok(big));
    assert.ok(big.length >= 2, 'a batch never exceeds the character cap');
  });

  it('unreachable, refused or short is an error that says how to start it — never an empty answer', async () => {
    const named = (e) => e instanceof NlpUnavailableError && /DOC_NLP_REPLICAS/.test(e.message) && /NLP_SIDECAR_URL/.test(e.message);
    await assert.rejects(spansOf(['a'], async () => { throw new Error('ECONNREFUSED'); }), named);
    await assert.rejects(spansOf(['a'], async () => new Response('no', { status: 503 })), named);
    await assert.rejects(spansOf(['a', 'b'], async () => new Response(JSON.stringify({ results: [{ spans: [] }] }))), named);
  });
});

describe('recall against the committed extractions, with the real sidecar', () => {
  it('proposes at least 92% of the entities whose name the conversation actually says', async () => {
    const EX = 'benchmarks/locomo/extractions';
    const files = existsSync(EX) ? readdirSync(EX).filter(f => f.endsWith('.json')) : [];
    assert.ok(files.length >= 2, `only ${files.length} extractions found — the sweep would be vacuous`);
    const path = JSON.parse(readFileSync('benchmarks/locomo/pin.json', 'utf8')).datasets.locomo.cachePath;
    if (!existsSync(path) || !(await isNlpAvailable())) {
      console.log(`SKIPPED: ${!existsSync(path) ? `${path} is not fetched` : 'the NLP sidecar is not running'}. `
        + `Mention recall over the ${files.length} committed extractions was NOT measured. Local only.`);
      return;
    }
    const byId = new Map(loadConversations(path).map(c => [c.id, c]));
    const norm = s => s.toLowerCase().replace(/’/g, "'").replace(/^(the|a|an)\s+/, '').replace(/[.,!?;:"]+$/, '').replace(/\s+/g, ' ').trim();
    let reachable = 0, found = 0;
    const missed = [];
    for (const f of files) {
      const x = JSON.parse(readFileSync(`${EX}/${f}`, 'utf8'));
      const conv = byId.get(x.conversationId);
      assert.ok(conv, `${f} names a conversation the corpus does not have`);
      const sessions = conv.sessions.map(s => s.turns.map(t => ({ id: t.id, speaker: t.speaker, speech: splitCaptions(t.text).speech })));
      const text = sessions.flat().map(t => t.speech).join(' ').toLowerCase().replace(/’/g, "'");
      const proposed = new Set([...(await findMentions(sessions)).values()].flat().map(m => norm(m.name)));
      for (const e of x.entities) {
        const n = norm(e.name);
        const owned = n.match(/^[a-z]+'s (.+)$/);
        // Reachable: the conversation says the name, or says "my <it>" for a possessed one. A name the
        // extraction composed ("the tech company John hoped to join") is out of reach for any finder.
        if (!text.includes(n) && !(owned && text.includes(`my ${owned[1]}`))) continue;
        reachable++;
        if ([e.name, ...(e.aliases ?? [])].some(a => proposed.has(norm(a)))) found++;
        else missed.push(`${x.conversationId}: ${e.name}`);
      }
    }
    assert.ok(reachable >= 200, `only ${reachable} reachable entities — the fixture set shrank, re-derive the floor`);
    const recall = found / reachable;
    console.log(`mention recall ${recall.toFixed(3)} over ${reachable} reachable entities (${found} proposed)`);
    assert.ok(recall >= 0.92, `mention recall ${recall.toFixed(3)} over ${reachable}; missed e.g.\n  ${missed.slice(0, 20).join('\n  ')}`);
  });
});
