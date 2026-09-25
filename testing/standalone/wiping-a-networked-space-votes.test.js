/**
 * X-5: emptying a space the network shares is a GOVERNED act.
 *
 * ## The ruling and what it dissolves
 *
 * Owner, 2026-08-16: *"thats a voting thing."* I had offered three options — propagate the wipe, refuse it
 * without a flag, or leave it documented — and the ruling is none of them.
 *
 * `wipeSpace` deletes the documents and then deletes the TOMBSTONES too, writing none. Tombstones are this
 * codebase's only way of telling a peer a record is gone, so a wipe left an empty space with no record of
 * any deletion, facing a peer that still offered everything. The next sync put it back.
 *
 * A vote does not fix the tombstone problem — it removes it. A wipe every member agreed to needs nothing to
 * survive a peer's manifest, because the peers are wiping too.
 *
 * ## What this file pins
 *
 * **One planner, both doors.** REST (`POST /api/admin/spaces/:spaceId/wipe`) and MCP (`delete_space_data`) both ask
 * `planSpaceWipe`. A second copy of "is this space governed" is the defect this repo produces most, and here
 * it would mean one surface wiping immediately while the other voted.
 *
 * **One side-effect, three conclusion sites.** A round concludes on an operator's own vote, on a peer's vote
 * arriving over sync, and in the gossip pass. `space_deletion` writes its side-effect out three times;
 * `space_wipe` calls one function from all three, so a change cannot reach two of them and miss the third.
 *
 * **The types voted for are the types wiped.** `wipeTypes` rides on the round. Resolving it at conclusion
 * would let a round approved for `files` conclude by emptying the knowledge graph.
 *
 * Run: node --test testing/standalone/wiping-a-networked-space-votes.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

describe('the decision lives in one place, and both doors ask it', () => {
  it('the REST route calls the planner', () => {
    assert.match(src('server/src/app.ts'), /planSpaceWipe\(spaceId, rawTypes\)/,
      'the wipe route must not decide for itself whether a space is governed');
  });

  it('the brain-side wipe asks it ONCE, in a module both doors call', () => {
    /*
     * THIS USED TO ASSERT THAT EACH DOOR MENTIONED THE PLANNER, and passing it was never the same as the
     * rule holding — the five per-collection `DELETE` routes called `bulkDelete<Collection>` directly and
     * were not read by this gate at all. On a networked space the tool opened a vote and those deleted the
     * data, with nothing reporting it, because each door did exactly what its own code said.
     *
     * `spaces/delete-space-data.ts` is now the capability and both doors are adapters over it, so "one
     * rule" is structural rather than something two greps agree about. What is asserted is that neither
     * adapter has grown a copy back.
     */
    assert.match(src('server/src/spaces/delete-space-data.ts'), /planSpaceWipe\(space, types\)/,
      'the shared module must be the thing that asks whether this space is governed');

    assert.match(src('server/src/mcp/tools/spaces.ts'), /deleteSpaceData\(/,
      'the tool must call the shared capability rather than wiping directly');

    /*
     * The REST side has no wipe code left to check, and that is the assertion.
     *
     * `POST /api/delete_space_data` is served by the generic tool door, which hands the body to `callTool`
     * and therefore to the same tool handler. So there is no second place to put a wipe — and the gate
     * asserts the ABSENCE, because the way this comes back is somebody adding a convenience route beside
     * the generic one and calling the collection wipe from it, exactly as the five old routes did.
     */
    const restDoor = src('server/src/api/tools.ts');
    assert.match(restDoor, /callTool\(/, 'the REST door must dispatch through the shared function');
    for (const reachingPast of [/wipeSpace\(/, /bulkDelete/, /planSpaceWipe\(/, /deleteSpaceData\(/]) {
      assert.doesNotMatch(restDoor, reachingPast,
        'the REST door names the wipe directly — a door with its own path to the data is how the five old '
        + 'routes came to skip the network vote the tool opened');
    }
  });

  it('neither door reimplements "which networks hold this space"', () => {
    // The specific duplication to avoid: `cfg.networks.filter(n => n.spaces.includes(id))` written again at
    // a call site. `networksHolding` exists so the answer has one definition.
    for (const f of ['server/src/app.ts', 'server/src/mcp/tools/spaces.ts']) {
      assert.doesNotMatch(src(f), /networks\.filter\(n => n\.spaces\.includes\(\s*(spaceId|callSpace)\s*\)\)/,
        `${f} re-derives the governed set instead of asking the planner`);
    }
  });

  it('and a wipe is not started when the plan says governed', () => {
    // The assertion that makes this a behaviour change rather than a notification: the governed branch must
    // RETURN before `wipeSpace` runs, on both doors.
    const app = src('server/src/app.ts');
    const governedAt = app.indexOf('if (plan.governed)');
    const wipeAt = app.indexOf('await wipeSpace(spaceId');
    assert.ok(governedAt > 0 && wipeAt > governedAt,
      'the governed branch must come BEFORE the wipe, or the vote is decoration');
    assert.match(app.slice(governedAt, wipeAt), /return;/, 'and it must return');
  });
});

describe('a space in no network is untouched by this', () => {
  it('the planner says not-governed when nothing holds the space', () => {
    assert.match(src('server/src/spaces/wipe-vote.ts'), /if \(nets\.length === 0\) return \{ governed: false \}/,
      'an unnetworked wipe stays immediate, final, and exactly what it was');
  });
});

describe('the round carries what was voted for', () => {
  it('wipeTypes rides on the round rather than being resolved later', () => {
    const plan = src('server/src/spaces/wipe-vote.ts');
    assert.match(plan, /wipeTypes: \[\.\.\.types\]/, 'stored when a subset was asked for');
    assert.match(plan, /type: 'space_wipe'/, 'under its own round type');
  });

  it('and the side-effect reads them off the round, never a fresh default', () => {
    // The dangerous shortcut: defaulting to "all five" at conclusion would empty the knowledge graph on a
    // round the members approved for files only.
    const apply = src('server/src/spaces/apply-wipe-round.js'.replace('.js', '.ts'));
    assert.match(apply, /round\.wipeTypes as WipeCollectionType\[\] \| undefined/,
      'the types come from the round');
    assert.doesNotMatch(apply, /WIPE_COLLECTION_TYPES/,
      'no fallback to everything — an absent wipeTypes already means all five inside wipeSpace');
  });

  it('the round type is declared', () => {
    assert.match(src('server/src/config/types-networks.ts'), /'space_deletion' \| 'space_wipe'/,
      'space_wipe must be a VoteRoundType');
  });
});

describe('all three conclusion sites apply it, through one function', () => {
  // One spelling (S-9): every site hands its rounds to `applyConcludedSpaceRounds`, which decides deletion and wipe
  // through `spaceRoundAction` — the inline `space_deletion` copies in the two vote handlers are gone. Both routes through `apply-wipe-round.ts`, which
  // is what the last assertion in this block actually guarantees.
  for (const [file, where, call] of [
    ['server/src/api/networks/votes.ts', 'an operator voting locally', /applyConcludedSpaceRounds\(net, \[round\], /],
    ['server/src/api/sync/votes.ts', "a peer's vote arriving", /applyConcludedSpaceRounds\(net, \[round\], /],
    ['server/src/sync/engine.ts', 'the gossip pass', /applyConcludedSpaceRounds\(/],
  ]) {
    it(`${where} concludes the wipe`, () => {
      assert.match(src(file), call,
        `${file} must apply a concluded wipe — a site that misses it leaves this instance holding data every peer deleted`);
    });
  }

  it('and the side-effect is not written out three times', () => {
    // `space_deletion` IS written out three times, which is the shape this avoids: a change that reaches two
    // sites and silently misses the third.
    for (const f of ['server/src/api/networks/votes.ts', 'server/src/api/sync/votes.ts', 'server/src/sync/engine.ts']) {
      assert.doesNotMatch(src(f), /wipeSpace\(/, `${f} must call the shared function, not wipe directly`);
    }
  });

  it('a single veto stops it, as for space_deletion', () => {
    assert.match(src('server/src/spaces/apply-wipe-round.ts'), /votes\.some\(v => v\.vote === 'veto'\)/,
      'a member that does not want its copy emptied is not outvoted — the wipe is irreversible there too');
  });
});

describe('peers are told a round is open', () => {
  it('the notify event exists and is accepted', () => {
    assert.match(src('server/src/api/notify.ts'), /'space_wipe_pending'/, 'declared in the accepted enum');
  });

  it('and it triggers an immediate sync, like space_deletion_pending', () => {
    // A deadline that expires before anyone sees the round is a vote nobody got to cast.
    assert.match(src('server/src/api/notify.ts'),
      /event === 'space_deletion_pending' \|\| event === 'space_wipe_pending'/,
      'both irreversible space-scoped rounds pull immediately rather than waiting for the schedule');
  });

  it('the peers are told, and from the one place that decides', () => {
    // Notifying from an adapter would be a second copy of the same decision: the door that forgot would
    // open a round its peers never heard about, and a round nobody sees is a vote nobody casts.
    assert.match(src('server/src/spaces/delete-space-data.ts'), /notifyPeersOfWipe\(/,
      'the shared capability must tell the peers');
    assert.match(src('server/src/app.ts'), /notifyPeersOfWipe\(/,
      'the admin-side space wipe is a different route and still notifies on its own');
  });
});

describe('the tool says what actually happens', () => {
  const DESC = (() => {
    const s = stripComments(readFileSync('server/src/mcp/tools/spaces.ts', 'utf8'));
    const at = s.indexOf("name: 'delete_space_data'");
    const d = s.indexOf('description:', at);
    const end = s.slice(d).search(/\n {2,}(mutating|spaceRequired|admin|spaceAdmin|inputSchema|async handle):/);
    return s.slice(d, d + end);
  })();

  it('says a networked space votes and wipes nothing yet', () => {
    assert.match(DESC, /OPENS A VOTE AND WIPES NOTHING YET/,
      'a caller must not read the absence of counts as a failure and retry');
  });

  it('says an unnetworked space is unchanged', () => {
    assert.match(DESC, /NO NETWORK it wipes immediately/, 'the other half, so nobody thinks wipe stopped working');
  });

  it('and the old "it will come back" warning is gone with the behaviour', () => {
    assert.doesNotMatch(DESC, /expect the next round to put much of it back/,
      'that was true of the local wipe and is not true of a voted one');
  });
});
