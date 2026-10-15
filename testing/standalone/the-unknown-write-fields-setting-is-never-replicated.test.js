/**
 * STRUCTURAL TRIPWIRE: `unknownWriteFields` is this instance's own setting and no meta, network or sync surface can carry it
 * (Q-320, bundle-128, design-v3 section 1 and 8.2 G9).
 *
 * ## Labelled a tripwire, because it cannot fail through `replicatedMetaOf` alone
 *
 * The setting is a TOP-LEVEL field of the space config, beside `dupeRules` and `recordTtlDays`, and that placement is what makes
 * it local: `replicatedMetaOf` copies only `meta`, the layer store and the vote round carry only metas, and the peer-facing
 * bodies are the `Incoming*` schemas. A test of `replicatedMetaOf` would therefore pass whether or not anyone had thought about
 * locality. What can break is the placement itself — a later change moving the key under `meta`, adding it to `SpaceMetaBody`,
 * or declaring it on an ingest schema. So this asserts the placement:
 *
 *   - it is a top-level `SPACE_FIELD_RIGHTS` row (no `meta.` prefix), so it is governed as a space setting;
 *   - it is NOT a key of `SpaceMetaBody`, and NOT a key of any `Incoming*Doc` schema (derived from the module, floor six);
 *   - the one meta-side list it appears in is `SERVER_OWNED_META_FIELDS` (it is read back on the meta answer, so a client that
 *     PATCHes the answer back must have it stripped, not refused — F-46);
 *   - no file under `server/src/sync` or `server/src/networks` mentions it.
 *
 * Its BEHAVIOURAL twin is a db case (design-v3 8.2 G9, T4: a network round and an adoption run with the key set, reading the
 * peer-facing body for the key); that case is not in this file because it needs a networked fixture.
 *
 * Seen red on the unchanged base: there is no row and no server-owned entry yet.
 *
 * Run: node --test testing/standalone/the-unknown-write-fields-setting-is-never-replicated.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { incomingSchemas } from '../_shared/incoming-sync-schemas.mjs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const KEY = 'unknownWriteFields';
const bodySchemas = await import('../../server/dist/spaces/body-schemas.js');
const { SPACE_FIELD_RIGHTS } = await import('../../server/dist/auth/space-field-rights.js');
const shared = await import('../../server/dist/api/sync/_shared.js');

const shapeKeys = (schema) => Object.keys(schema?.shape ?? schema?._def?.schema?.shape ?? {});

describe('the setting is a top-level space setting and a meta, network or sync surface cannot carry it', () => {
  it('it is a top-level SPACE_FIELD_RIGHTS row at schema:admin, not a `meta.` one', () => {
    assert.ok(Object.keys(SPACE_FIELD_RIGHTS).length >= 20, 'the rights table was not read');
    assert.deepEqual(SPACE_FIELD_RIGHTS[KEY], { area: 'schema', needs: 'admin' }, `no top-level ${KEY} row`);
    assert.equal(`meta.${KEY}` in SPACE_FIELD_RIGHTS, false, 'it is also governed as a meta key, which means it is placed under meta');
  });

  it('SpaceMetaBody does not take it, and the only meta-side list that names it is SERVER_OWNED_META_FIELDS', () => {
    assert.ok(shapeKeys(bodySchemas.SpaceMetaBody).length >= 8, 'SpaceMetaBody was not read');
    assert.equal(shapeKeys(bodySchemas.SpaceMetaBody).includes(KEY), false, 'a meta PATCH could set it, and a meta is replicated');
    assert.ok(bodySchemas.SERVER_OWNED_META_FIELDS.includes(KEY),
      'the meta answer carries the key but SERVER_OWNED_META_FIELDS does not name it, so a GET-then-PATCH would be refused for it');
  });

  it('no Incoming*Doc schema declares it (derived from the module; each one is a document a peer may send)', () => {
    const schemas = incomingSchemas(shared);
    const carrying = schemas.filter(([, schema]) => shapeKeys(schema).includes(KEY)).map(([name]) => name);
    assert.deepEqual(carrying, [], 'an ingest schema carries it, so a peer could set this instance\'s local setting');
  });

  it('nothing under server/src/sync or server/src/networks names it', () => {
    const files = trackedSources(['server/src/sync', 'server/src/networks'], { floor: 10 });
    const naming = files.filter(f => stripComments(readFileSync(f, 'utf8')).includes(KEY));
    assert.deepEqual(naming, [], 'a replication surface mentions the setting');
  });
});