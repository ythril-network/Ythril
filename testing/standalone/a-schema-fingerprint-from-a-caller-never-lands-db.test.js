/**
 * A `schemaFingerprint` a caller sends in a write body never lands: the server's own stamp does, or none (Q-736; bundle-265 design
 * revision 2 decision 4, revision 4 Q7).
 *
 * ## What is held
 *
 * - **Echoed, silently ignored.** A client that read a record and writes it back echoes the stamp. On every door (REST create and
 *   update, MCP create and update, a `save_bulk` item) a body carrying `schemaFingerprint: '0'*64` is answered 2xx with NO
 *   unknown-field row about it (it is a server-owned field, not an unknown one), and the stored value is the server's fingerprint of
 *   the space's schema — under the default `unknownWriteFields` and under `refuse` alike (it is never refused).
 * - **A non-conforming record echoing a stamp** (Q7) lands — a `warn` space lets the violation through with its warning — and is
 *   stored with NO stamp: neither the echoed value nor the server's, because it does not conform. This is what holds that the stamp is
 *   assigned only by the stamp op, never by spreading the body.
 * - **`deleteFields` refuses it by name** (it is a system field), on the door and in `validateDeleteFields`; the stored stamp stays.
 *
 * ## Red on the unchanged code (ce37b83a)
 *
 * The echoed key is named as an unknown field (warn) and refused (refuse); nothing is stamped, so the stored value is never the
 * server's; `deleteFields: ['schemaFingerprint']` is accepted. The non-conforming case passes today by absence (nothing is stamped);
 * it counts with the others, where the conforming twin in the same case is red.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-schema-fingerprint-from-a-caller-never-lands-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSchemaStampDoor, STRICT_META } from './_schema-stamp-door.mjs';

const skip = await mongoSkipReason();
const STRICT = 'echostrict';
const WARN = 'echowarn';
const ECHO = '0'.repeat(64);
const T0 = '2026-10-01T00:00:00.000Z';
const uniq = (s) => `${s} ${randomUUID().slice(0, 8)}`;

let door, getConfig;

/**
 * The rows of an answer about the echoed key, wherever they sit: a create's `warnings`, a bulk item's own rows, a refusal's issues.
 * Any object naming the key as its `field`, or listing it among `keys`.
 */
function rowsAboutTheStamp(answer) {
  const found = [];
  (function walk(v) {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    if (v.field === 'schemaFingerprint' || (Array.isArray(v.keys) && v.keys.includes('schemaFingerprint'))) found.push(v);
    Object.values(v).forEach(walk);
  })(answer);
  return found;
}

function setUnknownFields(space, mode) {
  const sp = getConfig().spaces.find(s => s.id === space);
  assert.ok(sp, `space ${space} is not in the config`);
  if (mode === 'refuse') sp.unknownWriteFields = 'refuse'; else delete sp.unknownWriteFields;
}

/** Every door, one conforming write each with the echoed stamp; `{ what, status, answer, text, row }` per door. */
async function echoOnEveryDoor(space) {
  const B = `/api/brain/spaces/${space}`;
  const out = [];
  const rest = async (what, method, url, body, part, idOf) => {
    const r = await door.rest(method, url, { ...body, schemaFingerprint: ECHO });
    const id = r.status < 300 ? idOf(r.body) : undefined;
    out.push({ what, status: r.status, answer: r.body, text: r.text, row: id ? await door.stored(space, part, id) : null });
  };
  const mcp = async (what, tool, args, part, filter) => {
    const r = await door.mcp(tool, { space, ...args, schemaFingerprint: ECHO });
    const rows = r.isError ? [] : await door.coll(space, part).find(filter).toArray();
    out.push({ what, status: r.isError ? Math.max(r.status, 400) : r.status, answer: r.body, text: r.text, row: rows.length === 1 ? rows[0] : null });
  };

  const fact = uniq('a rest fact');
  await rest('REST create', 'POST', `${B}/facts`, { fact, type: 'claim' }, 'facts', b => b?._id);
  const seeded = await door.rest('POST', `${B}/facts`, { fact: uniq('a fact to update'), type: 'claim' });
  assert.ok(seeded.status < 300, seeded.text);
  await rest('REST update', 'PATCH', `${B}/facts/${seeded.body._id}`, { description: 'updated' }, 'facts', () => seeded.body._id);
  const mFact = uniq('an mcp fact');
  await mcp('MCP create', 'save_fact', { fact: mFact, type: 'claim' }, 'facts', { fact: mFact });
  const mName = uniq('Echo person');
  await mcp('MCP create (entity)', 'save_entity', { name: mName, type: 'person' }, 'entities', { name: mName });
  const seeded2 = await door.rest('POST', `${B}/chrono`, { title: uniq('an event to update'), type: 'event', startsAt: T0 });
  assert.ok(seeded2.status < 300, seeded2.text);
  await mcp('MCP update', 'update_chrono', { id: seeded2.body._id, description: 'updated' }, 'chrono', { _id: seeded2.body._id });

  // A bulk item: the echoed key rides the item, not the call.
  const bFact = uniq('a bulk fact');
  const r = await door.mcp('save_bulk', { space, facts: [{ fact: bFact, type: 'claim', schemaFingerprint: ECHO }] });
  const rows = await door.coll(space, 'facts').find({ fact: bFact }).toArray();
  out.push({ what: 'save_bulk item', status: r.isError ? Math.max(r.status, 400) : r.status, answer: r.body, text: r.text, row: rows.length === 1 ? rows[0] : null });
  return out;
}

describe('a schemaFingerprint a caller sends never lands (Q-736)', { skip }, () => {
  before(async () => {
    door = await openSchemaStampDoor({
      name: 'b265echo', spaces: [STRICT, WARN],
      metaOf: (s) => (s === WARN ? { ...STRICT_META, validationMode: 'warn' } : STRICT_META),
    });
    ({ getConfig } = await import('../../server/dist/config/loader.js'));
  });
  after(async () => { await door?.close(); });

  for (const mode of ['warn', 'refuse']) {
    it(`unknownWriteFields ${mode}: every door answers 2xx, names nothing about the echo, and stores the server's stamp`, async () => {
      setUnknownFields(STRICT, mode);
      try {
        const doors = await echoOnEveryDoor(STRICT);
        const fp = await door.fpOrNull(STRICT);
        const failures = [];
        if (fp === null) failures.push('server/src/spaces/schema-stamp.ts is not built: there is no server stamp to store');
        for (const d of doors) {
          if (d.status >= 300) { failures.push(`${d.what}: answered ${d.status}: ${d.text.slice(0, 300)}`); continue; }
          const rows = rowsAboutTheStamp(d.answer);
          if (rows.length > 0 || /unknown field[^\n]*schemaFingerprint/.test(d.text)) failures.push(`${d.what}: the answer names the echoed stamp: ${JSON.stringify(rows)}`);
          if (!d.row) failures.push(`${d.what}: the write stored no row`);
          else if (d.row.schemaFingerprint === ECHO) failures.push(`${d.what}: the CALLER's stamp landed`);
          else if (d.row.schemaFingerprint === undefined || d.row.schemaFingerprint !== fp) failures.push(`${d.what}: stored ${d.row.schemaFingerprint ?? 'no stamp'}, not the server's`);
        }
        assert.deepEqual(failures, [], 'an echoed stamp must be ignored on every door: never warned, never refused, never stored');
      } finally { setUnknownFields(STRICT, 'warn'); }
    });
  }

  it('a non-conforming record whose body echoes a stamp lands unstamped; its conforming twin is stamped (Q7)', async () => {
    const B = `/api/brain/spaces/${WARN}`;
    const bad = await door.rest('POST', `${B}/facts`, { fact: uniq('a breaking fact'), type: 'claim', properties: { confidence: 'very' }, schemaFingerprint: ECHO });
    assert.ok(bad.status < 300, `a warn space refused the write: ${bad.text}`);
    assert.ok(JSON.stringify(bad.body?.warnings ?? []).includes('confidence'), `the violation was not warned: ${bad.text}`);
    const badRow = await door.stored(WARN, 'facts', bad.body._id);
    assert.ok(badRow, 'the non-conforming write stored nothing');
    assert.equal('schemaFingerprint' in badRow, false, `a non-conforming record carries a stamp: ${badRow.schemaFingerprint}`);

    const good = await door.rest('POST', `${B}/facts`, { fact: uniq('a conforming fact'), type: 'claim', properties: { confidence: 1 }, schemaFingerprint: ECHO });
    assert.ok(good.status < 300, good.text);
    const goodRow = await door.stored(WARN, 'facts', good.body._id);
    assert.notEqual(goodRow?.schemaFingerprint, ECHO, 'the caller\'s stamp landed on the conforming twin');
    await door.assertStamped(WARN, goodRow, 'the conforming twin');
  });

  it('deleteFields naming schemaFingerprint is refused by name, and the stored stamp stays', async () => {
    const { validateDeleteFields } = await import('../../server/dist/brain/delete-fields.js');
    const v = validateDeleteFields(['schemaFingerprint']);
    assert.equal(v.ok, false, 'validateDeleteFields accepts the stamp: a caller could remove the server\'s stamp, or $unset and $set one path in one write');
    assert.match(v.error, /schemaFingerprint/, `the refusal does not name the field: ${v.error}`);

    const B = `/api/brain/spaces/${STRICT}`;
    const made = await door.rest('POST', `${B}/facts`, { fact: uniq('a fact to keep its stamp'), type: 'claim' });
    assert.ok(made.status < 300, made.text);
    const r = await door.rest('PATCH', `${B}/facts/${made.body._id}`, { description: 'x', deleteFields: ['schemaFingerprint'] });
    assert.equal(r.status, 400, `the door accepted deleteFields: ['schemaFingerprint']: ${r.text}`);
    assert.match(r.text, /schemaFingerprint/, 'the door\'s refusal does not name the field');
    await door.assertStamped(STRICT, await door.stored(STRICT, 'facts', made.body._id), 'the row after a refused deleteFields');
  });
});
