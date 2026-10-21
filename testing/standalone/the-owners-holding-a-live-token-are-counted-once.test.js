/**
 * The view owners that still hold a live token are found by ONE function, `liveOwnerKeys` (`config/view-shape.ts`) (Q-531, bundle-100 row 7).
 *
 * ## The rule
 *
 * "Which owners still hold a live token" decides whether a revoke deletes an owner's views (`removeTokensFromConfig`: not while another of
 * its tokens is live), whether the grace sweep deletes them (`sweepOwnerlessViews`), and who receives the upgrade's copies (the live
 * instance-admin owners). It was spelled three times - a `new Set(tokens.filter(tokenIsLive).map(viewOwnerOf))`, a loop adding to a set,
 * and a second loop with an admin filter - so a change to what "live" or "owner" means had three places to land and a revoke and a sweep
 * could disagree about one owner. The admin variant is the same question over fewer tokens, so it is a filter on the argument, not a copy.
 *
 * Asserted over every tracked server source (derived, floor inside `trackedSources`): no source outside `view-shape.ts` builds a set of
 * owner keys from `tokenIsLive` and `viewOwnerOf` itself. A per-token check (is THIS caller's token live, whose view is it) is not a set
 * and is not matched.
 *
 * ## Seen red at 743562a5
 *
 * `auth/tokens.ts` (stillHeld), `config/views.ts` (sweepPlan) and `config/migrate-proxies-to-views.ts` (adminOwners) each built the set;
 * seen red by putting the stillHeld and adminOwners spellings back (both named), restored by hand.
 *
 * Run: node --test testing/standalone/the-owners-holding-a-live-token-are-counted-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const HOME = 'server/src/config/view-shape.ts';

/** A set of owner keys built from liveness: a Set over a filter/map, or a loop that adds an owner it judged live. */
const BUILDS_A_LIVE_OWNER_SET = [
  /new Set\([^;]*tokenIsLive\([^;]*viewOwnerOf\(/,
  /tokenIsLive\([^;]*\)[\s\S]{0,160}?viewOwnerOf\([^;]*\);[\s\S]{0,80}?\.add\(/,
  /viewOwnerOf\([^;]*\);[\s\S]{0,120}?tokenIsLive\([^)]*\)\)?\s*\w+\.add\(/,
];

describe('the owners holding a live token are counted once (Q-531)', () => {
  it('no source outside view-shape.ts builds the live-owner set itself', () => {
    const sources = readTrackedSources('server/src', { specs: false, untracked: true });
    const home = sources.find(s => s.file === HOME);
    assert.ok(home && /export function liveOwnerKeys\b/.test(home.text), `${HOME} no longer defines liveOwnerKeys: the rule has lost its home`);
    const built = sources
      .filter(s => s.file !== HOME)
      .filter(s => BUILDS_A_LIVE_OWNER_SET.some(re => re.test(stripComments(s.text))))
      .map(s => s.file);
    assert.deepEqual(built, [], 'sites that build the live-owner set themselves; ask liveOwnerKeys');
  });
});
