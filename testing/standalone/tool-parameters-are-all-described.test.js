/**
 * Every MCP tool parameter carries a description — including the nested ones.
 *
 * ## Why this is not documentation polish
 *
 * `help()` tells a caller that the tool schema IS the authoritative reference, and a caller constructing
 * arguments reads `tools/list`, not our docs. A parameter with no `description` is not "undocumented" — it
 * is a capability nobody can discover, because there is nothing to read.
 *
 * X-2's first half described every TOOL. This is the second half, and it was never measured: 26 parameters
 * across four tools had no description at all when this gate was written.
 *
 * ## The nesting is the whole point
 *
 * 8 of those 26 were at the top level. **18 were inside `save_bulk`'s per-item schemas** — `entities[].tags`,
 * `chrono[].status`, `edges[].weight` and the rest — which a top-level-only sweep reports as clean. That is
 * this repo's most common defect shape arriving in a measurement: the check and the thing it checks shared a
 * blind spot. So the walker descends into `properties` AND into `items`, and the test below proves it reaches
 * both rather than assuming it.
 *
 * ## The floor, and why it arrived second
 *
 * The first version of this gate checked PRESENCE only, and said so: `move_file.src` read "Source path." in
 * 12 characters, which meets a presence check and not the standard X-2 records. 52 parameters were that
 * thin. A floor was deliberately NOT added then — a threshold of 10 characters, set to accommodate the worst
 * case, blesses exactly what needs fixing, and an exemption list naming the 52 would have read as a plan.
 *
 * The sweep is done, so the floor is here with no exemptions: **40 characters**, which is roughly one
 * sentence. It is not a quality measure and cannot be — a 40-character sentence can still say nothing. What
 * it does is make the cheap failure impossible, so review can spend itself on whether the sentence is TRUE.
 *
 * Run: node --test testing/standalone/tool-parameters-are-all-described.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let ALL_TOOLS;
before(async () => {
  ({ ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js'));
});

// The REAL fragments the router injects (`router.ts:131-132`). A short stub here would make `space` look
// thin on 39 tools and bury the actual gaps — the first draft of this measurement did exactly that.
const SCHEMAS = {
  requiredSpace: { type: 'string', description: 'Space ID to operate on. Use list_spaces to discover available spaces.' },
  optionalSpace: { type: 'string', description: 'Optional space ID. Omit to search across all accessible spaces.' },
};

/** Every property in a JSON Schema, at every depth, as `path -> node`. */
function walkProperties(node, path = '', out = []) {
  if (!node || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node.properties ?? {})) {
    out.push([`${path}${key}`, value]);
    walkProperties(value, `${path}${key}.`, out);
    // Array items: `save_bulk` puts four whole record schemas here and nowhere else.
    if (value?.items && typeof value.items === 'object') walkProperties(value.items, `${path}${key}[].`, out);
  }
  return out;
}

const allParams = () => ALL_TOOLS.flatMap(t => walkProperties(t.inputSchema(SCHEMAS)).map(([p, v]) => [t.name, p, v]));

describe('the walker reaches where the gaps were', () => {
  it('descends into nested objects and into array items', () => {
    // Mutation-proof for the SCANNER. A walker that only reads the top level passes this whole suite while
    // 18 undescribed parameters sit one level down, which is how they survived X-2's first pass.
    const paths = walkProperties(ALL_TOOLS.find(t => t.name === 'save_bulk').inputSchema(SCHEMAS)).map(([p]) => p);
    assert.ok(paths.includes('chrono[].status'), 'array items must be walked');
    assert.ok(paths.includes('memories[].properties'), 'and every collection, not just the first');

    const chrono = walkProperties(ALL_TOOLS.find(t => t.name === 'update_chrono').inputSchema(SCHEMAS)).map(([p]) => p);
    assert.ok(chrono.includes('recurrence.freq'), 'nested objects must be walked');
  });

  it('walks a plausible number of parameters', () => {
    // A scanner that silently returned [] would pass every assertion below it.
    const n = allParams().length;
    assert.ok(n > 250, `only walked ${n} parameters across ${ALL_TOOLS.length} tools — the walker is broken`);
  });
});

describe('every parameter is described', () => {
  it('none is missing a description', () => {
    const missing = allParams()
      .filter(([, , v]) => typeof v?.description !== 'string' || v.description.trim().length === 0)
      .map(([tool, path]) => `${tool}: ${path}`);
    assert.deepEqual(missing, [],
      'a caller reads the schema while constructing arguments — these say nothing:\n  ' + missing.join('\n  '));
  });

  it('and none is under forty characters — about one sentence', () => {
    // NO EXEMPTION LIST, on purpose. `REST_ONLY_CAPABILITIES` is empty for the same reason: a row there
    // reads as a plan and behaves as a permanent carve-out. If a parameter genuinely cannot be described in
    // a sentence, that is a finding about the parameter.
    const FLOOR = 40;
    const thin = allParams()
      .filter(([, , v]) => typeof v?.description === 'string' && v.description.trim().length < FLOOR)
      .map(([tool, path, v]) => `${tool}: ${path} (${v.description.trim().length}) "${v.description.trim()}"`);
    assert.deepEqual(thin, [],
      `under ${FLOOR} characters is a type restated, not a description — say the TRAP:\n  ` + thin.join('\n  '));
  });

  it('and none merely restates its own name', () => {
    // `tags: { description: "Tags." }` is the shape that passes a presence check while telling a caller
    // nothing it could not read off the key. Compared with punctuation and case removed.
    const bare = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
    const echoes = allParams()
      .filter(([, path, v]) => typeof v?.description === 'string' && bare(v.description) === bare(path.split('.').pop().replace('[]', '')))
      .map(([tool, path]) => `${tool}: ${path}`);
    assert.deepEqual(echoes, [], 'these describe nothing beyond the key:\n  ' + echoes.join('\n  '));
  });
});

describe('the claims those descriptions make are still true', () => {
  /**
   * Several new sentences say a bound is enforced on `save_chrono`/`save_edge` and NOT on `save_bulk`.
   * That is true because of one line, and if the line goes the sentences become lies that read as facts —
   * which is the exact cost CLAUDE.md records for a stale schema description.
   */
  it('bulk_write really does skip per-item schema validation', () => {
    const bulk = ALL_TOOLS.find(t => t.name === 'save_bulk');
    assert.equal(bulk.skipSchemaValidation, true,
      'the item descriptions say the 0–1 bounds are not enforced here; remove this flag and they stop being true');
    for (const name of ['save_chrono', 'save_edge']) {
      assert.notEqual(ALL_TOOLS.find(t => t.name === name).skipSchemaValidation, true,
        `${name} is the door the bulk descriptions contrast with — it must still validate`);
    }
  });

  it('an unknown bulk chrono status is dropped, not reported', () => {
    // Source-read because exercising it needs Mongo. Comments stripped: the line above the normalisation
    // explains it, so a raw read matches its own explanation. This repo has a rule about that.
    //
    // Bounded by the STATEMENT — from `const status` to its own semicolon — and NOT by a character count.
    // It was `slice(at, at + 200)`, which passed here and failed in CI: this checkout is CRLF and CI's is
    // LF, so 200 characters covers a different number of LINES in each. The window reached the NEXT
    // statement's `errors.push` only on the machine with the shorter line endings. A count bounds distance;
    // what the assertion is about is one statement, and nothing in the diff shows the difference.
    const src = stripComments(readFileSync('server/src/brain/bulk.ts', 'utf8'));
    const start = src.indexOf('const status = ');
    assert.ok(start > 0, 'the status normalisation was not found — the scanner is wrong, not the code');
    const stmt = src.slice(start, src.indexOf(';', start) + 1);
    // `CHRONO_STATUS_SET` since the five status names became one tuple in `config/types.ts` — they were
    // written out FIVE times (here, the REST route, and three MCP schemas) and the sixth copy had two of
    // them wrong. The local Set derives from the tuple now; the rule this asserts is unchanged.
    assert.match(stmt, /CHRONO_STATUS_SET\.has/, 'and this is the statement that normalises it');
    assert.match(stmt, /:\s*undefined/,
      'an unrecognised status must fall back rather than throw — the description says so');
    assert.doesNotMatch(stmt, /errors\.push/,
      'and it must NOT be reported; if it starts being reported, `chrono[].status` stops being a silent drop');
    // The next statement DOES report, which is the contrast the description draws — and proves this window
    // really stops where it says it does rather than swallowing the neighbour.
    assert.match(src.slice(start, start + stmt.length + 200), /errors\.push/,
      'the ttlDays check right after it is reported; if it were not, the slice is not bounded where it claims');
  });

  it('nothing expands a recurrence rule into further entries', () => {
    // `recurrenceSchema` says the rule generates nothing. It is stored and validated only.
    const src = stripComments(readFileSync('server/src/brain/chrono.ts', 'utf8'));
    assert.doesNotMatch(src, /expandRecurrence|generateOccurrences/,
      'a generator would make "IT DESCRIBES THE ENTRY AND GENERATES NOTHING" false on both chrono tools');
  });

  it('the recurrence block is ONE schema, called twice', () => {
    // It was two near-identical literals differing by the word "Optional", and `freq` was undescribed in
    // both. Two copies of one schema is the shape this repo produces most.
    const src = stripComments(readFileSync('server/src/mcp/tools/chrono.ts', 'utf8'));
    assert.equal((src.match(/recurrenceSchema\(/g) ?? []).length, 2, 'both tools must call the helper');
    assert.doesNotMatch(src, /freq: \{ type: 'string', enum:/, 'and neither may keep its own copy');
  });
});
