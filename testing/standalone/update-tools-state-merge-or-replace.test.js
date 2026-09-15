/**
 * Each `update_*` tool says whether its list fields MERGE or REPLACE — and says the same thing the store does.
 *
 * ## The trap
 *
 * Four tools take the same-looking arguments and do not agree:
 *
 * | Tool | `tags` | `properties` | can unset? |
 * | --- | --- | --- | --- |
 * | `update_entity` | merge | merge | `deleteFields` |
 * | `update_edge` | merge | merge | `deleteFields` |
 * | `update_fact` | **replace** | merge | `deleteFields` |
 * | `update_chrono` | **replace** | merge | `deleteFields` |
 *
 * The memory/chrono split is deliberate and `brain/memory.ts` says so in as many words — both halves were
 * documented, so both were kept and pinned rather than silently unified. That makes it permanent, which makes
 * it something a caller has to be TOLD: sending `tags: ["b"]` adds a tag on an entity and destroys the other
 * tags on a memory, with no error either way.
 *
 * **All four take `deleteFields`, and this docblock said `update_chrono` did not** — that *"a key written
 * once cannot be removed through the tool at all"*. It gained one, on both doors, and the assertions below
 * have required the description to say so ever since; one of them is titled *"and chrono really has
 * deleteFields now, on BOTH doors"*. So the header described a limitation its own file proved absent, and a
 * reader who stopped at the table concluded a chrono property was permanently unremovable.
 *
 * Kept as a correction rather than deleted, because the SHAPE is what recurs: this table is the thing a
 * reader trusts, and it is the thing nobody updates when one row stops being true. The `tags` column still
 * carries a real asymmetry — that is what the table is for.
 *
 * ## Why the assertions read the STORE
 *
 * A test that only checked the descriptions would pass on four confident sentences that had drifted from the
 * code together. `mergeTagsOrKeep` in the store is the fact; the description is the claim. This pins the claim
 * to the fact, in the direction that matters — if someone unifies the behaviour, the prose fails until it is
 * rewritten.
 *
 * Run: node --test testing/standalone/update-tools-state-merge-or-replace.test.js
 */
import { describe, it } from 'node:test';
import { trackedSources } from './_sources.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';

const src = (p) => readFileSync(p, 'utf8');

/** One tool object's description, `name:` to the next sibling key. Comments stripped. */
const description = (file, name) => {
  const s = stripComments(src(file));
  const at = s.indexOf(`name: '${name}'`);
  assert.ok(at > 0, `${name} not found in ${file} — the scanner is wrong, not the code`);
  const d = s.indexOf('description:', at);
  const end = s.slice(d).search(/\n {2}(mutating|spaceRequired|admin|spaceAdmin|inputSchema|async handle):/);
  assert.ok(end > 0, `could not find the end of ${name}'s description`);
  return s.slice(d, d + end);
};

const TOOLS = {
  update_entity: description('server/src/mcp/tools/entity.ts', 'update_entity'),
  update_edge: description('server/src/mcp/tools/edge.ts', 'update_edge'),
  update_memory: description('server/src/mcp/tools/memory.ts', 'update_fact'),
  update_chrono: description('server/src/mcp/tools/chrono.ts', 'update_chrono'),
};

describe('the store still behaves the way the descriptions claim', () => {
  it('entity and edge updates MERGE tags', () => {
    // If this stops being true, the two descriptions below become wrong and their assertions must change with
    // it — which is the whole point of asserting on the store rather than only on the prose.
    for (const f of ['server/src/brain/entities.ts', 'server/src/brain/edges.ts']) {
      assert.match(stripComments(src(f)), /mergeTagsOrKeep\(existing\.tags, updates\.tags\)/,
        `${f} no longer merges tags — the update tool description is now a lie`);
    }
  });

  it('memory and chrono updates REPLACE tags', () => {
    assert.match(stripComments(src('server/src/brain/memory.ts')),
      /\$set\['tags'\] = updates\.tags/, 'memory tags are a straight overwrite');
    // Chrono writes every supplied field through a generic loop, and only `properties` is pulled out of it.
    const chrono = stripComments(src('server/src/brain/chrono.ts'));
    assert.match(chrono, /for \(const \[k, v\] of Object\.entries\(updates\)\)/, 'the generic overwrite loop');
    assert.match(chrono, /\$set\['properties'\] = mergedUpdateProps/, 'with properties lifted out to merge');
  });

  it('every writer that sets a properties bag MERGES it', () => {
    /*
     * **The count and the list both came out of this.** It read *"all four MERGE properties"* over four named
     * brain modules — a number in a title, which is a second copy of a fact the code holds, and a list that a
     * fifth writer would sit outside of while the title went on claiming all of them (`Q-6`, 2026-09-07).
     *
     * The set is now the SYMPTOM rather than the family: whoever assigns a properties bag into a `$set` is a
     * writer of properties, whatever it is called and wherever it lives. That is also the exact shape of the
     * defect — an assignment is what replaces the bag, and replacing it destroys keys the caller never named.
     */
    const files = trackedSources('server/src');
    const writers = files.filter(f => /\$set\[['"]properties['"]\]\s*=/.test(stripComments(src(f))));
    assert.ok(writers.length >= 4,
      `only ${writers.length} module(s) write a properties bag; the four record families are the minimum, `
      + 'so the scan is wrong rather than the code');

    for (const f of writers) {
      assert.match(stripComments(src(f)), /mergePropertiesOrKeep\(/,
        `${f} sets a properties bag without merging — replacing it destroys keys the caller never named`);
    }
  });
});

describe('every update tool states which it does', () => {
  for (const [name, d] of Object.entries(TOOLS)) {
    it(`${name} names the behaviour of BOTH tags and properties`, () => {
      assert.match(d, /MERGE|REPLACE|MERGED|REPLACES/,
        'a caller constructing arguments cannot infer this from the type');
      assert.match(d, /properties/i, 'properties must be described, not just listed');
      assert.match(d, /tags/i, 'tags must be described, not just listed');
    });
  }

  it('the two that REPLACE tags say so in capitals, because it destroys data', () => {
    assert.match(TOOLS.update_memory, /TAGS REPLACE HERE/, 'the difference has to be unmissable');
    assert.match(TOOLS.update_chrono, /REPLACE/, 'chrono replaces tags, entityIds and memoryIds');
  });

  it('the two that MERGE tags say how to remove one', () => {
    // A merge with no stated removal path reads as "there is no way to remove a tag", which is wrong and
    // would send a caller to delete-and-recreate.
    for (const name of ['update_entity', 'update_edge']) {
      assert.match(TOOLS[name], /deleteFields/, `${name} must point at the only way to unset`);
    }
  });

  it('update_chrono says removal is deleteFields, never an omission', () => {
    // This assertion originally required the OPPOSITE — that the description admit chrono could not unset
    // anything. That was true, and filing it is what became X-4; the parameter has now shipped, so the
    // assertion is INVERTED rather than deleted. The rule it protects never changed: whatever the tool does
    // about removal, the description has to say it, because an absent field means "leave alone" and a caller
    // cannot infer the rest.
    assert.match(TOOLS.update_chrono, /REMOVING SOMETHING IS `deleteFields`, NEVER AN OMISSION/,
      'the removal path must be named where a caller looks for it');
    assert.doesNotMatch(TOOLS.update_chrono, /CANNOT be removed|NO `deleteFields` ON THIS TOOL/,
      'the limitation paragraph must go with the limitation');
  });

  it('and chrono really has deleteFields now, on BOTH doors', () => {
    // Read from `inputSchema:` onward, not the whole tool: the description deliberately contains the word
    // `deleteFields` in prose, so a whole-tool scan would pass on the sentence rather than the parameter.
    const chronoTool = stripComments(src('server/src/mcp/tools/chrono.ts'));
    const at = chronoTool.indexOf("name: 'update_chrono'");
    const schemaAt = chronoTool.indexOf('inputSchema:', at);
    assert.ok(schemaAt > at, 'update_chrono has no inputSchema — the scanner is wrong, not the code');
    const end = chronoTool.indexOf('\nexport const ', at);
    assert.match(chronoTool.slice(schemaAt, end === -1 ? undefined : end), /deleteFields: \{/,
      'declared in the input schema');
    // The parity half: same parameter on the REST route, same commit. A capability on one door only is the
    // single most expensive defect this codebase produces.
    assert.match(stripComments(src('server/src/api/brain/chrono.ts')), /validateDeleteFields\(/,
      'and validated on the REST route with the same helper');
  });
});

describe('the excludeFromVectorSearch answer is stated on every tool that offers it', () => {
  // Owner, 2026-08-15: *"excludefromvector does also exclude from recalls traversal? ambigous and i want
  // entries to be findable via traversal even if they are not embedded themselves."* The behaviour was
  // already right; the sentence saying so existed nowhere, which is why the question had to be asked at all.
  for (const [name, d] of Object.entries(TOOLS)) {
    it(`${name} says traversal still reaches an excluded record`, () => {
      assert.match(d, /traverse|_graph|graph/i,
        'the owner asked this exact question — the answer belongs where the parameter is described');
      assert.match(d, /RANK/,
        'excluded means "cannot be ranked by meaning", not "removed from search"');
    });
  }
});
