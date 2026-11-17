/**
 * Every model slot the product declares is resolved by something.
 *
 * ## The hole this closes (`Q-8`)
 *
 * `docVerify` was declared in `MODEL_SLOTS`, given a default budget in `MODEL_SLOT_DEFAULT_MS`, accepted by
 * the admin PATCH, listed in `pinned-fields.ts` so infrastructure could fix it, and documented in the field
 * table an integrator reads. **No code resolved it.** The second-opinion pass runs against its own endpoint —
 * a deliberately different model — and charged everything to `docVlm`: its call budget, its egress permission
 * and, once that shipped, its reasoning effort.
 *
 * So an operator who set `modelSlots.docVerify.timeoutMs` because their verify model is slower got no effect
 * and no warning. The setting was accepted, stored, echoed back and pinnable. That is the failure shape this
 * repository keeps paying for: a control that looks applied and never was.
 *
 * ## Why this gate is derived rather than a test for one slot
 *
 * A test asserting "the verify call passes `docVerify`" would pass forever and say nothing about the
 * ELEVENTH slot somebody declares next year. The rule is that a declared slot has a reader, so the check
 * reads `MODEL_SLOTS` and looks for each name in the source that resolves slots. A slot added without a
 * reader fails here on the day it is added, which is the only day it is cheap to fix.
 */
import { test } from 'node:test';
import { trackedSources, SERVER_CODE_ROOTS } from './_sources.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODEL_SLOTS } from '../../server/dist/config/model-slots.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The call shapes that RESOLVE a slot, as opposed to declaring one.
 *
 * The first version of this gate listed five files as "declaration only" and asked whether the slot appeared
 * anywhere else. It was already wrong when it was written: `model-egress-exposure.ts` maps each slot's
 * aliases, which is a sixth declaration, and that mention alone made the gate pass while the defect was
 * planted underneath it. A hand-maintained list of exemptions is precisely what this repository has a rule
 * against, and I wrote one anyway.
 *
 * So the question is inverted. Not *"does this name appear outside the places I thought of"* but *"is it
 * handed to something that uses it"* — one of the three resolvers, or a call site naming its own slot. A new
 * resolver needs a row here, which is a deliberate cost: one line, in the file that would otherwise quietly
 * stop covering it.
 */
const RESOLVED_BY = [
  slot => new RegExp(`slotTimeoutMs\\(\\s*'${slot}'`),
  slot => new RegExp(`allowPrivateForSlot\\(\\s*'${slot}'`),
  slot => new RegExp(`reasoningEffortBody\\(\\s*'${slot}'`),
  slot => new RegExp(`slot:\\s*'${slot}'`),
  slot => new RegExp(`\\?\\?\\s*'${slot}'`),
  slot => new RegExp(`asEndpoint\\([^,]+,\\s*'${slot}'`),
];

test('every declared model slot is RESOLVED somewhere, not merely declared', () => {
  const listed = trackedSources(SERVER_CODE_ROOTS);
  const source = listed.map(f => readFileSync(join(repoRoot, f), 'utf8')).join('\n');

  const unread = MODEL_SLOTS.filter(slot => !RESOLVED_BY.some(shape => shape(slot).test(source)));
  assert.deepEqual(unread, [],
    `these slots are declared, documented and settable, and NOTHING resolves them: ${unread.join(', ')}. `
    + 'An operator can set one, have it stored, echoed back and pinned by infrastructure, and it will do '
    + 'nothing — with no warning anywhere. Either resolve it at the call it belongs to, or remove it from '
    + 'the vocabulary and the guide.');
});

test('the verify pass is charged to docVerify, not to the primary vision slot', () => {
  // The specific case Q-8 was filed for, kept beside the derived rule: the second-opinion pass runs on its
  // own endpoint, and the slot it names decides its budget, its egress permission and its reasoning effort.
  const extract = readFileSync(join(repoRoot, 'server/src/files/converters/vlm-extract.ts'), 'utf8');
  assert.match(extract, /\.\.\.verifyEp,\s*slot:\s*'docVerify'/,
    'the verify pass no longer names its own slot, so it is charged to docVlm again');
});

test('a caller that names no slot still gets the one it always had', () => {
  /*
   * The compatibility half. Making the slot settable is only safe because the default is unchanged — every
   * existing caller passes no slot and must keep resolving `docVlm`, or this fix silently re-points the
   * primary transcription at a budget nobody set for it.
   */
  const client = readFileSync(join(repoRoot, 'server/src/files/converters/vlm-client.ts'), 'utf8');
  const defaults = [...client.matchAll(/opts\.slot \?\? '([a-zA-Z]+)'/g)].map(m => m[1]);
  assert.ok(defaults.length >= 3, `expected a slot default at every call site, found ${defaults.length}`);

  /*
   * Each site keeps ITS OWN default — transcription and consensus on the vision slot, repair on the repair
   * slot — which is what those three functions always resolved. The first version of this asserted every
   * default was `docVlm` and went red on the repair site, which had carried its own default all along: the
   * test was wrong, not the code, and asserting one value would have made a genuinely correct third caller
   * look like a regression.
   */
  assert.deepEqual([...new Set(defaults)].sort(), ['docRepair', 'docVlm'],
    `unexpected slot defaults: ${defaults.join(', ')}`);
});
