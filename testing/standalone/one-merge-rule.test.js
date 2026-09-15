/**
 * There is ONE merge rule for `tags` and `properties`, and every write path uses it.
 *
 * ## The finding
 *
 * The rule is two lines — a de-duplicated tag union and a shallow property merge — and it was written
 * **eleven times** across six files. A canonical version existed (`mergedEntityWrite`) and was already
 * generic: its signature never mentioned an entity. It had two call sites. Everyone else re-derived it,
 * because a helper named and placed for its first caller is invisible to the second — nobody reaches
 * into `brain/entities.ts` to merge a chrono entry's properties.
 *
 * ## Why it is correctness rather than tidiness
 *
 * The docs promise the copies agree. 2.4.0's *Retry Safety* section says a converged retry does
 * "tags union and properties shallow-merge" for all four record types; the `deleteFields` section says
 * it is "applied **after** the normal merge" for entities, edges **and memories**; and
 * `update_fact`'s own tool schema said `properties` were "to merge".
 *
 * They did not agree. `updateMemory` and `updateChrono` **replaced** the properties map, so an agent
 * patching one key silently destroyed every other property on the record — no error, no warning, and
 * the REST validation simulation mirrored the same replace, so the schema check could not see it either.
 *
 * ## What this file pins
 *
 * 1. the rule itself, as pure functions;
 * 2. that no write path hand-rolls it again — enumerated from the SHAPE (`{ ...x.properties }`,
 *    `new Set([...tags])`), not from a list of file names, because a name list is what let the eleventh
 *    copy be added by the same person who wrote the promise;
 * 3. the one divergence that is deliberate and documented: `update_fact` REPLACES tags
 *    ("New tags (replaces existing)") while `update_entity`/`update_edge` union them. Both halves are
 *    stated, so the test states them too rather than letting a future sweep quietly unify them.
 *
 * The behavioural half — that the four writers really do agree against a real MongoDB — is
 * `merge-rule-db.test.js`. A source gate cannot tell live code from dead code.
 *
 * Run: node --test testing/standalone/one-merge-rule.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { trackedSources } from './_sources.mjs';
import { KNOWLEDGE_TYPES } from '../../server/dist/config/types-knowledge.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** The module that is allowed to contain the rule. Everything else must call it. */
const HOME = 'server/src/brain/merge-fields.ts';

let merge;

/**
 * Tracked AND newly-added sources. `git ls-files` alone misses a file a contributor has just written,
 * which is precisely when a fresh copy of the rule gets introduced.
 *
 * It used to pass two pathspecs, because `server/src/*.ts` does not descend in git's glob and a single
 * pattern silently skipped every subdirectory — which is all of them. A directory has no such edge, and the
 * shared helper is now the one place that has to know it.
 */
function sourceFiles() {
  return trackedSources('server/src', { untracked: true });
}

/**
 * Comments stripped, so the gate cannot fire on the prose that documents the rule — including this
 * file's own explanation of the pattern it bans, and the block comment at the top of `merge-fields.ts`.
 */
function code(path) {
  return readFileSync(join(ROOT, path), 'utf8')
    .split(/\r?\n/)
    .filter(l => !/^\s*\/\//.test(l))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Built fresh per call, never shared. A `/g` regex carries `lastIndex` between uses, and
 * `assert.match` advances it — a shared instance makes the NEXT file in the sweep come back clean on a
 * planted violation.
 */
const patterns = () => [
  // A MERGE, not a copy: the second spread is what makes it the rule. `{ ...(x.properties ?? {}) }`
  // on its own is a defensive copy — legitimate, and several validation paths take one before handing
  // it to `deleteFields`. Matching those too would make the gate noise that gets suppressed.
  { name: 'properties spread-merge', re: /\{\s*\.\.\.\([^)]*\.properties\s*\?\?\s*\{\}\)\s*,\s*\.\.\./g },
  { name: 'tags Set-union', re: /new Set\(\[\s*\.\.\.\([^)]*\.tags\s*\?\?\s*\[\]\)/g },
];

describe('one merge rule', () => {
  before(async () => {
    merge = await import('../../server/dist/brain/merge-fields.js');
  });

  describe('the rule', () => {
    it('unions tags, stored order first, de-duplicated', () => {
      assert.deepEqual(merge.mergeTags(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
    });

    it('shallow-merges properties, incoming wins per key', () => {
      assert.deepEqual(merge.mergeProperties({ x: 1, y: 2 }, { y: 3 }), { x: 1, y: 3 });
    });

    it('is the identity on an insert', () => {
      assert.deepEqual(merge.mergeTagsAndProperties(null, { tags: ['b'], properties: { y: 3 } }),
        { tags: ['b'], properties: { y: 3 } });
    });

    it('treats an ABSENT incoming map as "do not touch", not "clear"', () => {
      // The distinction the whole PATCH surface rests on: `undefined` is the caller saying nothing.
      // Collapsing it to `{}` would wipe a required property on any patch that only sets a weight.
      assert.deepEqual(merge.mergePropertiesOrKeep({ owner: 'platform' }, undefined), { owner: 'platform' });
      assert.equal(merge.mergePropertiesOrKeep(undefined, undefined), undefined,
        'nothing stored and nothing supplied must stay undefined, so a writer can leave it out of the $set');
      assert.deepEqual(merge.mergeTagsOrKeep(['prod'], undefined), ['prod']);
    });

    it('never hands back the stored object itself', () => {
      // deleteFields mutates what it is given. Aliasing the document just read from the driver is a
      // defect waiting for the first caller that merges and deletes in one request.
      const stored = { owner: 'platform' };
      const kept = merge.mergePropertiesOrKeep(stored, undefined);
      assert.notEqual(kept, stored, 'a copy, not the stored reference');
      kept.owner = 'mutated';
      assert.equal(stored.owner, 'platform');
    });

    it('an empty incoming map is a no-op, not a wipe', () => {
      assert.deepEqual(merge.mergeProperties({ x: 1 }, {}), { x: 1 });
    });
  });

  describe('nobody hand-rolls it', () => {
    it('the detector fires on the pattern it is meant to catch', () => {
      // Mutation-check the gate before believing a clean sweep. Three gates in this repo have passed on
      // planted bugs; a detector that matches nothing reports "clean" for every codebase on earth.
      const planted = 'const p = { ...(existing.properties ?? {}), ...incoming };\n'
        + 'const t = Array.from(new Set([...(existing.tags ?? []), ...incoming]));';
      const hits = patterns().filter(p => p.re.test(planted)).map(p => p.name);
      assert.deepEqual(hits.sort(), ['properties spread-merge', 'tags Set-union']);
    });

    it('the sweep reaches the files that used to hold the copies', () => {
      // Scope check. The eleven copies lived in these six; if the pathspec stops reaching them the
      // gate below passes vacuously and reads like coverage it does not have.
      const files = sourceFiles();
      for (const f of [
        'server/src/brain/entities.ts', 'server/src/brain/edges.ts', 'server/src/brain/memory.ts',
        'server/src/brain/chrono.ts', 'server/src/api/brain/entities.ts', 'server/src/mcp/tools/entity.ts',
      ]) {
        assert.ok(files.includes(f), `${f} must be in the swept set`);
      }
      assert.ok(files.length > 100, `expected the whole server tree, swept ${files.length}`);
    });

    it('no file outside brain/merge-fields.ts contains the rule', () => {
      const offenders = [];
      for (const file of sourceFiles()) {
        if (file === HOME) continue;
        const src = code(file);
        for (const { name, re } of patterns()) {
          for (const m of src.matchAll(re)) {
            offenders.push(`${file} — ${name}: ${m[0].slice(0, 60)}`);
          }
        }
      }
      assert.deepEqual(offenders, [],
        'the tag union and the property merge live in brain/merge-fields.ts. Import mergeTags / '
        + 'mergeProperties / mergeTagsAndProperties / mergePropertiesOrKeep / mergeTagsOrKeep instead of '
        + 'writing the two lines again — eleven copies is how a documented guarantee stopped being true.');
    });
  });

  describe('the one divergence is deliberate, and stated in both places', () => {
    const schema = (file) => readFileSync(join(ROOT, file), 'utf8');

    it('update_fact documents tags as a REPLACE and update_entity as a union', () => {
      // Not an oversight to be tidied away: both halves are written down, so a future sweep that
      // "unifies" them is changing documented behaviour and has to say so.
      //
      // Asserted on the RULE, not on a phrase. This required the literals `New tags (replaces existing)`
      // and `Tags to merge with existing tags`, so rewriting either description to say the SAME thing at
      // more length turned a documentation improvement into a red gate. A pinned sentence is a pinned
      // sentence even when the sentence is correct — and the version of this mistake that costs something
      // is the one where the sentence is wrong, which `read-tools-state-their-blind-spots` shipped.
      const tagsDescriptionOf = (file) => {
        const src = schema(file);
        const at = src.indexOf('export const update_');
        assert.ok(at > 0, `${file}: no update tool found — the scanner is wrong, not the code`);
        const tagsAt = src.indexOf('tags: {', at);
        assert.ok(tagsAt > at, `${file}: the update tool declares no tags parameter`);
        // The description VALUE, including the `+ '…'` continuation lines it is usually built from. Bounding
        // at the property's closing `},` looked right and was not: `items: { type: 'string' },` closes
        // first, so the slice stopped before the description began and the match failed on an empty string.
        // A brace-counting bound would work; matching the value itself is simpler and says what it wants.
        const m = /description:\s*((?:'(?:[^'\\]|\\.)*'\s*\+?\s*)+)/.exec(src.slice(tagsAt));
        assert.ok(m, `${file}: the tags parameter has no description at all`);
        assert.ok(m[1].length > 40, `${file}: captured only ${m[1].length} chars — the scanner is wrong`);
        return m[1];
      };

      assert.match(tagsDescriptionOf('server/src/mcp/tools/memory.ts'), /\breplaces?\b/i,
        'update_fact still documents replace semantics for tags');
      assert.doesNotMatch(tagsDescriptionOf('server/src/mcp/tools/memory.ts'), /\bmerged into\b/i,
        'and must not also claim to merge them');

      assert.match(tagsDescriptionOf('server/src/mcp/tools/entity.ts'), /\bmerge[ds]?\b/i,
        'update_entity still documents union semantics for tags');
      assert.doesNotMatch(tagsDescriptionOf('server/src/mcp/tools/entity.ts'), /\breplaces the stored tag\b/i,
        'and must not also claim to replace them');
    });

    it('every update tool that merges properties says so in its schema', () => {
      // The defect was a schema promising "to merge" over code that replaced. The promise is now true;
      // this keeps the two moving together.
      /*
       * The TYPES come from the source that defines them, and each tool is then located by the declaration
       * it makes rather than by its filename.
       *
       * Two lists were hiding in one line before. Four type names, which is a copy of `KNOWLEDGE_TYPES` — a
       * fifth record type would arrive with an update tool nothing here asked about. And `${f}.ts`, which
       * assumes the module is named after the type; that holds today and is not a rule anywhere, so a tool
       * moved into a shared module would silently stop being checked while the gate stayed green.
       *
       * NOT "every update tool that has a properties bag", which was the first attempt: `update_file_meta`
       * has one and REPLACES it, deliberately and documented. The merge is the brain records' rule.
       */
      const toolFiles = trackedSources('server/src/mcp/tools/*.ts', { floor: 10 });
      /*
       * THE TOOL NOUN IS NOT ALWAYS THE KNOWLEDGE TYPE, and A-1 is where they parted.
       *
       * This built `update_${type}` and that held while every tool was named after its collection. The
       * 5.0 rename made the memory tool `update_fact` — `save_fact` reads as what is stored, `save_memory`
       * reads as saving the memory system — while the knowledge TYPE is still `memory` until `A-2`
       * migrates it. One entry, and it disappears when A-2 lands rather than becoming permanent.
       */
      const TOOL_NOUN = { memory: 'fact' };
      for (const t of KNOWLEDGE_TYPES) {
        const noun = TOOL_NOUN[t] ?? t;
        const file = toolFiles.find(f => new RegExp(`name: 'update_${noun}'`).test(schema(f)));
        assert.ok(file, `no MCP module declares an update_${noun} tool — either it is gone, or it moved and this `
          + 'gate can no longer find it, and both need reading rather than a passing tick');
        assert.match(schema(file), /properties to merge|properties to merge into the stored map/i,
          `update_${noun}'s properties description must state the merge — the code does it`);
      }
    });
  });
});
