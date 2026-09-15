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

const CHRONO = description('server/src/mcp/tools/chrono.ts', 'list_chrono');
const DIR = description('server/src/mcp/tools/file.ts', 'list_dir');
const BYNAME = description('server/src/mcp/tools/entity.ts', 'find_entities_by_name');
const PEERS = description('server/src/mcp/tools/sync.ts', 'network_peers');
const SYNCNOW = description('server/src/mcp/tools/sync.ts', 'network_sync');
const TOKENS = description('server/src/mcp/tools/spaces.ts', 'list_tokens');

describe('list_chrono: the date filter answers a different question', () => {
  it('says after/before filter when the entry was WRITTEN', () => {
    assert.match(CHRONO, /NOT WHEN IT HAPPENS/,
      'the parameters are named after/before on a tool full of dates — this has to be unmissable');
  });

  it('and points at what to use for the scheduling question', () => {
    assert.match(CHRONO, /startsAt/, 'name the field the caller actually meant');
  });

  it('and that is what the code does', () => {
    // Pinned: the range really is assigned to createdAt. The old description said "created after", which was
    // correct and easy to read past.
    assert.match(src('server/src/brain/chrono.ts'), /query\['createdAt'\] = range/,
      'the range moved off createdAt — rewrite the warning rather than leaving it wrong');
  });

  it('says `overdue` IS derived from the clock', () => {
    // THIS ASSERTION USED TO PIN THE OPPOSITE, and that is the lesson worth keeping. It required the
    // sentence "NOTHING RECOMPUTES `status` FROM THE CLOCK" — which was false, and had been false since C5
    // shipped the derivation. A gate written from a description rather than from the code does not catch a
    // wrong description; it CEMENTS it, and turns rewriting it into a test failure that looks like a
    // regression. `deriveChronoStatus` is exercised against these claims in
    // `chrono-status-descriptions-match-the-derivation.test.js`, which is what this one should have done.
    assert.match(CHRONO, /DERIVED FROM THE CLOCK/,
      'an entry left `upcoming` past its date reads back as `overdue`, and the list filter is translated to match');
    assert.doesNotMatch(CHRONO, /nothing recomputes/i, 'the old claim must not come back in any casing');
  });

  it('and the default order really is newest-written first', () => {
    assert.match(CHRONO, /newest first/, 'stated');
    assert.match(src('server/src/brain/chrono.ts'), /\{ createdAt: -1 \}/, 'and true');
  });
});

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

describe('find_entities_by_name: exact, and an empty list proves nothing', () => {
  it('says exact and case-sensitive', () => {
    assert.match(BYNAME, /EXACT name/, 'and not a search');
    assert.match(BYNAME, /[Cc]ase-sensitive/, 'which is the half that surprises');
  });

  it('says several results usually means a duplicate to merge', () => {
    assert.match(BYNAME, /duplicate somebody should merge/,
      'taking [0] is how the second copy survives and keeps accumulating edges');
  });

  it('without NAMING the mutating merge tool — this is a read-only tool', () => {
    // `mcp-help.test.js` refused the first draft, for the second time this session: read-only help must not
    // advertise a tool a read-only token cannot call. The useful fact survives without the name — help()
    // lists what your token can reach, so its absence means "not you", not "does not exist".
    assert.doesNotMatch(BYNAME, /merge_entities/,
      'a read-only tool must not advertise a mutating one');
    assert.match(BYNAME, /help\(\)/, 'point at where a writing token would find it instead');
  });

  it('says an empty list does NOT mean the thing is absent', () => {
    assert.match(BYNAME, /does NOT mean/, 'it may be stored under another spelling');
    assert.match(BYNAME, /recall/, 'and name the tool for that case');
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
