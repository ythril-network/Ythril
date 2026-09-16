/**
 * A per-record write flag reaches all four record types on all the surfaces that can carry it, or none.
 *
 * ## Why this gate exists rather than a note
 *
 * Writes stopped waiting for the embedding model, which means a caller who will search for, scan, or
 * compare what it just wrote needs a way to say so. `waitForEmbedding` is that way — and it was added to
 * all four creator FUNCTIONS in one change while only ONE of the four ROUTES forwarded it.
 *
 * That gap was invisible from the code (each route looks complete on its own) and cost seven CI failures in
 * the duplicate-scanner suite, which creates entities and then scans: a scan cannot pair records that have
 * no vector yet. It was then fixed one route at a time, twice.
 *
 * The individual misses are cheap. The pattern is what this gate is for: it fails when the set is
 * INCONSISTENT, not when any particular route is missing, so it holds whichever way a future change moves.
 *
 * ## Why it was renamed, and why the detectors changed shape
 *
 * The `suppressEmbeddings` arm of the predecessor gate (then spelled `excludeFromVectorSearch`) PASSED on the very defect it was written for,
 * twice over, and both failures are worth keeping in view because they are the two ways a green means
 * nothing:
 *
 *  1. **Scope decided by a string the fix introduces.** It tested for `At least one field must be provided`
 *     to mean "this file has a PATCH handler". That message only existed in the three handlers already
 *     fixed, so `chrono.ts` — which has a PATCH handler and lacked the message — was classified out of
 *     scope. Three of three consistent, green, fourth type unreachable. An integrator found it by reading
 *     the source. Detect the HANDLER (`.patch(`), and assert the considered set is all four BEFORE
 *     comparing within it.
 *  2. **Presence anywhere in the file read as reachability.** `/<the field name>/.test(src)` stays
 *     true when the field is deleted from the writer call, because the same file still validates it and
 *     names it in an error message. Removing the forward — the exact reported defect — survived that
 *     detector. So each type now names the pattern that CONSTITUTES forwarding, and every detector is
 *     mutation-checked against a mention-only handler below.
 *
 * Run: node --test testing/standalone/record-flags-reachable-on-every-surface.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/**
 * The four brain record types that carry their own embedding.
 *
 * `forward` is what it means for THAT handler to hand the flag to its writer — not that the name occurs in
 * the file. Three build an allowlisted `updates` object, so the assignment into it is the forward; chrono
 * passes an inline object literal, so the forward is the field's presence in that call. Different shapes,
 * one question, and a regex per type is the honest way to ask it. Each is a factory so no two uses share
 * regex state.
 */
const ROUTES = {
  fact: {
    file: 'server/src/api/brain/facts.ts',
    forward: () => /if \(sup\.value !== undefined\) updates\.suppressEmbeddings = sup\.value;/,
  },
  entity: {
    file: 'server/src/api/brain/entities.ts',
    forward: () => /if \(sup\.value !== undefined\) updates\.suppressEmbeddings = sup\.value;/,
  },
  edge: {
    file: 'server/src/api/brain/edges.ts',
    forward: () => /if \(sup\.value !== undefined\) updates\.suppressEmbeddings = sup\.value;/,
  },
  chrono: {
    file: 'server/src/api/brain/chrono.ts',
    // Updated 2026-08-16 when chrono gained `deleteFields` (X-4) and the writer call became
    // `}, dfPaths, webhookToken(req), …`. The guard below caught the drift and refused to keep measuring,
    // which is exactly its job: a regex that silently stopped matching would have left this assertion green
    // for a flag nobody was forwarding.
    //
    // `dfPaths` is written out rather than skipped with a wildcard. Pinning the shape is the whole point —
    // a change to it should be reviewed, and `[^)]*` would trade that away to save one edit.
    forward: () => /suppressEmbeddings,\s*\}, dfPaths, webhookToken\(req\)/,
  },
};

/** The same four types on the MCP surface — the one an agent holds, where the flag reached none of them. */
const MCP_TOOLS = {
  fact: 'server/src/mcp/tools/fact.ts',
  entity: 'server/src/mcp/tools/entity.ts',
  edge: 'server/src/mcp/tools/edge.ts',
  chrono: 'server/src/mcp/tools/chrono.ts',
};

/** Comments stripped, so the gate cannot pass on the prose that documents it. */
const code = (p) => readFileSync(join(ROOT, p), 'utf8')
  .split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const routeCode = (type) => code(ROUTES[type].file);

describe('waitForEmbedding is reachable on every brain create route', () => {
  it('the detector sees the pattern it is gating', () => {
    // Mutation-check before trusting a positive: a matcher that matches everything is as useless as one
    // that matches nothing, and this gate's whole value is telling the four routes apart.
    assert.ok(/req\.body\?\.waitForEmbedding/.test('const x = req.body?.waitForEmbedding;'));
    assert.equal(/req\.body\?\.waitForEmbedding/.test('const x = req.body?.somethingElse;'), false);
  });

  it('all four routes read it, or none do', () => {
    const reads = {};
    for (const type of Object.keys(ROUTES)) {
      reads[type] = /req\.body\?\.waitForEmbedding/.test(routeCode(type));
    }
    const yes = Object.entries(reads).filter(([, v]) => v).map(([k]) => k);
    const no = Object.entries(reads).filter(([, v]) => !v).map(([k]) => k);

    assert.ok(yes.length === 4 || no.length === 4,
      `waitForEmbedding is reachable over REST for [${yes.join(', ')}] but not [${no.join(', ')}]. `
      + 'A caller writing one of the second group cannot ask for a synchronous embedding at all, so a '
      + 'write-then-search or write-then-scan flow has no correct form for that type. This exact gap cost '
      + 'seven duplicate-scanner failures. Add it to the rest, or remove it from all four deliberately.');
  });

  it('each route VALIDATES it rather than trusting the body', () => {
    // A boolean read straight out of a request body and passed to a writer is how a string "false" turns
    // into a truthy synchronous embed. Every route that reads it must also reject a non-boolean.
    const offenders = [];
    for (const type of Object.keys(ROUTES)) {
      const src = routeCode(type);
      if (!/req\.body\?\.waitForEmbedding/.test(src)) continue;
      if (!/typeof waitForEmbedding !== 'boolean'/.test(src)) offenders.push(type);
    }
    assert.deepEqual(offenders, [],
      'these routes read waitForEmbedding but never check it is a boolean');
  });
});

describe('suppressEmbeddings is reachable on every surface that can set it', () => {
  it('the PATCH detector keys on the handler, not on a message the fix introduces', () => {
    // Build the regex fresh per use — a shared /g literal advances lastIndex between calls and fakes a miss.
    const patch = () => /\.patch\(/;
    assert.ok(patch().test("router.patch('/spaces/:spaceId/chrono/:id', mw, async (req, res) => {"));
    assert.equal(patch().test("router.post('/spaces/:spaceId/chrono', mw, async (req, res) => {"), false);
    // The old detector's failure, reproduced: a real PATCH handler with no such message is NOT out of scope.
    const unfixed = "router.patch('/x/:id', async (req, res) => { res.json(await update(req.body)); });";
    assert.equal(/At least one field must be provided/.test(unfixed), false, 'the old detector saw nothing');
    assert.ok(patch().test(unfixed), 'the new detector still sees a PATCH handler');
  });

  it('the forward detectors distinguish forwarding from merely mentioning', () => {
    // The second way the predecessor passed on a real defect: a file that validates the flag and names it in
    // an error message contains the string with or without the forward. Every detector must reject the
    // mention-only shape, and must still match its own route — a detector that matches nothing measures
    // nothing, and this is the check that would have failed loudly instead of silently.
    //
    // Rewritten for 3.1.0's rename. The mention-only sample is the CURRENT shape with the forward taken out,
    // not the pre-rename one: a sample no detector could match either way would prove nothing about them.
    const mentionOnly = `
      const sup = parseRecordSuppression(req.body);
      if (!sup.ok) { res.status(400).json({ error: sup.error }); return; }
      const PATCHABLE_FIELDS = ['description', 'suppressEmbeddings', 'ttlDays'];
      const updated = await updateChrono(mid, id, {
        title, description,
      }, dfPaths, webhookToken(req), ttlDaysFromBody(req.body));
    `;
    for (const [type, { forward }] of Object.entries(ROUTES)) {
      assert.equal(forward().test(mentionOnly), false,
        `the ${type} forward detector matches a handler that only parses the flag and never passes it`);
      assert.ok(forward().test(routeCode(type)),
        `the ${type} forward detector does not match its own route — the handler changed shape, so this `
        + 'detector is measuring nothing. Update it deliberately.');
    }
  });

  it('every record type is actually CONSIDERED, not silently skipped', () => {
    // Assert the scope before comparing within it. A "3 of 3 consistent" pass over four types is how the
    // reported defect stayed green, and a count cannot tell absent from unlooked.
    const considered = Object.keys(ROUTES).filter(t => /\.patch\(/.test(routeCode(t)));
    assert.deepEqual(considered.sort(), ['chrono', 'edge', 'entity', 'fact'],
      'a brain record type has no PATCH handler, so the consistency check below would compare a short list. '
      + 'Either it lost its update route, or the file moved — decide which, do not let the gate skip it.');
  });

  it('all four REST PATCH handlers forward it, or none do', () => {
    const has = {};
    for (const [type, { forward }] of Object.entries(ROUTES)) {
      const src = routeCode(type);
      if (!/\.patch\(/.test(src)) continue;
      has[type] = forward().test(src);
    }
    const yes = Object.entries(has).filter(([, v]) => v).map(([k]) => k);
    const no = Object.entries(has).filter(([, v]) => !v).map(([k]) => k);
    assert.ok(yes.length === 0 || no.length === 0,
      `suppressEmbeddings is forwarded to the writer over REST for [${yes.join(', ')}] but not `
      + `[${no.join(', ')}]. A flag wired into the update function and not into the handler ships `
      + 'UNREACHABLE on the surface most integrators use, and these handlers DESTRUCTURE rather than '
      + 'allowlist, so sending it is a 200 that changes nothing.');
    assert.equal(Object.keys(has).length, 4, 'all four types must be in scope — see the test above');
  });

  it('every handler on BOTH doors reads it through the one shared parser', () => {
    // This replaced a per-file check for the literal refusal text, which stopped being evidence once the
    // refusal moved into `parseRecordSuppression`. The stronger question is the one this repo keeps getting
    // wrong: one rule, two implementations, the weaker winning silently. MCP's own copy WAS the weaker one —
    // `typeof a[...] === 'boolean'` accepted a non-boolean by dropping it, while REST answered 400 for the
    // same value. Eight handlers, one parser, or the two doors can disagree again.
    const offenders = [];
    for (const [type, { file }] of Object.entries(ROUTES)) {
      if (!/parseRecordSuppression\(req\.body\)/.test(code(file))) offenders.push(`REST ${type}`);
    }
    for (const [type, file] of Object.entries(MCP_TOOLS)) {
      if (!/parseRecordSuppression\(a\)/.test(code(file))) offenders.push(`MCP ${type}`);
    }
    assert.deepEqual(offenders, [],
      'these handlers do not go through parseRecordSuppression, so they carry their own copy of the '
      + 'record-tier rule — including which spellings are accepted and what a non-boolean does.');
  });

  it('all four MCP update tools accept it, or none do', () => {
    // REST and MCP are two doors onto one writer, and they have already diverged on this exact field: it
    // reached three REST handlers and zero MCP tools, so the capability was documented, implemented, and
    // unusable from the surface an agent holds. MCP schemas are `additionalProperties: false`, so a missing
    // field is at least a hard rejection rather than a silent drop — but rejected is still unreachable.
    const has = {};
    for (const [type, file] of Object.entries(MCP_TOOLS)) {
      const src = code(file);
      assert.match(src, /name: 'update_/, `${file} no longer defines an update tool — fix this gate's map`);
      // Both halves: the input schema must ADVERTISE it (or additionalProperties:false rejects the call)
      // and the handler must READ it out of the args.
      has[type] = /suppressEmbeddings: SUPPRESS_EMBEDDINGS_SCHEMA/.test(src)
        && /parseRecordSuppression\(a\)/.test(src);
    }
    const yes = Object.entries(has).filter(([, v]) => v).map(([k]) => k);
    const no = Object.entries(has).filter(([, v]) => !v).map(([k]) => k);
    assert.ok(yes.length === 0 || no.length === 0,
      `suppressEmbeddings is settable over MCP for [${yes.join(', ')}] but not [${no.join(', ')}]. `
      + 'A tool whose schema advertises the field but whose handler drops it, or the reverse, counts as not '
      + 'settable — both halves are checked.');
  });

  it('REST and MCP agree with each other, not merely each with itself', () => {
    // Two internally-consistent halves that disagree is the shape this whole gate keeps catching. Compare
    // ACROSS the surfaces, or a future sweep of one door passes twice and fixes half the problem.
    const rest = Object.entries(ROUTES).some(([type, { forward }]) => forward().test(routeCode(type)));
    const mcp = Object.values(MCP_TOOLS).some(f => /parseRecordSuppression\(a\)/.test(code(f)));
    assert.equal(rest, mcp,
      `suppressEmbeddings is reachable over ${rest ? 'REST but not MCP' : 'MCP but not REST'}. `
      + 'One rule, two surfaces: gate on consistency, not on presence.');
  });

  /*
   * ── THREE ALIAS CASES STOOD HERE and went with `D-6` in 4.0 ──────────────────────────────────
   *
   * They held the pre-3.1.0 spelling to a narrow shape while it existed: DECLARED on every MCP tool that
   * takes the flag (because a tool schema is `additionalProperties: false` and the dispatcher validates
   * before the handler, so an undeclared alias is refused where REST accepted it); appearing ONLY as the
   * shared alias constant and never in a tool's own prose; and redirecting to the real description rather
   * than restating the behaviour.
   *
   * Every one of them was about a name that no longer exists. They are deleted rather than inverted,
   * because `the-legacy-suppression-spelling-is-gone.test.js` asserts the absence across every server
   * source and both doors — and an inverted copy here would be the same rule in two files.
   *
   * **The reasoning is kept because it is the part that generalises.** The first of the three was itself
   * an inversion: it originally demanded the old name appear NOWHERE in a tool file, on the sound-looking
   * ground that a schema description is what an agent constructs arguments from. CI proved the conclusion
   * wrong — removing the property does not hide the alias, it makes the tool REFUSE it, which is a
   * capability difference between the doors rather than a documentation one. That is now exactly what
   * makes the removal work, and it is why `D-6` is a deletion in the schemas rather than a change in any
   * handler.
   */
  it('the legacy chrono POST-as-update form is GONE, so there is no deprecated door to drop it on', () => {
    // This assertion is inverted from what it was. While the route existed it had to REFUSE the flag —
    // performing no property validation and writing no audit snapshot, it was not a place to grant new
    // capability, and a silent drop there would have rebuilt the same trap on the deprecated door.
    //
    // 3.0 removed the route, so the refusal it required went with it. The check is kept rather than
    // deleted because a returning POST-as-update would arrive without that refusal, and this file is where
    // the consequence is written down.
    const src = code(ROUTES.chrono.file);
    assert.ok(!/chronoRouter\.post\('\/spaces\/:spaceId\/chrono\/:id'/.test(src),
      'the legacy POST-as-update route is back; it must refuse suppressEmbeddings, or be removed again');
    assert.ok(!/not supported on the legacy POST-as-update form/.test(src),
      'a refusal message for a route that no longer exists is dead text that reads like a live rule');
  });
});
