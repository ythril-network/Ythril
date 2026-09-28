/**
 * A tool's `inputSchema` description must not contradict `help()` about the same behaviour.
 *
 * ## What this is for
 *
 * The fleet integrator, 2026-08-13T1035Z §1: `recall`'s filter description said *"applied after vector search"*. It is not a
 * post-filter. They read that sentence, believed it, and **built a skill that deliberately avoided filtered recall** — on
 * the sound reasoning that a record which does not rank inside `topK` would never reach a post-filter, so an inbox built
 * on recall could silently miss a message.
 *
 * `help()` described the behaviour correctly at the same time. Two of our surfaces stated opposite semantics, and the one
 * that was wrong is the one a caller reads **while constructing arguments** — which `help()` itself calls the
 * authoritative machine-readable reference.
 *
 * Their sentence for why this outranked their feature asks: *"a stale sentence in a schema is invisible: nobody reports a
 * capability they were told they did not have."*
 *
 * ## What it can and cannot check
 *
 * It cannot judge prose. What it CAN do is refuse the specific contradictions we have been bitten by, as literal claims —
 * a small list, each entry naming the report that put it there. That is narrow on purpose: a gate that tried to diff two
 * pieces of documentation would produce noise, and noise is how a check gets deleted.
 *
 * Run: node --test testing/standalone/schema-descriptions-agree-with-help.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let ALL_TOOLS, helpSections;

const schemas = {
  requiredSpace: { type: 'string', description: 'Space ID to operate on.' },
  optionalSpace: { type: 'string', description: 'Optional space ID.' },
};

/** Every description string in a tool's schema, flattened. */
function descriptionsOf(tool) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.description === 'string') out.push(node.description);
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
  };
  walk(tool.inputSchema(schemas));
  return out;
}

before(async () => {
  ALL_TOOLS = (await import('../../server/dist/mcp/tools/index.js')).ALL_TOOLS;
  helpSections = (await import('../../server/dist/mcp/tools/help-sections.js')).helpSections;
});

describe('no tool schema repeats a claim we have already been corrected on', () => {
  /**
   * Each entry is a sentence a schema MUST NOT contain, with who reported it and why it was wrong. A banned phrase is
   * cheap to check and impossible to argue with, which is what makes it survivable.
   */
  const BANNED = [
    {
      phrase: 'applied after vector search',
      tool: 'recall',
      why: 'the fleet integrator 2026-08-13T1035Z: the filter is NOT a post-filter. `topK` is filled from records that satisfy the '
        + 'filter — either via a native index pre-filter or by scoring the whole space and filtering after — so nothing '
        + 'is dropped by `topK`. They avoided filtered recall entirely on the strength of this sentence.',
    },
    /*
     * Q-102, 2026-09-28. The recall key allowlist went on 2026-09-17 (`resolveRecallFilter` refuses no key; the
     * keys decide the PATH, not admission) and raw filters that are a flat conjunction of servable fields became
     * pushable the same day — but the schema, help() and the docs kept saying both. A caller told a key is
     * rejected never writes the filter they need; one told raw means slow avoids the recommended grammar.
     * `everywhere`: these are swept over help() and the docs too, not only the schemas.
     */
    {
      phrase: 'keys are allowlisted', tool: 'recall', everywhere: true,
      why: 'the key allowlist was removed on 2026-09-17 — any key is accepted and decides only whether the index can '
        + 'apply it. A schema still saying keys are allowlisted tells a caller not to write the filter they need.',
    },
    {
      phrase: 'key allowlist still applies', tool: 'recall', everywhere: true,
      why: 'the same removed allowlist, as the integration guide spelled it — see the entry above.',
    },
    {
      phrase: 'any other key is rejected', tool: 'recall', everywhere: true,
      why: 'no recall filter key is rejected since 2026-09-17; an unusual key costs a pass over the collection, it is '
        + 'not refused. Reported stale by the Q-102 audit.',
    },
    {
      phrase: 'filter keys must start with', tool: 'recall', everywhere: true,
      why: "help()'s spelling of the removed allowlist. The two surfaces must not disagree, and here both were wrong "
        + 'in the same direction.',
    },
    {
      phrase: 'a raw filter takes the exhaustive path', tool: 'recall', everywhere: true,
      why: 'false since 2026-09-17: a raw filter that is a flat conjunction of index-servable fields becomes a native '
        + 'pre-filter (`rawToNativeVectorFilter`). Believing it moves callers off the recommended grammar.',
    },
    {
      phrase: 'cannot become a native index pre-filter', tool: 'recall', everywhere: true,
      why: 'the second half of the sentence above, which survives an edit of the first half.',
    },
    {
      phrase: 'allowlisted keys with declared', tool: 'recall', everywhere: true,
      why: "CLAUDE.md's spelling of the removed allowlist, in the very section that says a description stating the "
        + 'mechanism rots — which it then did.',
    },
    {
      phrase: '`maxBytes` (default 25000', tool: 'recall',
      why: '`maxBytes` has NO default and is opt-in; the 25000 default on this door is `maxChars`. A caller reading '
        + 'this sets the wrong ceiling. Found by the Q-102 audit in the topK description.',
    },
  ];

  it('finds the tools (the check itself works)', () => {
    assert.ok(Array.isArray(ALL_TOOLS) && ALL_TOOLS.length > 20, `expected the tool registry, got ${ALL_TOOLS?.length}`);
    const recall = ALL_TOOLS.find(t => t.name === 'recall');
    assert.ok(recall, 'recall must exist for the entry below to mean anything');
    assert.ok(descriptionsOf(recall).length >= 5, 'expected several described parameters on recall');
  });

  it('no banned phrase appears in any tool schema', () => {
    const found = [];
    for (const entry of BANNED) {
      for (const tool of ALL_TOOLS) {
        for (const d of descriptionsOf(tool)) {
          if (d.toLowerCase().includes(entry.phrase.toLowerCase())) {
            found.push(`${tool.name}: "${entry.phrase}" — ${entry.why}`);
          }
        }
      }
    }
    assert.deepEqual(found, [],
      'A schema description repeats a claim that was reported wrong from the outside. A caller reads these while '
      + 'constructing arguments, so a stale sentence here is invisible — nobody reports a capability they were told they '
      + 'did not have.');
  });

  it('no phrase banned everywhere appears in help() or the docs', async () => {
    // The schema is one of three places a caller reads this; a sentence removed from it and left in help() or the
    // guide is the two-surfaces-disagree defect this file was written for, moved one door over.
    const { docFiles, DOCS_ROOT } = await import('./_docs.mjs');
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const ctx = { args: {}, readOnly: false, isAdmin: true, accessibleSpaces: [{ id: 'general', label: 'General' }] };
    const surfaces = [
      ...helpSections(ctx, [], 0).map(s => ({ where: `help() section '${s.id}'`, text: s.body })),
      ...docFiles().map(f => ({ where: `docs/${f}`, text: readFileSync(join(DOCS_ROOT, f), 'utf8') })),
      { where: 'CLAUDE.md', text: readFileSync(join(DOCS_ROOT, '..', 'CLAUDE.md'), 'utf8') },
    ];
    assert.ok(surfaces.length > 50, `only ${surfaces.length} surfaces read — the sweep is broken`);
    const found = [];
    for (const { phrase, why } of BANNED.filter(b => b.everywhere)) {
      for (const { where, text } of surfaces) {
        // Whitespace-normalised: help() wraps its prose, so a phrase can straddle a line break.
        if (text.replace(/\s+/g, ' ').toLowerCase().includes(phrase.toLowerCase())) found.push(`${where}: "${phrase}" — ${why}`);
      }
    }
    assert.deepEqual(found, [], 'a sentence corrected in the schema is still being read somewhere else');
  });

  it('every banned phrase names its tool, and that tool still exists', () => {
    // A stale entry pointing at a renamed tool would silently stop covering anything.
    for (const { phrase, tool, why } of BANNED) {
      assert.ok(ALL_TOOLS.some(t => t.name === tool), `${phrase} is pinned to '${tool}', which no longer exists`);
      assert.ok(why && why.length > 60, `${phrase}: the reason must survive without the conversation that produced it`);
    }
  });
});

describe('recall states the guarantee a caller needs, not just the mechanism', () => {
  const recallFilter = () => {
    const recall = ALL_TOOLS.find(t => t.name === 'recall');
    return recall.inputSchema(schemas).properties.filter.description;
  };

  it('says topK is filled from records that satisfy the filter', () => {
    // The load-bearing sentence. Whether the path is indexed or exhaustive is a performance detail; that nothing is
    // dropped by `topK` is the property their design decision hinged on.
    assert.match(recallFilter(), /topK/,
      'the description must say what happens to `topK`, which is the question a caller is actually asking');
    assert.match(recallFilter(), /satisf/i);
  });

  /*
   * THE PROMISE, NOT THE MECHANISM (Q-102). This block asserted that the description named both paths —
   * "pre-filter" and "exhaustive" — and it held while the sentence those words sat in was FALSE: "exhaustive"
   * scored only the nearest window, and the promise it was explaining was broken. A description that states the
   * mechanism has to be revisited every time the mechanism gains a case, and nobody does (CLAUDE.md, *A schema
   * description is the authoritative reference*). So what is asserted now is the promise, and the cost beside it.
   */
  const PROMISE = /every record that satisf[a-z]* the filter,? whatever its (vector )?rank/i;

  it('states the promise: topK is filled from every matching record, whatever its vector rank', () => {
    assert.match(recallFilter().replace(/\s+/g, ' '), PROMISE,
      'the filter description must state the guarantee a caller builds on — not only which path is fast');
    const recall = ALL_TOOLS.find(t => t.name === 'recall');
    assert.match(recall.inputSchema(schemas).properties.topK.description.replace(/\s+/g, ' '), PROMISE,
      'and so must topK\'s, which is where a caller asking "can a filtered topK miss one?" reads');
  });

  it('agrees with what help() tells the same caller', () => {
    const ctx = { args: {}, readOnly: false, isAdmin: true, accessibleSpaces: [{ id: 'general', label: 'General' }] };
    const retrieval = helpSections(ctx, [], 0).find(s => s.id === 'retrieval');
    assert.ok(retrieval, 'the retrieval guide section must exist');
    assert.match(retrieval.body.replace(/\s+/g, ' '), PROMISE, "help()'s retrieval guide must state the same promise");
    assert.match(recallFilter(), /declare/i,
      'and the schema should give the same advice help() does: declare a heavily-filtered property');
  });
});
