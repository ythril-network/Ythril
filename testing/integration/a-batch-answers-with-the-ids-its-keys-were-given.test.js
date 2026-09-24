/**
 * A batch answers with the id every correlation key was given — on both doors.
 *
 * A `$ref` names a record the same call creates, so a later item can point at it. It was resolved inside
 * the call and then thrown away: the response carried counts, and a caller that needed the new ids — to
 * link a file to them, to write a second batch against them — read the space back by text, which is a
 * second round trip per record and ambiguous the moment two records share a text. `bulkWrite`'s own
 * contract said callers take ids "from the first response", and the first response had none.
 *
 * `refs` is keyed by the key the caller chose, so it is exactly as unambiguous as the payload was: every
 * key is unique within a call or the item is refused. A key whose item was refused is ABSENT, never
 * present with a guessed id — a caller reading `refs` must be able to trust every row in it.
 *
 * Run: node --test testing/integration/a-batch-answers-with-the-ids-its-keys-were-given.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, readCollection } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = 'general';

let token;
let mcp;

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  mcp = await openMcpSession(token);
});

const viaRest = async (body) => (await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/bulk`, body)).body;
const viaMcp = async (body) => (await mcp.callTool('save_bulk', { space: SPACE, ...body }))?.structuredContent ?? {};
const DOORS = [['REST', viaRest], ['MCP', viaMcp]];

const byId = async (collection, id) => {
  const r = await readCollection(INSTANCES.a, token, SPACE, collection, { filter: { _id: id }, limit: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.results[0] ?? null;
};

describe('every declared key comes back with its id', () => {
  for (const [door, call] of DOORS) {
    it(`${door}: an entity, a fact and a chrono entry, each by its key`, async () => {
      const name = `refs-entity-${door}-${RUN}`, text = `refs fact ${door} ${RUN}`, title = `refs chrono ${door} ${RUN}`;
      const body = await call({
        entities: [{ $ref: 'e1', name, type: 'concept' }],
        facts: [{ $ref: 'f1', fact: text }],
        chrono: [{ $ref: 'c1', title, type: 'event', startsAt: new Date().toISOString() }],
      });
      assert.equal(body.errors?.length ?? 0, 0, JSON.stringify(body));
      assert.deepEqual(Object.keys(body.refs ?? {}).sort(), ['c1', 'e1', 'f1'], JSON.stringify(body));
      assert.equal(body.refs.e1.kind, 'entity');
      assert.equal(body.refs.f1.kind, 'fact');
      assert.equal(body.refs.c1.kind, 'chrono');
      // The id is the record's, not a correlation token: read back by it, each is the one this call wrote.
      assert.equal((await byId('entities', body.refs.e1.id))?.name, name);
      assert.equal((await byId('facts', body.refs.f1.id))?.fact, text);
      assert.equal((await byId('chrono', body.refs.c1.id))?.title, title);
    });

    it(`${door}: an item with no key, and an item that was refused, add nothing to refs`, async () => {
      const body = await call({
        entities: [
          { name: `refs-unkeyed-${door}-${RUN}`, type: 'concept' },
          // Refused (no type) — its key must not appear with an id nobody was given.
          { $ref: 'bad', name: `refs-refused-${door}-${RUN}` },
        ],
      });
      assert.equal(body.errors?.length, 1, JSON.stringify(body));
      assert.deepEqual(body.refs ?? {}, {}, JSON.stringify(body));
    });
  }
});
