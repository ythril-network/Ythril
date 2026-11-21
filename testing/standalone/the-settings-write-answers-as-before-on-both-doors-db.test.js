/**
 * The settings write answers as it did on both of its doors, `PATCH /api/spaces/:id` and MCP `schema_update`: a pin written before the
 * chain they share (field rungs, plan, price, audit, apply) moves into one act (bundle-270, Q-754, design revision 3).
 *
 * ## What it holds
 *
 * - A local write: 200 with the space on REST, `outcome: applied` on MCP; the audit pair handed over with the type the write added.
 * - A networked write: 202 `vote_pending` with its rounds and REST's fixed message, `outcome: vote_pending` on MCP; the merge notice of a
 *   replace that leaves types out (`appliedAsMerge`, `keptTypes`), the `warnings` row of a key members may refuse, and the conversion notice
 *   (`convert`) of a save that carries `convertRecords`, alike on both doors.
 * - The refusals, each by its status and nothing written: a space that does not exist (404), a stale `If-Match` (412, REST only), a body the
 *   strict parse refuses (400), a library reference that names nothing (422), the conversion price (403, its code alike on both doors), a
 *   field the caller's rungs do not reach (MCP 403 naming it; REST's middleware answers that one before the handler), and a space an RDF
 *   import holds (409 `space_being_rdf_imported`, as the app's final handler and the tool dispatcher answer it).
 * - A refusal hands over no audit pair.
 *
 * Run: node --test testing/standalone/the-settings-write-answers-as-before-on-both-doors-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir, handlerFor, fakeRes } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { seedActEntry, clearActEntries } from './_space-act-harness.mjs';
import { NET_ID, P1 } from './_vote-round-sites.mjs';

const dir = tempInstanceDir('ythril-settings-write-pin-');
const skip = await mongoSkipReason();
const LOCAL = 'local';
const SHARED = 'shared';
const ADMIN = { instanceAdmin: true, perSpace: {} };
const SEED_TYPES = { entity: { person: { propertySchemas: { age: { type: 'number' } } }, place: {} } };
const network = () => ({
  id: NET_ID, label: 'Net', type: 'closed', origin: 'created', syncSchedule: '', spaces: [SHARED], votingDeadlineHours: 24,
  createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
  members: [{ instanceId: P1, label: 'quiet-peer', url: 'https://p1.example', tokenHash: 'h', direction: 'both' }],
});

describe('the settings write answers as before on both doors', { skip }, () => {
  let inst, spacesRouter, spacesTools, spaceActAnswer;
  before(async () => {
    await openTestMongo('settings_write_pin');
    inst = await bootSchemaInstance(dir, {
      spaces: [
        { id: LOCAL, label: 'Local', folders: [], meta: { suppressEmbeddings: true, typeSchemas: SEED_TYPES } },
        { id: SHARED, label: 'Shared', folders: [], meta: { suppressEmbeddings: true, typeSchemas: SEED_TYPES } },
      ],
      networks: [network()],
    });
    ({ spacesRouter } = await import('../../server/dist/api/spaces.js'));
    spacesTools = await import('../../server/dist/mcp/tools/spaces.js');
    ({ spaceActAnswer } = await import('../../server/dist/spaces/space-act-answer.js'));
  });
  after(async () => {
    inst?.close();
    await closeTestMongo();
  });

  // The entries first: the loader's writer replaces the live config, which would undo a reset made before it.
  const fresh = () => {
    clearActEntries(inst.loader);
    inst.reset();
    const net = inst.loader.getConfig().networks.find(n => n.id === NET_ID);
    net.pendingRounds = [];
    delete net.schemaLayers;
  };
  const versionOf = (space) => inst.heldMeta(space).version ?? 0;
  const roundsOf = () => inst.loader.getConfig().networks.find(n => n.id === NET_ID).pendingRounds.length;

  /** The PATCH handler as the app runs it: a thrown act refusal is answered by the final handler's `spaceActAnswer`. */
  async function patchDoor(spaceId, body, { rights = ADMIN, ifMatch } = {}) {
    const req = {
      method: 'PATCH', params: { id: spaceId }, body, query: {}, headers: {}, ip: '127.0.0.1', authToken: { id: 'pin-token', rights },
      get: (h) => (h.toLowerCase() === 'if-match' ? ifMatch : undefined),
    };
    const res = fakeRes();
    try {
      await handlerFor(spacesRouter, 'patch', '/:id')(req, res);
    } catch (err) {
      const answer = spaceActAnswer(err);
      if (!answer) throw err;
      res.status(answer.status).json(answer.body);
    }
    return { status: res.code, body: res.body, audit: req.auditSnapshots };
  }

  /** `schema_update` as the dispatcher runs it: a thrown act refusal is answered with its status and its body as structured content. */
  async function toolDoor(spaceId, args, { rights = ADMIN } = {}) {
    let audit;
    const ctx = {
      callSpace: spaceId, callSpaces: [spaceId], accessibleSpaceIds: [spaceId], viewReads: new Map(), args: { space: spaceId, ...args }, rights,
      rateKey: 'pin-tool', recordChanges: (before, after) => { audit = { before, after }; },
    };
    try {
      const r = await spacesTools.schema_updateTool.handle(ctx);
      const text = (r.content ?? []).map(c => c.text ?? '').join('\n');
      const m = /Error \((\d{3})\)/.exec(text);
      return { status: m ? Number(m[1]) : (r.isError ? 500 : 200), isError: r.isError === true, text, structured: r.structuredContent ?? null, audit };
    } catch (err) {
      const answer = spaceActAnswer(err);
      if (!answer) throw err;
      return { status: answer.status, isError: true, text: answer.body.error, structured: answer.body, audit: undefined };
    }
  }

  const added = { typeSchemas: { entity: { tool: { propertySchemas: { maker: { type: 'string' } } } } } };

  it('a local write: 200 with the space on REST, applied on MCP, each with the audit pair naming the added type', async () => {
    fresh();
    const v0 = versionOf(LOCAL);
    const rest = await patchDoor(LOCAL, { meta: added });
    assert.equal(rest.status, 200, JSON.stringify(rest.body).slice(0, 300));
    assert.equal(rest.body?.space?.id, LOCAL);
    assert.ok(rest.audit?.before && rest.audit?.after, 'REST handed no audit pair');
    assert.ok('tool' in (rest.audit.after.typeSchemas?.entity ?? {}) && !('tool' in (rest.audit.before.typeSchemas?.entity ?? {})), 'the pair does not show the added type');
    assert.ok(versionOf(LOCAL) > v0, 'nothing was written');

    // Another type name: the pair is read against what the space holds, and the REST write above stays in its own definitions.
    const gadget = { typeSchemas: { entity: { gadget: {} } } };
    const mcp = await toolDoor(LOCAL, gadget);
    assert.equal(mcp.isError, false, mcp.text.slice(0, 300));
    assert.equal(mcp.structured?.outcome, 'applied');
    assert.match(mcp.text, /^Space 'local' schema updated \(typeSchemas\)\./);
    assert.ok('gadget' in (mcp.audit?.after?.typeSchemas?.entity ?? {}) && !('gadget' in (mcp.audit?.before?.typeSchemas?.entity ?? {})),
      `MCP handed no audit pair naming the type: ${JSON.stringify({ before: mcp.audit?.before?.typeSchemas, after: mcp.audit?.after?.typeSchemas })}`);
  });

  it('a networked write: 202 vote_pending with its rounds on REST, vote_pending on MCP, and the audit pair; no type is stored', async () => {
    fresh();
    const rest = await patchDoor(SHARED, { meta: added });
    assert.equal(rest.status, 202, JSON.stringify(rest.body).slice(0, 300));
    assert.equal(rest.body.status, 'vote_pending');
    assert.equal(rest.body.message, 'Meta change requires network vote');
    assert.equal(rest.body.rounds?.length, 1);
    assert.ok(rest.audit?.after, 'REST handed no audit pair for a proposed write');
    assert.equal(roundsOf(), 1, 'no round opened');
    assert.ok(!('tool' in (inst.heldTypes(SHARED).entity ?? {})), 'a proposed type was stored');

    fresh();
    const mcp = await toolDoor(SHARED, added);
    assert.equal(mcp.isError, false, mcp.text.slice(0, 300));
    assert.equal(mcp.structured?.outcome, 'vote_pending');
    assert.equal(mcp.structured?.rounds?.length, 1);
    assert.match(mcp.text, /^Proposed, NOT yet applied: 'shared' belongs to a network that votes on meta changes \(Net\)/);
    assert.ok(mcp.audit?.after, 'MCP handed no audit pair for a proposed write');
  });

  it('the notices: a replace leaving types out, a key members may refuse, and a conversion, alike on both doors', async () => {
    const answers = {};
    for (const door of ['rest', 'mcp']) {
      fresh();
      const replace = { typeSchemas: { entity: { person: SEED_TYPES.entity.person } } };
      const merged = door === 'rest' ? (await patchDoor(SHARED, { meta: replace, typeSchemasMode: 'replace' })).body
        : (await toolDoor(SHARED, { ...replace, typeSchemasMode: 'replace' })).structured;
      fresh();
      const skew = door === 'rest' ? (await patchDoor(SHARED, { meta: { stampSkew: { warnMinutes: 10 } } })).body
        : (await toolDoor(SHARED, { stampSkew: { warnMinutes: 10 } })).structured;
      fresh();
      const convert = door === 'rest' ? (await patchDoor(SHARED, { meta: added, convertRecords: {} })).body
        : (await toolDoor(SHARED, { ...added, convertRecords: {} })).structured;
      answers[door] = { merged, skew, convert };
    }
    for (const door of ['rest', 'mcp']) {
      const { merged, skew, convert } = answers[door];
      assert.equal(merged?.appliedAsMerge, true, `${door}: ${JSON.stringify(merged).slice(0, 300)}`);
      assert.deepEqual(merged.keptTypes, ['entity:place']);
      assert.match(merged.mergeNote, /left out of the replacement/);
      assert.ok((skew?.warnings ?? []).some(w => w.code === 'members_may_refuse_new_keys'), `${door}: ${JSON.stringify(skew).slice(0, 300)}`);
      assert.equal(convert?.convert?.state, 'after_vote', `${door}: ${JSON.stringify(convert).slice(0, 300)}`);
    }
    assert.deepEqual(answers.rest.merged.keptTypes, answers.mcp.merged.keptTypes);
    assert.deepEqual(answers.rest.skew.warnings, answers.mcp.skew.warnings);
    assert.deepEqual(answers.rest.convert.convert, answers.mcp.convert.convert);
  });

  it('a space that does not exist is 404 on both doors', async () => {
    fresh();
    const rest = await patchDoor('no-such-space', { meta: added });
    assert.equal(rest.status, 404, JSON.stringify(rest.body));
    assert.equal(rest.audit, undefined);
    const mcp = await toolDoor('no-such-space', added);
    assert.equal(mcp.status, 404, mcp.text);
    assert.equal(mcp.audit, undefined);
  });

  it('a stale If-Match is 412 naming both versions, and nothing is written', async () => {
    fresh();
    const v0 = versionOf(LOCAL);
    const rest = await patchDoor(LOCAL, { meta: added }, { ifMatch: String(v0 + 7) });
    assert.equal(rest.status, 412, JSON.stringify(rest.body));
    assert.equal(rest.body.currentVersion, v0);
    assert.equal(rest.audit, undefined);
    assert.equal(versionOf(LOCAL), v0);
  });

  it('a body the strict parse refuses is 400, and a library reference that names nothing is 422, on both doors', async () => {
    for (const door of ['rest', 'mcp']) {
      fresh();
      const v0 = versionOf(LOCAL);
      const typo = door === 'rest' ? await patchDoor(LOCAL, { meta: { validationMdoe: 'strict' } }) : await toolDoor(LOCAL, { typeSchemas: { entity: { bad: { propertySchemas: 5 } } } });
      assert.equal(typo.status, 400, `${door}: ${JSON.stringify(typo.body ?? typo.text).slice(0, 300)}`);
      const ref = { typeSchemas: { entity: { linked: { $ref: 'library:no-such-entry' } } } };
      const dangling = door === 'rest' ? await patchDoor(LOCAL, { meta: ref }) : await toolDoor(LOCAL, ref);
      assert.equal(dangling.status, 422, `${door}: ${JSON.stringify(dangling.body ?? dangling.text).slice(0, 300)}`);
      assert.equal(typo.audit, undefined);
      assert.equal(dangling.audit, undefined);
      assert.equal(versionOf(LOCAL), v0, `${door}: a refused write changed the version`);
    }
  });

  it('a save with convertRecords pays the conversion price: a caller without the space admin right is refused alike on both doors', async () => {
    // The fields' rungs admit it (typeSchemas: schema admin; convertRecords: knowledge admin); the price asks the space admin right on top.
    const rights = { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [LOCAL]: { knowledge: 'admin', files: 'none', schema: 'admin', dataQuality: 'none' } } };
    fresh();
    const v0 = versionOf(LOCAL);
    const rest = await patchDoor(LOCAL, { meta: added, convertRecords: {} }, { rights });
    assert.equal(rest.status, 403, JSON.stringify(rest.body));
    assert.ok(rest.body.code, 'the price refusal carries its code');
    assert.equal(rest.audit, undefined);
    const mcp = await toolDoor(LOCAL, { ...added, convertRecords: {} }, { rights });
    assert.equal(mcp.status, 403, mcp.text);
    assert.equal(mcp.structured?.code, rest.body.code);
    assert.equal(mcp.audit, undefined);
    assert.equal(versionOf(LOCAL), v0);
  });

  it('MCP: a field the caller\'s rungs do not reach is 403 naming it, before anything is planned', async () => {
    fresh();
    const rights = { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [LOCAL]: { knowledge: 'write', files: 'none', schema: 'none', dataQuality: 'none' } } };
    const mcp = await toolDoor(LOCAL, added, { rights });
    assert.equal(mcp.status, 403, mcp.text);
    assert.match(mcp.text, /Not allowed to change .*typeSchemas/);
    assert.equal(mcp.audit, undefined);
  });

  it('a space an RDF import holds is 409 space_being_rdf_imported on both doors, and nothing is written', async () => {
    fresh();
    await seedActEntry(inst.loader, { kind: 'rdf-import', localId: LOCAL, state: 'owed', retryAt: '2999-01-01T00:00:00.000Z', spoolId: 'planted' });
    const v0 = versionOf(LOCAL);
    const rest = await patchDoor(LOCAL, { meta: added });
    assert.equal(rest.status, 409, JSON.stringify(rest.body));
    assert.equal(rest.body.code, 'space_being_rdf_imported');
    assert.match(rest.body.error, /RDF import/i);
    const mcp = await toolDoor(LOCAL, added);
    assert.equal(mcp.status, 409, mcp.text);
    assert.equal(mcp.structured?.code, 'space_being_rdf_imported');
    assert.equal(versionOf(LOCAL), v0);
    clearActEntries(inst.loader);
  });
});
