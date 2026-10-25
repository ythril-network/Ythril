/**
 * Red-team tests: seq injection at the ceiling, and the forkOf depth bomb.
 *
 * Attack vectors:
 *
 * 1. A record at the ceiling (`MAX_INGEST_SEQ`, Q-241 / bundle-81 plan rev 8 §1a, §9 test 5a)
 *    The protocol refuses any seq above `MAX_INGEST_SEQ = MAX_SYNC_SEQ - SEQ_CEILING_RESERVE` (`util/seq.ts`). Until bundle-81
 *    a record AT that boundary was accepted AND dragged the space's own counter to it, so this instance's next local write
 *    was stamped `MAX_INGEST_SEQ + 1`: above what every peer accepts. One request, no credentials beyond a peer token, and every
 *    later write of the space is silently refused by every receiver, for ever.
 *
 *    This file used to attack `Number.MAX_SAFE_INTEGER`, which the schema bound had long refused (so its "EXPECTED TO FAIL"
 *    header was stale), and the boundary that is real moved with Q-241: what must hold is that the boundary itself is accepted,
 *    one above it is refused, and an accepted ceiling record never lifts what this instance stamps itself.
 *
 * 2. forkOf depth bomb
 *    When two peers arrive with equal seq but different content, the engine
 *    creates a "fork" child document.  Without a depth/count limit, an attacker
 *    can repeat this (different content, equal seq, same _id) to produce an
 *    unbounded chain of forkOf-linked documents — a linear chain that grows
 *    the DB unboundedly. (Held: the cap is in place; this case is a control.)
 *
 * The fork cap runs FIRST on purpose: on the base, the ceiling record below drags the counter to the ceiling, and every fork written
 * after it would be stamped above it and refused: the same defect, reported against a rule it has nothing to do with.
 *
 * At the base of bundle-81 ONE case here fails: the write after a ceiling arrival is stamped above the ceiling. The boundary
 * cases and the fork cap hold.
 *
 * Run: node --test testing/red-team-tests/seq-injection.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 9007199254740991

/**
 * The boundary, READ from the build the stack runs rather than copied: `util/seq.js` spells `MAX_SYNC_SEQ = 2 ** 50` and
 * `SEQ_CEILING_RESERVE = 2 ** 40`, and `MAX_INGEST_SEQ` is their difference. A source that stops spelling them that way fails here,
 * loudly, instead of leaving this file attacking a boundary that moved.
 */
// `MAX_SYNC_SEQ` is defined in `util/seq-ceiling.js` (import-free, so the `Incoming*` schema leaf can read it, Q-624) and re-exported by `util/seq.js`;
// `SEQ_CEILING_RESERVE` stays in `util/seq.js`. Each is read from the module that spells it.
const distUtil = (name) => fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'dist', 'util', name), 'utf8');
const sourceOf = { MAX_SYNC_SEQ: ['seq-ceiling.js', distUtil('seq-ceiling.js')], SEQ_CEILING_RESERVE: ['seq.js', distUtil('seq.js')] };
const exponentOf = (name) => {
  const [file, text] = sourceOf[name];
  const m = new RegExp(name + String.raw`\s*=\s*2\s*\*\*\s*(\d+)`).exec(text);
  assert.ok(m, `server/dist/util/${file} no longer spells ${name} as 2 ** n: re-anchor this test`);
  return Number(m[1]);
};
const MAX_INGEST_SEQ = 2 ** exponentOf('MAX_SYNC_SEQ') - 2 ** exponentOf('SEQ_CEILING_RESERVE');

let token;

const factAt = (id, seq, fact) => ({
  _id: id, spaceId: 'general', fact, seq, embedding: [], tags: [], entityIds: [],
  author: { instanceId: 'attacker', instanceLabel: 'Attacker' },
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), embeddingModel: 'none',
});

// ── forkOf depth bomb ──────────────────────────────────────────────────────

describe('forkOf depth bomb — fork chain must be capped', () => {
  const TARGET_ID = `fork-bomb-${Date.now()}`;
  const MAX_FORK_DEPTH = 10; // expected cap
  const SAME_SEQ = 5000;

  let token2;

  before(() => {
    token2 = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

    // Seed the original document
  });

  it('Seed the original document (seq=5000)', async () => {
    const r = await post(INSTANCES.a, token2, '/api/sync/facts?spaceId=general', {
      _id: TARGET_ID,
      spaceId: 'general',
      fact: 'fork-bomb original version',
      seq: SAME_SEQ,
      embedding: [],
      tags: [],
      entityIds: [],
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      embeddingModel: 'none',
    });
    assert.equal(r.status, 200, `Seed: ${JSON.stringify(r.body)}`);
    assert.ok(['inserted', 'updated', 'skipped'].includes(r.body.status),
      `Unexpected status: ${r.body.status}`);
  });

  it(`After ${MAX_FORK_DEPTH + 1} conflicting forks, next one must be rejected with 400`, async () => {
    // Push MAX_FORK_DEPTH conflicting docs (different content, same seq, same _id)
    for (let i = 1; i <= MAX_FORK_DEPTH; i++) {
      const r = await post(INSTANCES.a, token2, '/api/sync/facts?spaceId=general', {
        _id: TARGET_ID,
        spaceId: 'general',
        fact: `fork-bomb variant ${i} — unique content to force fork ${Date.now()}-${i}`,
        seq: SAME_SEQ,
        embedding: [],
        tags: [],
        entityIds: [],
        author: { instanceId: `attacker-${i}`, instanceLabel: `Attacker ${i}` },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        embeddingModel: 'none',
      });
      /*
       * Forks 1..MAX_FORK_DEPTH are legitimate and must FORK. This used to accept an early 400 as "already being
       * blocked" and pass — so a cap that refused the first fork, or a door that answered 400 for an unrelated
       * reason, passed exactly like a working cap. A cap is two halves: what it lets through and what it stops.
       */
      assert.equal(r.status, 200, `Fork ${i}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.status, 'forked', `Fork ${i} within the cap must fork: ${JSON.stringify(r.body)}`);
    }

    // The (MAX_FORK_DEPTH + 1)-th fork must now be blocked
    const r = await post(INSTANCES.a, token2, '/api/sync/facts?spaceId=general', {
      _id: TARGET_ID,
      spaceId: 'general',
      fact: `fork-bomb OVER LIMIT — this one must be rejected ${Date.now()}`,
      seq: SAME_SEQ,
      embedding: [],
      tags: [],
      entityIds: [],
      author: { instanceId: 'attacker-bomb', instanceLabel: 'Attacker Bomb' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      embeddingModel: 'none',
    });
    assert.equal(r.status, 400,
      `VULNERABILITY: forkOf depth ${MAX_FORK_DEPTH + 1} was accepted (got ${r.status}).\n` +
      `Add a MAX_FORK_DEPTH check to the upsertMemory/sync POST handler.`);
  });
});

describe('seq injection — the ceiling is the boundary, and a record at it never strands the space', () => {
  before(() => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('the boundary is a real, safe-integer boundary below MAX_SAFE_INTEGER', () => {
    assert.ok(Number.isSafeInteger(MAX_INGEST_SEQ) && MAX_INGEST_SEQ > 2 ** 40 && MAX_INGEST_SEQ < MAX_SAFE);
  });

  it('Memory with seq = MAX_INGEST_SEQ + 1 must be rejected with 400', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/facts?spaceId=general', factAt(`seq-over-mem-${Date.now()}`, MAX_INGEST_SEQ + 1, 'one above the ceiling'));
    assert.equal(r.status, 400,
      `VULNERABILITY: seq = MAX_INGEST_SEQ + 1 was accepted (got ${r.status} ${JSON.stringify(r.body)}).`);
  });

  it('Entity with seq = MAX_INGEST_SEQ + 1 must be rejected with 400', async () => {
    const r = await post(INSTANCES.a, token, '/api/sync/entities?spaceId=general', {
      _id: `seq-over-ent-${Date.now()}`, spaceId: 'general', name: 'OverTheCeiling', type: 'concept', tags: [], seq: MAX_INGEST_SEQ + 1,
      author: { instanceId: 'attacker', instanceLabel: 'Attacker' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    assert.equal(r.status, 400, `VULNERABILITY: Entity seq = MAX_INGEST_SEQ + 1 was accepted (got ${r.status}).`);
  });

  it('Memory with a legitimate high-but-valid seq is accepted', async () => {
    // Anything up to and including MAX_INGEST_SEQ is valid; only what is above it is blocked.
    const reasonableSeq = Math.floor(MAX_SAFE / 10); // still enormous, below the ceiling
    const r = await post(INSTANCES.a, token, '/api/sync/facts?spaceId=general', {
      ...factAt(`seq-valid-high-${Date.now()}`, reasonableSeq, 'high but valid seq'),
      author: { instanceId: 'test', instanceLabel: 'Test' },
    });
    assert.equal(r.status, 200,
      `False positive: a reasonable-but-large seq was blocked (got ${r.status}).`);
  });

  it('Memory with seq = MAX_INGEST_SEQ (the boundary itself) is accepted and stored at that seq', async () => {
    const id = `seq-at-ceiling-${Date.now()}`;
    const r = await post(INSTANCES.a, token, '/api/sync/facts?spaceId=general', factAt(id, MAX_INGEST_SEQ, 'exactly at the ceiling'));
    assert.equal(r.status, 200, `The boundary itself was refused (got ${r.status} ${JSON.stringify(r.body)}).`);
    assert.ok(['ok', 'inserted', 'updated'].includes(r.body?.status), `Unexpected answer for the boundary record: ${JSON.stringify(r.body)}`);
  });

  it('After a record at the ceiling was accepted, a normal write is stamped at or below the ceiling (Q-241)', async () => {
    // The record above is at MAX_INGEST_SEQ, and an arrival must never lift this instance's own versions (rev 8 §1a, D-19 B):
    // a stamp above MAX_INGEST_SEQ is refused by every peer, so the write would "succeed" here and reach nobody.
    const r = await post(INSTANCES.a, token, '/api/brain/spaces/general/facts', {
      fact: `seq health check ${Date.now()}`,
    });
    assert.equal(r.status, 201, `Write after the ceiling arrival: ${JSON.stringify(r.body)}`);
    assert.ok(typeof r.body.seq === 'number', 'seq must be a number');
    assert.ok(r.body.seq <= MAX_INGEST_SEQ,
      `VULNERABILITY: after one peer record at MAX_INGEST_SEQ (${MAX_INGEST_SEQ}) this instance stamped its own write ${r.body.seq}, `
      + 'above what any receiver accepts: every later write of the space is refused by every peer.');
  });
});
