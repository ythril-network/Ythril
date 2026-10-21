/**
 * A door decides whether a space exists only through the one existence answer (`spaces/unknown-space.ts`), never in its own words
 * (Q-531, bundle-100, plan rev 3.2 arch S3).
 *
 * ## The rule
 *
 * Whether a door can serve the space id it was handed has four answers - a space, a retired proxy id (`410 space_retired`), the caller's own
 * view on a door that does not take one (`404` with the owner-only hint), nothing (`404 Space '<id>' not found`) - and ONE function gives
 * them: `unknownSpaceAnswer`, with `lostSpaceAnswer` for a site that has already found the id missing (or lost it between a plan and its
 * write). A REST route asks it through ONE wrapper module, `api/write-target-answer.ts` (`answeredUnknownSpace`, `writeSpaceOf`,
 * `sendLostSpace`).
 *
 * The diff pass on Q-531 found about thirty-five sites that tested `cfg.spaces.some(...)` and answered `404`/`400` in their own words.
 * Each was correct for a space and wrong for a retired id (it answered `404` where every path route answers `410`), and three of them said
 * it as `400 Unknown space(s): ...`. A second wrapper (`requireKnownSpace`) re-spelled the first. So this asserts, over every tracked
 * server source:
 *
 * 1. **the words are spelled once.** No source outside the module writes the unknown-space sentence (`Space '<id>' not found`), the bare
 *    `Space not found`, or `Unknown space(s):` - a site that spells them decided existence itself.
 * 2. **the REST half has one wrapper.** The request-shaped answers (`answerUnknownSpace`, `answerLostSpace`) are called from
 *    `api/write-target-answer.ts` alone; every route goes through it.
 *
 * Both sets are DERIVED from the tracked sources (`trackedSources`, floor inside), and the askers of the module carry a floor of their own,
 * so a broken import scan cannot pass about nothing.
 *
 * ## Seen red
 *
 * Re-adding `res.status(404).json({ error: \`Space '${id}' not found\` })` to `GET /api/spaces/:id/meta` fails rule 1 naming
 * `server/src/api/spaces.ts`; a route calling `answerUnknownSpace` itself fails rule 2. Both restored by hand.
 *
 * Run: node --test testing/standalone/a-door-decides-space-existence-only-through-the-one-answer.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const MODULE = 'server/src/spaces/unknown-space.ts';
const REST_WRAPPER = 'server/src/api/write-target-answer.ts';

const sources = readTrackedSources('server/src', { specs: false, untracked: true })
  .filter(s => s.file !== MODULE)
  .map(s => ({ file: s.file, code: stripComments(s.text) }));

/** The spellings of "this space does not exist" a door wrote by hand. */
const OWN_WORDS = [
  /Space '\$\{[^}]+\}' not found[`'"]/,
  /['"`]Space not found['"`]/,
  /Unknown spaces?:/,
];

describe('a door decides space existence only through the one answer (Q-531)', () => {
  it('no source outside unknown-space.ts spells the unknown-space words', () => {
    const spelled = sources.flatMap(s => OWN_WORDS.filter(re => re.test(s.code)).map(re => `${s.file}: ${re}`));
    assert.deepEqual(spelled, [], 'sites that decide space existence in their own words; answer through unknownSpaceAnswer / lostSpaceAnswer');
  });

  it('the request-shaped answers are called from the one REST wrapper alone', () => {
    const askers = sources.filter(s => /\b(unknownSpaceAnswer|lostSpaceAnswer|answeredUnknownSpace|writeSpaceOf|sendLostSpace)\s*\(/.test(s.code));
    assert.ok(askers.length >= 20, `derived ${askers.length} asker(s) of the existence answer: the scan is broken`);
    const outside = sources
      .filter(s => s.file !== REST_WRAPPER && /\b(answerUnknownSpace|answerLostSpace)\s*\(/.test(s.code))
      .map(s => s.file);
    assert.deepEqual(outside, [], `routes that call the request-shaped answer themselves; go through ${REST_WRAPPER}`);
  });
});
