/**
 * `structuredContent` is the structured form of the SAME answer — never a sidecar of metadata about one.
 *
 * ## The rule, and the two tools that broke it
 *
 * The MCP spec's framing is that `structuredContent` is the structured form of the result. A client may
 * legitimately surface it in preference to `content`, and several do — Claude Code was observed doing exactly
 * that on 2026-08-15, four calls in a row, while a tool that returns no `structuredContent` rendered its whole
 * body in the same session.
 *
 * So a tool whose `structuredContent` holds only metadata hands that client **the worst shape a result can
 * have**: the answer is absent while the metadata says how much of it there was, so it reads as a successful
 * thin page rather than as a client that dropped the payload.
 *
 * `query` had it: `{count: 25, total: 32, limit, skip}` and not one row. Fixed — `results` now goes in both.
 *
 * **`help` had it too, and survived that fix because a COMMENT claimed the problem was unique.** Beside
 * `query`'s repair someone wrote *"It is also the only tool with that shape — every other structuredContent in
 * this layer carries its own payload."* True of the eight it described; false of the ninth. The canary operator
 * then reported the guide as unreachable, filed it as `help()` returning no section bodies (it never did —
 * 76,754 characters of them, measured), and two further items were raised downstream because the discovery
 * surface read as blind.
 *
 * **A comment cannot hold a universal claim. This file is that claim, enforced.**
 *
 * ## What it does NOT check, and it read as though it did until 2026-09-18
 *
 * This gate's subject is every `structuredContent: { … }` LITERAL. A return that carries no
 * `structuredContent` at all matches nothing here, so it is outside the sweep entirely — and that is the
 * strictly worse version of the same defect: metadata-only hands a client a thin page, absent hands it
 * `null`.
 *
 * Thirty-three returns across eleven tool files were in that state while this file was green, including
 * `graph_traverse` and every write tool that reports the id it just wrote. The title said *"every tool
 * that returns structuredContent"* and was literally true — it is the reading of it as *"every tool"*
 * that was wrong, which is this repo's most-repeated gate failure and is why the title now names the
 * narrowing out loud.
 *
 * The other half is `a-tool-answer-reaches-both-halves.test.js`. Neither is complete alone: this one
 * says *if you carry it, carry the answer*, that one says *carry it*.
 *
 * Run: node --test testing/standalone/mcp-structured-content-carries-its-payload.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trackedSources } from './_sources.mjs';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

/**
 * From git, not the filesystem — see `gitignored-files-break-local-checks`.
 *
 * The floor is 10 rather than the default 100: this is one directory, and a floor above what the scan can
 * ever return fails on correct code, which is how a guard gets deleted instead of corrected.
 */
const toolFiles = trackedSources('server/src/mcp/tools/*.ts', { floor: 10 });

/**
 * Keys that describe an answer rather than BEING one.
 *
 * A `structuredContent` built only from these is the defect. Anything else present means the payload — the
 * rows, the record, the outcome, the violations, the guide — is in there with them.
 */
const METADATA_ONLY_KEYS = new Set([
  'count', 'total', 'limit', 'skip', 'sort', 'dir',      // paging facts — `query`'s original defect
  'sections', 'matched', 'query',                        // an index — `help`'s
  'restOnly',                                            // a capability map ABOUT the instance
  'space', 'recordType', 'recordId', 'path', 'id',       // locators
]);

/**
 * Flatten `...(cond ? { a, b: c } : {})` into `a, b: c` so its keys are classified like any other.
 *
 * Without this, a conditional spread reads as an opaque payload and satisfies the check by itself — which is
 * exactly how the pre-fix `help` passed: `{restOnly, sections, ...(query ? {query, matched} : {})}` is metadata
 * top to bottom, and the spread was the only thing that looked like content. Verified by mutation: with this
 * in place, removing `guide` makes the sweep fire; without it, the sweep stayed green.
 */
function flattenSpreads(literal) {
  return literal.replace(/\.\.\.\([^?]*\?\s*\{/g, '').replace(/\}\s*:\s*\{\}\)/g, ',');
}

describe('a structuredContent that EXISTS holds the answer, not metadata about it', () => {
  it('sweeps a real set of tool files, so an empty sweep cannot pass', () => {
    assert.ok(toolFiles.length >= 8,
      `expected at least 8 tracked tool files, found ${toolFiles.length} — the scope is wrong and every `
      + 'assertion below is meaningless until it is fixed');
    assert.ok(toolFiles.some(f => f.endsWith('help.ts')), 'help.ts must be in scope — it is the one that broke');
    assert.ok(toolFiles.some(f => f.endsWith('search.ts')), 'search.ts must be in scope');
  });

  it('no structuredContent is built from metadata keys alone', () => {
    const offenders = [];
    for (const file of toolFiles) {
      const raw = readFileSync(file, 'utf8');
      const rawLines = raw.split(/\r?\n/);
      const trueLine = (text) => {
        const needle = text.trim();
        let at = rawLines.findIndex(l => l.trim() === needle);
        // Fall back to a substring hit: a stripped line can differ from the raw one by a trailing comment.
        if (at === -1) at = rawLines.findIndex(l => needle.length > 12 && l.includes(needle.slice(0, 40)));
        if (at === -1) at = rawLines.findIndex(l => l.includes('structuredContent:'));
        return at === -1 ? '?' : at + 1;
      };
      const src = stripComments(raw);
      // Each `structuredContent: { … }` literal, brace-matched so a nested object does not end it early.
      const re = /structuredContent:\s*\{/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        let depth = 1, i = m.index + m[0].length;
        for (; i < src.length && depth > 0; i++) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') depth--;
        }
        const literal = flattenSpreads(src.slice(m.index, i));
        // Top-level keys only: skip anything nested inside a deeper brace.
        const keys = [];
        let d = 0;
        for (const tok of literal.slice(literal.indexOf('{') + 1).split(/([{}])/)) {
          if (tok === '{') { d++; continue; }
          if (tok === '}') { d--; continue; }
          if (d !== 0) continue;
          /*
           * BOTH SPELLINGS: `name: value` AND the shorthand `name`.
           *
           * The first version of this matched `name:` only, and `{ result, recordType: a['recordType'] }` came
           * back as `{recordType}` — so a literal that DID carry its payload was reported as metadata-only.
           * A measurement that shares its subject's blind spot cannot find what the blind spot hides, and here
           * it manufactured three false findings instead.
           */
          // A KEY, never a value. `{ a, b: c }` has keys `a` and `b`; `c` is a value and must not count.
          // Allowing whitespace BEFORE the identifier was the bug: it let `guide: text,` yield `text`, and
          // `matched: matchedIds` yield `matchedIds` — a non-metadata name that satisfied the check by
          // itself, so the sweep stayed green on the very defect it was written for. The delimiter must be
          // `{` or `,` IMMEDIATELY before (whitespace after it is fine).
          for (const km of tok.matchAll(/(?:^|[,{])\s*([A-Za-z_][\w]*)\s*(?=[:,}]|$)/g)) keys.push(km[1]);
          // A spread is handled by FLATTENING it before this loop — see `flattenSpreads`. Treating it as an
          // opaque payload-bearing token was the first version's escape hatch, and it is what let the pre-fix
          // `help` pass the shape sweep: its only non-metadata "key" was the spread itself. Mutation-tested.
          if (/\.\.\.[A-Za-z_]/.test(tok)) keys.push('__object_spread__');   // `...someObject` — opaque, and rare
        }
        if (keys.length === 0) continue;                              // a cast or a variable, not a literal
        const payload = keys.filter(k => !METADATA_ONLY_KEYS.has(k));
        if (payload.length === 0) {
          const line = literal.split('\n')[0];
          offenders.push(`${file}:${trueLine(line)}  keys={${keys.join(', ')}} — metadata only`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      'these tools hand a structuredContent-preferring client metadata and no answer, which reads as a thin '
      + 'successful page rather than a dropped payload:\n  ' + offenders.join('\n  '));
  });

  it('help carries the guide, and carries the SAME string content does', () => {
    // Two renderings would be two implementations of the guide — the defect help.ts's own header warns about
    // for its searched-vs-full paths. So this asserts the identity, not merely the presence.
    const src = stripComments(readFileSync('server/src/mcp/tools/help.ts', 'utf8'));
    assert.match(src, /guide: text,/,
      'help must put the rendered guide in structuredContent, not just the index');
    assert.match(src, /content: \[\{ type: 'text' as const, text \}\],/,
      'and the same `text` must still be the prose, so adding the copy cannot break a client reading content');
  });

  it('the tool schema SAYS which fields carry the guide', () => {
    // The schema description is what a caller reads while constructing arguments. A caller who had been told
    // where the prose lives would not have concluded the guide was unreachable.
    const src = readFileSync('server/src/mcp/tools/help.ts', 'utf8');
    assert.match(src, /content\[0\]\.text` AND `structuredContent\.guide/,
      'the description must name both fields — this is the surface that failed to say so');
  });
});
