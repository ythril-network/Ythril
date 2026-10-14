/**
 * A schema write that sets a meta key an older member will refuse says so, naming the members (`Q-217`; R6-7).
 *
 * ## Why a warning, and why on the write
 *
 * The previous release refuses a meta carrying a key it does not know WHOLE (`the-meta-reader-tolerates-what-a-newer-build-sends.test.js`
 * measures that on `v5.6.10`'s own receiver). The capability negotiation the first design had for this (every member announcing the
 * keys it accepts, refused 409 when one lacked a key) was withdrawn: it could not reach members beyond the direct peers, could be
 * deadlocked by one silent member, and could be forged. What a release CAN do on its own is tell the writer, at the moment it writes:
 * *success, plus a `warnings` row naming the members whose recorded version is older than the release that understands the key, or
 * unknown* — the same two states `peerRunsAtLeast` treats as old everywhere else a newer shape is sent.
 *
 * The write is NOT refused: a network of one upgraded instance and some old ones is the ordinary state of a rolling upgrade, and the
 * operator is the one who decides whether to proceed (D-24 is the precedent: upgrade every instance of a network).
 *
 * ## What holds
 *
 * - REST and MCP both answer with the warning, naming an older member and a member that never recorded a version;
 * - a member recorded at a newer version is not named, and a write of a key every release understands carries no such warning;
 * - the labels are named only to a caller who may read networks (`networks:read`); a token without it still gets the write and a
 *   warning, without the names.
 *
 * Run: node --test testing/standalone/a-schema-write-warns-of-members-that-predate-its-keys-db.test.js
 * (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { NET_ID, P1, P2 } from './_vote-round-sites.mjs';

const dir = tempInstanceDir('ythril-member-warning-');
const skip = await mongoSkipReason();
const SPACE = 'notes';
const THIRD = 'aaaaaaaa-0000-4000-8000-0000000000a3';
const CHECKED = '2026-10-09T09:00:00.000Z';

const member = (instanceId, label, extra = {}) => ({ instanceId, label, url: `https://${instanceId.slice(-2)}.example`, tokenHash: 'h', direction: 'both', ...extra });

/** A club (one yes passes a round, so a write answers 200 and stays readable) with one member per version state. */
const network = () => ({
  id: NET_ID, label: 'Net', type: 'club', origin: 'created', syncSchedule: '', spaces: [SPACE], votingDeadlineHours: 24,
  createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
  members: [
    member(P1, 'OlderMember', { version: '5.6.10', versionCheckedAt: CHECKED }),
    member(P2, 'UnknownMember'),
    member(THIRD, 'NewerMember', { version: '99.0.0', versionCheckedAt: CHECKED }),
  ],
});

/** A token that may write the schema area and may not read networks. */
const SCHEMA_ADMIN_ONLY = { instanceAdmin: false, createSpaces: false, floor: { knowledge: 'none', files: 'none', schema: 'admin', dataQuality: 'none', networks: 'none' }, perSpace: {} };

describe('a schema write warns of members that predate its keys', { skip }, () => {
  let inst, spacesTools;
  before(async () => {
    await openTestMongo('member_warning');
    inst = await bootSchemaInstance(dir, {
      spaces: [{ id: SPACE, label: 'Notes', folders: [], meta: { validationMode: 'strict' } }],
      networks: [network()],
    });
    spacesTools = await import('../../server/dist/mcp/tools/spaces.js');
  });
  after(async () => {
    inst?.close();
    await closeTestMongo();
  });

  const NEW_KEY = { stampSkew: { warnMinutes: 5 } };
  const text = (answer) => answer.text;

  describe('REST (PATCH)', () => {
    it('answers success and names the older member and the member with no recorded version, not the newer one', async () => {
      inst.reset();
      const answer = await inst.doors['space-patch'](SPACE, NEW_KEY);
      assert.equal(answer.refused, false, `the write was refused: ${text(answer).slice(0, 300)}`);
      assert.ok(Array.isArray(answer.body?.warnings), `the answer carries no warnings array: ${text(answer).slice(0, 400)}`);
      const said = JSON.stringify(answer.body.warnings);
      assert.match(said, /OlderMember/, 'a member on a release before this one is not named');
      assert.match(said, /UnknownMember/, 'a member that never recorded a version is not named (unknown counts as old)');
      assert.doesNotMatch(said, /NewerMember/, 'a member on a newer release is named');
    });
    it('carries no such warning for a write every release understands', async () => {
      inst.reset();
      const answer = await inst.doors['space-patch'](SPACE, { purpose: 'a purpose every release reads' });
      assert.equal(answer.refused, false, text(answer).slice(0, 300));
      assert.doesNotMatch(text(answer), /OlderMember|UnknownMember/, 'a write of a key the previous release accepts warned about its members');
    });
  });

  describe('MCP (schema_update)', () => {
    it('answers success and names the same members', async () => {
      inst.reset();
      const answer = await inst.doors['mcp-schema-update'](SPACE, NEW_KEY);
      assert.equal(answer.refused, false, `the write was refused: ${text(answer).slice(0, 300)}`);
      assert.match(text(answer), /OlderMember/);
      assert.match(text(answer), /UnknownMember/);
      assert.doesNotMatch(text(answer), /NewerMember/);
    });
    it('names no member to a token that may not read networks, and still tells it that members are behind', async () => {
      inst.reset();
      const result = await spacesTools.schema_updateTool.handle({
        callSpace: SPACE, callSpaces: [SPACE], accessibleSpaceIds: [SPACE], args: { space: SPACE, ...NEW_KEY }, rights: SCHEMA_ADMIN_ONLY,
      });
      const said = (result.content ?? []).map(c => c.text).join('\n');
      assert.notEqual(result.isError, true, `a schema-admin token was refused the write: ${said.slice(0, 300)}`);
      assert.doesNotMatch(said, /OlderMember|UnknownMember/, 'member labels were handed to a token without networks:read');
      assert.match(said, /member/i, 'the token is not told that members on an older release will refuse the key');
    });
  });
});
