/**
 * Every `409` code a record update can answer is named in that update tool's MCP text and on the integration-guide page that covers it
 * (bundle-378, Q-976, lens sweep L1.5).
 *
 * ## The failure this prevents
 *
 * `409 write_race_lost` was added to every record update on every door, and named in neither the four update tools' descriptions nor the brain
 * API page, which still said an edit retries with no end; `record_version_at_ceiling` beside it was named in both. A caller reads the tool's text while
 * it builds a call and the page while it plans a retry, and nobody reports a refusal they were never told of.
 *
 * ## The rule, and how it is held
 *
 * `tools/flow-checks/check-i-docs-update-409-codes-named.mjs` reads the codes from the two functions that answer an update's refusal for every door
 * (`connectionRefusalAnswer`, `writeRefusalAnswer`), asks each row of its table of the built tool registry and the docs pages, and fails on a code with no
 * row. This file runs it on the repository, which must hold, and on a planted copy of each defect, which must not: a tool's text without the code, a page
 * without it, a refusal with no row, a row for a refusal that is gone, and a reader that read nothing.
 *
 * ## Seen red
 *
 * On f91569511 the repository fails: `update_entity`, `update_fact`, `update_chrono` and `update_edge` do not name write_race_lost, and
 * docs/integration-guide/04-brain-api.md does not.
 *
 * Run: node --test testing/standalone/every-409-code-an-update-answers-is-named-in-its-tools-and-on-its-page.test.js   (after `npm run build:server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { decide, readInputs, refusalCodesOf, ANSWERED_BY } from '../../tools/flow-checks/check-i-docs-update-409-codes-named.mjs';

describe('every 409 code an update answers is named in its tools and on its page', () => {
  let real;
  before(async () => { real = await readInputs(); });

  it('the repository holds', () => {
    const v = decide(real);
    assert.equal(v.holds, true, v.reason);
  });

  it('the codes are read, not listed: the table and the source agree on every one', () => {
    assert.deepEqual([...new Set(real.codes.map(c => c.code))].sort(), Object.keys(ANSWERED_BY).sort());
  });

  for (const name of ['update_entity', 'update_fact', 'update_chrono', 'update_edge']) {
    it(`planted: ${name}'s text without write_race_lost fails`, () => {
      const tools = real.tools.map(t => (t.name === name ? { ...t, description: String(t.description).replaceAll('write_race_lost', ''), inputSchema: () => ({}) } : t));
      const v = decide({ ...real, tools });
      assert.equal(v.holds, false, 'a tool that never names the refusal passed');
      assert.match(v.reason, new RegExp(`${name} does not name write_race_lost`));
    });
  }

  it('planted: the brain API page without write_race_lost fails', () => {
    const pages = { ...real.pages, 'docs/integration-guide/04-brain-api.md': real.pages['docs/integration-guide/04-brain-api.md'].replaceAll('write_race_lost', '') };
    const v = decide({ ...real, pages });
    assert.equal(v.holds, false);
    assert.match(v.reason, /04-brain-api\.md does not name write_race_lost/);
  });

  it('planted: a refusal the table has no row for fails, naming it', () => {
    const v = decide({ ...real, codes: [...real.codes, { cls: 'NewRefusal', code: 'a_new_refusal' }] });
    assert.equal(v.holds, false);
    assert.match(v.reason, /a_new_refusal/);
  });

  it('planted: a row for a refusal the source no longer answers fails', () => {
    const v = decide({ ...real, codes: real.codes.filter(c => c.code !== 'endpoint_removed') });
    assert.equal(v.holds, false);
    assert.match(v.reason, /endpoint_removed/);
  });

  it('planted: a reader that finds no refusal fails instead of passing about nothing', () => {
    assert.equal(decide({ ...real, codes: [] }).holds, false);
    assert.throws(() => refusalCodesOf('export function nothing() {}\n', []), /re-anchor this probe/);
  });
});
