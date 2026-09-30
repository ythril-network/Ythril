/**
 * Every quantity a caller sends has a bound — on both doors, and the same bound on both (`Q-108`).
 *
 * ## The rule
 *
 * An array a caller sends is a COUNT the server works through, and a number a caller sends is often one too
 * (`limit`, a floor, a depth). Unbounded, either is a way for one request to cost what a thousand should: a
 * lookup per id, a link per target, a model call per turn. So every array in every door's validator carries a
 * `maxItems`, every number a `maximum`, and a quantity deliberately left open is named below with the reason it
 * does not cost — each reason a ruling somebody can read and overturn, not a gap nobody saw.
 *
 * ## Both doors, derived
 *
 * - **MCP**: every tool's `inputSchema`, from the registry (`ALL_TOOLS`). For a REST route that answers through
 *   `callTool` — `recall`, `similar`, traverse, the generic tool door — that schema is the REST validator too.
 * - **REST**: every zod schema EXPORTED by a module that imports zod, rendered with `z.toJSONSchema` so the two
 *   doors are walked by one walker. A validator left unexported is one this gate cannot read, so the last test
 *   refuses one in `server/src/api`.
 *
 * What neither side covers, stated: a REST route that validates by hand (`Array.isArray(ids)`) rather than with a
 * schema. Those carry their bound in code, and `a-quantity-over-its-bound-is-refused.test.js` exercises each.
 *
 * ## The same bound on both
 *
 * A field named in `BOUND_BY_FIELD` (`util/request-bounds.ts`) means one thing everywhere — `tags` is a record's
 * tags on every write door and on the sync door — so it carries exactly that bound wherever it is declared. The
 * sync door refused 101 tags while every write door took any number: a record saved on one instance could never
 * be pushed to another, and this is the assertion that would have said so.
 *
 * Run: node --test testing/standalone/every-quantity-a-caller-sends-has-a-bound.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { toolValidators, zodValidators, quantities } from './_validator-schemas.mjs';

const BOUNDS = await import('../../server/dist/util/request-bounds.js').catch(() => null);

/** Every validator, as `{ door, schema }` — the MCP tools and the exported zod schemas, one JSON-schema shape. */
const VALIDATORS = [...toolValidators(), ...await zodValidators()];

const ALL = VALIDATORS.flatMap(quantities);

const bounded = q => q.kind === 'array'
  ? q.node.maxItems !== undefined
  : q.node.maximum !== undefined || q.node.exclusiveMaximum !== undefined || Array.isArray(q.node.enum) || q.node.const !== undefined;

/**
 * The quantities left open ON PURPOSE — each a rule over what the value IS, with the reason it does not cost.
 * A rule that matches nothing fails the gate, so a ruling cannot outlive its subject.
 */
const OPEN_BY_RULING = [
  { name: 'an offset', test: q => q.seg === 'skip' || q.seg === 'markdownSkip',
    why: 'skip passes over rows rather than returning them: on `filter` the query deadline (`maxTimeMS`, capped at 10 s) '
      + 'bounds it, and on recall, similar, traverse, read_spill and list_embed_jobs it pages an answer whose size is bounded elsewhere; '
      + '`markdownSkip` is a character offset into a document whose window the answer budget bounds' },
  { name: 'an answer budget', test: q => ['maxChars', 'maxBytes', 'maxTokens'].includes(q.seg),
    why: 'resolved by `brain/result-budget.ts` into [MIN_MAX_BYTES, MAX_MAX_BYTES] and echoed back as budgetChars/budgetBytes, '
      + 'so the clamp is disclosed on every answer (Q-161); the cost is bounded by the resolver, not the request' },
  { name: 'a stored property value', test: q => q.path.includes('properties{*}'),
    why: 'a number a record STORES, not a count the server works through' },
  { name: 'a space schema definition', test: q => q.door.startsWith('REST ') && (q.path.includes('propertySchemas') || /PropertySchemaZ$/.test(q.door)),
    why: 'minimum, maximum, default and enum are the rules a space schema DEFINES for its values; they are values, not request quantities' },
  { name: 'a quota', test: q => q.seg === 'maxGiB', why: 'a storage quota the operator sets; a larger one costs nothing at the call' },
  { name: 'a recurrence period', test: q => /recurrence\.interval$/.test(q.path),
    why: 'a stored period; a larger interval means fewer occurrences, never more work' },
  { name: 'a stored weight or confidence', test: q => ['weight', 'confidence'].includes(q.seg),
    why: 'a value a record stores (0–1 by convention), not a count. Where a door does not enforce the range — `save_bulk`, '
      + 'the sync ingest — it says so in its own description, and refusing a legacy value on sync would strand that record on push' },
  { name: 'recall topK', test: q => q.door === 'MCP recall' && q.seg === 'topK',
    why: 'documented "NO ceiling" since 4.0 on both doors; what comes back is bounded by the answer budget and the walk budgets in brain/search-bounds.ts' },
  { name: 'recall per-type floors and ceilings', test: q => q.door === 'MCP recall' && /\.(minPerType|maxPerType)\{\*\}$/.test(q.path),
    why: 'clamped to topK by brain/search-bounds.ts, as the guide promises' },
  { name: 'recall deadline', test: q => q.door === 'MCP recall' && q.seg === 'maxTimeMS',
    why: 'it can only LOWER the instance deadline, never raise it' },
  { name: 'filter limit', test: q => q.door === 'MCP filter' && q.seg === 'limit',
    why: 'documented "NOT capped" since 5.0, where a clamp made a page of 200 read as a correct page of 100. What is READ is bounded instead '
      + '(Q-108): a single-space read stops at twice the byte budget, and a proxy read at PROXY_PAGE_CEILING' },
  { name: 'merge resolutions', test: q => q.door === 'MCP graph_merge' && q.seg === 'resolutions',
    why: 'read once into a map keyed by property name; an entry naming a property the plan did not report changes nothing' },
];

const open = q => OPEN_BY_RULING.find(r => r.test(q));

describe('every quantity a caller sends has a bound', () => {
  it('reads both doors, and not thinly', () => {
    const mcp = VALIDATORS.filter(v => v.door.startsWith('MCP ')).length;
    const rest = VALIDATORS.filter(v => v.door.startsWith('REST ')).length;
    assert.ok(mcp >= 60, `only ${mcp} MCP tool schema(s) read — the registry import broke`);
    assert.ok(rest >= 70, `only ${rest} exported zod schema(s) read — the module derivation broke`);
    assert.ok(ALL.length >= 300, `only ${ALL.length} array/number node(s) found — the walker stopped descending`);
  });

  it('every array carries maxItems and every number a maximum, unless a ruling says why not', () => {
    const unbounded = ALL.filter(q => !bounded(q) && !open(q)).map(q => `${q.door} ${q.path} (${q.kind})`);
    assert.deepEqual(unbounded, [], `${unbounded.length} unbounded quantit(ies):\n  ${unbounded.join('\n  ')}\n`
      + 'Bound it from util/request-bounds.ts on EVERY door that takes it, or add a ruling above with the reason it does not cost.');
  });

  it('every ruling still has a subject', () => {
    const dead = OPEN_BY_RULING.filter(r => !ALL.some(q => !bounded(q) && r.test(q))).map(r => r.name);
    assert.deepEqual(dead, [], `ruling(s) that excuse nothing any more — delete them: ${dead.join(', ')}`);
  });

  it('a field that means one thing everywhere carries one bound everywhere', () => {
    assert.ok(BOUNDS?.BOUND_BY_FIELD, 'server/dist/util/request-bounds.js exports no BOUND_BY_FIELD — the one place the bounds live is missing');
    const wrong = [];
    for (const [field, max] of Object.entries(BOUNDS.BOUND_BY_FIELD)) {
      const sites = ALL.filter(q => q.kind === 'array' && q.seg === field && !q.path.endsWith('[]'));
      assert.ok(sites.length > 0, `no validator declares \`${field}\` — the name moved, and the bound on it now binds nothing`);
      for (const q of sites) if (q.node.maxItems !== max) wrong.push(`${q.door} ${q.path}: maxItems ${q.node.maxItems ?? 'absent'}, expected ${max}`);
    }
    assert.deepEqual(wrong, [], `a shared field bounded differently by door:\n  ${wrong.join('\n  ')}`);
  });

  it('an array of a closed set is bounded by the size of the set', () => {
    const loose = ALL.filter(q => q.kind === 'array' && Array.isArray(q.node.items?.enum)
      && !(q.node.maxItems <= q.node.items.enum.length))
      .map(q => `${q.door} ${q.path}: maxItems ${q.node.maxItems ?? 'absent'} for ${q.node.items.enum.length} value(s)`);
    assert.deepEqual(loose, [], `an enum array that admits repeats past its own size:\n  ${loose.join('\n  ')}`);
  });

  it('no REST body validator in server/src/api hides from this gate by being unexported', () => {
    const hidden = trackedSources('server/src/api', { untracked: true, floor: 20 }).flatMap(f =>
      [...stripComments(readFileSync(join(REPO_ROOT, f), 'utf8')).matchAll(/^const ([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*z\./gm)]
        .map(m => `${f}:${m[1]}`));
    assert.deepEqual(hidden, [], `unexported zod validator(s) this gate cannot read — export them: ${hidden.join(', ')}`);
  });
});
