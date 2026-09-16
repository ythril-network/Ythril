/**
 * Record retention — every branch of **record > schema > space**, without a database.
 *
 * ## Where the requirement came from
 *
 * A canary operator, 2026-08-02. Their `operation-logs` space holds deploy `event`s next to `health-snapshot`
 * and `metrics-snapshot` records, and the two want opposite treatment — so a space-wide TTL is the wrong axis:
 *
 *   - deploy events are **content-free by design**, so they cluster tightly and displace knowledge. A recall
 *     for *"how is the platform deployed and what runs on the server"* returned four near-identical
 *     `platform-apps deployed` chronos at 0.874, above the guideline they wanted at 0.823;
 *   - snapshots exist to be **trended**, and 90 days is one quarter with no year-over-year.
 *
 * It is a recall-quality feature, not a storage one: their volumes were 516 and 139 records.
 *
 * ## Where the window lives, and why it moved
 *
 * The first cut put a per-type map on the SPACE (`chronoRetention`). The owner replaced it: the window belongs
 * on the TYPE, in `typeSchemas[collection][type].retention`, because that is where the type is already defined
 * and a second parallel map is a convention an operator has to know exists. It also generalises — `typeSchemas`
 * covers entity, memory, edge and chrono, so the tier reaches every typed record rather than chrono alone.
 *
 * That shape shipped into `[Unreleased]` only, never a release, so it was replaced outright with no alias.
 *
 * ## What must not go wrong
 *
 * The dangerous direction is deleting or redacting MORE than the operator asked for — a snapshot series
 * silently truncated, or a per-record `ttlDays` overridden by a type policy. Every case below is about
 * precedence, or about a policy that cannot fire.
 *
 * Run: node --test testing/standalone/chrono-retention.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { balancedFrom } from './_structural-window.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DAY = 86_400_000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

let retentionDays, contentDays, recordExpiry, recordContentExpiry,
  needsContentRedaction, REDACTED_CHRONO_FIELDS, declaredRetention, CONTENT_TIER_COLLECTIONS;

before(async () => {
  ({ retentionDays, contentDays, recordExpiry, recordContentExpiry,
    needsContentRedaction, REDACTED_CHRONO_FIELDS, declaredRetention, CONTENT_TIER_COLLECTIONS } =
    await import('../../server/dist/brain/chrono-retention.js'));
});

/** A space shaped like the reporter's: the schema carries the per-type windows. */
const chrono = (types) => ({ meta: { typeSchemas: { chrono: types } } });

const TELEMETRY = {
  recordTtlDays: 90,
  meta: {
    typeSchemas: {
      chrono: {
        event: { retention: { days: 90, contentDays: 14 } },
        episode: { retention: { days: 90 } },
        'health-snapshot': { retention: { days: 3650 } },
        'metrics-snapshot': { retention: { days: 3650 } },
      },
    },
  },
};

describe('which window applies', () => {
  it('the SCHEMA tier beats the space tier', () => {
    assert.equal(retentionDays(TELEMETRY, 'chrono', 'health-snapshot'), 3650);
    assert.equal(retentionDays(TELEMETRY, 'chrono', 'event'), 90);
  });

  it('a type with no schema window falls back to the space tier', () => {
    assert.equal(retentionDays(TELEMETRY, 'chrono', 'meeting'), 90);
  });

  it('an untyped record can only reach the space tier', () => {
    // Memories, edges and files may carry no type at all — which is why the space-wide number cannot be
    // replaced by the schema tier, only overridden by it.
    assert.equal(retentionDays(TELEMETRY, 'fact', undefined), 90);
    assert.equal(retentionDays({ recordTtlDays: 30 }, 'edge', undefined), 30);
  });

  it('no policy anywhere means no expiry at all', () => {
    assert.equal(retentionDays({}, 'chrono', 'event'), undefined);
    assert.equal(recordExpiry({}, 'chrono', 'event', T0), undefined);
  });

  it('the tier reaches every typed collection, not just chrono', () => {
    const space = { meta: { typeSchemas: { entity: { 'build-artifact': { retention: { days: 7 } } } } } };
    assert.equal(retentionDays(space, 'entity', 'build-artifact'), 7);
    assert.equal(retentionDays(space, 'entity', 'person'), undefined);
    // And a type name is scoped to its collection: the same name elsewhere is unaffected.
    assert.equal(retentionDays(space, 'fact', 'build-artifact'), undefined);
  });

  it('a type with ONLY contentDays still deletes on the space schedule', () => {
    // Reading "no days" as "keep forever" would silently retain records the operator expected to go — the
    // intent behind a content window is "redact sooner", not "exempt from deletion".
    const space = { recordTtlDays: 90, ...chrono({ event: { retention: { contentDays: 7 } } }) };
    assert.equal(retentionDays(space, 'chrono', 'event'), 90);
    assert.equal(contentDays(space, 'chrono', 'event'), 7);
  });

  it('rejects zero and negative windows rather than expiring instantly', () => {
    for (const bad of [0, -1, NaN, Infinity, '30', null, undefined]) {
      const space = chrono({ event: { retention: { days: bad } } });
      assert.equal(retentionDays(space, 'chrono', 'event'), undefined, `days=${String(bad)} was accepted`);
    }
  });
});

describe('the per-record ttlDays still wins', () => {
  it('an explicit ttlDays beats the schema tier', () => {
    assert.equal(recordExpiry(TELEMETRY, 'chrono', 'health-snapshot', T0, 5).getTime(), T0 + 5 * DAY);
  });

  it('ttlDays 0 or null means never expire, whatever the schema says', () => {
    assert.equal(recordExpiry(TELEMETRY, 'chrono', 'event', T0, 0), undefined);
    assert.equal(recordExpiry(TELEMETRY, 'chrono', 'event', T0, null), undefined);
  });

  it('an omitted ttlDays defers to the schema, then the space', () => {
    assert.equal(recordExpiry(TELEMETRY, 'chrono', 'event', T0).getTime(), T0 + 90 * DAY);
    assert.equal(recordExpiry(TELEMETRY, 'chrono', 'health-snapshot', T0).getTime(), T0 + 3650 * DAY);
    assert.equal(recordExpiry(TELEMETRY, 'chrono', 'unlisted', T0).getTime(), T0 + 90 * DAY);
  });

  it('expiry is measured from the record, not from now', () => {
    // The backfill stamps existing records from their own createdAt. Using `now` would hand every one of them a
    // fresh full window, which is the opposite of enabling a retention policy.
    const older = Date.parse('2020-06-01T00:00:00.000Z');
    assert.equal(recordExpiry(TELEMETRY, 'chrono', 'event', older).getTime(), older + 90 * DAY);
  });
});

describe('the content tier cannot be set up to never fire', () => {
  it('is chrono only — a content window elsewhere resolves to nothing', () => {
    // The fields it removes are chrono's. Accepting it on an entity type would store a setting that does
    // nothing, which is worse than refusing it.
    assert.deepEqual([...CONTENT_TIER_COLLECTIONS], ['chrono']);
    const space = { meta: { typeSchemas: { entity: { thing: { retention: { days: 90, contentDays: 5 } } } } } };
    assert.equal(contentDays(space, 'entity', 'thing'), undefined);
    assert.equal(recordContentExpiry(space, 'entity', 'thing', T0), undefined);
    // The delete half of the same block still applies.
    assert.equal(retentionDays(space, 'entity', 'thing'), 90);
  });

  it('a content window at or past the delete window is ignored', () => {
    for (const cd of [90, 120]) {
      const space = chrono({ event: { retention: { days: 90, contentDays: cd } } });
      assert.equal(contentDays(space, 'chrono', 'event'), undefined, `contentDays=${cd} was kept`);
    }
  });

  it('a content window inside the delete window applies', () => {
    assert.equal(contentDays(TELEMETRY, 'chrono', 'event'), 14);
    assert.equal(recordContentExpiry(TELEMETRY, 'chrono', 'event', T0).getTime(), T0 + 14 * DAY);
  });

  it('is checked against the SPACE window when the type sets no days', () => {
    const space = { recordTtlDays: 10, ...chrono({ event: { retention: { contentDays: 30 } } }) };
    assert.equal(contentDays(space, 'chrono', 'event'), undefined, '30 > the 10-day space window, so it can never fire');
  });

  it('a type with no content window never redacts', () => {
    assert.equal(contentDays(TELEMETRY, 'chrono', 'health-snapshot'), undefined);
    assert.equal(recordContentExpiry(TELEMETRY, 'chrono', 'health-snapshot', T0), undefined);
  });
});

describe('what redaction removes', () => {
  it('drops the vector along with the text', () => {
    // The whole point: a record that keeps its embedding keeps winning semantic searches for content that is no
    // longer there, which is the reported failure.
    for (const f of ['embedding', 'matchedText', 'description']) {
      assert.ok(REDACTED_CHRONO_FIELDS.includes(f), `${f} must be removed`);
    }
  });

  it('keeps the fact — title, type, when, tags and links are NOT removed', () => {
    for (const kept of ['title', 'type', 'startsAt', 'tags', 'entityIds', 'memoryIds', 'status']) {
      assert.equal(REDACTED_CHRONO_FIELDS.includes(kept), false, `${kept} must survive redaction`);
    }
  });

  it('keeps `properties` — the record goes semantically silent, not blank', () => {
    // Asked and answered by the reporting operator, who was holding a space's configuration on it: for an alert
    // episode `properties` (alertname, fingerprint, notifyCount, outcome) is the entire value and nothing else
    // records it. What displaces knowledge in recall is the VECTOR, plus the free text that produced it; a
    // structured field reachable only by explicit query displaces nothing. Removing it bought nothing this
    // feature exists to buy — `days` is what removes the structured data.
    assert.equal(REDACTED_CHRONO_FIELDS.includes('properties'), false,
      'properties must survive redaction, or the tier destroys the only thing a telemetry record was for');
  });

  it('does not rewrite a record that is already redacted', () => {
    assert.equal(needsContentRedaction({ contentRedacted: true, description: 'x' }), false);
  });

  it('reports nothing to do for a record that never had detail', () => {
    assert.equal(needsContentRedaction({ title: 'deployed' }), false);
    assert.equal(needsContentRedaction({ description: 'a note' }), true);
    assert.equal(needsContentRedaction({ embedding: [0.1] }), true);
  });
});

describe('listing what a space declares', () => {
  it('reports every collection.type with a window, sorted', () => {
    const found = declaredRetention(TELEMETRY);
    assert.deepEqual(found.map(r => r.type), ['episode', 'event', 'health-snapshot', 'metrics-snapshot']);
    assert.ok(found.every(r => r.collection === 'chrono'));
    assert.deepEqual(found.find(r => r.type === 'event'), { collection: 'chrono', type: 'event', days: 90, contentDays: 14 });
  });

  it('skips a type whose retention block is empty or absent', () => {
    const space = chrono({ a: { retention: {} }, b: { namingPattern: 'x' }, c: { retention: { days: 5 } } });
    assert.deepEqual(declaredRetention(space).map(r => r.type), ['c']);
  });

  it('is empty for a space with no schemas at all', () => {
    assert.deepEqual(declaredRetention({ recordTtlDays: 30 }), []);
  });
});

describe('the feature is reachable and wired', () => {
  // Named files. A rule nothing calls is a rule that does not exist, and this one is invisible when broken:
  // records simply keep accumulating, which is what the operator reported in the first place.
  it('the chrono write passes its collection and type so the schema tier applies', () => {
    const src = readFileSync(join(ROOT, 'server/src/brain/chrono.ts'), 'utf8');
    assert.match(src, /stampExpiryOnCreate\(spaceId,\s*doc,\s*ttlDays,\s*\{\s*collection:\s*'chrono',\s*type:\s*doc\.type\s*\}\)/);
  });

  it('the space PATCH accepts retention inside a type schema', () => {
    // `TypeSchemaZ` is `.strict()`, so an unlisted key is REJECTED — without this the field would be stripped
    // from every request and the whole tier would silently not exist.
    // `TypeSchemaZ` moved to `spaces/body-schemas.ts` with the rest of the space request bodies.
    const src = readFileSync(join(ROOT, 'server/src/spaces/body-schemas.ts'), 'utf8');
    // A WINDOW, converted: the subject is the `retention` object, bounded by the brace that closes it.
    // 200 characters reached past it into the sibling fields, so a `contentDays` declared on a NEIGHBOURING
    // property would have satisfied a check about this one.
    const at = src.indexOf('retention: z.object({');
    assert.ok(at > -1, 'the retention schema is gone — re-anchor this gate');
    assert.match(balancedFrom(src, src.indexOf('{', at + 'retention: z.object('.length - 1), 'the retention schema'),
      /contentDays: z\.number\(\)/);
  });

  it('the sweep runs both passes off the schema policy', () => {
    const src = readFileSync(join(ROOT, 'server/src/brain/ttl-sweep.ts'), 'utf8');
    assert.match(src, /sweepChronoRetention\(now\)/);
    const red = readFileSync(join(ROOT, 'server/src/brain/chrono-redaction.ts'), 'utf8');
    assert.match(red, /policedChronoTypes/);
    assert.match(red, /backfillChronoExpiry/);
    assert.match(red, /redactLapsedChronoContent/);
  });

  it('the backfill dates records from createdAt, never from now', () => {
    // The one line that decides whether enabling a policy prunes the backlog or resets it.
    const red = readFileSync(join(ROOT, 'server/src/brain/chrono-redaction.ts'), 'utf8');
    assert.match(red, /Date\.parse\(r\.createdAt/);
    assert.doesNotMatch(red, /recordExpiry\(space, 'chrono', r\.type, Date\.now\(\)/);
  });

  it('the content-expiry sweep query is indexed', () => {
    const ttl = readFileSync(join(ROOT, 'server/src/brain/ttl.ts'), 'utf8');
    assert.match(ttl, /createIndex\(\{ _contentExpireAt: 1 \}/);
  });

  it('the retired per-space map is gone, not merely unused', () => {
    // It shipped into [Unreleased] only, so it was replaced outright. A leftover field would be a second place
    // to configure one window — the exact thing the owner rejected.
    for (const f of ['server/src/config/types.ts', 'server/src/api/spaces.ts', 'server/src/spaces/spaces.ts']) {
      assert.doesNotMatch(readFileSync(join(ROOT, f), 'utf8'), /chronoRetention/, `${f} still mentions chronoRetention`);
    }
  });

  it('MCP tells an agent the precedence, not just the space default', () => {
    // An agent writing records is the caller most likely to need the override and least likely to read docs.
    const src = readFileSync(join(ROOT, 'server/src/mcp/tools/shared.ts'), 'utf8');
    assert.match(src, /RECORD > SCHEMA > SPACE/);
  });
});
