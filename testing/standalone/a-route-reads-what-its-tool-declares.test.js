/**
 * A brain write route reads exactly the keys its paired MCP tool declares, and the tool's handler reads exactly the keys it
 * declares — on every pair, derived, with the helper a handler hands its body to named rather than skipped (Q-320, bundle-128,
 * design-v3 section 8.2 G1).
 *
 * ## What the rule is, and where its subject comes from
 *
 * One answer to "which top-level field does a brain write take" is `acceptedWriteKeys(operation)`: the paired tool's
 * `inputSchema` properties minus addressing (`contract/write-accepts.ts`, which the plan creates). Every door judges an unknown
 * field against THAT set, so a door that READS a key the set lacks makes a working parameter an "unknown field" (a false
 * alarm under warn, a refusal of a working call under refuse), and a door that does not read a key the set holds makes a
 * declared parameter a silent no-op — the quietest failure this repo produces. This gate asserts the two are the same set, on
 * both doors, for every pair.
 *
 * ## How a handler's reads are found, and the half that fails instead of skipping
 *
 * `_brain-write-pairs.mjs` reads them out of comment-stripped source: a destructure, `req.body?.x`, a bracket access
 * (`body['x']`, `item['x']`, `a['x']`), `'x' in body`, and a helper that is handed the whole body, through the declared
 * helper -> keys map (`HELPER_KEYS`). **A handler that hands `req.body` (or `args`) to a helper NOT in the map fails the
 * gate**: a helper can read any key, so skipping it would report the handler's reads complete. So do a spread, an alias and a
 * computed key. And a paired route whose reads cannot be found at all fails, because "reads nothing" and "could not tell"
 * must not look alike.
 *
 * ## What it replaces
 *
 * It takes over the PRESENCE assertions of `a-create-says-which-fields-it-did-not-understand.test.js` and
 * `an-update-answers-the-same-questions-a-create-does-db.test.js`: those asked whether each route lists its destructured names
 * in a hand-kept `*_BODY_KEYS` array. There are no such arrays after this bundle (one source, `acceptedWriteKeys`), and the
 * drift they policed is what this derives; the first of those files now asserts that the arrays are gone. Seen red on the unchanged base: the plan's module does not exist
 * (`server/dist/contract/write-accepts.js`); and, with a stand-in for it derived as design-v3 2.1 says, the three creates that
 * read `waitForEmbedding` without declaring it, chrono's bulk `recurrence`, the connection helpers called without a kind, and
 * chrono's PATCH reading its body through an alias.
 *
 * Run: node --test testing/standalone/a-route-reads-what-its-tool-declares.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';
import { balancedFrom, blockAfter } from './_structural-window.mjs';
import {
  BRAIN_WRITE_PAIRS, RECORD_PAIRS, HELPER_KEYS, KIND_BOUNDED_HELPERS,
  restHandlerOf, toolHandlerOf, readsOf, argsIdentifier,
} from './_brain-write-pairs.mjs';

const { ROUTE_RULES } = await import('../../server/dist/audit/middleware.js');
const { MCP_TOOL_OPERATIONS } = await import('../../server/dist/mcp/audit-map.js');
const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
const connections = await import('../../server/dist/brain/write-connections.js');

/** The planned judge module. Its absence is part of the red output, and is reported by the case that needs it, not by an import. */
let judge;
let judgeMissing = null;
before(async () => {
  try { judge = await import('../../server/dist/contract/write-accepts.js'); } catch (err) { judgeMissing = err; }
});

/** `acceptedWriteKeys(op[, collection])` as a sorted array, or the reason the module is not there. */
function accepted(op, collection) {
  if (judgeMissing) throw new Error(`server/dist/contract/write-accepts.js (design-v3 2.1) cannot be imported: ${judgeMissing.message}`);
  const set = judge.acceptedWriteKeys(op, collection);
  return [...set].sort();
}

/**
 * The keys that ADDRESS a write rather than being part of it (design-v3 2.1): the space, the proxy target, and the record's
 * own id on an update. They are read by both doors and never judged, so they are taken out of a tool's reads.
 */
const addressing = (pair) => new Set([
  'space', 'targetSpace',
  ...(pair.tool.startsWith('update_') ? ['id'] : []),
  ...(pair.tool === 'update_file_meta' ? ['path'] : []),
  ...(pair.tool === 'graph_merge' ? ['survivorId', 'absorbedId'] : []),
]);

/** Link-class keys and `edges`, for a connection helper, from the one builder the tools declare them with. */
function connectionKeys(kind, which) {
  if (!['entity', 'fact', 'chrono', 'file'].includes(kind)) return [];
  if (which === 'edges') return ['edges'];
  if (which === 'links') return Object.keys(connections.linkInputSchemasFor(kind));
  return Object.keys(connections.connectionSchemas(kind));
}

/** Does this argument list carry a record kind (a literal, or a value named `…kind…`)? */
const carriesKind = (args) => args.some(a => /^['"](?:entity|fact|chrono|file|edge|link)['"]$/.test(a) || /kind/i.test(a));

/**
 * What a handler's reads come to: its own keys plus what each helper it hands the body to reads.
 * `unmapped` are helpers the map does not know (a failure), `noKind` are kind-bounded helpers called without one.
 */
function readsOfHandler(source, subject, kind) {
  const r = readsOf(source, subject);
  const keys = new Set(r.keys);
  const unmapped = [];
  const noKind = [];
  for (const h of r.handed) {
    const entry = HELPER_KEYS[h.callee];
    if (!entry) { unmapped.push(h.callee); continue; }
    for (const k of entry.keys ?? connectionKeys(kind, entry.connection)) keys.add(k);
    if (entry.needsKind && !carriesKind(h.args.slice(1))) noKind.push(h.callee);
  }
  return { keys, problems: r.problems, unmapped: [...new Set(unmapped)], noKind: [...new Set(noKind)] };
}

const diff = (a, b) => [...a].filter(k => !b.has(k)).sort();

describe('the instrument: what a handler reads is found, and what it cannot find fails', () => {
  // CONTROLS. They pass on the unchanged base by design: they prove the reader sees each spelling the design names, so the
  // cases below cannot report clean about a key the reader never saw.
  it('finds a destructure, optional chaining, bracket access, `in` and a mapped helper', () => {
    const src = `
      const { a1, b1 = 1, c1: renamed } = req.body ?? {};
      const x = req.body?.opt;
      const y = req.body['brk'];
      const z = req.body?.['optbrk'];
      const t = ttlDaysFromBody(req.body);
      const has = 'inkey' in req.body;
    `;
    const r = readsOfHandler(src, 'req.body', 'fact');
    assert.deepEqual([...r.keys].sort(), ['a1', 'b1', 'brk', 'c1', 'inkey', 'opt', 'optbrk', 'ttlDays']);
    assert.deepEqual([r.problems, r.unmapped], [[], []]);
  });

  it('finds item[\'x\'] and a tool\'s bound arguments', () => {
    assert.deepEqual([...readsOf(`const t = item['ttlDays']; const n = typeof item.name;`, 'item').keys].sort(), ['name', 'ttlDays']);
    const handle = `const { args: a, callSpace } = ctx; const n = a['name']; const d = a.description;`;
    assert.equal(argsIdentifier(handle), 'a');
    assert.deepEqual([...readsOf(handle, 'a').keys].sort(), ['description', 'name']);
  });

  it('FAILS on a body handed to a helper the map does not know, a spread, an alias, a computed key and a rest element', () => {
    assert.deepEqual(readsOfHandler('doSomething(req.body, 1);', 'req.body', 'fact').unmapped, ['doSomething']);
    assert.equal(readsOfHandler('const all = { ...req.body };', 'req.body', 'fact').problems.length, 1);
    assert.equal(readsOfHandler('const body = req.body; use(body);', 'req.body', 'fact').problems.length, 1);
    assert.equal(readsOfHandler('const k = req.body[name];', 'req.body', 'fact').problems.length, 1);
    assert.equal(readsOfHandler('const { a, ...others } = req.body;', 'req.body', 'fact').problems.length, 1);
  });

  it('does not read a key out of a string, and a guard is not a read', () => {
    const r = readsOfHandler(`const m = 'send a fact in a body'; const ok = !!req.body && typeof req.body === 'object';`, 'req.body', 'fact');
    assert.deepEqual([[...r.keys], r.problems, r.unmapped], [[], [], []]);
    assert.deepEqual([...readsOf(`const m = 'is a thing'; const t = \`a \${a['x']}\`;`, 'a').keys], ['x']);
  });
});

describe('the pairs are the registries\' brain writes, not a list that could miss one', () => {
  it('every pair resolves to a registered route and a tool whose operation is the pair\'s', () => {
    for (const p of BRAIN_WRITE_PAIRS) {
      assert.ok(restHandlerOf(p).source.length > 0, `${p.op}: the route's handler source is empty`);
      assert.ok(ALL_TOOLS.some(t => t.name === p.tool), `${p.op}: ${p.tool} is not a registered tool`);
      const ops = [MCP_TOOL_OPERATIONS[p.tool]].flat();
      assert.ok(ops.includes(p.op), `${p.tool} is paired to ${ops.join('|')}, not ${p.op}`);
      assert.ok(ROUTE_RULES.some(r => r.operation === p.op && r.method === p.method), `${p.op} has no audit rule for ${p.method}`);
    }
  });

  it('no create, update or merge operation of a brain route is outside the list (derived from the audit rules, with a floor)', () => {
    const judged = new Set(ROUTE_RULES
      .filter(r => r.method !== 'GET' && r.method !== 'DELETE' && r.pattern.source.includes('brain'))
      .map(r => r.operation)
      .filter(op => /\.(create|update|merge)$/.test(op) || op === 'bulk.write'));
    assert.ok(judged.size >= 12, `only ${judged.size} judged operations were derived — the derivation is wrong, not the code`);
    assert.deepEqual([...judged].filter(op => !BRAIN_WRITE_PAIRS.some(p => p.op === op)).sort(), [],
      'a brain write operation has no pair, so no gate reads its door');
    assert.ok(BRAIN_WRITE_PAIRS.length >= 12, 'the pair list shrank');
  });
});

describe('the REST route reads exactly what its tool declares', () => {
  for (const pair of RECORD_PAIRS) {
    it(`${pair.method} ${pair.route} (${pair.op})`, () => {
      const row = restHandlerOf(pair);
      const r = readsOfHandler(row.source, 'req.body', pair.kind);
      assert.deepEqual([r.problems, r.unmapped], [[], []],
        `${pair.op}: the route's reads cannot all be attributed to a key — a body handed to a helper not in HELPER_KEYS, or used through an alias, a spread or a computed key`);
      assert.deepEqual(r.noKind, [],
        `${pair.op}: a connection helper is called with no record kind, so it reads every link class including ones a ${pair.kind} cannot hold (design-v3 2.4)`);
      assert.ok(r.keys.size > 0, `${pair.op}: no read was found at all — "reads nothing" and "could not find them" must not look alike`);
      const want = new Set(accepted(pair.op));
      assert.deepEqual(diff(r.keys, want), [],
        `${pair.op}: the route reads keys that ${pair.tool} does not declare, so a caller's working parameter would be named unknown`);
      assert.deepEqual(diff(want, r.keys), [],
        `${pair.op}: ${pair.tool} declares keys the route never reads, so on REST they are a silent no-op`);
    });
  }
});

describe('the MCP handler reads exactly what its tool declares', () => {
  for (const pair of RECORD_PAIRS) {
    it(`${pair.tool} (${pair.op})`, () => {
      const t = toolHandlerOf(pair.tool);
      const id = argsIdentifier(t.handle);
      assert.ok(id, `${pair.tool}: the handler binds its arguments to nothing readable`);
      const r = readsOfHandler(t.handle, id, pair.kind);
      assert.deepEqual([r.problems, r.unmapped], [[], []],
        `${pair.tool}: the handler's reads cannot all be attributed to a key — arguments handed to a helper not in HELPER_KEYS, or used through an alias, a spread or a computed key`);
      assert.deepEqual(r.noKind, [],
        `${pair.tool}: a connection helper is called with no record kind, so it reads every link class including ones a ${pair.kind} cannot hold (design-v3 2.4)`);
      const own = diff(r.keys, addressing(pair));
      assert.ok(own.length > 0, `${pair.tool}: no read was found at all`);
      const want = new Set(accepted(pair.op));
      assert.deepEqual(diff(new Set(own), want), [], `${pair.tool}: the handler reads keys its own schema does not declare`);
      assert.deepEqual(diff(want, new Set(own)), [], `${pair.tool}: the schema declares keys the handler never reads`);
    });
  }
});

describe('a bulk item is read as its collection declares (the one reader both doors reach)', () => {
  const src = stripComments(readFileSync('server/src/brain/bulk.ts', 'utf8'));

  /** The `{ … }` of `for (… of slice(input.<collection>).entries()) { … }`. */
  function collectionLoop(collection) {
    const at = src.indexOf(`slice(input.${collection})`);
    assert.ok(at > -1, `no loop over input.${collection} in brain/bulk.ts — re-anchor this gate`);
    return blockAfter(src, src.indexOf(')', src.indexOf('.entries()', at)));
  }
  /** A named function's body, by structure. */
  function functionBody(name) {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at > -1, `no function ${name} in brain/bulk.ts — re-anchor this gate`);
    const params = balancedFrom(src, src.indexOf('(', at));
    return blockAfter(src, at + 'function '.length + name.length + params.length);
  }
  /** What the shared per-item closure `common(kind, item, i)` reads. */
  function commonBody() {
    const at = src.indexOf('const common = ');
    assert.ok(at > -1, 'no `common` closure in prepareItems — re-anchor this gate');
    return blockAfter(src, src.indexOf('=> {', at));
  }

  const COLLECTIONS = [
    ['facts', 'fact', () => [collectionLoop('facts'), commonBody()]],
    ['entities', 'entity', () => [collectionLoop('entities'), commonBody()]],
    ['chrono', 'chrono', () => [collectionLoop('chrono'), commonBody()]],
    ['edges', 'edge', () => [functionBody('planTopLevelEdge'), functionBody('topLevelEdgeWant')]],
  ];

  /** Helpers of this file that read a key of the item and are not in the shared map. */
  const BULK_HELPERS = { refKeyDeclared: ['$ref'], itemConnectionError: 'both', reject: [], common: [], planEdgeItem: [] };

  for (const [collection, kind, windows] of COLLECTIONS) {
    it(`${collection}: the keys the reader takes from an item are the keys save_bulk declares for it`, () => {
      const keys = new Set();
      for (const w of windows()) {
        const r = readsOf(w, 'item');
        for (const k of r.keys) keys.add(k);
        // The record is stored on the prepared row (`item,` in an object literal) and read back as `p.item`, which is read below.
        const real = r.problems.filter(p => !/\bitem, desired:/.test(p));
        assert.deepEqual(real, [], `${collection}: an item is read through something the reader cannot follow`);
        for (const h of r.handed) {
          const entry = HELPER_KEYS[h.callee];
          if (entry) { for (const k of entry.keys ?? connectionKeys(kind, entry.connection)) keys.add(k); continue; }
          const own = BULK_HELPERS[h.callee];
          assert.ok(own !== undefined, `${collection}: the item is handed to ${h.callee}(), which is in neither HELPER_KEYS nor this gate's bulk map`);
          for (const k of own === 'both' ? connectionKeys(kind, 'both') : own) keys.add(k);
        }
      }
      // The item is also read, field by field, from the prepared row.
      for (const k of readsOf(src, 'p.item').keys) if (['type', 'id'].includes(k)) keys.add(k);
      // `$ref`, the correlation key, is declared by every collection and read through `refKeyDeclared(item)`.
      if (/\brefKeyDeclared\(/.test(src)) keys.add('$ref');
      const want = new Set(accepted('bulk.write', collection));
      assert.ok(keys.size > 0, `${collection}: no item read was found`);
      assert.deepEqual(diff(keys, want), [],
        `${collection}: bulk reads and stores keys save_bulk does not declare for it, so a working field is named unknown and (under refuse) refused`);
      assert.deepEqual(diff(want, keys), [], `${collection}: save_bulk declares item keys the bulk writer never reads`);
    });
  }
});

describe('a connection helper reads only the link classes its record kind holds', () => {
  it('no connection helper is called without a record kind (V10: a link key a kind cannot hold is never read)', () => {
    // Every tracked source, not only the doors: the helpers are called from `readEditAudit` and the writers as well.
    const offenders = [];
    for (const f of trackedSources(['server/src'], { floor: 100 })) {
      if (f.endsWith('brain/write-connections.ts')) continue;
      const s = stripComments(readFileSync(f, 'utf8'));
      for (const name of KIND_BOUNDED_HELPERS) {
        for (const m of s.matchAll(new RegExp(`(?<![\\w.])${name}\\(`, 'g'))) {
          const args = balancedFrom(s, m.index + name.length);
          if (!carriesKind(args.slice(1, -1).split(',').map(x => x.trim()).slice(1))) offenders.push(`${f}: ${name}(…) passes no kind`);
        }
      }
    }
    assert.deepEqual(offenders, [], 'these calls read every link class, including ones the record kind cannot hold');
  });
});