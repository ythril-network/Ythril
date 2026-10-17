/**
 * What happens when a peer's request meets a space is written ONCE, in `sync/peer-space-admission.ts`: the refusal's count, its `423 space_held` body and
 * the admission that enters the fence (bundle-106 PR A, the duplicate-rule sweep of the diff).
 *
 * ## What it prevents
 *
 * The three steps were spelled at five sites — the sync routes, the rights middleware and the tool dispatch — and the tool dispatch was the weaker copy:
 * it refused without counting and admitted without entering the fence. A rule written five times lets one of them rot silently, because each copy reads as
 * complete alone. The behaviour is held by `a-peers-tool-call-meets-a-held-space-as-every-door-does-db.test.js`; this holds the SHAPE, so a sixth door
 * cannot spell it again.
 *
 * ## What it derives
 *
 * Every tracked source under `server/src`, comments stripped. It asserts the set of modules that increment the held-refusals counter, the set that
 * names the held answer's body, and the set that enters the fence for a peer, each against the one reasoned owner list, with a floor so a scan of nothing
 * cannot pass.
 *
 * ## Seen red
 *
 * Run against 72f2a5d3 (the checkout before the fold): the counter is incremented in the sync helpers and the rights middleware, and the held body is
 * named in both, so the first two cases are red; the module does not exist, so the third is red.
 *
 * Run: node --test testing/standalone/a-peers-held-refusal-and-admission-are-written-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const ADMISSION = 'server/src/sync/peer-space-admission.ts';
/** Where the held body and the verdict a sender reads from it are DEFINED: the answer's own module, not a door. */
const HELD_ANSWER = 'server/src/sync/held-answer.ts';
/** The turn that exchanges with a peer outbound has no request to refuse: it enters the fence directly, and the hold's own module defines the entry. */
const ENTERS_THE_FENCE_FOR_ITS_OWN_REASON = ['server/src/sync/space-exchange.ts', 'server/src/sync/space-exchange-set.ts'];
/** The doors that must ask the one module, whatever else they do. */
const DOORS = ['server/src/api/sync/_shared.ts', 'server/src/auth/middleware.ts', 'server/src/mcp/call-tool.ts'];

const sources = () => trackedSources('server/src', { untracked: true, floor: 300 });
const code = (file) => stripComments(readFileSync(`${REPO_ROOT}/${file}`, 'utf8'));
const naming = (re) => sources().filter(f => re.test(code(f))).sort();

describe('a peer meeting a space is counted, answered and admitted by one module', () => {
  it('the module exists', () => {
    assert.ok(existsSync(`${REPO_ROOT}/${ADMISSION}`), `${ADMISSION} does not exist: each door spells the refusal and the admission itself`);
  });

  it('the held-refusals counter is incremented there and nowhere else', () => {
    assert.deepEqual(naming(/\bspaceHeldRefusalsTotal\.inc\s*\(/), [ADMISSION], 'a door counts a held refusal by hand: the door that forgets leaves the metric under-counting');
  });

  it('the held answer\'s body is named by its definition and by the admission only', () => {
    assert.deepEqual(naming(/\bSPACE_HELD_ANSWER\b/), [ADMISSION, HELD_ANSWER].sort(), 'a door answers `space_held` by hand instead of through the admission');
  });

  it('only the admission and the outbound turn enter the fence for a peer', () => {
    const entering = naming(/\benterSpaceTransfer\s*\(/).filter(f => !ENTERS_THE_FENCE_FOR_ITS_OWN_REASON.includes(f));
    assert.deepEqual(entering, [ADMISSION], 'a door enters the fence for a peer by hand: it must release in the same place it admits, and the admission already does');
  });

  it('every door that meets a peer asks it', () => {
    for (const door of DOORS) assert.match(code(door), /from '[./]+\/(?:sync\/)?peer-space-admission\.js'/, `${door} does not import the admission: it spells the refusal or the admission itself`);
  });
});
