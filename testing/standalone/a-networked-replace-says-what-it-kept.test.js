/**
 * A schema replace on a networked space says it was applied as a merge, and names every type it kept (`Q-61`).
 *
 * Owner, 2026-09-26: *"deleting in a network can be problematic (customization, reuse, other networks, ...) - i
 * think updates should be non-destructive"*. So a network round is applied as a merge on every member, the proposer
 * included, and a replace removes nothing. What was wrong was the answer: `PUT /api/spaces/:id/schema` said 200 and
 * the type stayed, on dev and on every subscriber, with nothing to say why. Found removing `Profile` from y-flows.
 *
 * The decision is pure (`typesAReplaceWouldDrop`, `networkMergeNotice`, `metaChangeNote` in
 * `server/src/spaces/meta-update.ts`), so it is tested here; the source gates below hold every door to it.
 *
 * Run: node --test testing/standalone/a-networked-replace-says-what-it-kept.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let M;
before(async () => { M = await import('../../server/dist/spaces/meta-update.js'); });

const base = { typeSchemas: { entity: { Profile: {}, Project: {} }, chrono: { Work: {} } } };

describe('which types a replace leaves out', () => {
  it('names every type of the base the replacement omits, per kind', () => {
    const incoming = { typeSchemas: { entity: { Project: {} } } };
    assert.deepEqual(M.typesAReplaceWouldDrop(base, incoming, 'replace'), ['chrono:Work', 'entity:Profile']);
  });
  it('a merge drops nothing, and neither does a replace that sends no typeSchemas', () => {
    assert.deepEqual(M.typesAReplaceWouldDrop(base, { typeSchemas: {} }, 'merge'), []);
    assert.deepEqual(M.typesAReplaceWouldDrop(base, { purpose: 'x' }, 'replace'), []);
  });
});

describe('what both doors add to the answer', () => {
  it('a networked outcome with kept types carries the flag, the list and one sentence', () => {
    const n = M.networkMergeNotice({ outcome: 'applied', space: {}, keptTypes: ['entity:Profile'] });
    assert.equal(n.appliedAsMerge, true);
    assert.deepEqual(n.keptTypes, ['entity:Profile']);
    assert.match(n.mergeNote, /entity:Profile was left out/);
  });
  it('nothing kept, nothing added', () => {
    assert.deepEqual(M.networkMergeNotice({ outcome: 'applied', space: {} }), {});
    assert.deepEqual(M.networkMergeNotice({ outcome: 'not_found' }), {});
  });
});

describe('the change note a network update sends down', () => {
  it('says who changed what, and that the left-out types are kept', () => {
    const text = M.metaChangeNote('ythril-dev', 'ythril dev net', 'y-flows', { typeSchemas: { entity: { Project: {} } }, usageNotes: 'n' }, ['entity:Profile']);
    assert.match(text, /ythril-dev updated the schema of 'y-flows' in 'ythril dev net'/);
    assert.match(text, /Types added or changed: entity:Project/);
    assert.match(text, /Also changed: usageNotes/);
    assert.match(text, /KEPT on every member.*entity:Profile/);
  });
});

describe('every door reports it', () => {
  const read = f => stripComments(readFileSync(f, 'utf8'));
  it('PATCH /api/spaces/:id and every schema route through voteOnSchemaEditIfNetworked', () => {
    assert.equal((read('server/src/api/spaces.ts').match(/\.\.\.networkMergeNotice\(result\)/g) ?? []).length, 2, 'the 202 and the 200 of PATCH');
    assert.equal((read('server/src/spaces/meta-update.ts').match(/\.\.\.networkMergeNotice\(result\)/g) ?? []).length, 2, 'the 202 and the 200 of the schema routes');
  });
  it('MCP schema_update, in the text and the structured half', () => {
    const src = read('server/src/mcp/tools/spaces.ts');
    assert.equal((src.match(/\.\.\.networkMergeNotice\(result\)/g) ?? []).length, 2);
    assert.equal((src.match(/mergeLine\(result\)/g) ?? []).length, 2);
  });
  it('the Verify marker the ticket names is present', () => {
    assert.match(read('server/src/spaces/meta-update.ts'), /appliedAsMerge/);
  });
});
