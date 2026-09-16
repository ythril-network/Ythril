/**
 * The read surface says how to keep a read cheap, and what it never sends.
 *
 * ## X-7 — the owner could not find the parameter, and there was a reason
 *
 * Owner, 2026-08-16: *"i cant find the parameter to retieve entries without embeddings and vectorinfo — how
 * is it done and where is it documented?"*
 *
 * The answer had two halves and one of them was a lie in the authoritative reference:
 *
 * 1. **There is no parameter because there is nothing to switch off.** The embedding vector is never
 *    returned by anything, on any surface. `mergeEmbeddingExclusion` strips an explicit `embedding: 1` out
 *    of a caller's projection, so it cannot even be opted back in. Nowhere said so, and an absent statement
 *    is indistinguishable from an undiscovered feature.
 * 2. **`recall`'s own tool description listed `seq` and `matchedText` among the fields it returns, and it
 *    returns neither.** `toRecallRecord` is an allowlist and has never emitted them. So an agent reading the
 *    description believed it was paying for the pre-embedding source string — for a file chunk, the passage
 *    a second time — and went looking for the flag to turn it off. `16-mcp.md` said the opposite, correctly,
 *    in a blockquote partway down the page. Two surfaces describing one behaviour, and the one being read
 *    while constructing arguments was the wrong one.
 *
 * ## Gated on the RULE, not on a phrasing
 *
 * `mergeEmbeddingExclusion` is pure, so the vector rule is a real call rather than a grep — including the
 * case that matters, a caller asking for the vector back. The description assertions check that the
 * response list does not name a field the allowlist cannot produce, which is the defect above rather than a
 * sentence somebody liked. A gate that pins a sentence cements one; four were found doing that in one week
 * here, and two were pinning a sentence that was false.
 *
 * Run: node --test testing/standalone/reads-say-what-they-do-not-send.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let mergeEmbeddingExclusion, toRecallRecord, recallTool, queryTool;
before(async () => {
  ({ mergeEmbeddingExclusion } = await import('../../server/dist/brain/query.js'));
  ({ toRecallRecord } = await import('../../server/dist/mcp/tools/shared.js'));
  ({ recallTool, queryTool } = await import('../../server/dist/mcp/tools/search.js'));
});

describe('the vector cannot be asked for, which is why there is no parameter', () => {
  it('no projection at all still excludes it', () => {
    assert.deepEqual(mergeEmbeddingExclusion(), { embedding: 0 });
    assert.deepEqual(mergeEmbeddingExclusion({}), { embedding: 0 });
  });

  it('an exclusion projection gains it', () => {
    assert.equal(mergeEmbeddingExclusion({ description: 0 })['embedding'], 0);
  });

  it('and a caller who asks for it back does not get it', () => {
    // The whole claim rests on this one: "always excluded" is only true if an explicit request is stripped
    // rather than honoured. An inclusion projection excludes by omission, so the test is that `embedding`
    // is not among the keys — not that it is mapped to 0, which MongoDB would refuse to mix.
    const out = mergeEmbeddingExclusion({ _id: 1, tags: 1, embedding: 1 });
    assert.equal('embedding' in out, false, 'an explicit `embedding: 1` must be dropped, not honoured');
    assert.deepEqual(out, { _id: 1, tags: 1 });
  });
});

describe('recall describes the record it actually returns', () => {
  /** Every key `toRecallRecord` can emit, across all five knowledge types. */
  const emittable = () => {
    const base = {
      _id: 'x', createdAt: 'c', updatedAt: 'u', tags: [], description: 'd', properties: {},
      // Fields the allowlist must NOT pass through, offered on the input so a regression shows up as a key.
      seq: 7, matchedText: 'the passage again', embeddingModel: 'm', embedding: [0.1],
    };
    const rows = [
      { ...base, type: 'fact', fact: 'f', entityIds: [] },
      { ...base, type: 'entity', name: 'n', entityType: 't' },
      { ...base, type: 'edge', from: 'a', to: 'b', label: 'l', weight: 1, edgeType: 't' },
      { ...base, type: 'chrono', title: 't', chronoType: 'event', startsAt: 's', status: 'upcoming' },
      { ...base, type: 'file', path: 'p', chunkIndex: 0, headingText: 'h', content: 'body' },
    ];
    const keys = new Set();
    for (const r of rows) for (const k of Object.keys(toRecallRecord(r))) keys.add(k);
    return keys;
  };

  it('drops the four internal fields even when the result carries them', () => {
    const keys = emittable();
    for (const k of ['embedding', 'matchedText', 'embeddingModel', 'seq']) {
      assert.equal(keys.has(k), false,
        `toRecallRecord emitted \`${k}\` — the MCP door is documented as the slim one, and every field here `
        + 'is multiplied by topK and paid for in a calling model\'s context');
    }
  });

  it('the description does not promise a field the allowlist cannot produce', () => {
    // The exact defect: it listed `seq` and `matchedText` among what each result "carries". A caller reading
    // that budgets for them and hunts for the flag that turns them off — which is how X-7 was raised.
    const keys = emittable();
    const promised = /Each carries ([^\n]*)/.exec(recallTool.description);
    assert.ok(promised, 'the response description changed shape — this gate is measuring nothing');
    for (const k of ['seq', 'matchedText', 'embeddingModel']) {
      assert.equal(promised[1].includes('`' + k + '`'), false,
        `the recall description says a result carries \`${k}\` and toRecallRecord never emits it`);
      assert.equal(keys.has(k), false, 'sanity: and it really does not');
    }
  });

  it('and it says WHICH fields it withholds, so nobody looks for a flag', () => {
    const d = recallTool.description;
    for (const k of ['matchedText', 'embeddingModel', 'seq']) {
      assert.ok(d.includes(k), `the description must name \`${k}\` as withheld — an absent statement reads `
        + 'as an undiscovered feature, which is the whole of this entry');
    }
    assert.match(d, /includeContent/, 'and point at the one size lever the caller does hold');
  });
});

describe('field selection is findable from where somebody would look', () => {
  it('query leads with `projection` rather than burying it in one parameter', () => {
    assert.match(queryTool.description, /projection/,
      'the tool-level description is what a caller reads before opening the parameters');
  });

  it('and the help guide answers the question in the retrieval section', () => {
    // `help()` is the discovery surface — the tool an agent calls when it does not know what exists. The
    // answer to "how do I not fetch the internal fields" belongs there, not only inside the one tool that
    // happens to carry the lever.
    const src = readFileSync('server/src/mcp/tools/help-sections.ts', 'utf8');
    assert.match(src, /never returned/i, 'help() must state the vector rule');
    assert.match(src, /projection/, 'and name the lever that does exist');
    assert.match(src, /includeContent/, 'and the recall-side one');
  });

  it('the REST reference states the vector rule too', () => {
    // REST is the door that has NO field selection on its list routes, so a reader there needs the rule
    // even more than an MCP caller: what they cannot control, they should at least not be hunting for.
    // `04f-write-semantics.md` since A-5: the write-and-read rules moved off the memory page, because
    // they apply to every record type. Read from where the section IS — a gate left pointing at the old
    // page fails several assertions at once and reads as missing sentences rather than a moved file.
    const doc = readFileSync('docs/integration-guide/04f-write-semantics.md', 'utf8');
    assert.match(doc, /never returned|cannot be requested/i, 'the brain-API page must state it');
  });
});
