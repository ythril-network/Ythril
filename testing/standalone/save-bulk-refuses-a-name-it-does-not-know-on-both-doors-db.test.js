/**
 * `save_bulk` refuses a name it does not know — a retired key or an unknown one, at the top level or on an item
 * — with the same refusal on BOTH doors.
 *
 * ## The defect (`Q-195`)
 *
 * `Q-41` closed this on REST: `{"memories":[…]}` used to answer `207` with nothing inserted and an empty
 * `errors`, which is the answer a body that legitimately wrote nothing gives. The fleet integrator reported it
 * after about thirty builders had been writing into it and reading success. `api/brain/bulk.ts` now refuses a
 * retired name with its replacement (`retiredWriteFieldError`), then any other unknown name (`unknownBodyFields`),
 * then a retired name on any item.
 *
 * The MCP tool is `skipSchemaValidation: true` — it reports per-item errors rather than refusing the call — so
 * the dispatcher's own `additionalProperties: false` never runs for it, and the handler checks none of the
 * three. The same `memories` payload is a 400 naming `facts` on one door and a clean success that wrote nothing
 * on the other. Both are individually defensible; the gap is only visible from outside, which is the shape
 * `CLAUDE.md` names as this repo's most expensive.
 *
 * ## What is asserted
 *
 * Each body is sent through both doors IN-PROCESS: the REST route's own handler, and `callTool` — the dispatch
 * every MCP request goes through, so the gates in front of the handler are included. Both must refuse, nothing
 * may be written, and the refusal must say the same thing: the retired-name sentence verbatim (it is one table),
 * and the unknown key named. The REST door's "Allowed:" list differs on purpose — the MCP door also takes
 * `space` — so the shared part asserted for an unknown key is the key, not the inventory.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/save-bulk-refuses-a-name-it-does-not-know-on-both-doors-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-bulk-names-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';

let mongo, restHandler, callTool, RETIRED_WRITE_FIELDS, BULK_BODY_KEYS, ADMIN;

const coll = (n) => mongo.col(`${SPACE}_${n}`);

/** Every record collection a bulk call can write, so "nothing was written" is read from all of them. */
const WRITTEN = ['facts', 'entities', 'edges', 'chrono', 'links'];

async function writtenCount() {
  let n = 0;
  for (const c of WRITTEN) n += await coll(c).countDocuments({});
  return n;
}

/** POST /api/brain/spaces/:spaceId/bulk, through the route's own final handler. */
async function viaRest(body) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader() { return this; }, set() { return this; },
  };
  await restHandler({ params: { spaceId: SPACE }, query: {}, body, headers: {}, ip: '127.0.0.1' }, res);
  return { refused: res.statusCode >= 400, status: res.statusCode, text: JSON.stringify(res.body ?? '') };
}

/** `save_bulk` through `callTool`, the dispatch the MCP transport hands every request to. */
async function viaMcp(body) {
  const out = await callTool({
    name: 'save_bulk',
    args: { space: SPACE, ...body },
    caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' },
  });
  const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
  return { refused: out.result.isError === true, status: out.status, text };
}

describe('save_bulk refuses an unknown name the same way on both doors', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('bulknamesbothdoors');
    const loader = await import('../../server/dist/config/loader.js');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'bulk-names-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    loader.loadConfig();
    const { bulkRouter } = await import('../../server/dist/api/brain/bulk.js');
    const layer = bulkRouter.stack.find(l => l.route?.path === '/spaces/:spaceId/bulk' && l.route.methods?.post);
    assert.ok(layer, 'the REST bulk route is gone or moved — re-anchor this test');
    restHandler = layer.route.stack[layer.route.stack.length - 1].handle;
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    ({ RETIRED_WRITE_FIELDS } = await import('../../server/dist/brain/retired-write-fields.js'));
    ({ BULK_BODY_KEYS } = await import('../../server/dist/brain/bulk.js'));
    // An instance-admin token, built from the area list so a new area cannot leave it short of a rung.
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {},
      floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of [...WRITTEN, 'embed_jobs', 'tombstones']) await coll(c).deleteMany({});
  });

  it('control: a well-formed body is accepted on both doors', async () => {
    // Without this, "refused on both" could be both doors refusing everything.
    for (const door of [viaRest, viaMcp]) {
      const r = await door({ facts: [{ fact: 'a fact both doors accept' }] });
      assert.equal(r.refused, false, `${door.name} refused a well-formed body: ${r.text}`);
    }
    assert.equal(await coll('facts').countDocuments({}), 2);
  });

  /*
   * The cases, derived where the code holds the set: every retired name that is a COLLECTION key (its
   * replacement is one of `BULK_BODY_KEYS`) is a top-level case, and every other retired name is an item case.
   */
  const cases = () => {
    const out = [];
    for (const [name, r] of Object.entries(RETIRED_WRITE_FIELDS)) {
      if (BULK_BODY_KEYS.includes(r.replacement)) {
        out.push({ label: `the retired top-level key \`${name}\``, body: { [name]: [{ fact: 'x' }] }, says: r.message });
      } else {
        out.push({ label: `the retired item key \`${name}\``, body: { facts: [{ fact: 'x', [name]: [] }] }, says: r.message });
      }
    }
    out.push({ label: 'an unknown top-level key', body: { factz: [{ fact: 'x' }] }, says: 'factz' });
    return out;
  };

  it('the derived cases include a retired top-level key and an item key', () => {
    const c = cases();
    assert.ok(c.some(x => x.label.includes('top-level key `memories`')), 'the `memories` case is not derived — re-anchor');
    assert.ok(c.filter(x => x.label.includes('item key')).length >= 1, 'no retired item key was derived');
  });

  it('every case is refused on both doors, with the same sentence, and writes nothing', async () => {
    const failures = [];
    for (const c of cases()) {
      await coll('facts').deleteMany({});
      const rest = await viaRest(c.body);
      const mcp = await viaMcp(c.body);
      const rest2 = await viaRest(c.body); // sandwiched, so the comparison is not of two different moments
      assert.equal(rest.refused, true, `REST accepted ${c.label} — this test's REST half is the reference and must hold`);
      assert.equal(rest.refused, rest2.refused);
      if (!mcp.refused) {
        failures.push(`${c.label}: REST ${rest.status} refused, MCP ACCEPTED it (status ${mcp.status}): ${mcp.text.slice(0, 160)}`);
        continue;
      }
      if (!mcp.text.includes(c.says)) failures.push(`${c.label}: MCP refused without saying ${JSON.stringify(c.says)}: ${mcp.text}`);
      if (!rest.text.includes(c.says)) failures.push(`${c.label}: REST refused without saying ${JSON.stringify(c.says)}`);
      if (mcp.status !== rest.status) failures.push(`${c.label}: REST answers ${rest.status}, MCP ${mcp.status}`);
      const n = await writtenCount();
      if (n !== 0) failures.push(`${c.label}: ${n} record(s) written by a refused call`);
    }
    assert.deepEqual(failures, [],
      'save_bulk answers a name it does not know differently by door — the payload REST refuses with the '
      + 'replacement is a clean success that wrote nothing on MCP, which is the silent 207 Q-41 closed on one door');
  });
});
