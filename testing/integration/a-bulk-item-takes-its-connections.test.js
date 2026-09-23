/**
 * A batch item attaches its relationships in the same call, exactly as a single-record write does (`Q-44`).
 *
 * ## What was true before, and why it was invisible
 *
 * `F-27` gave every create door `linkEntities` and its siblings plus `edges`, through one module, so that
 * attaching a record to three things is one call rather than four. The batch door got none of it: a bulk
 * item could name two link classes, validated by a copy of the rule that lives in `write-connections.ts`,
 * and could not carry `edges` at all. So the door where the arithmetic is WORST — hundreds of records in
 * one request — was the one that still needed a second pass.
 *
 * The gate that was supposed to catch this scanned two directories and the batch writer is in neither, so
 * it was green about a set it never contained. That half is `every-write-door-takes-its-connections.test.js`.
 * This file is the other half: the gate proves the module is reached, and only a live instance proves the
 * relationships are actually THERE afterwards.
 *
 * ## Both doors, because it is one capability
 *
 * REST and MCP are one API with two doors, so every case here runs through both. A parameter that lands on
 * one surface alone is the same defect arriving as an omission.
 *
 * ## What a bad connection must NOT do
 *
 * Leave the record behind. The connections are refused before the item is written, so a fact whose `edges`
 * entry has no label is reported by index and does not exist afterwards — the alternative is a caller
 * getting an error and a row they did not ask for, which is the silent unlinked write made noisy rather
 * than fixed.
 *
 * Run: node --test testing/integration/a-bulk-item-takes-its-connections.test.js
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
/** An entity that already exists — every case here attaches to it, which is what `edges` is for. */
let targetId;

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  mcp = await openMcpSession(token);
  const e = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/entities`,
    { name: `bulk-conn-target-${RUN}`, type: 'concept' });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  targetId = e.body._id ?? e.body.id;
});

/*
 * The two doors, returning the same shape so every case below is written once.
 *
 * `save_bulk` is partial-success on both surfaces: a bad item is reported in `errors` and the request still
 * answers. So neither door has a status to assert on — what both are judged by is `errors` and what is in
 * the space afterwards.
 */
const viaRest = async (body) => {
  const r = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/bulk`, body);
  return { status: r.status, body: r.body };
};
const viaMcp = async (body) => {
  const r = await mcp.callTool('save_bulk', { space: SPACE, ...body });
  return { status: r?.isError ? 400 : 207, body: r?.structuredContent ?? {} };
};
const DOORS = [['REST', viaRest], ['MCP', viaMcp]];

/** Every edge out of `from`, read back through the generic collection reader. */
const edgesFrom = async (from) => {
  const r = await readCollection(INSTANCES.a, token, SPACE, 'edges', { filter: { from }, limit: 50 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.results;
};

/** The fact this batch just wrote, by its text — bulk does not return ids. */
const factByText = async (text) => {
  const r = await readCollection(INSTANCES.a, token, SPACE, 'facts', { filter: { fact: text }, limit: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.results[0] ?? null;
};

describe('an item carries `edges` to records that already exist', () => {
  for (const [door, call] of DOORS) {
    it(`${door}: a fact item's edge is written, labelled, and pointed the right way`, async () => {
      const text = `bulk fact with an edge ${door} ${RUN}`;
      const r = await call({
        facts: [{ fact: text, edges: [{ to: targetId, label: 'mentions' }] }],
      });
      assert.equal(r.body.errors?.length ?? 0, 0, JSON.stringify(r.body));

      const doc = await factByText(text);
      assert.ok(doc, `the fact was not written: ${JSON.stringify(r.body)}`);
      const edges = await edgesFrom(doc._id);
      assert.equal(edges.length, 1, `expected one edge out of the new fact: ${JSON.stringify(edges)}`);
      assert.equal(edges[0].to, targetId);
      assert.equal(edges[0].label, 'mentions');
      // The direction is data, not derivable — a reversed edge reads as plausible and is a different fact.
      assert.equal(edges[0].from, doc._id);
    });

    it(`${door}: an entity item carries edges too, though it holds no link classes`, async () => {
      /*
       * An entity is only ever the FAR end of a link, so it has no `link*` fields at all. It can still be
       * the start of a labelled edge, and a door that offered `edges` only where links exist would be
       * declaring the capability by accident rather than by rule.
       */
      const name = `bulk-entity-with-edge-${door}-${RUN}`;
      const r = await call({
        entities: [{ name, type: 'concept', edges: [{ to: targetId, label: 'relates_to' }] }],
      });
      assert.equal(r.body.errors?.length ?? 0, 0, JSON.stringify(r.body));

      const found = await readCollection(INSTANCES.a, token, SPACE, 'entities', { filter: { name }, limit: 2 });
      assert.equal(found.status, 200, JSON.stringify(found.body));
      assert.equal(found.results.length, 1, JSON.stringify(found.results));
      const edges = await edgesFrom(found.results[0]._id);
      assert.equal(edges.length, 1, `expected one edge out of the new entity: ${JSON.stringify(edges)}`);
      assert.equal(edges[0].label, 'relates_to');
    });

    it(`${door}: a chrono item carries both a link and an edge in one item`, async () => {
      const title = `bulk-chrono-conn-${door}-${RUN}`;
      const r = await call({
        chrono: [{
          title, type: 'event', startsAt: new Date().toISOString(),
          linkEntities: [targetId],
          edges: [{ to: targetId, label: 'scheduled_for' }],
        }],
      });
      assert.equal(r.body.errors?.length ?? 0, 0, JSON.stringify(r.body));

      const found = await readCollection(INSTANCES.a, token, SPACE, 'chrono', { filter: { title }, limit: 2 });
      assert.equal(found.status, 200, JSON.stringify(found.body));
      assert.equal(found.results.length, 1, JSON.stringify(found.results));
      const id = found.results[0]._id;

      const links = await readCollection(INSTANCES.a, token, SPACE, 'links', { filter: { from: id }, limit: 10 });
      assert.equal(links.status, 200, JSON.stringify(links.body));
      assert.equal(links.results.length, 1, `the link half did not land: ${JSON.stringify(links.results)}`);
      assert.equal(links.results[0].to, targetId);

      const edges = await edgesFrom(id);
      assert.equal(edges.length, 1, `the edge half did not land: ${JSON.stringify(edges)}`);
      assert.equal(edges[0].label, 'scheduled_for');
    });
  }
});

describe('the response says what it did with the connections it was given', () => {
  for (const [door, call] of DOORS) {
    it(`${door}: counts the links and the edges it attached`, async () => {
      /*
       * A count, because the alternative is a caller re-reading the space to find out whether the half they
       * cannot see from `inserted` happened. `inserted.edges` is the top-level `edges` ARRAY — an item's own
       * connections are a different question and get their own answer.
       */
      const r = await call({
        facts: [{
          fact: `bulk connection counting ${door} ${RUN}`,
          linkEntities: [targetId],
          edges: [{ to: targetId, label: 'counted_by' }],
        }],
      });
      assert.equal(r.body.errors?.length ?? 0, 0, JSON.stringify(r.body));
      assert.equal(r.body.connections?.links, 1, `links not reported: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.connections?.edges, 1, `edges not reported: ${JSON.stringify(r.body)}`);
    });
  }
});

describe('a connection it cannot honour is refused BEFORE the record is written', () => {
  for (const [door, call] of DOORS) {
    it(`${door}: an edge with no label reports the item and writes nothing`, async () => {
      const text = `bulk fact with a bad edge ${door} ${RUN}`;
      const r = await call({ facts: [{ fact: text, edges: [{ to: targetId }] }] });

      const errs = r.body.errors ?? [];
      assert.equal(errs.length, 1, `expected exactly one item error: ${JSON.stringify(r.body)}`);
      assert.equal(errs[0].type, 'fact');
      assert.equal(errs[0].index, 0);
      assert.match(errs[0].reason, /label/, `the reason must name the missing field: ${errs[0].reason}`);

      assert.equal(await factByText(text), null,
        'the fact was written anyway — a refused connection must leave no record behind');
      assert.equal(r.body.inserted?.facts ?? 0, 0, JSON.stringify(r.body));
    });

    it(`${door}: a link class the record cannot hold is refused, not ignored`, async () => {
      /*
       * A fact names entities and nothing else. Before this, `linkFiles` on a fact item was simply never
       * read — accepted, counted as inserted, and silently without the connection the caller asked for.
       * That is the failure the whole module exists to prevent, arriving as an omission.
       */
      const text = `bulk fact with an impossible link class ${door} ${RUN}`;
      const r = await call({ facts: [{ fact: text, linkFiles: ['some/path.md'] }] });

      const errs = r.body.errors ?? [];
      assert.equal(errs.length, 1, `expected exactly one item error: ${JSON.stringify(r.body)}`);
      assert.match(errs[0].reason, /linkFiles|file/,
        `the reason must name the class that was refused: ${errs[0].reason}`);
      assert.equal(await factByText(text), null, 'the fact was written despite an impossible link class');
    });

    it(`${door}: a \`$ref\` in an item's edge is refused and names where refs DO resolve`, async () => {
      /*
       * The correlation key belongs to the top-level `edges` array, which runs after every record array so a
       * reference can point at any of them. An item's own `edges` run with the item, so a forward reference
       * cannot resolve — and resolving only backwards would make the answer depend on the order somebody
       * happened to write their payload. Refused, with the alternative named.
       */
      const text = `bulk fact with a ref edge ${door} ${RUN}`;
      const r = await call({
        facts: [{ '$ref': `anchor-${RUN}`, fact: text, edges: [{ to: `$ref:anchor-${RUN}`, label: 'loops' }] }],
      });

      const errs = r.body.errors ?? [];
      assert.equal(errs.length, 1, `expected exactly one item error: ${JSON.stringify(r.body)}`);
      assert.match(errs[0].reason, /\$ref/, `the reason must name what was sent: ${errs[0].reason}`);
      assert.match(errs[0].reason, /edges/,
        `the reason must point at the array that DOES resolve a ref: ${errs[0].reason}`);
      assert.equal(await factByText(text), null, 'the fact was written despite an unresolvable edge');
    });
  }
});

describe('the top-level `edges` array still resolves a `$ref`', () => {
  it('a record and a labelled edge to it, in one call, unchanged', async () => {
    /*
     * The case the item-level refusal above must not have broken. This is what `save_bulk` has offered
     * since `F-27` item 2, and it is the reason an item's own `edges` can stay the simpler rule.
     */
    const text = `bulk ref anchor ${RUN}`;
    const r = await viaRest({
      facts: [{ '$ref': `post-${RUN}`, fact: text }],
      edges: [{ from: `$ref:post-${RUN}`, fromKind: 'fact', to: targetId, label: 'answers' }],
    });
    assert.equal(r.body.errors?.length ?? 0, 0, JSON.stringify(r.body));
    assert.equal(r.body.inserted?.edges, 1, JSON.stringify(r.body));

    const doc = await factByText(text);
    assert.ok(doc, 'the anchored fact was not written');
    const edges = await edgesFrom(doc._id);
    assert.equal(edges.length, 1, JSON.stringify(edges));
    assert.equal(edges[0].label, 'answers');
  });
});
