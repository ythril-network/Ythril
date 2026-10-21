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
 * Asserted over every tracked server source (derived, floor inside `serverSources`), bounded by the FUNCTION, never by a character count:
 * every function outside `view-shape.ts` that asks `tokenIsLive` and `viewOwnerOf` and collects into a set (`new Set`, `.add(`) is
 * building the live-owner set itself. A per-token check (is THIS caller's token live, whose view is it) collects nothing and is not matched.
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
import { serverSources, sitesOf } from './_view-gates.mjs';

const HOME = 'server/src/config/view-shape.ts';
const asksOwner = (text) => /\bviewOwnerOf\s*\(/.test(text);
const collects = (text) => /\bnew Set\b|\.add\s*\(/.test(text);

describe('the owners holding a live token are counted once (Q-531)', () => {
  it('no source outside view-shape.ts builds the live-owner set itself', () => {
    const sources = serverSources();
    const home = sources.find(s => s.file === HOME);
    assert.ok(home && /export function liveOwnerKeys\b/.test(home.text), `${HOME} no longer defines liveOwnerKeys: the rule has lost its home`);
    const sites = sitesOf(sources, String.raw`\btokenIsLive\s*\(`, { files: f => f !== HOME, widenUntil: asksOwner });
    const built = [...new Set(sites.filter(s => asksOwner(s.fnText) && collects(s.fnText)).map(s => `${s.file} ${s.fn}`))];
    assert.deepEqual(built, [], 'functions that build the live-owner set themselves; ask liveOwnerKeys');
  });
});
