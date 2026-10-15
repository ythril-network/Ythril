/**
 * Every space setting a caller can write is also reported where a caller learns the space's settings (Q-320, bundle-128,
 * design-v3 section 1.2 and 8.2 G11).
 *
 * ## The forgettable half
 *
 * A setting that cannot be read back shows its default after a reload even when the space is set otherwise: the Settings page
 * would say Warn while the space refuses. So a settable top-level key must appear in the `GET /api/spaces` projection and in the
 * MCP `list_spaces` answer (the second so that an integrator can learn the mode BEFORE it writes).
 *
 * ## Derived, with exemptions that say why
 *
 * The set is the top-level keys of `SPACE_FIELD_RIGHTS` (no `meta.` prefix), minus the write-only ones: `'nobody'` rows are
 * derived from the table, the rest are named with a reason. "Appears" means the key is an identifier in the projection's own
 * source (REST: the `visibleSpaces.map(...)` callback of `GET /api/spaces`; MCP: `list_spaces`' handler), read from
 * comment-stripped source with string contents blanked so a description cannot satisfy it.
 *
 * The first run on the unchanged base lists what is missing today. The new `unknownWriteFields` row does not exist yet, so it is
 * guarded by name as well (a derivation over a table that lacks the row would pass about it). Existing gaps that are NOT this
 * bundle's are listed as exemptions below naming their ticket (Q-503): design-v3 1.2 says each is "either fixed or becomes a reasoned
 * exemption naming a ticket". Every exemption is checked still to be a gap, so a fixed one must leave the list.
 *
 * Run: node --test testing/standalone/every-readable-space-setting-is-reported-by-both-read-doors.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { balancedFrom } from './_structural-window.mjs';
import { maskStrings, toolHandlerOf } from './_brain-write-pairs.mjs';

const { SPACE_FIELD_RIGHTS } = await import('../../server/dist/auth/space-field-rights.js');

/** Keys written through `PATCH /api/spaces/:id` that are never READ back, each with why. */
const WRITE_ONLY = new Map([
  ['typeSchemasMode', 'applied while the type map is written and not stored as a setting: the stored map is read through `meta`'],
  ['targetNetwork', 'an instruction to send a definition to a network, not a stored setting'],
]);

/** Settings the REST projection reports and `list_spaces` does not, until a ticket gives `list_spaces` them. */
const NOT_ON_LIST_SPACES = new Map(
  ['recordTtlDays', 'dupeRules', 'dupeMergeSurvivor', 'dupeRulesOnInsert', 'documentExtraction',
    'imageAnalysis', 'audioAnalysis', 'videoAnalysis', 'textAnalysis', 'faceDescriptorDims']
    .map(k => [k, { ticket: 'Q-503', why: '`list_spaces` reports identity, counts and quota; the instance-local settings are read through `space_meta` and `GET /api/spaces`' }]));

/** Settings the REST projection does not report today, until a ticket gives it them. */
const NOT_ON_REST = new Map([
  ['faceDescriptorDims', { ticket: 'Q-503', why: 'the face-descriptor width is not part of the `GET /api/spaces` projection today' }],
]);

const topLevel = Object.entries(SPACE_FIELD_RIGHTS).filter(([k]) => !k.includes('.'));
const nobody = new Set(topLevel.filter(([, v]) => v === 'nobody').map(([k]) => k));
const readable = topLevel.map(([k]) => k).filter(k => !nobody.has(k) && !WRITE_ONLY.has(k));

/** The identifiers of a source window, with strings and comments gone. */
const identifiersOf = (src) => new Set(maskStrings(stripComments(src)).match(/[A-Za-z_$][\w$]*/g) ?? []);

function restProjection() {
  const src = stripComments(readFileSync('server/src/api/spaces.ts', 'utf8'));
  const at = src.indexOf('const spaces = visibleSpaces.map(');
  assert.ok(at > -1, 'no `const spaces = visibleSpaces.map(` in api/spaces.ts — re-anchor this gate');
  return identifiersOf(balancedFrom(src, src.indexOf('(', at)));
}
const listSpaces = () => identifiersOf(toolHandlerOf('list_spaces').handle);

describe('every settable space setting is reported by GET /api/spaces and list_spaces', () => {
  it('derives its subjects, with a floor', () => {
    assert.ok(topLevel.length >= 8, `only ${topLevel.length} top-level rights rows`);
    assert.ok(readable.length >= 8, `only ${readable.length} readable keys were derived`);
    assert.ok(nobody.size >= 1, 'no `nobody` row: the write-only derivation read nothing');
  });

  it('the new setting is governed, so the derivation below covers it (a table without the row would pass about it)', () => {
    assert.ok(readable.includes('unknownWriteFields'), 'SPACE_FIELD_RIGHTS has no top-level `unknownWriteFields` row');
  });

  it('GET /api/spaces reports each readable setting', () => {
    const projected = restProjection();
    assert.ok(projected.has('unknownWriteFields'), 'the GET /api/spaces projection does not carry unknownWriteFields, so the Settings page shows Warn after a reload for a space that refuses');
    const missing = readable.filter(k => !projected.has(k) && !NOT_ON_REST.has(k));
    assert.deepEqual(missing, [], 'these settings can be written and are not in the GET /api/spaces projection, so the Settings page shows their default');
  });

  it('list_spaces reports each readable setting', () => {
    const listed = listSpaces();
    assert.ok(listed.has('unknownWriteFields'), 'list_spaces does not report unknownWriteFields, so an integrator cannot learn the mode before it writes');
    const missing = readable.filter(k => !listed.has(k) && !NOT_ON_LIST_SPACES.has(k));
    assert.deepEqual(missing, [], 'these settings can be written and `list_spaces` does not report them, so an integrator cannot learn them before writing');
  });

  it('every exemption is still a gap and names a key the table has (a fixed one leaves the list)', () => {
    const projected = restProjection();
    const listed = listSpaces();
    const stale = [
      ...[...NOT_ON_REST.keys()].filter(k => !readable.includes(k) || projected.has(k)),
      ...[...NOT_ON_LIST_SPACES.keys()].filter(k => !readable.includes(k) || listed.has(k)),
    ];
    assert.deepEqual(stale, [], 'these exemptions no longer describe a gap');
  });
});