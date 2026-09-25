/**
 * A peer reports its version, and one below the floor is refused by name.
 *
 * ## Why this exists
 *
 * Owner's ruling on `P-33`, 2026-09-04: **B, and explicitly not A.** A would have kept the legacy
 * `excludeFromVectorSearch` key at 4.0 so that a pre-3.1.0 peer could not strip a record's suppression
 * mark. B is the other way round: declare a peer floor, enforce it, and then the legacy key has nothing
 * left to protect against.
 *
 * **The product could not express a peer floor at all.** Checked 2026-09-04 and again here: no
 * `minPeerVersion` anywhere in `server/src`, nothing refused a peer on version grounds, and
 * `NetworkMember` did not carry a version. `/health` reports one and no sync path read it — so an
 * instance had no way to know what its peers ran.
 *
 * ## The two things this gate is really holding
 *
 * **1. An ABSENT version is below the floor, not exempt from it.** A peer that reports no version is by
 * definition older than the release that started reporting one. This repo has shipped the opposite
 * reading three times — an empty allowlist read as "unrestricted" — and it is the same shape: a missing
 * value treated as permission. Read that way, every single peer the floor exists to refuse would pass.
 *
 * **2. ONE comparison, not one per caller.** There are two enforcement points, inbound and outbound, and
 * they are the two halves of one rule. `CLAUDE.md` names this as the defect class this repo produces
 * most, so the comparison lives in one module and both sides call it.
 *
 * ## What this gate is NOT
 *
 * It does not prove a refusal happens between two running instances — `testing/sync/peer-floor.test.js`
 * does that against real servers. This one holds the shape: that the floor is declared once, that a
 * version travels in both directions of the gossip exchange, and that the refusal names the numbers.
 *
 * Run: node --test testing/standalone/a-peer-below-the-floor-is-refused.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const FLOOR = 'server/src/sync/peer-floor.ts';
const MEMBERS = 'server/src/api/sync/members.ts';
const TYPES = 'server/src/config/types-networks.ts';
const ENGINE = 'server/src/sync/engine.ts';
const ROUTER = 'server/src/api/sync/index.ts';
const code = (f) => stripComments(readFileSync(f, 'utf8'));
/** This checkout is CRLF; deriving it rather than assuming keeps the slice honest on either. */
const NL = readFileSync(FLOOR, 'utf8').includes('\r\n') ? '\r\n' : '\n';

describe('the floor IS the running major, derived not chosen', () => {
  it('a module owns it, and the value is a real version', async () => {
    const { MIN_PEER_VERSION } = await import('../../server/dist/sync/peer-floor.js');
    assert.match(MIN_PEER_VERSION, /^\d+\.\d+\.\d+$/,
      `the floor is ${JSON.stringify(MIN_PEER_VERSION)}, which is not a version a peer could report`);
  });

  it('and it equals this build\'s own major at .0.0', async () => {
    /*
     * Owner, 2026-09-05: *"can we make the current major always be the version floor? that fits to
     * 'this is breaking'. That makes sure no chaining (4.1 allows 3.2, 3.2 allows 2.5,...)"*.
     *
     * THE CHAINING ARGUMENT IS WHAT THIS CASE PROTECTS. Compatibility between two instances is not
     * transitive, but a network is: with a floor a few minors back, 4.1 admits 3.2, 3.2 admits 2.5,
     * and records travel the whole chain although the ends were never compatible. Every hop sits
     * inside its own floor and the path sits outside all of them.
     *
     * Derived from `SERVER_VERSION`, so there is no number to remember to raise at the next major.
     * The constant this replaced would still have read 3.1.0 the day 5.0 shipped, with nothing to
     * contradict it.
     */
    const { MIN_PEER_VERSION } = await import('../../server/dist/sync/peer-floor.js');
    const { SERVER_VERSION } = await import('../../server/dist/util/server-version.js');
    const major = SERVER_VERSION.trim().split(/[-+]/)[0].split('.')[0];
    assert.equal(MIN_PEER_VERSION, `${major}.0.0`,
      `this build is ${SERVER_VERSION} so the floor must be ${major}.0.0, not ${MIN_PEER_VERSION} — a `
      + 'floor below the running major lets a network chain across a breaking boundary');
  });

  it('and it is NOT a literal — it is computed from the manifest', () => {
    /*
     * The failure this forbids is someone "simplifying" the derivation back to a constant. That reads
     * as tidier and reintroduces exactly the staleness the derivation exists to remove.
     */
    const src = code(FLOOR);
    const at = src.indexOf('MIN_PEER_VERSION =');
    assert.ok(at > 0, 'MIN_PEER_VERSION is gone — re-point this gate');
    const decl = src.slice(at, src.indexOf(';', at));
    assert.doesNotMatch(decl, /['"`]\d+\.\d+\.\d+['"`]/,
      'the floor is a hardcoded version again, so it stops tracking the major and goes stale in '
      + 'silence. The 0.0.0 fail-open fallback lives inside the function, not in the declaration');
    assert.match(decl, /SERVER_VERSION/,
      'the floor no longer reads the running version, so it cannot be the running major');
  });

  it('fails OPEN on an unparseable own version, not closed', () => {
    /*
     * The right way round for a value that comes from OUR OWN manifest: an unparseable
     * `SERVER_VERSION` is a build defect on this side, and answering it by refusing every peer turns a
     * packaging mistake into an outage at every member of the network.
     */
    const src = code(FLOOR);
    const at = src.indexOf('MIN_PEER_VERSION =');
    const decl = src.slice(at, src.indexOf('})()', at));
    assert.match(decl, /0\.0\.0/,
      'there is no fail-open fallback, so a malformed own version either throws at import or yields a '
      + 'floor no peer can satisfy');
  });

  it('and nobody else hardcodes a version to compare against', () => {
    /*
     * The point of a declared floor is that raising it is one edit. A second literal somewhere is how a
     * floor gets raised in one place and not the other — and the half that still permits the old peer is
     * the half that wins, silently, because nothing contradicts a peer that was let in.
     */
    for (const f of [MEMBERS, ENGINE, ROUTER, 'server/src/sync/peer-fetch.ts']) {
      assert.doesNotMatch(code(f), /['"`]\d+\.\d+\.\d+['"`]/,
        `${f} carries a version literal — compare against MIN_PEER_VERSION instead of a second copy. `
        + 'It is derived from the running major, so a literal here is a number that stops tracking it');
    }
  });
});

describe('a version travels, in both directions of one exchange', () => {
  it('NetworkMember can hold what a peer reported', () => {
    const src = code(TYPES);
    const at = src.indexOf('export interface NetworkMember');
    assert.ok(at > 0, 'NetworkMember is gone — re-point this gate');
    const iface = src.slice(at, src.indexOf('}', at));
    assert.match(iface, /version\?:\s*string/,
      'a member record cannot hold a version, so the floor has nothing to check against');
  });

  it('we ANNOUNCE ours on the self-record the response piggybacks', () => {
    /*
     * The gossip exchange is symmetric: the caller announces itself in the body and the responder
     * piggybacks its own identity in `self` so the caller can update its record. A floor enforced on
     * only one of those is a floor one instance can see and the other cannot.
     */
    const src = code(MEMBERS);
    const at = src.indexOf('const selfRecord');
    assert.ok(at > 0, 'the piggybacked self-record is gone — re-point this gate');
    const block = src.slice(at, src.indexOf('res.status(200)', at));
    assert.match(block, /SERVER_VERSION|version/,
      'our own version is missing from the self-record, so a peer can never learn what we run');
  });

  it('and we STORE what the caller announced', () => {
    const src = code(MEMBERS);
    const at = src.indexOf('const updated = {');
    assert.ok(at > 0, 'the member self-update is gone — re-point this gate');
    const block = src.slice(at, src.indexOf('};', at));
    assert.match(block, /version/,
      'an announced version is dropped on ingest, so the stored record stays blank and the floor never bites');
  });
});

describe('what the floor does with a version', () => {
  it('refuses one below it, and the refusal names BOTH numbers', async () => {
    const { peerFloorRefusal, MIN_PEER_VERSION } = await import('../../server/dist/sync/peer-floor.js');
    const refusal = peerFloorRefusal('1.0.0');
    assert.ok(refusal, 'a 1.0.0 peer is not refused');
    assert.ok(refusal.includes('1.0.0'),
      `the refusal does not say what the peer reported: ${JSON.stringify(refusal)}`);
    assert.ok(refusal.includes(MIN_PEER_VERSION),
      `the refusal does not say what is required: ${JSON.stringify(refusal)}`);
  });

  it('ADMITS one at the floor and above — a floor is not a ceiling', async () => {
    const { peerFloorRefusal, MIN_PEER_VERSION } = await import('../../server/dist/sync/peer-floor.js');
    assert.equal(peerFloorRefusal(MIN_PEER_VERSION), null, 'a peer exactly at the floor is refused');
    const [maj] = MIN_PEER_VERSION.split('.').map(Number);
    assert.equal(peerFloorRefusal(`${maj + 1}.0.0`), null, 'a NEWER peer is refused — the floor is being read as an equality');
  });

  it('refuses an absent version WHEN AN EXCHANGE HAS COMPLETED — that peer answered and named none', async () => {
    /*
     * THE CASE THIS GATE EXISTS FOR. A peer that answered and reported nothing is older than the
     * release that started reporting, so it is below the floor. Read the other way — absent means
     * "unknown, probably fine" — every peer the floor was built to refuse walks straight through.
     */
    const { peerFloorRefusal } = await import('../../server/dist/sync/peer-floor.js');
    const answered = '2026-09-04T22:00:00.000Z';
    for (const nothing of [undefined, null, '', '   ']) {
      assert.ok(peerFloorRefusal(nothing, answered),
        `a peer that answered and reported ${JSON.stringify(nothing)} is admitted — for a peer we HAVE `
        + 'exchanged with, absent is not exempt, it is old');
    }
  });

  it('but says NOTHING about a peer it has never exchanged with', async () => {
    /*
     * THE CASE CI TAUGHT ME, and it is the more expensive half. The first version refused an absent
     * version unconditionally, which reads as safe and is an outage: a member can legitimately be
     * versionless for ever. `conflicts.test.js` registers one under an invented `instanceId` with a
     * token carrying no `peerInstanceId` — not a broken fixture, but what a manually-provisioned peer
     * and a single-side-configured network both look like. Gossip can never match that member to a
     * self-record, so no version can ever arrive, so the data plane stopped for good. Every fresh
     * network was in the same state until its first exchange completed.
     *
     * Unreachability is already counted and surfaced by `consecutiveFailures`. The floor must not
     * answer a question it has no evidence for.
     */
    const { peerFloorRefusal } = await import('../../server/dist/sync/peer-floor.js');
    for (const never of [undefined, null, '']) {
      assert.equal(peerFloorRefusal(undefined, never), null,
        `a peer never exchanged with (checkedAt ${JSON.stringify(never)}) is refused — that is not `
        + 'evidence of an old peer, it is evidence of no contact, and refusing it stops asymmetric '
        + 'and manually-provisioned networks permanently');
    }
  });

  it('and an unparseable version is refused even with no exchange stamp', async () => {
    // Unlike silence, a junk version only exists because the peer sent it — so it IS evidence, and
    // the no-contact exemption must not extend to it.
    const { peerFloorRefusal } = await import('../../server/dist/sync/peer-floor.js');
    assert.ok(peerFloorRefusal('banana', undefined),
      'a peer that sent an uncomparable version is admitted because no stamp was recorded');
  });

  it('and refuses a version it cannot parse, rather than guessing', async () => {
    const { peerFloorRefusal } = await import('../../server/dist/sync/peer-floor.js');
    for (const junk of ['banana', '3', '3.x', 'v3.1.0-suffix-with-no-numbers']) {
      assert.ok(peerFloorRefusal(junk, '2026-09-04T22:00:00.000Z'),
        `${JSON.stringify(junk)} is admitted — an unparseable claim is not evidence of being current`);
    }
  });

  it('compares NUMERICALLY, not as text', async () => {
    /*
     * `'10.0.0' < '9.0.0'` is true for strings, so a lexicographic comparison refuses the newest peers
     * first and does it the moment a component reaches double digits. That is a defect with a date on
     * it rather than a probability.
     */
    const { comparePeerVersions } = await import('../../server/dist/sync/peer-floor.js');
    assert.ok(comparePeerVersions('10.0.0', '9.0.0') > 0, '10.0.0 is being read as older than 9.0.0');
    assert.ok(comparePeerVersions('3.10.0', '3.9.0') > 0, '3.10.0 is being read as older than 3.9.0');
    assert.ok(comparePeerVersions('3.1.10', '3.1.9') > 0, '3.1.10 is being read as older than 3.1.9');
    assert.equal(comparePeerVersions('4.0.0', '4.0.0'), 0, 'equal versions do not compare equal');
  });

  it('and ignores a prerelease suffix rather than choking on it', async () => {
    // Our own tags are plain, but a peer building from source can report `4.0.0-rc.1`. Refusing it as
    // unparseable would lock a tester out of their own network.
    const { peerFloorRefusal, MIN_PEER_VERSION } = await import('../../server/dist/sync/peer-floor.js');
    assert.equal(peerFloorRefusal(`${MIN_PEER_VERSION}-rc.1`), null,
      'a prerelease of a version at the floor is refused');
  });
});

describe('the evidence stamp is written on both directions of the exchange', () => {
  it('outbound, when we call a peer', () => {
    /*
     * Stamped whether or not a version came back — that is the point of it. A peer that answered and
     * named nothing is a pre-4.0 peer, which is evidence; a peer we never reached is not.
     */
    const src = code(ENGINE);
    assert.match(src, /versionCheckedAt/,
      'the outbound exchange records no stamp, so a peer that answers us can never be judged');
  });

  it('and inbound, when a peer announces itself to us', () => {
    // Without this a pull-only peer — one that dials us and is never dialled — stays unjudgeable.
    const src = code(MEMBERS);
    const at = src.indexOf('const updated = {');
    const block = src.slice(at, src.indexOf('};', at));
    assert.match(block, /versionCheckedAt/,
      'an announce records no stamp, so a peer that only ever dials us can never be judged');
  });
});

describe('both doors report the floor the same way', () => {
  it('the same three fields, per member, on REST and on MCP', () => {
    /*
     * ONE SPELLING, not one per door. `minPeerVersion` went on the REST envelope first and inside an
     * object wrapper on MCP — and CI refused the wrapper, because `network_peers` returns a bare JSON
     * array by contract and an envelope breaks every caller that indexes it. Per-member on both is
     * the shape that is identical through both doors and breaks nothing.
     */
    // `networks/network-acts.ts` builds every REST network body (`networkView`), and network_get's too (F-36).
    for (const f of ['server/src/mcp/tools/sync.ts', 'server/src/networks/network-acts.ts']) {
      const src = code(f);
      for (const field of ['version', 'belowFloor', 'minPeerVersion']) {
        assert.match(src, new RegExp(field), `${f} does not report ${field}`);
      }
    }
  });

  it('and list_peers stays a bare array', () => {
    const src = code('server/src/mcp/tools/sync.ts');
    assert.match(src, /JSON\.stringify\(peers\)/,
      'list_peers wraps its array again — its contract is an array, and `mcp.test.js` asserts it');
  });
});

describe('both enforcement points ask the same function', () => {
  it('inbound: a peer calling us is REFUSED, not merely noticed', () => {
    /*
     * THIS CASE WAS WRONG WHEN FIRST WRITTEN and the correction is the point. It matched
     * `peerFloorRefusal` anywhere in the members route — which passes on the WARNING LOG that route
     * also carries, while the route itself still answers 200. A gate satisfied by an observation of
     * the problem is not a gate on the problem.
     *
     * Enforcement is one middleware on the parent router, the same place the ejection guard lives,
     * so a route added later inherits it. So the subject is that middleware, and the assertion is
     * that it REFUSES: a status and the message, not a mention.
     */
    const src = code(ROUTER);
    const at = src.indexOf('peerFloorRefusal(');
    assert.ok(at > 0, 'no sync route checks the floor, so a stale peer keeps syncing INTO us');
    const block = src.slice(at, src.indexOf('next();', at));
    assert.match(block, /res\.status\(4\d\d\)/,
      'the floor is consulted inbound and the request proceeds anyway — a warning is not a refusal');
  });

  it('and the announce is the ONE route it lets through, deliberately', () => {
    /*
     * The exception is the floor's input rather than a hole in it: a version is only ever learned
     * from gossip, so refusing the announce would refuse every peer for having no version and then
     * never be able to learn one — an upgraded peer could not tell us it was current. Asserted
     * because a later reader who removes it as an oversight breaks recovery, silently.
     */
    assert.match(code(ROUTER), /members\$\//,
      'the member announce is no longer exempt, so a below-floor peer can never report an upgrade');
  });

  it('outbound: a peer we call is checked, and AFTER the gossip that learns its version', () => {
    /*
     * The order is the design. Checked in the member loop — where this went first — it deadlocks:
     * gossip is the only thing that ever learns a version, gossip runs inside `runSyncForMember`, so
     * skipping the member skips the exchange that would have cleared it. Every member on a fresh or
     * freshly-upgraded network reports nothing, absent is below the floor, and the network stops
     * syncing for good.
     */
    const src = code(ENGINE);
    const check = src.indexOf('assertPeerAtFloor(');
    assert.ok(check > 0, 'the engine syncs with any member regardless of version');
    const gossip = src.indexOf('await gossipWithPeer(');
    assert.ok(gossip > 0, 'gossipWithPeer is gone — re-point this gate');
    assert.ok(gossip < check,
      'the floor is checked before the gossip that learns the version, so a versionless peer can '
      + 'never report one and the network stops syncing permanently');
  });

  it('and it re-reads the version rather than trusting the captured member', () => {
    /*
     * The `member` the engine passes was captured before gossip ran, so it is a cycle stale by the
     * time the check happens — an upgraded peer would be refused for a version it no longer runs.
     *
     * BOUNDED BY THE FUNCTION, not by a character count. The first version of this read 400
     * characters backwards from the call, and `gates-bound-their-subject-structurally` refused it —
     * the same ratchet, applied to me. A character count spans different LINES on CRLF than on LF,
     * so the window a gate reads is not the window it was written against.
     */
    const src = code(FLOOR);
    const at = src.indexOf('export function assertPeerAtFloor');
    assert.ok(at > 0, 'assertPeerAtFloor is gone — re-point this gate');
    const body = src.slice(at, src.indexOf(NL + '}', at));
    assert.match(body, /getConfig\(\)/,
      'the check reads the stale captured member, so an upgraded peer stays refused for a cycle');
    assert.match(body, /throw/,
      'the refusal is computed and dropped — the cycle must record an error, or a member is excluded '
      + 'from a run that reports success');
  });
});
