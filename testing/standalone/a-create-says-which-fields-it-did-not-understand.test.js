/**
 * A create route says which of the fields you sent it did not understand.
 *
 * ## Why this is worth a response field
 *
 * `POST /facts` had no body schema at all: it destructured the six keys it knew, hand-validated those, and
 * dropped everything else. `"totallyMadeUpField": "xyzzy"` returned `200` and a record id.
 *
 * So a caller cannot tell *"this parameter is not implemented"* from *"this parameter was applied"* — both are
 * a 200 and an id. That is not a hypothetical: it is how W-7 stayed hidden. The fleet integrator sent
 * `suppressEmbeddings` on a create, got a 200, and believed it; they found out only because the symptom
 * surfaced elsewhere and they ran a deliberate read-back and a recall probe.
 *
 * ## A warning, not a refusal
 *
 * They asked for exactly this and were explicit that a strict rejection might break existing callers. It is
 * also the better answer on its own terms: a `400` would answer a different question, and would turn every
 * forward-compatible client into a broken one the day a field is removed.
 *
 * The row goes in the `warnings` array these responses already carry for schema violations, in the same
 * `{field, value, reason}` shape — two warning channels on one response would be a worse outcome than the
 * silence it replaces.
 *
 * ## MCP needs none of this, and that asymmetry is the point
 *
 * An MCP tool's input schema is `additionalProperties: false` and the DISPATCHER enforces it, so an unknown
 * argument is refused there before any handler runs. A caller who tests through MCP and deploys through REST
 * gets two different answers to the same mistake, which is why the REST half has to say something.
 *
 * Run: node --test testing/standalone/a-create-says-which-fields-it-did-not-understand.test.js
 * (requires a prior `npm run build` in server/ — the reporter is imported from `dist`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const ROUTES = {
  facts: 'server/src/api/brain/facts.ts',
  entities: 'server/src/api/brain/entities.ts',
  edges: 'server/src/api/brain/edges.ts',
  chrono: 'server/src/api/brain/chrono.ts',
};

const src = (p) => stripComments(readFileSync(p, 'utf8'));

let warnFor, sharedKeys;

describe('unknown fields are reported, not swallowed', () => {
  before(async () => {
    ({ unknownFieldWarnings: warnFor, SHARED_WRITE_BODY_KEYS: sharedKeys } =
      await import('../../server/dist/api/brain/unknown-fields.js'));
  });

  it('the reporter is reachable (the suite cannot pass by importing nothing)', () => {
    assert.equal(typeof warnFor, 'function');
    assert.ok(Array.isArray(sharedKeys) && sharedKeys.length > 0, 'the shared write keys are missing');
  });

  it('an invented field is named, with what it accepts instead', () => {
    const rows = warnFor({ fact: 'a fact', totallyMadeUpField: 'xyzzy' }, ['fact']);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0].field, 'totallyMadeUpField');
    assert.match(rows[0].reason, /unknown/i, 'the reason has to say what is wrong');
    assert.match(rows[0].reason, /fact/,
      'the reason does not say what the route DOES accept, which is the half a caller acts on');
  });

  it('a body of only known fields warns about nothing', () => {
    // The control. Without it every case here passes on a function that warns about everything, and a create
    // that always returns warnings is a create nobody reads warnings from.
    assert.deepEqual(warnFor({ fact: 'a fact', tags: ['x'] }, ['fact', 'tags']), []);
  });

  it('the shared write options are known everywhere, without each route restating them', () => {
    /*
     * `ttlDays`, `waitForEmbedding` and the duplicate-check flags are read by helpers, not by the route body.
     * A route that declared only its own destructured keys would warn about every one of them — which is the
     * failure mode that makes a warnings array worthless: it would cry wolf on the commonest write there is.
     */
    for (const k of sharedKeys) {
      assert.deepEqual(warnFor({ [k]: 1 }, ['fact']), [],
        `${k} is read by a shared helper but is not in SHARED_WRITE_BODY_KEYS, so every route warns about it`);
    }
  });

  it('several unknown fields are all named, not just the first', () => {
    const rows = warnFor({ a: 1, b: 2, fact: 'x' }, ['fact']);
    assert.deepEqual(rows.map(r => r.field).sort(), ['a', 'b']);
  });

  it('a non-object body is not an unknown field', () => {
    // `req.body` can be undefined, a string, or an array depending on what was posted and what the parser did
    // with it. None of those is a bag of keys, and inventing warnings from one would report on nothing.
    for (const body of [undefined, null, 'a string', 42, ['x']]) {
      assert.deepEqual(warnFor(body, ['fact']), [], `a ${typeof body} body produced warnings`);
    }
  });
});

describe('every create route reports them', () => {
  let sharedKeys;
  before(async () => {
    ({ SHARED_WRITE_BODY_KEYS: sharedKeys } = await import('../../server/dist/api/brain/unknown-fields.js'));
  });

  /*
   * Derived from the routes rather than fixed at four, for the reason W-7 paid the day before: the reported
   * route gets fixed and the other three keep the defect. This is the same report's other half.
   */
  for (const [name, file] of Object.entries(ROUTES)) {
    it(`the ${name} create calls the reporter`, () => {
      const body = src(file);
      const at = body.indexOf(`Router.post('/spaces/:spaceId/${name}'`);
      assert.ok(at > 0, `could not find the ${name} create route — re-point this gate`);
      // From this route to the NEXT route registration, so a call in a neighbouring handler cannot satisfy
      // the assertion — the mistake `merge-runs-the-write-paths-validators` records making.
      const rest = body.slice(at + 20);
      const nextAt = rest.search(/Router\.(post|get|patch|delete|put)\(/);
      const handler = nextAt === -1 ? rest : rest.slice(0, nextAt);
      assert.match(handler, /unknownFieldWarnings\(/,
        `the ${name} create drops an unknown field silently, so a caller cannot tell an unimplemented `
        + 'parameter from an applied one — both are a 200 and an id');
    });
  }

  it('and the known-key list is not a second copy of the destructure', () => {
    /*
     * The direction that keeps this honest. Each route declares the keys it accepts; the destructure at the
     * top of the handler is what it actually READS. Two lists, and the one that drifts is the declaration —
     * a field added to the destructure and not to the list becomes an "unknown field" warning about a
     * parameter that works.
     *
     * So every name in a route's destructure must appear in its declared key list.
     */
    const offenders = [];
    for (const [name, file] of Object.entries(ROUTES)) {
      const body = src(file);
      const at = body.indexOf(`Router.post('/spaces/:spaceId/${name}'`);
      // `(?:[^{}]|\{\})*` and not `[^}]*`: the entities create defaults `properties = {}`, so a
      // brace-excluding class stops at that inner `}`, the match fails there, and the regex quietly finds the
      // PATCH handler's destructure further down instead — which reads `deleteFields` and reported it as an
      // undeclared field of the CREATE. A gate that silently changes subject is worse than one that fails.
      const destructure = /const \{((?:[^{}]|\{\})*)\} = req\.body \?\? \{\};/.exec(body.slice(at));
      assert.ok(destructure, `no body destructure found in the ${name} create`);
      const read = destructure[1]
        .split(',')
        .map(s => s.split(':')[0].split('=')[0].trim())
        .filter(Boolean);

      /*
       * The destructure is not the only way a route reads a key, and a gate that thought it was let a real
       * mutant through: `id` is taken with `req.body?.['id']` on the memories create, so removing it from the
       * declared list changed nothing here while every caller sending an id would have been warned that a
       * working parameter was unknown.
       *
       * Both spellings, for the reason this repo has written down twice — a dotted-only sweep reports clean.
       * The helper calls that pass the WHOLE body (`ttlDaysError(req.body)`) are not key reads and do not
       * match: this needs a `.` or a `['` immediately after `body`.
       */
      const rest2 = body.slice(at + 20);
      const stop = rest2.search(/Router\.(post|get|patch|delete|put)\(/);
      const handlerBody = stop === -1 ? rest2 : rest2.slice(0, stop);
      // `req.body?.['id']` is THREE spellings in one — optional chaining, then a bracket. A pattern that
      // allowed `?` but then demanded a `.` or a `[` immediately matched neither half of it, and a mutant
      // dropping `id` from the memories list survived because of it. The optional-chain operator has to be
      // consumed as a unit.
      for (const m of handlerBody.matchAll(/req\.body(?:\?\.|\.)?(?:\['(\w+)'\]|(\w+))/g)) {
        const k = m[1] ?? m[2];
        if (k && !read.includes(k)) read.push(k);
      }

      // Found by NAME across the whole file rather than by reading N characters backwards from the route.
      // A backwards character window starts inside its subject silently, which `gates-bound-their-subject-
      // structurally.test.js` refuses outright — and it was wrong here for a plainer reason too: the first
      // draft did `at - 3000`, which is NEGATIVE for a route near the top of its file and so sliced from
      // the END. The declaration's name contains the route's, so no window is needed at all.
      const declared = new RegExp(`const ${name.toUpperCase()}_CREATE_BODY_KEYS = \\[([^\\]]*)\\]`).exec(body);
      assert.ok(declared, `the ${name} create declares no ${name.toUpperCase()}_CREATE_BODY_KEYS list`);
      const known = declared[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);

      // A key the route reads directly may still be DECLARED in the shared list rather than its own —
      // `waitForEmbedding` is read as `req.body?.waitForEmbedding` on three routes and belongs to every
      // write. Accepted either way; what this refuses is a key accepted by neither.
      for (const k of read) {
        if (!known.includes(k) && !sharedKeys.includes(k)) {
          offenders.push(`${name}: reads \`${k}\` but declares it in neither its own list nor the shared one`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      'a field the route reads is missing from its accepted-key list, so sending it produces an "unknown '
      + `field" warning about a parameter that works:\n  ${offenders.join('\n  ')}`);
  });
});
