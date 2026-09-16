/**
 * The listing and lookup tools say where their answer is narrower than it looks.
 *
 * These five were the shortest descriptions in the fleet — between 78 and 368 characters — and each was
 * accurate as far as it went. What they left out is the same shape every time: a filter that answers a
 * slightly different question from the one being asked, or an empty result that means two different things.
 *
 * | Tool | The gap |
 * | --- | --- |
 * | `list_chrono` | `after`/`before` filter `createdAt` — when it was WRITTEN, not when it HAPPENS |
 * | `list_dir` | on a proxy, two members holding the same filename collapse to one entry, silently |
 * | `find_entities_by_name` | exact and case-sensitive, and an empty list does not mean the thing is absent |
 * | `network_peers` | one row per peer PER NETWORK, not per machine |
 * | `network_sync` | returns when the cycle STARTS; an unreachable peer does not make it fail |
 * | `list_tokens` | an expired token is still listed, and `rights` is not the legacy `admin` flag |
 *
 * The `list_chrono` one is the sharpest: "list entries between two dates" is the obvious reading, the
 * parameters are named `after` and `before`, and they filter the wrong field for that question. Confirmed
 * from `brain/chrono.ts`, where the range is assigned to `query['createdAt']`.
 *
 * Run: node --test testing/standalone/read-tools-state-their-blind-spots.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

const description = (file, name) => {
  const s = src(file);
  const at = s.indexOf(`name: '${name}'`);
  assert.ok(at > 0, `${name} not found in ${file} — the scanner is wrong, not the code`);
  const d = s.indexOf('description:', at);
  const end = s.slice(d).search(/\n {2,}(mutating|spaceRequired|admin|spaceAdmin|skipSchemaValidation|inputSchema|async handle):/);
  assert.ok(end > 0, `could not find the end of ${name}'s description`);
  return s.slice(d, d + end);
};

const DIR = description('server/src/mcp/tools/file.ts', 'list_dir');
const PEERS = description('server/src/mcp/tools/sync.ts', 'network_peers');
const SYNCNOW = description('server/src/mcp/tools/sync.ts', 'network_sync');
const TOKENS = description('server/src/mcp/tools/spaces.ts', 'list_tokens');


/*
 * TWO OF THIS FILE'S FINDINGS WERE DISSOLVED BY A FOLD, NOT FIXED, AND THAT IS WORTH THE PARAGRAPH.
 *
 * It covered `list_chrono` and `find_entities_by_name`, both of which folded into `filter` at 5.0. Their
 * blind spots did not move with them — they stopped existing, for the same reason in both cases:
 *
 * - `list_chrono`'s `after`/`before` filtered `createdAt`, when the entry was WRITTEN, on a tool full of
 *   dates where "entries between two dates" is the obvious reading. In `filter` the caller names the field
 *   themselves, so choosing `startsAt` or `createdAt` is a decision they make rather than one made for them.
 * - `find_entities_by_name` was exact and case-sensitive, so an empty list did not mean the thing was
 *   absent. In `filter` that is `{ name: 'x' }`, which is visibly an equality, and `$regex` is right there
 *   for the other reading.
 *
 * The general shape: a convenience wrapper hides the predicate it runs, and every hidden predicate is a
 * blind spot somebody has to be warned about in prose. Removing the wrapper removes the warning too.
 */
describe('list_dir: the proxy merge loses a duplicate name', () => {
  it('says collisions are resolved silently', () => {
    assert.match(DIR, /COLLISION IS RESOLVED SILENTLY/,
      'two members with the same filename yield one entry and no warning');
  });

  it('and the merge really is by name with first-wins', () => {
    const s = src('server/src/mcp/tools/file.ts');
    assert.match(s, /if \(!seen\.has\(e\.name\)\)/,
      'dedupe is on the bare name — if that changes, so must the warning');
  });

  it('says it is not recursive, and that names are not paths', () => {
    assert.match(DIR, /NOT recursive/, 'a caller expecting a tree gets one level');
    assert.match(DIR, /Names only/, 'and must join them onto `path` themselves');
  });

  it('says a missing directory reads as empty', () => {
    assert.match(DIR, /MISSING DIRECTORY IS AN EMPTY LISTING/,
      'empty means "nothing here OR no such path" and the two are indistinguishable');
  });
});


describe('the sync tools say what their answers do not cover', () => {
  it('list_peers: one row per peer PER NETWORK', () => {
    assert.match(PEERS, /ONCE PER NETWORK/, 'counting rows is not counting machines');
  });

  it('list_peers: no credentials, ever', () => {
    assert.match(PEERS, /NO CREDENTIALS/, 'say it, because it is the first thing an auditor asks');
    // The guarantee is by CONSTRUCTION, not by deleting named fields: the reply lists its fields one by one
    // off the member record. A spread would carry `tokenHash` and `inviteKeyHash` along the moment either is
    // added upstream, which is the failure this assertion exists to prevent — so pin the shape, not a name.
    // (The first version of this test grepped for `tokenHash` and matched only the comment explaining it.)
    const sync = src('server/src/mcp/tools/sync.ts');
    const at = sync.indexOf('net.members.map');
    assert.ok(at > 0, 'the peer mapping was not found — the scanner is wrong, not the code');
    const mapping = sync.slice(at, sync.indexOf('}))', at) + 3);
    assert.match(mapping, /instanceId: m\.instanceId/, 'fields are named individually');
    assert.doesNotMatch(mapping, /\.\.\.m\b/,
      'a spread here would leak every field the member record ever gains, credentials included');
  });

  /*
   * THESE TWO PINNED THE OPPOSITE OF THE CODE, which is the second time in this file — see the `overdue`
   * case above, which records the same lesson and is what these should have copied.
   *
   * The gate required the description to say "DOES NOT WAIT FOR THE DATA" and that an unreachable peer does
   * not make the call fail. The handler awaits `runSyncForPeer`, reports "N network(s) synced, M error(s)"
   * from the result, and sets `isError` from that count. So a caller was told to ignore an outcome they were
   * actually being given, and to expect no error where they get one — and correcting either sentence turned
   * this file red, which reads as a regression rather than as the fix it is.
   *
   * Both are asserted from BOTH SIDES now: the handler must await and must derive `isError` from the error
   * count, AND the description must say so. A single-sided check is what let one drift; two copies compared
   * cannot drift silently, because whichever one moves, this fails naming the other.
   */
  it('sync_now: the handler AWAITS the cycle, and the description says so', () => {
    const handler = src('server/src/mcp/tools/sync.ts');
    assert.match(handler, /await runSyncForPeer\(/, 'the handler no longer awaits — re-read the description');
    assert.match(SYNCNOW, /IT WAITS FOR THE CYCLE/,
      'the reply is an outcome, not an acknowledgement, and a caller polling for it waits for nothing');
    assert.doesNotMatch(SYNCNOW, /IT DOES NOT WAIT FOR THE DATA/,
      'the old claim must not come back — it was false and this gate used to require it');
  });

  it('sync_now: an unreachable peer IS an error, on both surfaces', () => {
    const handler = src('server/src/mcp/tools/sync.ts');
    assert.match(handler, /isError: result\.errors > 0/, 'the peer path no longer reports errors');
    assert.match(handler, /isError: totalErrors > 0/, 'the all-networks path no longer reports errors');
    assert.match(SYNCNOW, /COUNTED as an error/,
      'a caller told an unreachable peer is invisible here will not check isError');
    assert.match(SYNCNOW, /consecutiveFailures/,
      'and name where a peer failing over TIME surfaces, which is the part a single call cannot show');
  });
});

describe('list_tokens: what an audit would get wrong', () => {
  it('says an expired token is still listed', () => {
    assert.match(TOKENS, /still LISTED/,
      'expiry is enforced at use, so presence in this list is not proof of access');
  });

  it('says to read `rights`, not the legacy flags', () => {
    assert.match(TOKENS, /legacy/i, 'the two are not different spellings of one thing');
    assert.match(TOKENS, /instanceAdmin/, 'and name what actually governs');
  });

  it('says the prefix is the identifier that appears in logs', () => {
    assert.match(TOKENS, /prefix/, 'it is how a row is matched to an audit entry');
  });
});
