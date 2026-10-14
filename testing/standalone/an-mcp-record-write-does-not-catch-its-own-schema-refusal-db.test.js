/**
 * The MCP record-write tools do not catch their own schema refusal: it reaches `callTool`, which answers every tool's
 * refusal the one way (`Q-315`, R4.1).
 *
 * ## The finding
 *
 * `save_entity` and `save_chrono` each wrapped the writer in a `try` for `SchemaViolationError` and answered a result of
 * their own. The entity catch built `Error: schema_violation: <message>`; the chrono catch built `Error: schema_violation`
 * and DROPPED the message. `callTool` already answers a thrown `SchemaViolationError` for every other tool (the update
 * tools, `save_fact`, `save_edge`) as `Error: <message>` with `structuredContent: toStructured()` and status 422. So the same
 * refusal read three ways over one door, and the chrono one told an agent that something was refused without saying what.
 *
 * ## What is held
 *
 *  - **Behaviour, every create tool alike.** For each of `save_entity`, `save_chrono`, `save_fact` and `save_edge`, through the
 *    dispatch both the MCP transport and `POST /api/<tool>` use, a write the strict schema refuses answers status 422, `isError`,
 *    `structuredContent` with exactly the keys of `toStructured()` and its tag, and text `Error: schema_violation: <the message
 *    of the structured body>` — so the chrono tool keeps its message, and the four tools say one thing. Nothing is stored.
 *  - **The doors are the same door.** The identical call over `transport: 'rest'` answers the identical text and body.
 *  - **No tool catches the family itself.** Derived from every file under `server/src/mcp/tools`: none branches on a member of
 *    the `SchemaViolation` family (the `instanceof` that was the catch), so a fifth tool written next year cannot grow one.
 *
 * ## Seen red
 *
 * On 85c4c564 `save_chrono` answers the text `Error: schema_violation` (no message), and both `mcp/tools/entity.ts` and
 * `mcp/tools/chrono.ts` branch on `SchemaViolationError`.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/an-mcp-record-write-does-not-catch-its-own-schema-refusal-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { readTrackedSources } from './_sources.mjs';

const skip = await mongoSkipReason();

const SPACE = 'ownrefusal';
const META = {
  validationMode: 'strict',
  typeSchemas: {
    entity: { person: { propertySchemas: { age: { type: 'number', required: true } } } },
    chrono: { event: { propertySchemas: { priority: { type: 'string', enum: ['low', 'high'] } } } },
    fact: { claim: { propertySchemas: { confidence: { type: 'number', required: true } } } },
    edge: { knows: { propertySchemas: { since: { type: 'number', required: true } } }, likes: {} },
  },
};
const STRUCTURED_KEYS = ['error', 'introduced', 'message', 'preExisting', 'violations'];

/** One refused write per create tool: the arguments, and the collection and the field the refusal is about. */
const REFUSED = {
  save_entity: { args: { name: 'Ann', type: 'person', properties: { age: 'old' } }, collection: 'entities', field: 'properties.age' },
  save_chrono: { args: { title: 'Launch', type: 'event', startsAt: '2026-10-01T00:00:00.000Z', properties: { priority: 'urgent' } }, collection: 'chrono', field: 'properties.priority' },
  save_fact: { args: { fact: 'the sky is blue', type: 'claim', properties: { confidence: 'high' } }, collection: 'facts', field: 'properties.confidence' },
};

let door;
describe('an MCP record write\'s schema refusal reaches the one mapping', { skip }, () => {
  before(async () => {
    door = await openToolDoor({ suite: 'mcpownrefusal', spaces: [{ id: SPACE, label: SPACE, folders: [], meta: META }] });
  });
  after(async () => { await door?.close(); });

  const stored = async (collection) => door.coll(SPACE, collection).countDocuments();

  for (const [tool, { args, collection, field }] of Object.entries(REFUSED)) {
    it(`${tool}: answers 422, the structured body, and \`Error: schema_violation: <message>\` — and stores nothing`, async () => {
      const before_ = await stored(collection);
      const out = await door.call(tool, { space: SPACE, ...args });
      assert.equal(out.status, 422, `${tool} answered ${out.status}: ${out.text}`);
      assert.equal(out.result.isError, true);
      assert.deepEqual(Object.keys(out.structured ?? {}).sort(), STRUCTURED_KEYS, `${tool}: structuredContent is not the refusal body`);
      assert.equal(out.structured.error, 'schema_violation');
      assert.ok(out.structured.introduced.some(v => v.field === field), `${tool}: the refusal does not name ${field}: ${JSON.stringify(out.structured.introduced)}`);
      assert.ok(typeof out.structured.message === 'string' && out.structured.message.includes(field),
        `${tool}: the refusal's message does not name ${field}: ${out.structured.message}`);
      assert.equal(out.text, `Error: schema_violation: ${out.structured.message}`,
        `${tool}: the text is not the one every tool's refusal reads (the chrono tool dropped the message)`);
      assert.equal(await stored(collection), before_, `${tool}: a refused write stored something`);
    });
  }

  it('save_edge: the same refusal reads the same way', async () => {
    // The two ends are stored directly: a valid `save_entity` embeds, and the harness has no model.
    const [from, to] = [randomUUID(), randomUUID()];
    await door.coll(SPACE, 'entities').insertMany([from, to].map((_id, i) => ({
      _id, spaceId: SPACE, name: `end ${i}`, type: 'person', tags: [], properties: { age: i + 1 }, seq: i + 1,
    })));
    const out = await door.call('save_edge', { space: SPACE, from, to, label: 'knows', properties: { since: 'long ago' } });
    assert.equal(out.status, 422, `save_edge answered ${out.status}: ${out.text}`);
    assert.deepEqual(Object.keys(out.structured ?? {}).sort(), STRUCTURED_KEYS);
    assert.equal(out.text, `Error: schema_violation: ${out.structured.message}`);
  });

  it('the REST door of the same tool answers the identical text and body', async () => {
    for (const [tool, { args }] of Object.entries(REFUSED)) {
      const mcp = await door.call(tool, { space: SPACE, ...args }, { transport: 'mcp' });
      const rest = await door.call(tool, { space: SPACE, ...args }, { transport: 'rest' });
      assert.equal(rest.status, mcp.status, `${tool}: the two doors answered different statuses`);
      assert.equal(rest.text, mcp.text, `${tool}: the two doors answered different text`);
      assert.deepEqual(rest.structured, mcp.structured, `${tool}: the two doors answered different bodies`);
    }
  });
});

describe('no MCP tool catches the schema refusal itself', () => {
  const tools = readTrackedSources('server/src/mcp/tools', { floor: 10 });

  /** The tool files that branch on a class whose name says SchemaViolation — the `instanceof` that is the catch. */
  const catching = tools.filter(({ file, text }) => {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    let found = false;
    (function visit(n) {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && /SchemaViolation/.test(n.right.getText(sf))) found = true;
      ts.forEachChild(n, visit);
    })(sf);
    return found;
  }).map(f => f.file);

  it('the derivation reads the tool files (a floor)', () => {
    assert.ok(tools.length >= 10, `only ${tools.length} tool file(s) read`);
    assert.ok(tools.some(f => f.file.endsWith('mcp/tools/entity.ts')) && tools.some(f => f.file.endsWith('mcp/tools/chrono.ts')), 'entity.ts or chrono.ts was not read');
  });

  it('none of them branches on a SchemaViolation class: `callTool` answers it for every tool', () => {
    assert.deepEqual(catching, [],
      'a tool answers a schema refusal itself, so it can say something other than every other tool says (save_chrono dropped the message); '
      + 'let it throw — callTool maps it once, with toStructured()');
  });
});
