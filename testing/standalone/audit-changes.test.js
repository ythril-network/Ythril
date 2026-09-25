/**
 * What an audit entry is allowed to say about a change — and, far more importantly, what it can never say.
 *
 * Audit entries are queryable by any admin and retained for `audit.retentionDays`. Several audited routes
 * handle secrets directly: token create/regenerate/update, webhook create/update (target URLs and signing
 * secrets), and the media-config routes (vision / STT / NLI / assist API keys).
 *
 * That makes the shape of this feature the whole feature. Diffing a request body and stripping known-secret
 * names fails in the worst direction — forget one name and a live key lands in a retained store where
 * nothing will report it. An ALLOWLIST fails the other way: forget a field and the entry merely lacks it.
 *
 * These tests pin that direction, not the current field list. The list will grow; the direction must not
 * flip.
 *
 * Run: node --test testing/standalone/audit-changes.test.js
 * (requires a prior `npm run build` in server/ so server/dist exists)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { trackedSources } from './_sources.mjs';
import { KNOWLEDGE_TYPES } from '../../server/dist/config/types-knowledge.js';
import { readFileSync } from 'node:fs';

let auditChanges, AUDIT_CHANGE_FIELDS;

/** Anything whose NAME suggests a credential. Deliberately broad. */
const SECRETISH = /key|secret|token|password|credential|apikey|auth|bearer|signature|salt|hash/i;

describe('audit changes — nothing is recorded unless it was named', () => {
  before(async () => {
    ({ auditChanges, AUDIT_CHANGE_FIELDS } = await import('../../server/dist/audit/audit-changes.js'));
  });

  it('records nothing at all for an operation with no allowlist', () => {
    // The default must be silence. A route added later then leaks nothing until someone deliberately
    // decides what it may say — which is the only safe direction for a default to point.
    const before = { label: 'old', apiKey: 'sk-live-AAA' };
    const after = { label: 'new', apiKey: 'sk-live-BBB' };
    assert.deepEqual(auditChanges('token.create', before, after), []);
    assert.deepEqual(auditChanges('webhook.update', before, after), []);
    assert.deepEqual(auditChanges('some.route.added.next.year', before, after), []);
  });

  it('ignores unlisted fields even when they sit beside a listed one', () => {
    // The realistic leak: a PATCH body carrying both a harmless rename and a credential.
    const changes = auditChanges('space.update',
      { label: 'Old', apiKey: 'sk-live-AAA', secretToken: 'zzz' },
      { label: 'New', apiKey: 'sk-live-BBB', secretToken: 'yyy' });
    assert.deepEqual(changes.map(c => c.field), ['label']);
    assert.equal(JSON.stringify(changes).includes('sk-live'), false);
  });

  it('never names a credential-ish field in ANY allowlist', () => {
    // The guard against a future well-meant addition. If a genuinely safe field ever trips this, rename
    // the field rather than loosening the pattern.
    for (const [operation, fields] of Object.entries(AUDIT_CHANGE_FIELDS)) {
      for (const f of fields) {
        assert.ok(!SECRETISH.test(f), `${operation} allowlists "${f}", which reads like a credential`);
      }
    }
  });

  it('does not allowlist the operations whose payload IS a secret', () => {
    // token.create / token.regenerate produce the token; webhook.* carry URLs that can embed credentials
    // in userinfo or a query string. Absent by design, not by oversight.
    for (const op of ['token.create', 'token.regenerate', 'webhook.create', 'webhook.update']) {
      assert.equal(AUDIT_CHANGE_FIELDS[op], undefined, `${op} must not have a change allowlist`);
    }
  });
});

describe('audit changes — every allowlist is actually reachable', () => {
  before(async () => {
    ({ AUDIT_CHANGE_FIELDS } = await import('../../server/dist/audit/audit-changes.js'));
  });

  const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
  const ROUTE_SOURCES = [
    'server/src/api/spaces.ts', 'server/src/api/tokens.ts', 'server/src/api/media-config.ts',
    'server/src/api/networks/crud.ts', 'server/src/api/data.ts',
    // Brain record edits — the operations whose changes carry user content and expire early.
    'server/src/api/brain/facts.ts', 'server/src/api/brain/entities.ts',
    'server/src/api/brain/edges.ts', 'server/src/api/brain/chrono.ts',
  ];

  it('every allowlisted key is a REAL operation name from the middleware', () => {
    // The failure this catches, found end-to-end rather than by any unit test: the media route's
    // operation is `config.media.update`, and the allowlist said `media-config.update`. A key that
    // matches no operation is silent forever — the entry is written, `changes` never appears, and
    // nothing anywhere reports the mismatch.
    const middleware = read('server/src/audit/middleware.ts');
    const known = new Set([...middleware.matchAll(/operation:\s*'([^']+)'/g)].map(m => m[1]));
    assert.ok(known.size > 50, `expected the middleware operation table, parsed ${known.size}`);
    for (const key of Object.keys(AUDIT_CHANGE_FIELDS)) {
      assert.ok(known.has(key), `"${key}" is not an operation name in middleware.ts — it can never match`);
    }
  });

  it('every allowlisted operation has a route that supplies snapshots', () => {
    // An allowlist with no route behind it records nothing while claiming coverage — which is how the
    // FIRST slice shipped: four operations listed, one wired. Harmless (silence is the safe direction)
    // but misleading to anyone reading the list to find out what is audited.
    const wiredFiles = ROUTE_SOURCES.filter(f => read(f).includes('auditSnapshots'));
    assert.equal(wiredFiles.length, ROUTE_SOURCES.length,
      `these route files should set auditSnapshots but do not: ${ROUTE_SOURCES.filter(f => !wiredFiles.includes(f))}`);
  });

  it('allowlists the field names the routes can actually change', () => {
    // The second half of the same mistake: `token.update` was allowlisted as label/level/expiresAt when
    // the record field is `name` and the route changes nothing else. Entries that can never match are
    // silent forever, so nothing would have reported it.
    // `rights` joined `name` when PATCH gained the ability to edit the matrix. Both are asserted against the
    // route's own snapshot, not against each other: an allowlisted field the route never snapshots is silent
    // forever, and a snapshotted field the allowlist omits is an edit that leaves no audit trace — and the
    // second is worse here, because the field is the token's permissions.
    assert.deepEqual(AUDIT_CHANGE_FIELDS['token.update'], ['name', 'rights']);
    // Substring, not a regex: the snapshot spans two lines and a pattern that assumed one was the reason
    // this assertion first failed against code that was actually correct.
    const tokenSrc = read('server/src/api/tokens.ts');
    assert.ok(tokenSrc.includes('name: previous.name'), 'the route does not snapshot `name`');
    assert.ok(tokenSrc.includes('rights: previous.rights'),
      'the route does not snapshot `rights`, so a permissions edit would leave no audit trace');
  });

  it('network.update names exactly the three fields its PATCH can change', () => {
    // Same check for slice 3. The route assigns `label`, `syncSchedule` and `requireSignedVotes` and
    // nothing else; an allowlist naming a fourth would be silent forever rather than wrong-and-loud.
    const src = read('server/src/networks/network-acts.ts');  // the PATCH's act, shared with MCP (F-36)
    for (const f of AUDIT_CHANGE_FIELDS['network.update']) {
      assert.ok(src.includes(`net.${f} =`) || src.includes(`net.${f},`),
        `network.update allowlists "${f}", which the PATCH route never assigns`);
    }
  });

  it('the maintenance toggle snapshots the CURRENT state, not the requested one twice', () => {
    // The failure this guards is a plausible copy-paste: `before: { active: parsed.data.active }`.
    // from === to on every request, so `auditChanges` returns [] and maintenance mode looks like it
    // was never toggled — silent, and indistinguishable from the feature working.
    // Must match the ASSIGNMENT, not just the expression: data.ts has a second snapshot site
    // (backup-config), so a check for the bare pattern would pass with this one deleted, and one for
    // `auditSnapshots` anywhere in the file would pass with it assigned to a dead variable.
    const src = read('server/src/api/data.ts');
    assert.ok(/req\.auditSnapshots\s*=\s*\{\s*before:\s*\{\s*active:\s*isMaintenanceActive\(\)\s*\}/.test(src),
      'the maintenance route must assign req.auditSnapshots with isMaintenanceActive() as the before-state');
    assert.deepEqual(AUDIT_CHANGE_FIELDS['data.maintenance.toggle'], ['active']);
  });

  it('the backup-config allowlist matches the schema that validates the body', () => {
    // These are dotted paths into a nested config. A typo (retention.keepLocal -> retention.keep) reads
    // as "nothing changed" forever, so pin them against the schema that defines the shape.
    const schema = read('server/src/db/backup-config.ts');
    for (const path of AUDIT_CHANGE_FIELDS['data.backup_config.update']) {
      const leaf = path.split('.').pop();
      assert.ok(new RegExp(`\\b${leaf}\\s*:`).test(schema),
        `backup-config allowlists "${path}" but the schema defines no "${leaf}"`);
    }
  });
});

describe('audit changes — scalars only', () => {
  before(async () => {
    ({ auditChanges } = await import('../../server/dist/audit/audit-changes.js'));
  });

  it('drops objects and arrays rather than stringifying them', () => {
    // A nested value would mean one allowlisted parent name silently shipping every child it gains later —
    // the forget-one-field failure, reintroduced through nesting.
    const changes = auditChanges('space.update',
      { label: { nested: 'sk-live-AAA' } },
      { label: { nested: 'sk-live-BBB' } });
    assert.deepEqual(changes, []);
  });

  it('records scalar transitions with both sides', () => {
    const changes = auditChanges('space.update',
      { strictLinkage: false }, { strictLinkage: true });
    assert.deepEqual(changes, [{ field: 'strictLinkage', from: false, to: true }]);
  });

  it('distinguishes "was not set" from "set to null"', () => {
    // `from` absent means the field did not exist; from: null means it existed and was null. An audit
    // reader cannot reconstruct intent if those collapse together.
    const added = auditChanges('space.update', {}, { purpose: 'research' });
    assert.deepEqual(added, [{ field: 'purpose', to: 'research' }]);
    const nulled = auditChanges('space.update', { purpose: 'research' }, { purpose: null });
    assert.deepEqual(nulled, [{ field: 'purpose', from: 'research', to: null }]);
  });

  it('says nothing when nothing changed', () => {
    assert.deepEqual(auditChanges('space.update', { label: 'Same' }, { label: 'Same' }), []);
  });

  it('reads dotted paths without touching their siblings', () => {
    const changes = auditChanges('config.media.update',
      { levels: { images: 'caption', audio: 'off' }, vision: { apiKey: 'sk-AAA' } },
      { levels: { images: 'recognition', audio: 'off' }, vision: { apiKey: 'sk-BBB' } });
    assert.deepEqual(changes, [{ field: 'levels.images', from: 'caption', to: 'recognition' }]);
  });

  it('is safe on missing or malformed snapshots', () => {
    // The middleware may not have a "before" for every route; that must be silence, not a throw on a
    // fire-and-forget audit write.
    assert.deepEqual(auditChanges('space.update', null, { label: 'x' }), []);
    assert.deepEqual(auditChanges('space.update', undefined, undefined), []);
    assert.deepEqual(auditChanges('space.update', 'not-an-object', 42), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Brain record edits — list fields, and the content that must NOT be recorded
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('audit changes — list fields record what moved, not the whole list', () => {
  before(async () => {
    ({ auditChanges, AUDIT_CHANGE_FIELDS } = await import('../../server/dist/audit/audit-changes.js'));
  });

  it('records tags as added/removed rather than dropping them', () => {
    // The bug this exists to prevent is silent: `scalarOrDrop` discards arrays, so before this the
    // entry appeared with `tags` simply missing from `changes` — and a reader concludes the tags were
    // untouched. No error, no empty value, just absence.
    const changes = auditChanges('fact.update',
      { tags: ['a', 'b'] }, { tags: ['b', 'c'] });
    assert.deepEqual(changes, [{ field: 'tags', added: ['c'], removed: ['a'] }]);
  });

  it('treats an absent list as empty, so first-time tagging still records', () => {
    assert.deepEqual(auditChanges('fact.update', {}, { tags: ['new'] }),
      [{ field: 'tags', added: ['new'] }]);
  });

  it('records a cleared list as removals', () => {
    assert.deepEqual(auditChanges('fact.update', { tags: ['gone'] }, { tags: [] }),
      [{ field: 'tags', removed: ['gone'] }]);
  });

  it('says nothing when a list is merely reordered', () => {
    // Set semantics, not sequence — a reorder is not a change anyone needs explained, and recording
    // one would make every save look like an edit.
    assert.deepEqual(auditChanges('fact.update', { tags: ['a', 'b'] }, { tags: ['b', 'a'] }), []);
  });

  it('drops the whole field when a list contains a non-primitive', () => {
    // Fail-closed, same direction as everywhere else here: one object in the array and nothing is
    // recorded, rather than recording part of it or stringifying the object.
    assert.deepEqual(auditChanges('fact.update',
      { tags: ['a'] }, { tags: [{ nested: 'sk-live-AAA' }] }), []);
  });

  it('never records `properties` for any record type', () => {
    // The one field on a record whose KEYS the user chooses, so it is where a pasted credential would
    // land. The allowlist cannot vet names it has never seen, so the whole bag stays out.
    // The record types come from the source that defines them: a fifth knowledge type would arrive with an
    // audit operation of its own, and a list written here would keep passing while saying nothing about it.
    for (const op of KNOWLEDGE_TYPES.map(t => `${t}.update`)) {
      assert.ok(!(AUDIT_CHANGE_FIELDS[op] ?? []).includes('properties'),
        `${op} must not allowlist the free-form properties bag`);
      assert.deepEqual(
        auditChanges(op, { properties: { k: 'old' } }, { properties: { k: 'sk-live-AAA' } }), [],
        `${op} must record nothing from properties`);
    }
  });

  it('records the content fields the owner asked for', () => {
    // "Yes with a TTL" means content IS in scope — the TTL is the mitigation, not omission.
    const changes = auditChanges('fact.update',
      { fact: 'old text' }, { fact: 'new text' });
    assert.deepEqual(changes, [{ field: 'fact', from: 'old text', to: 'new text' }]);
  });

  it('every record operation that expires early has an allowlist, and vice versa', async () => {
    // The two lists are written in different files and must not drift: an operation with content in
    // `changes` but no early expiry would keep user content for the full 90 days.
    const { RECORD_CHANGE_OPERATIONS } = await import('../../server/dist/audit/change-retention.js');
    for (const op of Object.keys(AUDIT_CHANGE_FIELDS)) {
      const isRecordOp = /^(memory|entity|edge|chrono|file\.meta)\./.test(op);
      if (!isRecordOp) continue;
      assert.ok(RECORD_CHANGE_OPERATIONS.includes(op),
        `${op} records record content but is not in RECORD_CHANGE_OPERATIONS — its changes would ` +
        'keep the full audit retention instead of the short one.');
    }
  });
});

describe('audit changes — file meta and entity merge (the two held back from slice 2)', () => {
  before(async () => {
    ({ auditChanges, AUDIT_CHANGE_FIELDS } = await import('../../server/dist/audit/audit-changes.js'));
  });

  const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

  it('file meta records all THREE link sets, not just the entities', () => {
    /*
     * A file links to entities, chrono entries AND facts. Missing one means a link nobody can account
     * for later — and the symptom is a traversal that comes back empty, not an error.
     *
     * Named as the CALLER writes them since 5.0. A record no longer carries its connections, so the
     * route reads the link rows and folds them into the snapshot under the field a reader of the entry
     * would go and change — see `linkAuditSnapshots`.
     */
    const changes = auditChanges('file.meta.update',
      { linkEntities: ['e1'], linkChronos: ['c1'], linkFacts: ['m1'] },
      { linkEntities: ['e1', 'e2'], linkChronos: [], linkFacts: ['m1'] });
    assert.deepEqual(changes, [
      { field: 'linkEntities', added: ['e2'] },
      { field: 'linkChronos', removed: ['c1'] },
    ]);
  });

  it('file meta never records properties', () => {
    assert.ok(!AUDIT_CHANGE_FIELDS['file.meta.update'].includes('properties'));
    assert.deepEqual(
      auditChanges('file.meta.update', { properties: { k: 'a' } }, { properties: { k: 'sk-live-X' } }), []);
  });

  it('a merge records the absorbed name going to null', () => {
    // The id is in the path and the survivor is the entry id; the NAME is the only thing that stops
    // being resolvable once the record is gone.
    assert.deepEqual(
      auditChanges('entity.merge', { absorbedName: 'Acme Corp' }, { absorbedName: null }),
      [{ field: 'absorbedName', from: 'Acme Corp', to: null }]);
  });

  /**
   * A real before-snapshot: `before` reads a variable holding the pre-write record, not `{}`.
   *
   * The identifier is not pinned. It used to be spelled `prior` everywhere, and #571 folded that read
   * into the one update validation already needed — renaming it to `existing` and breaking four
   * assertions that were checking a variable NAME while claiming to check that the snapshot exists. The
   * property worth holding is "before comes from a read", so that is what this matches; `before: {}`
   * still fails, which is the mutation that matters.
   *
   * Nor is the LAYOUT pinned, for the same reason. Three routes now spread the record's link sets in
   * beside it — a record stopped carrying its connections in 5.0, so the diff has nowhere else to get
   * them — and a pattern demanding `before: existing ?? {}` and nothing else would fail on the change
   * that made link edits auditable again.
   */
  // Or through `readEditAudit` (Q-50), whose `before` is the prior read — pinned by the case below.
  const SNAPSHOT = /req\.auditSnapshots = (?:\{ before: (?:\{ \.\.\.)?\(?[A-Za-z_$][\w$]*(?:\[0\])? \?\? \{\}|[A-Za-z_$][\w$]*\.snapshots\()/;

  it('both routes actually supply snapshots — checked per SITE, not per file', () => {
    // The #471 rule: an allowlist with no route behind it records nothing while claiming coverage.
    //
    // Per-site matters because entities.ts now has TWO snapshot sites (the PATCH and the merge). A
    // file-level "does it mention auditSnapshots" check passes when either one is deleted — mutation
    // proved it, by removing the PATCH snapshot while every test stayed green.
    const entities = read('server/src/api/brain/entities.ts');
    assert.match(entities, SNAPSHOT, 'entity.update must snapshot around its PATCH');
    assert.match(entities, /before: \{ absorbedName: absorbed\.name \}/,
      'entity.merge must snapshot the absorbed name');

    assert.match(read('server/src/api/brain/file-meta.ts'), SNAPSHOT);
  });

  it('EVERY brain route with an update handler snapshots, whichever files those are', () => {
    /*
     * This said "derived rather than enumerated" and then enumerated three files — and the set is five: it
     * could not see `entities.ts` or `file-meta.ts`, both of which are checked one case up and neither of
     * which this case would have noticed losing its snapshot.
     *
     * Derived properly now, from the SHAPE: a file under `api/brain/` that registers a PATCH or a PUT is a
     * record update, and a record update without a before/after snapshot writes an audit entry saying
     * something changed and not what. A sixth record route fails here rather than shipping unaudited.
     */
    const updaters = trackedSources('server/src/api/brain/*.ts', { floor: 5 })
      .filter(f => /\.(patch|put)\(/.test(read(f)));
    assert.ok(updaters.length >= 5,
      `only ${updaters.length} brain route(s) with an update handler found — the scan is wrong, and an empty `
      + 'one reports every route audited');
    for (const file of updaters) {
      assert.match(read(file), SNAPSHOT, `${file} has an update handler and no audit snapshot, so its audit `
        + 'entry records that something changed without recording what');
    }
  });

  it('the shared edit read builds `before` from the record it read, not from nothing', () => {
    // Q-50: two routes and five tools take their snapshot from `readEditAudit`, so its `before` is theirs.
    assert.match(read('server/src/brain/edit-audit.ts'), /before: \{ \.\.\.\(\(prior \?\? \{\}\)/,
      'readEditAudit must spread the prior record into before');
  });

  it('the merge snapshot reads the absorbed entity, not the survivor', () => {
    // Recording `survivor.name` here would look correct and be useless — the survivor still exists.
    const src = read('server/src/api/brain/entities.ts');
    assert.match(src, /before: \{ absorbedName: absorbed\.name \}/,
      'the before-snapshot must come from the ABSORBED entity');
  });
});
