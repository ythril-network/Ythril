/**
 * A space's directive has ONE maximum length, whichever transport writes it.
 *
 * ## What was wrong
 *
 * Six literals for one field, and two of them disagreed: REST accepted **4000** characters
 * (`SpaceMetaBody.purpose`, and `description` on both create and update), while the MCP `update_space` tool
 * refused anything over **2000**. So a purpose written through one transport could not be edited through the
 * other, and the API's two front doors advertised different rules for the same value.
 *
 * The sharp end is the migration: legacy `description` text was moved into `meta.purpose` under the 4000
 * bound, so an MCP client could be handed a purpose it was then forbidden to change — a validation error on
 * a field the caller never touched, which is the shape of failure the upsert fix in this same release was
 * about.
 *
 * Found while writing the release message to the deployment that reads these limits, not by a test.
 *
 * ## What this pins
 *
 * One exported constant, and nobody spelling their own. Enumerated from the source rather than asserted
 * per-site: a hand-listed set of call sites is what let two of six drift in the first place.
 *
 * Run: node --test testing/standalone/purpose-cap-one-limit.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { trackedSources } from './_sources.mjs';
import { readFileSync } from 'node:fs';

let SPACE_PURPOSE_MAX;

/** Files that could plausibly bound this field — enumerated from the repo, not listed here. */
const sources = trackedSources('server/src');

const strip = s => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('the directive cap', () => {
  before(async () => {
    ({ SPACE_PURPOSE_MAX } = await import('../../server/dist/spaces/_shared.js'));
  });

  it('is exported as one constant, at the value the writer actually stores', () => {
    // Unified UP: `updateSpace` truncates at this value, so a lower advertised limit would claim a bound
    // smaller than the data already in the database.
    assert.equal(SPACE_PURPOSE_MAX, 4000);
  });

  /**
   * Scoped on `purpose`, ANYWHERE in the tree — and on `description` only inside the two space surfaces.
   *
   * `purpose` names exactly one field in this system, so a numeric bound on a line mentioning it is always
   * this field, in any file, including one added later. `description` is a generic word: a schema-library
   * entry has its own (1000), a memory record's is 50000. Flagging those would be a gate demanding that
   * unrelated fields adopt a space's limit — which is how a gate ends up being worked around rather than
   * obeyed. The narrowing is a claim about the names, not a convenience: check it if either changes.
   */
  it('is what every bound on the directive refers to — no file spelling its own number', () => {
    const SPACE_SURFACES = ['server/src/api/spaces.ts', 'server/src/mcp/tools/spaces.ts'];
    const offenders = [];
    for (const file of sources) {
      const rel = file.split('\\').join('/');
      const isSpaceSurface = SPACE_SURFACES.includes(rel);
      strip(readFileSync(file, 'utf8')).split(/\r?\n/).forEach((line, i) => {
        const namesField = /\bpurpose\b/.test(line) || (isSpaceSurface && /\bdescription\b/.test(line));
        if (!namesField) return;
        // `usageNotes` and `label` have their own, deliberately different limits.
        if (/usageNotes|label/.test(line)) return;
        const bound = line.match(/(?:\.max\(|maxLength:\s*|length\s*>\s*)(\d[\d_]*)/);
        if (bound) offenders.push(`${rel}:${i + 1} bounds it at ${bound[1]} literally`);
      });
    }
    assert.deepEqual(offenders, [],
      'use SPACE_PURPOSE_MAX from spaces/_shared.ts:\n  ' + offenders.join('\n  '));
  });

  it('the MCP tool and the REST schema resolve to the SAME number', () => {
    // The disagreement itself, asserted rather than assumed away: both sides now read one identifier, so
    // this fails if either is given its own literal again.
    const mcp = strip(readFileSync('server/src/mcp/tools/spaces.ts', 'utf8'));
    // The REST body schema lives in spaces/body-schemas.ts. This read api/spaces.ts, and passed on an
    // import nothing used after the schema moved.
    const rest = strip(readFileSync('server/src/spaces/body-schemas.ts', 'utf8'));
    for (const [name, src] of [['mcp/tools/spaces.ts', mcp], ['spaces/body-schemas.ts', rest]]) {
      assert.match(src, /SPACE_PURPOSE_MAX/, `${name} must use the shared constant`);
      assert.ok(!/maxLength: 2000|max\(2000\)|> 2000/.test(src), `${name} still carries the old 2000 bound`);
    }
  });

  it('the tool advertises the real number to a client, not a stale sentence', () => {
    // The description string said "max 2000 chars" beside a maxLength of 2000. Interpolated now, so the
    // prose cannot drift from the schema — an agent reads the prose.
    const mcp = strip(readFileSync('server/src/mcp/tools/spaces.ts', 'utf8'));
    assert.match(mcp, /max \$\{SPACE_PURPOSE_MAX\} chars/);
  });
});
