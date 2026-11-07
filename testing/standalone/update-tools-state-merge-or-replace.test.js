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
 * The memory/chrono split is deliberate and `brain/fact.ts` says so in as many words — both halves were
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
import { propertiesWriteSites, unmergedPropertiesWrites, PROPERTIES_WRITE_EXCEPTIONS } from './_properties-write-sites.mjs';

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
  update_memory: description('server/src/mcp/tools/fact.ts', 'update_fact'),
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
    assert.match(stripComments(src('server/src/brain/fact.ts')),
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
    /*
     * PER SITE, not per file (Q-197). This asked whether a MODULE contained a merge call anywhere, so `files/file-meta.ts` passed on
     * `updateFileMeta`'s merge while `upsertFileMeta`'s own line replaced the bag — a rewrite of a file destroyed every key the caller
     * never named. The scan, what satisfies a site and the named exceptions are in `_properties-write-sites.mjs`.
     */
    const files = trackedSources('server/src').map(file => ({ file, text: src(file) }));
    const sites = propertiesWriteSites(files);
    assert.ok(sites.filter(s => s.ok).length >= 6,
      `only ${sites.filter(s => s.ok).length} properties-write site(s) merge; the write planners and the update writers are at least six, `
      + 'so the scan is wrong rather than the code');
    assert.deepEqual(unmergedPropertiesWrites(files), []);
    console.log(`properties-write sites: ${sites.length}; named exceptions: ${PROPERTIES_WRITE_EXCEPTIONS.length}`);
    for (const e of PROPERTIES_WRITE_EXCEPTIONS) {
      assert.ok(e.reason.length > 20 && /^\d{4}-\d\d-\d\d$/.test(e.reviewed), `exception for ${e.file} carries no reason or no review date`);
    }
  });

  describe('the per-site scan goes red on the shapes that destroyed keys (planted)', () => {
    const problemsOf = (text) => unmergedPropertiesWrites([{ file: 'planted.ts', text }], []);

    it('a raw replace', () => {
      assert.equal(problemsOf("function f(opts) {\n  const $set = {};\n  if (opts.properties !== undefined) $set['properties'] = opts.properties;\n}\n").length, 1);
    });

    it('a variable merged at its declaration and reassigned to a raw bag', () => {
      const text = "function f(existing, incoming, merged) {\n  let p = mergeProperties(existing, incoming);\n"
        + "  if (x) {\n    p = merged['properties'] as R;\n  }\n  $set['properties'] = p;\n}\n";
      assert.equal(problemsOf(text).length, 1, 'a reassignment to a raw bag is a raw bag');
    });

    it('a stage put inside the $literal-mapped $set (stored as text)', () => {
      const text = "function g(opts) {\n  const $set = {};\n  $set['properties'] = mergePropertiesStage(opts.properties);\n"
        + "  const values = Object.fromEntries(Object.entries($set).map(([k, v]) => [k, { $literal: v }]));\n}\n";
      assert.equal(problemsOf(text).length, 1);
    });

    it('an object-literal key headed for an update', () => {
      assert.equal(problemsOf("async function h(opts) {\n  await c.updateOne(f, { $set: { updatedAt: now, properties: opts.properties } });\n}\n").length, 1);
    });

    it('and stays quiet on the right shapes', () => {
      assert.deepEqual(problemsOf("function f(e, o) {\n  const $set = {};\n  $set['properties'] = mergeProperties(e.properties, o);\n}\n"), []);
      assert.deepEqual(problemsOf("function f(e, o) {\n  const m = mergePropertiesOrKeep(e, o);\n  $set['properties'] = m;\n}\n"), []);
      assert.deepEqual(problemsOf("async function f(o) {\n  await c.updateOne(f, [ { $set: { properties: mergePropertiesStage(o.properties) } } ]);\n}\n"), [],
        'the stage as a key of a pipeline $set is the database spelling of the rule');
    });
  });
});

describe('write_file says what a rewrite does with the stored bag (Q-197)', () => {
  // Not in TOOLS: that table also feeds the excludeFromVectorSearch rows below, which write_file has no such parameter for.
  const tool = (() => {
    const s = stripComments(src('server/src/mcp/tools/file.ts'));
    const at = s.indexOf("name: 'write_file'");
    assert.ok(at > 0, 'write_file not found — the scanner is wrong, not the code');
    const end = s.indexOf('\nexport const ', at);
    return s.slice(at, end === -1 ? undefined : end);
  })();
  /** One input property's description, from its key to the next sibling key of the schema. */
  const schemaText = (name) => {
    const at = tool.search(new RegExp(`\\n\\s+${name}: \\{\\s*type:`));
    assert.ok(at > 0, `write_file's input schema has no ${name} — the scanner is wrong, not the code`);
    const rest = tool.slice(at + 1);
    const next = rest.slice(1).search(/\n\s{12}[a-zA-Z]+: [{A-Z]/);
    return rest.slice(0, next > 0 ? next : undefined);
  };

  it('its `properties` text says MERGED over the stored bag, and that removal is deleteFields', () => {
    const d = schemaText('properties');
    assert.match(d, /MERGE/, 'a rewrite merges the bag; the text must say so, a caller cannot infer it');
    assert.match(d, /deleteFields/, 'and that removing a key is update_file_meta deleteFields, never an omission');
  });

  it('its `tags` text no longer says update_file_meta replaces "unlike the brain update tools"', () => {
    const d = schemaText('tags');
    assert.match(d, /REPLACES/, 'a rewrite still replaces the tag list');
    assert.doesNotMatch(d, /update_file_meta`? replaces too, unlike/, 'update_file_meta merges its properties: only its LISTS replace');
    assert.match(d, /update_file_meta`? replaces lists too/, 'the sentence the plan names');
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
