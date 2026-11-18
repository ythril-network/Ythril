/**
 * A schema save that carries `convertRecords` is priced exactly as the Convert act, on both doors, by the one function both ask (`Q-745`, `Q-746`,
 * bundle-284; the lens sweep's N20, decided: both start the same mass rewrite, so both need the same right).
 *
 * ## What it prevents
 *
 * The act asked the knowledge admin rung, the space's admin right and one call of the heavy-call allowance; a save with steps asked the knowledge
 * admin rung alone, so a token refused the act could start the same rewrite of every record of a type, on every peer, through PATCH or
 * `schema_update`, and as often as it liked.
 *
 * ## What holds, on `PATCH /api/spaces/:id` and MCP `schema_update` (through the real dispatcher) alike
 *
 * - a caller with the knowledge admin rung but without the space's admin right is refused a save WITH `convertRecords` (`403`, the act's code
 *   `space_admin_required`) and accepted on the same save without it;
 * - past the heavy-call allowance a save with `convertRecords` answers `429 schema_convert_rate_limited`, and a save without it is unaffected;
 * - the act and the save spend ONE allowance: a call of either counts against the other.
 *
 * Run: node --test testing/standalone/a-save-with-steps-is-priced-as-the-convert-act-db.test.js (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir, callRoute } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const dir = tempInstanceDir('ythril-save-priced-');
const skip = await mongoSkipReason();
const SPACE = 'people';
const string = { type: 'string' };
const EDIT = { typeSchemas: { entity: { Person: { propertySchemas: { name: string } } } } };

describe('a save with convertRecords is priced as the Convert act', { skip }, () => {
  let inst, spacesRouter, callTool, acts, run, heavy, AREAS;
  let keySeq = 0;
  const key = (what) => `b284-price-${what}-${++keySeq}-${Date.now()}`;
  before(async () => {
    await openTestMongo('save_priced');
    inst = await bootSchemaInstance(dir, {
      spaces: [{ id: SPACE, label: 'People', folders: [], meta: { typeSchemas: { entity: { Person: { propertySchemas: { name: string } } } } } },
        { id: 'general', label: 'General', builtIn: true, folders: [] }],
    });
    ({ spacesRouter } = await import('../../server/dist/api/spaces.js'));
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    acts = await import('../../server/dist/spaces/schema-convert-acts.js');
    run = await import('../../server/dist/spaces/schema-convert-run.js');
    heavy = await import('../../server/dist/rate-limit/heavy-tool.js');
    ({ SPACE_AREAS: AREAS } = await import('../../server/dist/config/rights-shape.js'));
  });
  after(async () => { run?.stopSchemaConvertWatcher(); inst?.close(); await closeTestMongo(); });

  /** Every area at `admin` on every space, and the space's admin right only when `spaceAdmin`. */
  const rightsOf = (spaceAdmin) => ({
    perSpace: {}, floor: Object.fromEntries(AREAS.map(a => [a, 'admin'])), ...(spaceAdmin ? { spaceAdmin: { floor: true, spaces: [] } } : {}),
  });

  /** One save through `door`, as the token `tokenId`: `{ status, code }`. */
  const DOORS = {
    async rest(rights, tokenId, convertRecords) {
      const r = await callRoute(spacesRouter, 'patch', '/:id', { params: { id: SPACE }, body: { meta: EDIT, ...(convertRecords ? { convertRecords } : {}) },
        authToken: { id: tokenId, rights } });
      return { status: r.code, code: r.body?.code, text: JSON.stringify(r.body) };
    },
    async mcp(rights, tokenId, convertRecords) {
      const out = await callTool({ name: 'schema_update', args: { space: SPACE, ...EDIT, ...(convertRecords ? { convertRecords } : {}) },
        caller: { rights, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId, tokenLabel: tokenId } });
      const text = (out.result?.content ?? []).map(c => c.text ?? '').join('\n');
      const m = /^Error \((\d{3})\)/.exec(text);
      return { status: out.result?.isError ? Number(m?.[1] ?? out.status) : 200, code: out.result?.structuredContent?.code, text };
    },
  };

  for (const door of ['rest', 'mcp']) {
    const name = door === 'rest' ? 'PATCH /api/spaces/:id' : 'MCP schema_update';

    it(`${name}: without the space's admin right, a save with convertRecords is refused with the act's code, and the same save without it is accepted`, async () => {
      const rights = rightsOf(false);
      const withSteps = await DOORS[door](rights, key('noadmin'), {});
      assert.equal(withSteps.status, 403, `a save with steps by a caller who may not start the act: ${withSteps.text}`);
      assert.equal(withSteps.code, 'space_admin_required', withSteps.text);
      const act = await acts.schemaConvertStartAct(SPACE, { types: [{ kind: 'entity', type: 'Person' }] }, { rights, rateKey: key('noadmin-act') });
      assert.equal(act.body.code, withSteps.code, 'the save and the act refuse the caller in different words');
      const plain = await DOORS[door](rights, key('noadmin'), undefined);
      assert.equal(plain.status, 200, `a save without steps was priced: ${plain.text}`);
    });

    it(`${name}: past the allowance a save with convertRecords answers 429 schema_convert_rate_limited, and a save without it is unaffected`, async () => {
      const rights = rightsOf(true);
      const token = key('allowance');
      for (let i = 0; i < heavy.HEAVY_CALLS_PER_WINDOW; i++) {
        const ok = await DOORS[door](rights, token, {});
        assert.equal(ok.status, 200, `save ${i + 1} within the allowance: ${ok.text}`);
      }
      const over = await DOORS[door](rights, token, {});
      assert.equal(over.status, 429, `a save with steps past the allowance: ${over.text}`);
      assert.equal(over.code, 'schema_convert_rate_limited', over.text);
      const plain = await DOORS[door](rights, token, undefined);
      assert.equal(plain.status, 200, `a save without steps was counted: ${plain.text}`);
    });

    it(`${name}: the act and the save spend one allowance`, async () => {
      const rights = rightsOf(true);
      const token = key('shared');
      // An act behind an unfinished run is refused before it is priced: the runs the cases before started are let finish first.
      await waitForValue(async () => { const s = await run.schemaConvertStatus(SPACE); return !s || s.state !== 'running'; },
        15_000, 100, undefined, { what: 'the runs of the cases before to finish' });
      const act = await acts.schemaConvertStartAct(SPACE, { types: [{ kind: 'entity', type: 'Person' }] }, { rights, rateKey: token });
      assert.equal(act.status, 202, `the act: ${JSON.stringify(act.body)}`);
      for (let i = 1; i < heavy.HEAVY_CALLS_PER_WINDOW; i++) {
        const ok = await DOORS[door](rights, token, {});
        assert.equal(ok.status, 200, `save ${i} after the act: ${ok.text}`);
      }
      const over = await DOORS[door](rights, token, {});
      assert.equal(over.status, 429, `the act's call did not count against the save: ${over.text}`);
      assert.equal(over.code, 'schema_convert_rate_limited');
    });
  }
});
