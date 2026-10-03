/**
 * A label, a round id or a voter id that arrives by governance gossip cannot forge a line in this instance's log
 * (`Q-214`, under the rule `Q-231` states for every peer value).
 *
 * ## The rule
 *
 * Governance runs first in every sync cycle and names the peer in nearly every line it writes: `Gossip self-push to
 * <label>`, `Gossip pull from <label>`, `Gossip: updated member <label>`, `Vote pull from <label>`, `Vote gossip:
 * adopted round <id>`, `rejecting cast for '<voter>'`. Every one of those values is chosen by a peer — a member's
 * label is whatever its own instance announced, and gossip copies it into this instance's config. Interpolated raw, a
 * label of `peer\r\nFORGED [ERROR] …` ends the line and prints a second one that reads exactly like this server's
 * own, on every cycle, for as long as the label is stored.
 *
 * Asserted over the lines the server actually emitted (the ring, `_log-lines.mjs`), split the way a log reader splits
 * them, for the three ways such a value reaches a line: a label already stored, a label arriving by member gossip,
 * and a round and a cast arriving by vote gossip. Each case also checks that the value DID reach the log — a case in
 * which nothing was logged would pass by saying nothing.
 *
 * The real engine (`runSyncForPeer`) runs against `_pull-door.mjs`'s fake peer, whose governance routes a case
 * scripts through `state.network`; a route the case does not script answers 404, which is itself a line naming
 * the peer.
 *
 * ## Seen red
 *
 * On 0b066822 every case: the engine interpolates `member.label`, `local.label`, `peerRound.roundId` and
 * `peerCast.instanceId` raw, so the marker starts a line of its own.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`) and a non-loopback address (`_private-address.mjs`), then
 *      node --test testing/standalone/a-peer-label-cannot-forge-a-governance-log-line-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openPullDoor, PEER, PEER_LABEL } from './_pull-door.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'govforge';
let door, loader;

/** A value a peer sends: a CR LF and then a line that reads like this server's own. */
const forged = marker => `peer\r\n${marker} [ERROR] this line was written by a peer`;

const network = () => loader.getConfig().networks.find(n => n.id === door.NET);

/**
 * One sync cycle; the lines it logged. Asserts the rule (no line starts with a marker, each marker shown escaped)
 * BEFORE the fixture checks, so a tree that forges fails for the forgery and not for a missing line.
 */
async function cycleNaming(...markers) {
  const { lines } = await logLinesDuring(() => door.sync());
  for (const marker of markers) {
    assert.deepEqual(lines.filter(l => l.startsWith(marker)), [],
      `a value the peer sent started a log line of its own (${marker}) — log injection`);
    assert.ok(lines.some(l => l.includes(`\\r\\n${marker}`)),
      `fixture check: ${marker} never reached the log, so this case proves nothing about it`);
  }
  return lines;
}

/** The lines that name `marker`, each starting with one of `prefixes` — the governance lines this case is about. */
function assertLinesNamed(lines, marker, prefixes) {
  for (const prefix of prefixes) {
    assert.ok(lines.some(l => l.includes(prefix) && l.includes(marker)),
      `no "${prefix}" line named the value — the case no longer reaches the line it is about`);
  }
}

describe('a peer label cannot forge a governance log line', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'govforge', spaces: [S] });
    loader = await import('../../server/dist/config/loader.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    door.member().label = PEER_LABEL;
    network().pendingRounds = [];
  });

  it('a label this instance already holds: the self-push, member-pull and vote-pull lines that name the peer', async () => {
    const MARK = 'FORGED-LABEL';
    door.member().label = forged(MARK);
    const lines = await cycleNaming(MARK);
    assertLinesNamed(lines, MARK, ['Gossip self-push to', 'Gossip pull from', 'Vote pull from']);
  });

  it('a label arriving by member gossip: the line that records the update', async () => {
    const MARK = 'FORGED-MEMBER';
    door.state.network = (req, res, next) => {
      if (req.method === 'GET' && req.path.endsWith('/members')) {
        res.json({ members: [{ instanceId: PEER, label: forged(MARK), url: door.url }] });
        return;
      }
      next();
    };
    const lines = await cycleNaming(MARK);
    assertLinesNamed(lines, MARK, ['Gossip: updated member']);
    assert.equal(door.member().label, forged(MARK), 'fixture check: gossip did not store the label it was sent');
  });

  it('a round and a relayed cast arriving by vote gossip: the adopt and reject lines', async () => {
    const ROUND = 'FORGED-ROUND';
    const VOTER = 'FORGED-VOTER';
    const deadline = new Date(Date.now() + 86_400_000).toISOString();
    door.state.network = (req, res, next) => {
      if (req.method === 'GET' && req.path.endsWith('/votes')) {
        res.json({ rounds: [{
          roundId: forged(ROUND), type: 'join', subjectInstanceId: 'subject-1', subjectLabel: 'Subject',
          subjectUrl: 'https://subject.example', deadline, createdAt: new Date().toISOString(),
          votes: [{ instanceId: forged(VOTER), vote: 'yes' }],
        }] });
        return;
      }
      next();
    };
    const lines = await cycleNaming(ROUND, VOTER);
    assertLinesNamed(lines, ROUND, ['Vote gossip: adopted round']);
    assertLinesNamed(lines, VOTER, ['Vote gossip: rejecting cast']);
  });
});
