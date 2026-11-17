/**
 * Every place that says what a `schema_versions_busy` answer keeps says what the refusal itself says (Q-744).
 *
 * A placement of a space's records against its schema versions that runs past its deadline answers `503
 * schema_versions_busy`. What survives it is the versions already compared, so trying again has less left to do: that is
 * the sentence of `SchemaVersionsBusyError` in `server/src/util/errors.ts`. The integration guide's filter page said
 * instead that "what was placed is kept, so trying again continues it", which promises a resumed pass the server does
 * not make, and no check read the guide beside the refusal.
 *
 * The set is the repository's, not a list: every tracked `.md` under `docs/` and every tracked `.ts` under `server/src`
 * is read, so the next copy of the sentence is held to the same words wherever it is written.
 *
 * Run: node --test testing/standalone/docs-say-what-a-busy-schema-placement-keeps.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources, closeStringJoins, SERVER_CODE_ROOTS } from './_sources.mjs';

const CODE = 'schema_versions_busy';
/** What the refusal says is kept. */
const KEPT = 'versions already compared are kept';
/** How far after the code a sentence about it can reach. */
const REACH = 320;

/** A source as prose: string pieces joined (`' + '`), line breaks and runs of blanks as one blank. */
export const asProse = (text) => closeStringJoins(text).replace(/\s+/g, ' ');

/** For each mention of the code in `text` of `file`: what follows it says nothing is kept, the refusal's words, or other words (a problem). */
export function busyClaims(file, text) {
  const prose = asProse(text);
  const out = [];
  for (let at = prose.indexOf(CODE); at >= 0; at = prose.indexOf(CODE, at + CODE.length)) {
    const after = prose.slice(at, at + REACH);
    if (/continues it/.test(after)) out.push({ file, problem: 'says trying again continues the pass' });
    else if (/\bkept\b/.test(after)) out.push({ file, problem: after.includes(KEPT) ? null : `says something is kept, and not that the ${KEPT}` });
  }
  return out;
}

const DOCS = trackedSources('docs', { ext: ['.md'], floor: 20 });
const SOURCES = trackedSources(SERVER_CODE_ROOTS, { ext: ['.ts'], floor: 100 });
const claims = [...DOCS, ...SOURCES].flatMap(f => busyClaims(f, readFileSync(join(REPO_ROOT, f), 'utf8')));

describe('what a busy schema placement keeps is said in the refusal\'s words everywhere (Q-744)', () => {
  it('the refusal itself carries the sentence the others are held to', () => {
    const errors = asProse(readFileSync(join(REPO_ROOT, 'server/src/util/errors.ts'), 'utf8'));
    assert.ok(errors.includes(`the ${KEPT}, so trying again has less left to do`), 'SchemaVersionsBusyError no longer says what is kept: this check reads its words');
  });

  it('the scan reads the filter page, the schema page and the MCP tool description', () => {
    const read = new Set(claims.map(c => c.file));
    for (const f of ['docs/integration-guide/04d-brain-ops-api.md', 'docs/integration-guide/06a-schema-api.md', 'server/src/mcp/tools/schema-versions.ts']) {
      assert.ok(read.has(f), `${f} names ${CODE} with what is kept, and the scan did not read it there`);
    }
  });

  it('no page and no description says another thing is kept, or that trying again continues the pass', () => {
    const wrong = claims.filter(c => c.problem).map(c => `${c.file} ${c.problem}`);
    assert.deepEqual(wrong, []);
  });

  it('the old sentence of the filter page is caught', () => {
    const old = 'answers `503 schema_versions_busy` (what was placed is kept, so trying again continues it).';
    assert.deepEqual(busyClaims('x.md', old).map(c => c.problem), ['says trying again continues the pass']);
    assert.deepEqual(busyClaims('x.md', '`schema_versions_busy` (the placement is kept)').map(c => Boolean(c.problem)), [true]);
    assert.deepEqual(busyClaims('x.ts', "`schema_versions_busy` when placing the '\n  + 'records took too long (the versions already compared are kept: try again)").map(c => c.problem), [null]);
  });
});
