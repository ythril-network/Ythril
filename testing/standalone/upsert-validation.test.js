/**
 * An upsert is validated against the record it will WRITE, not against the payload.
 *
 * ## The defect
 *
 * `upsertEntity` merges into the stored record when `id` matches: `{ ...stored.properties, ...incoming }`.
 * `upsertEdge` does the same, and its identity is `(from, to, label)` — no id anywhere in the call, so
 * EVERY repeat upsert of an existing edge merges and nothing in the payload hints at it.
 *
 * Six call sites validated the incoming payload instead. In a `strict` space, patching one property of a
 * conformant record was refused for required properties the record already had and would keep. Reported
 * by an operator whose agent could not update a complete record one field at a time.
 *
 * ## Why this is the update defect again
 *
 * #571 fixed exactly this for `update_*` — validate the merged record, and split violations into
 * introduced vs pre-existing so a record that was already non-compliant does not blame the caller. That
 * sweep stopped at the update tools and never reached upsert, which is the same write with a different
 * name. So the fix here is not new machinery: it is the same classifier, given the record the upsert
 * lands on.
 *
 * ## What this file pins
 *
 * The pure decision (`classify*UpsertAgainst`) rather than the loading wrapper, because the question is
 * *which record gets validated* and that is decided before any database call. Plus a source-level check
 * that no upsert path has gone back to handing a raw payload to a validator — the sites are enumerated
 * from the writers they call, not hand-listed, since a hand-listed set is how the first sweep missed
 * these.
 *
 * Run: node --test testing/standalone/upsert-validation.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';

let classifyEntityUpsertAgainst;
let classifyEdgeUpsertAgainst;
let mergeTagsAndProperties;
let mergePropertiesOrKeep;

/** A space that requires `owner` on every `machine` entity, and `since` on every edge. */
const STRICT_ENTITY = {
  validationMode: 'strict',
  typeSchemas: {
    entity: {
      machine: {
        propertySchemas: {
          owner: { type: 'string', required: true },
          rack: { type: 'string' },
        },
      },
    },
  },
};

const STRICT_EDGE = {
  validationMode: 'strict',
  typeSchemas: {
    edge: {
      'runs-on': {
        propertySchemas: {
          since: { type: 'string', required: true },
          note: { type: 'string' },
        },
      },
    },
  },
};

const WARN_ENTITY = { ...STRICT_ENTITY, validationMode: 'warn' };
const OFF_ENTITY = { ...STRICT_ENTITY, validationMode: 'off' };

/** The stored record: complete, conformant, exactly what the reporter had. */
const STORED = { name: 'node-7', type: 'machine', properties: { owner: 'platform', rack: 'B12' }, tags: ['prod'] };

describe('upsert validation', () => {
  before(async () => {
    ({ classifyEntityUpsertAgainst, classifyEdgeUpsertAgainst } =
      await import('../../server/dist/brain/write-validation.js'));
    // Both merge rules now live in one module — see brain/merge-fields.ts. They used to live with the
    // entity writer and the edge writer respectively, which is exactly why nine other sites re-derived them.
    ({ mergeTagsAndProperties, mergePropertiesOrKeep } = await import('../../server/dist/brain/merge-fields.js'));
  });

  describe('the reported case', () => {
    it('accepts a partial patch of a complete record', () => {
      // The payload alone has no `owner`, which is required. The MERGED record has it, from the store.
      const out = classifyEntityUpsertAgainst(STRICT_ENTITY, STORED,
        { name: 'node-7', type: 'machine', properties: { rack: 'C03' } });
      assert.equal(out.blocked, false,
        'a patch whose merged result is conformant must not be refused — this is the reported defect');
      assert.deepEqual(out.all, []);
    });

    it('still refuses the same payload as a NEW record', () => {
      // Same fragment, nothing to merge with: now `owner` really is missing.
      const out = classifyEntityUpsertAgainst(STRICT_ENTITY, null,
        { name: 'node-9', type: 'machine', properties: { rack: 'C03' } });
      assert.equal(out.blocked, true, 'an insert has no stored record to supply the required property');
      assert.deepEqual(out.introduced.map(x => x.field), ['properties.owner']);
      assert.deepEqual(out.preExisting, [], 'nothing can pre-exist on a record that does not exist yet');
    });

    it('refuses a patch that breaks the merged record', () => {
      // Overwriting a required property with the wrong type is the caller's doing, merge or no merge.
      const out = classifyEntityUpsertAgainst(STRICT_ENTITY, STORED,
        { name: 'node-7', type: 'machine', properties: { owner: 42 } });
      assert.equal(out.blocked, true, 'validating the merged record must not become validating nothing');
      assert.deepEqual(out.introduced.map(x => x.field), ['properties.owner']);
    });
  });

  describe('an already-broken record does not blame the caller', () => {
    const BROKEN = { name: 'node-3', type: 'machine', properties: { rack: 'A01' }, tags: [] };

    it('reports the record\'s own violation as pre-existing, not introduced', () => {
      const out = classifyEntityUpsertAgainst(STRICT_ENTITY, BROKEN,
        { name: 'node-3', type: 'machine', properties: { rack: 'A02' } });
      assert.deepEqual(out.preExisting.map(x => x.field), ['properties.owner']);
      assert.deepEqual(out.introduced, [], 'the caller touched `rack`, not `owner`');
      assert.match(out.message, /already non-compliant/);
      // Owner ruling P-6 = B, 2026-08-15. This asserted `blocked: true` — "the merged record is still what
      // gets stored" — and that WAS the freeze the canary operator reported: tightening a schema made every
      // record that no longer fit uneditable until an unrelated field was repaired in the same request.
      // The violation is already stored, so refusing the patch does not improve the data; it only blocks
      // maintenance. Reported, not refused.
      assert.equal(out.blocked, false, 'a pre-existing violation does not block an unrelated write');
      assert.ok(out.all.some(x => x.field === 'properties.owner'), 'still reported in `all`');
    });

    it('lets the same upsert repair it', () => {
      const out = classifyEntityUpsertAgainst(STRICT_ENTITY, BROKEN,
        { name: 'node-3', type: 'machine', properties: { owner: 'platform' } });
      assert.equal(out.blocked, false);
    });
  });

  describe('edges merge with no id in sight', () => {
    const STORED_EDGE = { label: 'runs-on', properties: { since: '2024-01-01', note: 'primary' } };

    it('accepts a partial patch of a complete edge', () => {
      const out = classifyEdgeUpsertAgainst(STRICT_EDGE, STORED_EDGE,
        { label: 'runs-on', properties: { note: 'secondary' } });
      assert.equal(out.blocked, false);
    });

    it('refuses the same payload for a new edge', () => {
      const out = classifyEdgeUpsertAgainst(STRICT_EDGE, null,
        { label: 'runs-on', properties: { note: 'secondary' } });
      assert.equal(out.blocked, true);
      assert.deepEqual(out.introduced.map(x => x.field), ['properties.since']);
    });

    it('treats absent properties as "leave them alone", not "clear them"', () => {
      // `properties: undefined` is the caller saying nothing about properties. Reading it as {} would
      // wipe a required field and refuse an upsert that only sets, say, a weight.
      const out = classifyEdgeUpsertAgainst(STRICT_EDGE, STORED_EDGE, { label: 'runs-on' });
      assert.equal(out.blocked, false);
      assert.deepEqual(mergePropertiesOrKeep(STORED_EDGE.properties, undefined), STORED_EDGE.properties);
    });
  });

  describe('validation mode still decides what is surfaced', () => {
    const PATCH = { name: 'node-9', type: 'machine', properties: { rack: 'C03' } };

    it('warn mode reports without blocking', () => {
      const out = classifyEntityUpsertAgainst(WARN_ENTITY, null, PATCH);
      assert.equal(out.blocked, false);
      assert.deepEqual(out.warnings.map(x => x.field), ['properties.owner'], 'warn mode still tells the caller');
    });

    it('off mode surfaces nothing at all', () => {
      const out = classifyEntityUpsertAgainst(OFF_ENTITY, null, PATCH);
      assert.equal(out.blocked, false);
      assert.deepEqual(out.warnings, [],
        'a space that switched validation off must not start receiving warnings because the create ' +
        'routes adopted this classifier');
      assert.equal(out.all.length, 1, '`all` is what the validator found; `warnings` is what the mode says to say');
    });
  });

  describe('the merge rule lives with the writer', () => {
    it('merges properties and unions tags', () => {
      const out = mergeTagsAndProperties({ tags: ['a'], properties: { x: 1, y: 2 } }, { tags: ['b'], properties: { y: 3 } });
      assert.deepEqual(out.properties, { x: 1, y: 3 });
      assert.deepEqual(out.tags.sort(), ['a', 'b']);
    });

    it('is the identity on an insert', () => {
      const out = mergeTagsAndProperties(null, { tags: ['b'], properties: { y: 3 } });
      assert.deepEqual(out, { tags: ['b'], properties: { y: 3 } });
    });
  });

  describe('no upsert path validates a raw payload', () => {
    /**
     * Enumerated from the WRITERS, not hand-listed: every file that calls `upsertEntity` or `upsertEdge`
     * is a site where a merge happens, and therefore a site that must not validate the payload. Hand-
     * listing is how the #571 sweep missed all six of these.
     */
    const WRITER_CALLERS = [
      'server/src/mcp/tools/entity.ts',
      'server/src/mcp/tools/edge.ts',
      'server/src/api/brain/entities.ts',
      'server/src/api/brain/edges.ts',
      'server/src/brain/bulk.ts',
      // `F-27`: the one-call write's `edges` field. It calls the merging writer and validates NOTHING
      // itself — which is the property this list exists to hold every caller to, and the reason adding a
      // row here is cheap rather than a formality.
      'server/src/brain/write-connections.ts',
    ];

    const strip = src => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

    it('the enumeration matches reality (the check itself works)', () => {
      // If a new file starts calling a merging writer, it belongs in this list — and the assertion below
      // has to see it. A gate whose scope is stale reads like coverage it does not have.
      //
      // Q-99 part 3: the merge moved into the write PLANNERS (`planEntity` / `planEdge`), and `upsertEntity` /
      // `upsertEdge` became doors over them. A batch now plans its items directly rather than calling the doors,
      // so a caller of EITHER spelling is a site where a merge happens. Listed through the shared git helper,
      // not readdir, so a gitignored scratch file cannot enter the set.
      const roots = ['server/src/mcp/tools', 'server/src/api/brain', 'server/src/brain'];
      const MERGING_WRITER_CALL = /\b(?:upsertEntity|upsertEdge|planEntity|planEdge)\(/;
      const found = trackedSources(roots, { specs: false, untracked: true, floor: 50 })
        .filter(p => MERGING_WRITER_CALL.test(strip(readFileSync(p, 'utf8'))));
      // The writers' own modules define the functions; exclude the definitions, keep the callers. The
      // path has to be anchored — `brain/entities.ts` also matches `api/brain/entities.ts`, which is a
      // caller, and dropping it would have made this check silently ignore two of the six sites. The doors
      // and the planners they delegate to are ONE writer, so both halves are definitions here.
      const callers = found.filter(p =>
        !/^server\/src\/brain\/(?:(?:entities|edges)|write-plan\/plan-(?:entity|edge))\.ts$/.test(p));
      assert.deepEqual(callers.sort(), [...WRITER_CALLERS].sort(),
        'a new caller of upsertEntity/upsertEdge must be checked here — it merges, so it must not ' +
        'validate the payload');
    });

    it('none of them classifies the upsert itself any more', () => {
      /*
       * This asserted the OPPOSITE until 2026-08-30 — that each caller runs a classifier — and that was right
       * while the rule lived at the doors. The owner ruled on 2026-08-29 that every writer validates, so the
       * merged-record check now happens inside `upsertEntity` / `upsertEdge`, against the record actually
       * about to be stored rather than a rebuild of it.
       *
       * The property this file is named for — an upsert is validated in its MERGED form — is asserted by the
       * classifiers exercised as functions above, and by `every-writer-validates-internally.test.js` over all
       * eight writers. What is left for a CALLER is to do none of it.
       *
       * Two intermediate drafts of this check accepted a caller that mentions `SchemaViolationError`, on the
       * grounds that translating the refusal is delegation. That is true but insufficient as a test: an MCP
       * tool needs no translation at all, because the router already converts the throw — so the tidiest
       * callers mention nothing and were reported as failures for it.
       */
      const offenders = [];
      for (const p of WRITER_CALLERS) {
        // `bulk.ts` composes the merge itself for its own counters and is allowed the direct validator call;
        // what it must not do is classify the upsert, which is the writer's job.
        for (const m of strip(readFileSync(p, 'utf8')).matchAll(/classify(Entity|Edge)Upsert\w*\(/g)) {
          offenders.push(`${p}: ${m[0]}`);
        }
      }
      assert.deepEqual(offenders, [],
        'these classify an upsert the writer already classifies, against a merge they rebuild themselves — '
        + 'one rule, two implementations, and the rebuilt one is what drifts:\n  ' + offenders.join('\n  '));
    });

    it('no caller passes the request payload straight to a validator', () => {
      // The exact shape of the defect: `validateEntity(meta, { ..., properties: <the payload> })` with no
      // merge in between. Matching the payload identifiers the six sites actually used.
      const offenders = [];
      for (const p of WRITER_CALLERS) {
        const src = strip(readFileSync(p, 'utf8'));
        for (const m of src.matchAll(/validate(?:Entity|Edge)\([^)]*properties:\s*([A-Za-z_$][\w$]*)/g)) {
          const arg = m[1];
          if (/^(props|properties|edgeProps|safeProps)$/.test(arg)) offenders.push(`${p} — properties: ${arg}`);
        }
      }
      assert.deepEqual(offenders, [],
        'that identifier is the incoming payload. The merged record is what gets stored.');
    });
  });
});
