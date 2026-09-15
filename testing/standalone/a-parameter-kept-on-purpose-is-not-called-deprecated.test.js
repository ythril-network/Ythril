/**
 * A parameter whose schema says it is KEPT is not called deprecated by the code that implements it.
 *
 * ## The decision, and the two sentences that outlived it
 *
 * `crossSpace` on `similar` looked like a pure duplicate: omitting `space` on MCP says the same thing.
 * Removing it from the tool turned the MCP/REST parity gate's `find-similar ↔ find_similar` case RED,
 * because **the REST route takes the space in its PATH** — *"omit the space"* is not expressible there, so
 * `crossSpace: true` is REST's only route to that capability. Dropping it on one door alone is precisely the
 * parameter-level divergence that gate exists to catch.
 *
 * So the decision was recorded as KEEP, and the tool's schema description was corrected to say **"Not slated
 * for removal"** — because a caller who reads *deprecated* builds around an absence that will never arrive.
 *
 * **The correction reached the surface that had been reported and stopped there.** Two comments in the two
 * files that implement it still said otherwise, and one of them was worse than stale: *"deprecated here but
 * still ALLOWED … before we have removed it"* told the next reader that a removal was coming, which is a
 * change that must not happen. A stale sentence misinforms; that one gives an instruction.
 *
 * ## Why this is derived rather than a check on `crossSpace`
 *
 * `CLAUDE.md`: *assert the RULE, not the site* — a case naming one parameter does not survive a second
 * parameter being kept for the same reason next year, and the two read identically in a diff. So the subject
 * is **every** parameter whose own description claims permanence, found by reading the tool registry.
 *
 * The decisions record itself cannot be the source: `todo/` is gitignored, so a clean checkout cannot read
 * it. The schema description is the checked-in surface that carries the decision, which is what makes it the
 * right anchor as well as the convenient one.
 *
 * Run: node --test testing/standalone/a-parameter-kept-on-purpose-is-not-called-deprecated.test.js
 * (requires a prior `npm run build` in server/ so server/dist exists)
 */
import { describe, it, before } from 'node:test';
import { trackedSources } from './_sources.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** The phrase a description uses to claim permanence. Matched case-insensitively. */
const KEPT = 'not slated for removal';

/** Words that contradict it when they appear on the same line as the parameter's name. */
const CONTRADICTS = /\bdeprecat|\blegacy\b|before we have removed|will be removed|slated for removal/i;

const schemas = {
  requiredSpace: { type: 'string', description: 'Space ID to operate on.' },
  optionalSpace: { type: 'string', description: 'Optional space ID.' },
};

let ALL_TOOLS;

before(async () => {
  ALL_TOOLS = (await import('../../server/dist/mcp/tools/index.js')).ALL_TOOLS;
});

/** `[toolName, paramName]` for every schema property whose description claims permanence. */
function keptParameters() {
  const out = [];
  for (const tool of ALL_TOOLS) {
    const props = tool.inputSchema(schemas)?.properties ?? {};
    for (const [name, node] of Object.entries(props)) {
      const d = typeof node?.description === 'string' ? node.description : '';
      if (d.toLowerCase().includes(KEPT)) out.push([tool.name, name]);
    }
  }
  return out;
}

/** Every checked-in TypeScript source under `server/src`, via git so gitignored build output is excluded. */
function serverSources() {
  return trackedSources('server/src');
}

describe('a parameter kept on purpose is not called deprecated by its own implementation', () => {
  it('the tool registry is readable, and at least one parameter claims permanence', () => {
    /*
     * THE VACUITY GUARD, and it is doing two jobs. An unreadable registry would make `keptParameters()`
     * empty, and an empty list satisfies the sweep below over no parameters at all — the silent pass this
     * whole family of gates exists to end.
     *
     * The second job is subtler: if the phrase is ever reworded, this goes red rather than passing over
     * nothing. That is the correct failure — it says the anchor moved, not that the code is fine.
     */
    assert.ok(Array.isArray(ALL_TOOLS) && ALL_TOOLS.length > 20,
      `expected the tool registry, got ${ALL_TOOLS?.length}`);
    const kept = keptParameters();
    assert.ok(kept.length >= 1,
      `no schema description contains "${KEPT}" any more. Either the phrase was reworded — in which case `
      + 'update KEPT here — or a permanence decision was deleted from the surface that carried it.');
  });

  it('and no server source contradicts that claim on a line naming the parameter', () => {
    /*
     * Line-scoped rather than file-scoped on purpose. `api/brain/search.ts` legitimately discusses a legacy
     * allowlist elsewhere in the same file; what must not happen is the word landing on a line about THIS
     * parameter. A file-wide search would be noise, and noise is how a check gets deleted.
     *
     * Comments are NOT stripped — they are the subject. This is the one gate in this directory that reads
     * them deliberately.
     */
    const kept = keptParameters();
    const offenders = [];
    for (const file of serverSources()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // The DECLARING line is the source of truth, not an offender — and it trips the pattern on its own
        // wording, because "Not slated for removal" contains "slated for removal". Caught by this gate on
        // its first run, against itself, which is the shortest possible demonstration of why a check has to
        // be seen red before it is believed.
        if (line.toLowerCase().includes(KEPT)) return;
        for (const [tool, param] of kept) {
          if (!line.includes(param)) continue;
          if (!CONTRADICTS.test(line)) continue;
          // The correction itself has to be sayable. A line that quotes the old wording in order to retract
          // it is the opposite of the defect, and forbidding it would make the fix unwriteable.
          if (/\bnot deprecated\b|said|used to|no longer|kept|must not happen|removed from/i.test(line)) continue;
          offenders.push(`${file}:${i + 1} — '${param}' (${tool}) called deprecated: ${line.trim().slice(0, 110)}`);
        }
      });
    }
    assert.deepEqual(offenders, [],
      'A parameter whose schema description says it is NOT slated for removal is described as deprecated or '
      + 'legacy by the code that implements it. One of the two is wrong, and the schema is the one a caller '
      + 'reads while constructing arguments — so a comment saying "before we have removed it" is not merely '
      + 'stale, it points the next reader at a change that must not happen.');
  });
});
