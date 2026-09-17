/**
 * Every convenience the browser can filter a list by, an agent can too — through ONE assembly.
 *
 * ## The defect
 *
 * `filter` takes a predicate and knows nothing else. The nine per-collection `GET` list routes take
 * conveniences it does not: `tag` (substring over an array field), `type`, `description` (that column
 * only), `properties` (a value scan), and `search` (freetext over the collection's own text fields).
 *
 * So a browser can ask for *"facts tagged release"* and an agent cannot. Both doors are present and one
 * accepts less, which `CLAUDE.md` names in those words as the half of the parity rule that hides — and it
 * hid here for as long as the capability map paired the tool with the routes and called the pair answered.
 *
 * ## Why a module rather than five more lines in the tool
 *
 * The assembly existed FIVE times before this: `buildFactFilter`, and inline copies in the entities route,
 * `listEdges`, `buildChronoQuery` and the file-meta route. Each reads the same names and reaches the same
 * three primitives. A sixth copy inside `filter` is how the browser and the agent come to disagree about
 * what `tag` means, which is the thing nobody reports because both answers look like answers.
 *
 * ## THE GUARD THE MODULE EXISTS TO HOLD, and it is new with this change
 *
 * The four old assemblies do `Object.assign(predicate, textSearchOr(...))`. That is safe only because none
 * of them has a CALLER-SUPPLIED predicate to collide with. `filter` takes a raw Mongo filter which may
 * already contain `$or` — so assigning the convenience's `$or` on top silently REPLACES the caller's
 * disjunction, and the answer is wrong with nothing logged and no error. The module merges under `$and`,
 * and a hand-written copy is exactly what would drop that.
 *
 * Run: node --test testing/standalone/a-convenience-filter-reaches-both-doors.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';

const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
const { CONVENIENCE_KEYS, conveniencePredicate, convenienceFieldsFor } =
  await import('../../server/dist/brain/list-conveniences.js');
const { SEARCHABLE_FIELDS } = await import('../../server/dist/brain/text-search.js');

const src = (p) => stripComments(readFileSync(p, 'utf8'));
/** Unwrap the module's result, failing loudly on the refusal branch. */
const ok = (r) => { assert.ok(!('error' in r), `refused: ${r.error}`); return r.predicate; };

/** The `filter` tool's published schema — the same one a caller reads. */
function filterSchema() {
  const tool = ALL_TOOLS.find(t => t.name === 'filter');
  assert.ok(tool, 'the `filter` tool is gone or renamed — re-anchor this gate');
  return tool.inputSchema({ requiredSpace: {}, optionalSpace: {} });
}

describe('the conveniences are one set, declared once', () => {
  it('found them', () => {
    // A floor: an empty set passes every loop below it, and this one is read out of the module.
    assert.ok(CONVENIENCE_KEYS.length >= 5,
      `only ${CONVENIENCE_KEYS.length} convenience key(s) — the module export is broken, not the code`);
  });

  it('every one of them is an argument of the `filter` tool', () => {
    // The parity half. A convenience the REST list routes accept and the tool does not is a capability
    // the browser has and an agent does not, which is the defect this whole row is about.
    const props = filterSchema().properties ?? {};
    const missing = CONVENIENCE_KEYS.filter(k => !(k in props));
    assert.deepEqual(missing, [],
      `these narrow a list over REST and cannot be asked for through the tool: ${missing.join(', ')}`);
  });

  it('and each one says what it does, because the schema IS the reference', () => {
    // `help()` says the schema description is what a caller reads while constructing arguments. An
    // argument with no description is one nobody can tell apart from the predicate beside it.
    const props = filterSchema().properties ?? {};
    const undescribed = CONVENIENCE_KEYS.filter(k => !(props[k]?.description ?? '').trim());
    assert.deepEqual(undescribed, [], `these are offered with no description: ${undescribed.join(', ')}`);
  });
});

describe('a convenience cannot silently replace the caller\'s own predicate', () => {
  it('`search` beside a caller `$or` keeps BOTH', () => {
    /*
     * THE WHOLE REASON THIS IS A MODULE. `textSearchOr` returns `{$or: [...]}`, and the four older
     * assemblies `Object.assign` it straight on — safe only because none of them has a caller predicate.
     * `filter` does. Assigned, the caller's `$or` disappears and the answer is a plausible, wrong,
     * SILENT superset.
     */
    const caller = { $or: [{ type: 'note' }, { type: 'decision' }] };
    const merged = ok(conveniencePredicate('facts', { search: 'release' }, caller));
    const asText = JSON.stringify(merged);
    assert.ok(asText.includes('note') && asText.includes('decision'),
      `the caller's own $or was dropped by the search convenience: ${asText}`);
    assert.ok(asText.includes('release'), `the search convenience was not applied: ${asText}`);
  });

  it('two conveniences that both produce `$or` keep both', () => {
    // Same rule between two conveniences rather than against the caller. Nothing may be assigned over.
    const merged = ok(conveniencePredicate('facts', { search: 'alpha', tag: 'beta' }, {}));
    const asText = JSON.stringify(merged);
    assert.ok(asText.includes('alpha') && asText.includes('beta'),
      `one convenience overwrote the other: ${asText}`);
  });

  it('no conveniences at all leaves the caller predicate byte for byte', () => {
    // A caller that sends none must get today's behaviour exactly — no empty `$and`, no reshaping.
    const caller = { type: 'note', tags: { $in: ['a'] } };
    assert.deepEqual(ok(conveniencePredicate('facts', {}, caller)), caller);
  });
});

describe('every collection the tool offers either narrows or REFUSES', () => {
  /*
   * A collection reaching the tool's enum without an entry in `SEARCHABLE_FIELDS` accepts `search` and
   * narrows NOTHING — and a filter that returns everything is indistinguishable from a filter that was
   * ignored. `links` is that collection today: it is a pair of ids, with no tags, type, description or
   * text of its own, so inventing fields for it would be worse than refusing.
   *
   * Same shape as `B-12`, where a collection reaching the enum without a sortable-field set crashed. The
   * rule is that every enum member has ONE of the two honest answers, derived from the published enum so
   * that a seventh collection is covered by the commit that declares it.
   */
  const collections = () => filterSchema().properties?.collection?.enum ?? [];

  it('found the collections', () => {
    assert.ok(collections().length >= 5, `only ${collections().length} collection(s) — the schema read broke`);
  });

  it('a collection that cannot honour a convenience says so, rather than ignoring it', () => {
    const refusing = collections().filter(c => !convenienceFieldsFor(c));
    for (const c of refusing) {
      const r = conveniencePredicate(c, { search: 'anything' }, {});
      assert.ok('error' in r,
        `\`${c}\` has no searchable fields and accepted \`search\` anyway, so it matched everything`);
      assert.match(r.error, new RegExp(c), 'and the refusal must name the collection');
      assert.match(r.error, /search/, 'and name what it could not honour');
    }
  });

  it('and one that can, does', () => {
    const honouring = collections().filter(c => convenienceFieldsFor(c));
    assert.ok(honouring.length >= 5, `only ${honouring.length} collection(s) honour a convenience`);
    for (const c of honouring) {
      const merged = ok(conveniencePredicate(c, { search: 'zzz' }, {}));
      assert.ok(JSON.stringify(merged).includes('zzz'), `\`${c}\` dropped the search convenience`);
      // The fields it spans are the ones declared for it, not another collection's.
      for (const f of SEARCHABLE_FIELDS[c]) {
        assert.ok(JSON.stringify(merged).includes(`"${f}"`),
          `\`${c}\`'s \`search\` does not span its declared field \`${f}\``);
      }
    }
  });
});

describe('nobody assembles the conveniences a second time', () => {
  it('the sites that used to spell them reach the module instead', () => {
    /*
     * Assembly, not the primitives. `tagContains`/`textContains`/`propertiesValueContains`/`textSearchOr`
     * are shared already and are not the copy that matters — what recurred was the four-line sequence
     * that reads the same five names and calls them in the same order, five times.
     *
     * The subject is derived: any tracked source that reaches TWO of the primitives is assembling, and
     * must do it through the module. The module itself is the one that may.
     */
    /*
     * THE FLOOR IS ON THE MODULE'S CALLERS, not on the offenders — and the first version had it the
     * other way round. It counted sites reaching two primitives and required at least three, which was
     * true of the code before the conversion and false the moment the conversion worked: the gate went
     * red for succeeding. A floor has to be a fact that stays true, so it is the population this rule
     * governs, not the violations it is hunting.
     */
    const PRIMITIVES = ['tagContains', 'propertiesValueContains', 'textSearchOr'];
    // The module itself, and the two files that DEFINE the primitives, are the legitimate holders.
    // `exclude` is EXACT PATHS, matched with `Array.includes` — a regex here is silently no exclusion
    // at all, and the gate then reports the definition site as an offender.
    // `untracked: true`: a file the change ADDS is not in `git ls-files` until it is committed, so a
    // pre-commit sweep without it cannot see a new copy — which is the copy a reviewer most needs
    // flagged.
    const sources = trackedSources(['server/src'], {
      untracked: true,
      exclude: [
        'server/src/brain/list-conveniences.ts',
        'server/src/brain/tag-filter.ts',
        'server/src/brain/text-search.ts',
      ],
    });
    const callers = sources.filter(f => src(f).includes('conveniencePredicate('));
    assert.ok(callers.length >= 5,
      `only ${callers.length} site(s) call the module — the five list assemblies and both doors should`);
    const offenders = sources.filter(f => PRIMITIVES.filter(p => src(f).includes(p)).length >= 2);
    assert.deepEqual(offenders, [],
      'these assemble the list conveniences themselves instead of calling the one module, so the browser '
      + `and the agent can come to disagree about what \`tag\` means: ${offenders.join(', ')}`);
  });
});
