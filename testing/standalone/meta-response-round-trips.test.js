/**
 * Every field `GET /api/spaces/:id/meta` emits can be PATCHed straight back.
 *
 * ## The report this answers, and the way it keeps coming back
 *
 * An integrator did the obvious thing — `GET` a space, edit one field of `meta.typeSchemas`, `PATCH` it back —
 * and got `unrecognized_keys` for three fields they never wrote and could not have known to remove. Their ask
 * was *"either merge, or do not return what you will not accept"*, and `SERVER_OWNED_META_FIELDS` is the second
 * half of the answer: those fields are stripped from an incoming body rather than refused.
 *
 * **It broke again the moment the response grew a field.** `needsReindex` was added so an MCP caller could poll
 * after `reindex`, and `type-schema-crud.test.js` went red in CI — it round-trips a real response rather than a
 * hand-built body, which is the only reason it noticed. That is a good test and a slow signal: it needs Docker,
 * Mongo, and four minutes.
 *
 * This gate is the fast half. It reads the fields the handler assembles and requires each one to be either a
 * known envelope field or a member of the strip list — so adding a field to the response and forgetting the
 * strip fails in seconds, at the desk, instead of in CI.
 *
 * ## Why the envelope list is spelled out here
 *
 * `spaceId`, `spaceName` and `stats` sit OUTSIDE `meta` in the response, and a caller peels them off before
 * PATCHing `{meta}` back — the integration test's own `metaFrom` does exactly that. They are not in the strip
 * list and must not be: `.strict()` refusing `spaceId` inside `meta` is correct.
 *
 * Run: node --test testing/standalone/meta-response-round-trips.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { SERVER_OWNED_META_FIELDS } = await import('../../server/dist/spaces/body-schemas.js');

/** Line comments first — see `Q-1`: a `/*` inside a `//` comment otherwise opens a phantom block. */
const strip = s => s.replace(/(^|[^:])\/\/.*/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

/** Fields that live outside `meta` in the response, which a caller peels off rather than sending back. */
const ENVELOPE = new Set(['spaceId', 'spaceName', 'stats']);

/**
 * The object the meta answer assembles, as a list of top-level keys.
 *
 * Read from `spaceMetaAnswer`, which both doors return since `Q-95` — the route itself is one line now, and
 * `space-meta-is-one-answer-on-both-doors.test.js` holds it to calling this function.
 */
function metaResponseKeys() {
  const src = strip(readFileSync('server/src/spaces/space-meta-answer.ts', 'utf8'));
  const at = src.indexOf('export async function spaceMetaAnswer');
  assert.ok(at > -1, 'the meta answer moved — this gate reads it by name');
  const body = src.slice(at);
  const open = body.indexOf('return {');
  assert.ok(open > 0, 'could not find the response object');
  const json = body.slice(open);
  const close = json.indexOf('\n  };');
  assert.ok(close > 0, 'could not find the end of the response object');
  const literal = json.slice('return {'.length, close);
  return [...literal.matchAll(/^\s*(?:\.\.\.)?(\w+)\s*[:,]/gm)].map(m => m[1]);
}

describe('the meta response and the PATCH strip agree', () => {
  const keys = metaResponseKeys();

  it('the extraction found the response, not an empty string', () => {
    // Without this the loop below passes for ever on a regex that stopped matching.
    assert.ok(keys.length >= 4, `expected several response fields, got ${JSON.stringify(keys)}`);
    assert.ok(keys.includes('spaceId'), `expected spaceId among ${JSON.stringify(keys)}`);
  });

  it('every emitted field is an envelope field, the meta spread, or stripped on the way back in', () => {
    const stripped = new Set(SERVER_OWNED_META_FIELDS);
    const offenders = keys.filter(k => !ENVELOPE.has(k) && !stripped.has(k) && k !== 'metaPublic' && k !== 'meta');
    assert.deepEqual(offenders, [], `these fields are returned but would be refused on PATCH: ${offenders.join(', ')}. `
      + 'Add each to SERVER_OWNED_META_FIELDS (derived and server-written) or to the envelope, or stop returning it '
      + '— "do not return what you will not accept".');
  });

  it('needsReindex specifically, because it is the one that broke this', () => {
    assert.ok(keys.includes('needsReindex'), 'the reindex state must still be on the response — `reindex` tells '
      + 'callers to poll it');
    assert.ok(SERVER_OWNED_META_FIELDS.includes('needsReindex'), 'and must still be stripped on the way back in');
  });

  it('the strip stays SMALL — it is not a licence to ignore unknown keys', () => {
    // The distinction is the whole design: an echoed-back field costs the caller nothing to drop, while
    // silently ignoring `validationMdoe` would let someone believe they had turned validation on.
    assert.ok(SERVER_OWNED_META_FIELDS.length <= 6,
      `${SERVER_OWNED_META_FIELDS.length} stripped fields is heading towards "accept anything": `
      + SERVER_OWNED_META_FIELDS.join(', '));
  });
});
