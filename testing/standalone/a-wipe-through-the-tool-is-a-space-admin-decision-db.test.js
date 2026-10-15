/**
 * A space admin may empty a networked space through the tool, an area admin without the space grant may not, and the decision is the tool's `spaceAdmin`
 * flag alone (bundle-106 R-D41; design v5 section 2.4a; owner D-41, 2026-10-15: space admin can do it, and a network member may decide to leave the
 * network instead of wiping).
 *
 * ## What it holds
 *
 * On a club that passes at open, a token that administers `notes` and holds no area `admin` wipes it through `POST /api/delete_space_data` AND MCP:
 * both answer `200` with `data.status: 'wiped'`. A token with `knowledge: admin` and NO space-admin grant is refused `403` on both, with the same
 * `spaceAdminRefusal` sentence. The refusal half already holds at the base commit and is the control; the admitted half is red there because the
 * networked wipe still answers `vote_pending` (Q-453).
 *
 * ## What it does not hold
 *
 * That the admin route asks MFA only when that administrator enabled it is today's behaviour, unchanged, and needs a TOTP-enabled admin. The source gate
 * `the-space-wipe-is-a-space-admin-decision` (a describe of `every-round-is-opened-and-settled-by-one-function.test.js`) holds that no second rights
 * question exists; the MFA half is listed as not written.
 *
 * Run: node --test testing/standalone/a-wipe-through-the-tool-is-a-space-admin-decision-db.test.js
 * (requires a prior server build and the test MongoDB: `npm run test:up`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { removeInstanceDir } from './_vote-round-instance.mjs';
import { spaceAdminRights } from '../_shared/space-admin-rights.mjs';
import { M1, M2, tempInstance, networkOf, boot, seedFacts, factCount, databaseTakesCollections, warmSpaceCreation } from './_round-open-fixtures.mjs';

const dir = tempInstance('ythril-d41-');
const skip = await mongoSkipReason();

describe('D-41: the wipe tool is the space admin\'s, on both tool doors', { skip }, () => {
  let mongo; let callTool;
  before(async () => {
    process.env['YTHRIL_MODELS_OFFLINE'] = '1';
    mongo = await openTestMongo('d41_tool');
    await databaseTakesCollections(mongo);
    await boot(dir, { networks: [] });
    await warmSpaceCreation();
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
  });
  after(async () => { await closeTestMongo(); removeInstanceDir(dir); });

  const areaAdminOnly = { instanceAdmin: false, createSpaces: false, floor: { knowledge: 'admin' }, perSpace: {}, spaceAdmin: { floor: false, spaces: [] } };
  let serial = 0;
  const call = async (rights, transport) => {
    const id = `d41-${++serial}`;
    const out = await callTool({ name: 'delete_space_data', args: { space: 'notes', confirm: true },
      caller: { rights, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport, tokenId: id, tokenLabel: id } });
    return { status: out.status, text: (out.result.content ?? []).map(c => c.text ?? '').join('\n'), structured: out.result.structuredContent };
  };
  const club = () => boot(dir, { spaces: ['notes'], networks: [networkOf('club', [M1, M2], { spaces: ['general', 'notes'] })] });

  for (const transport of ['mcp', 'rest']) {
    it(`${transport}: a token administering the space, with no area admin, wipes a networked club space — 200, status wiped, the data gone`, async () => {
      await club();
      await seedFacts(mongo, 'notes', 2, `d41-${transport}`);
      const out = await call(spaceAdminRights(['notes']), transport);
      assert.equal(out.status, 200, `${out.status}: ${out.text.slice(0, 300)}`);
      assert.equal(out.structured?.status, 'wiped', JSON.stringify(out.structured)?.slice(0, 300));
      assert.equal(await factCount(mongo, 'notes'), 0);
    });
    it(`${transport} (control): a token with knowledge: admin and no space-admin grant is refused 403`, async () => {
      await club();
      await seedFacts(mongo, 'notes', 1, `d41-no-${transport}`);
      const out = await call(areaAdminOnly, transport);
      assert.equal(out.status, 403, `${out.status}: ${out.text.slice(0, 300)}`);
      assert.ok(await factCount(mongo, 'notes') > 0, 'a refused wipe emptied the space');
    });
  }

  it('both doors refuse with the same sentence', async () => {
    await club();
    const [mcp, rest] = [await call(areaAdminOnly, 'mcp'), await call(areaAdminOnly, 'rest')];
    assert.equal(mcp.text, rest.text);
  });
});
