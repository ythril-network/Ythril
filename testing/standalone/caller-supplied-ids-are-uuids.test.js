/**
 * Every caller-supplied `id` on an MCP write tool is constrained to a UUID v4.
 *
 * ## What happened
 *
 * An operator passed a corrupted UUID to `save_chrono` — *"a Devanagari digit where a hex nibble belonged"* —
 * and it stored **silently**. Nothing broke: the record came back, and its `entityIds` linkage resolved fine.
 *
 * What was lost is the only reason that field exists. A caller supplies `id` to make the call **idempotent** —
 * retrying with the same id converges on the same record instead of writing a second one. An id no generator
 * would ever produce again cannot serve that purpose, so the retry it was there to enable can never fire.
 *
 * `save_entity` had it right, via a shared `uuidSchema()` helper. `save_chrono` and `remember` hand-rolled
 * the declaration and only **described** "Optional UUID v4" in prose, with no `pattern` at all — so the docs
 * promised a constraint the schema never applied.
 *
 * ## The fourth one, which nobody reported
 *
 * The report named two tools and inferred a third it deliberately did not test (writing a junk record to prove
 * it is a poor trade). Sweeping by SHAPE instead of by those names found **`save_bulk`** as well — the same
 * hand-rolled declaration, on the tool most likely to be handed machine-generated ids in volume.
 *
 * That is why this gate reads the tool schemas rather than checking three file names: a per-tool fix leaves the
 * instance nobody happened to hit.
 *
 * ## Why prose is not enough, stated as a test
 *
 * `'description': 'Optional UUID v4'` and `pattern: UUID_V4_PATTERN` look equally reassuring in a diff and are
 * not remotely equal at runtime. Two of the four had the first and not the second, which is exactly how this
 * survived review — so the assertion below deliberately ignores descriptions.
 *
 * Run: node --test testing/standalone/caller-supplied-ids-are-uuids.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { balancedFrom } from './_structural-window.mjs';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const files = execSync('git ls-files "server/src/mcp/tools/*.ts"', { encoding: 'utf8' })
  .trim().split('\n').filter(f => f && !f.endsWith('.spec.ts'));

/**
 * Every `id:` property declaration in a tool's inputSchema, with how it is constrained.
 *
 * `create` here means the declaration is optional — a caller CHOOSING an id, which is the idempotency contract.
 * An `id` on update/delete names a record that already exists; those are covered too, because an id that could
 * not have been created cannot be addressed either.
 */
function idDeclarations(src) {
  const out = [];
  /*
   * A WINDOW, converted: an `id:` declaration is either a `uuidSchema(` call or an OBJECT, and an object is
   * bounded by the brace that closes it — not by 400 characters of whatever follows.
   *
   * The cap decided in advance how large a declaration could be. A schema that grew past it matched a
   * TRUNCATED blob, and every judgement below then read a fragment: `required` could fall outside the window
   * and a constrained declaration would be reported as permissive. A positive check would go red and a
   * negative one would quietly pass, which is the worse half.
   */
  for (const m of src.matchAll(/^(\s+)id:\s*(uuidSchema\(|\{)/gm)) {
    const line = src.slice(0, m.index).split('\n').length;
    const blob = m[2] === '{'
      ? balancedFrom(src, src.indexOf('{', m.index), `the id declaration at line ${line}`)
      : m[2];
    // A REQUIRED id addresses a record that already exists. Those are deliberately left permissive: records
    // written before this fix may carry a non-UUID id — the reporting operator has one — and constraining the
    // update and delete paths would make exactly those records unfixable and undeletable. Being unable to
    // delete the junk record you were warned not to create is worse than the bug being fixed.
    //
    // An OPTIONAL id is the caller CHOOSING one, which is the idempotency contract and the only case where a
    // malformed value silently destroys the field's purpose. Read from the schema's own `required` array, not
    // from the description — prose is what made two of these look constrained when they were not.
    // EVERY `required` array in the window, not the first: `update_chrono` nests a recurrence object whose own
    // `required: ['freq']` sits between the id and the schema's real one, so taking the first match read the
    // wrong list and called a required id optional.
    //
    // The window ends at the NEXT tool, not after a fixed 4000 characters. It was a fixed count, and that is a
    // guard on the wrong axis: it bounds DISTANCE while the thing between the id and its `required` array is
    // parameter PROSE, which has no bound at all. Writing four sentences onto `update_chrono`'s parameters
    // pushed its own `required: ['space', 'id']` past the cutoff, so a required id read as caller-supplied and
    // this gate failed on a tool nobody had changed the shape of. A schema cannot outrun its own module.
    const nextTool = src.indexOf('export const ', m.index + 1);
    const window = src.slice(m.index, nextTool > 0 ? nextTool : undefined);
    const addressesExisting = [...window.matchAll(/required:\s*\[([^\]]*)\]/g)].some(r => /'id'/.test(r[1]));
    out.push({ line, helper: blob.startsWith('uuidSchema('), blob, addressesExisting });
  }
  return out;
}

describe('a caller-supplied id must be a UUID', () => {
  it('finds the tool schemas it is meant to be checking', () => {
    // A sweep that enumerates nothing passes vacuously — and this gate exists because a sweep scoped to three
    // remembered names missed a fourth tool.
    assert.ok(files.length >= 5, `expected the MCP tool modules, found ${files.length}`);
    const total = files.reduce((n, f) => n + idDeclarations(readFileSync(f, 'utf8')).length, 0);
    assert.ok(total >= 8, `expected several id declarations across the tools, found ${total}`);
  });

  /**
   * The SPACE-id slug, which is a different identity from a record id and constrained differently on purpose.
   *
   * A record id is server-generated and a caller supplies one only to be idempotent, so anything but a UUID
   * destroys the field's purpose. A space id is **chosen by a human**, appears in every URL and collection name,
   * and is documented as a slug — `save_space` would be unusable if it demanded a UUID.
   *
   * So this is an allowlist of identity SHAPES, not of tools. That distinction is the whole point: a per-tool
   * exemption is what let the original defect hide in a fourth tool nobody named, and it would let the next
   * unconstrained record id in behind a name. Two shapes are recognised, both explicit, and everything else is
   * still refused.
   */
  const SPACE_ID_PATTERN = "'^[a-z0-9-]+$'";

  it('every id declaration is constrained, not merely described', () => {
    const open = [];
    for (const f of files) {
      for (const d of idDeclarations(readFileSync(f, 'utf8'))) {
        if (d.addressesExisting) continue;                          // update/delete — see idDeclarations
        if (d.helper) continue;                                     // uuidSchema() carries the pattern
        if (/pattern:\s*UUID_V4_PATTERN/.test(d.blob)) continue;     // spelled out inline is fine too
        if (d.blob.includes(`pattern: ${SPACE_ID_PATTERN}`)) continue; // a space id is a slug, not a record id
        open.push(`${f.split('/').pop()}:${d.line}`);
      }
    }
    assert.deepEqual(open, [],
      'these accept any string as an id, so a corrupted one stores silently and the idempotent retry the field '
      + `exists for can never fire:\n  ${open.join('\n  ')}`);
  });

  it('the space-id slug the exemption recognises is the one the REST body enforces', () => {
    // This is what keeps the second shape from being a hole. If the tool and the route disagreed about what a space
    // id may contain, the looser one would decide — and the exemption above would be the reason nobody noticed.
    // Asserted against the request-body schema rather than against a copy of the regex.
    const bodies = readFileSync('server/src/spaces/body-schemas.ts', 'utf8');
    const create = bodies.slice(bodies.indexOf('export const CreateSpaceBody'));
    assert.match(create.slice(0, 400), /id: z\.string\(\)\.min\(1\)\.max\(40\)\.regex\(\/\^\[a-z0-9-\]\+\$\/\)/,
      'the REST create body no longer enforces the slug this exemption is written against — reconcile them');

    const tools = readFileSync('server/src/mcp/tools/spaces.ts', 'utf8');
    assert.ok(tools.includes(`pattern: ${SPACE_ID_PATTERN}`),
      'no tool declares the space-id slug, so this exemption is either unused or misspelled');
    assert.match(tools, /maxLength: 40, pattern: '\^\[a-z0-9-\]\+\$'/,
      'the tool must also carry the same 40-character bound as the body, or the two surfaces accept different ids');
  });

  it('a DESCRIPTION mentioning UUID does not count as a constraint', () => {
    // The exact shape that shipped: prose promising "Optional UUID v4" with no pattern. If this gate accepted a
    // description it would have passed on the original bug, which is the only failure mode worth ruling out.
    const fake = "      id: { type: 'string', description: 'Optional UUID v4. Supply one to be idempotent.' },";
    const [d] = idDeclarations(fake);
    assert.ok(d, 'the parser must see this declaration at all');
    assert.equal(d.helper, false);
    assert.ok(!/pattern:\s*UUID_V4_PATTERN/.test(d.blob),
      'a description mentioning UUID must not satisfy the constraint check');
  });

  it('the shared helper really carries the pattern', () => {
    // The other half. Every fix above routes through `uuidSchema()`, so an empty helper would silently unfix
    // all four while this file stayed green.
    const shared = readFileSync('server/src/mcp/tools/shared.ts', 'utf8');
    assert.match(shared, /export function uuidSchema\(description: string\) \{\s*\n\s*return \{ type: 'string', pattern: UUID_V4_PATTERN, description \}/,
      'uuidSchema no longer applies the pattern — every caller of it is unconstrained');
    assert.match(shared, /UUID_V4_PATTERN = '\^\[0-9a-fA-F\]\{8\}-/, 'the pattern itself is gone');
  });
});
