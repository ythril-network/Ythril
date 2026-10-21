/**
 * Every space request body refuses a key it does not know.
 *
 * ## The defect this closes
 *
 * Four of the ten body schemas were `.strict()` and six were not, and the split fell across one nesting level:
 *
 *     PATCH {"meta":{"validationMdoe":"strict"}}     -> 400, refused
 *     PATCH {"label":"x","validaitonMode":"strict"}  -> 200, label applied and the typo gone
 *
 * The same misspelling, refused one level down and swallowed one level up. A typo in `faceDescriptorDims`
 * created a space at the DEFAULT descriptor width and reported 201 — the caller's notes say 512, the gallery
 * is 128, and nothing in the response, the record or the log distinguishes the two.
 *
 * It is the same failure the token mint route had in 2.6, where `{"spaceIds":["qa"]}` returned 201 with no
 * scoping at all. That one was closed by `.strict()`; this is the rest of it.
 *
 * ## Why it needed a ruling and not just a commit
 *
 * Refusing is BREAKING for any integrator currently sending a key we ignore: a 200 becomes a 400 on a request
 * whose shape has not changed. Parked as P-4 with A recommended, and the owner ruled A on 2026-08-15.
 *
 * ## Why the list is DERIVED
 *
 * A hand-written list of ten names is a second copy that goes stale the moment somebody adds an eleventh
 * body — and the failure mode is silence, because a body nobody listed is a body nobody checks. So the names
 * come out of the module itself: every exported `z.object(...)` in `body-schemas.ts` must carry `.strict()`.
 *
 * Run: node --test testing/standalone/space-bodies-are-strict.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = 'server/src/spaces/body-schemas.ts';

/** Line comments first, then block — a block-open inside a line comment otherwise swallows real code. */
const strip = (src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Every exported `z.object(...)` declaration, with the text that closes it.
 *
 * Brace-matched from the `z.object({` rather than regex-to-the-next-`})`, because these schemas nest objects
 * and arrays several deep — `UpdateSpaceBody` is fifty lines with `dupeRules` inside it — and a lazy match
 * would report the INNER close and read its modifiers instead of the outer one's.
 */
function exportedObjects(src) {
  const out = [];
  const decl = /export const (\w+)\s*=\s*z\.object\(\{/g;
  for (const m of src.matchAll(decl)) {
    let i = src.indexOf('{', m.index + m[0].length - 1);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      const ch = src[j];
      if (ch === '{') depth++;
      else if (ch === '}') {
        if (--depth === 0) {
          // Everything up to the statement's semicolon: `.strict()` may sit before a `.refine(...)`.
          const tail = src.slice(j, src.indexOf(';', j) + 1);
          out.push({ name: m[1], tail });
          break;
        }
      }
    }
  }
  return out;
}

let bodies;
before(() => { bodies = exportedObjects(strip(readFileSync(SRC, 'utf8'))); });

describe('space request bodies refuse unknown keys', () => {
  it('finds every exported body — the parser is checked before the property is', () => {
    // set-claim: parser ANCHORS, not the subject. The strictness rule below iterates every body the
    // scanner found; these four are named to prove the scanner survives the four shapes it must parse.
    // A gate that parses nothing passes everything. These four names are stable and span the shapes the
    // scanner has to survive: a flat body, one with a nested object, one ending in `.refine`, one with a
    // union field.
    const names = bodies.map((b) => b.name);
    assert.ok(names.length >= 8, `parsed only ${names.length} bodies from ${SRC}`);
    for (const n of ['CreateSpaceBody', 'UpdateSpaceBody', 'SpaceMetaBody', 'PutSchemaBody']) {
      assert.ok(names.includes(n), `${n} was not found — the scanner is wrong, not the code`);
    }
  });

  it('every one of them is .strict()', () => {
    // 10 of 10. It was 4 of 10, and the six that were not are the ones an integrator posts DIRECTLY.
    const lenient = bodies.filter((b) => !b.tail.includes('.strict()')).map((b) => b.name);
    assert.deepEqual(lenient, [], `these accept and silently drop unknown keys: ${lenient.join(', ')}`);
  });

  it('.strict() comes before .refine(), where it still applies', () => {
    // `UpdateSpaceBody` ends `.strict().refine(...)`. Written the other way round the refinement returns a
    // ZodEffects and `.strict()` is not a method on it — that is a compile error rather than a silent hole,
    // but pinning the ORDER keeps the fix from being "corrected" into a build failure by someone tidying.
    const upd = bodies.find((b) => b.name === 'UpdateSpaceBody');
    assert.ok(upd, 'UpdateSpaceBody not found');
    const s = upd.tail.indexOf('.strict()');
    const r = upd.tail.indexOf('.refine(');
    assert.ok(s !== -1 && r !== -1 && s < r, 'UpdateSpaceBody must read .strict().refine(...)');
  });
});

describe('the schemas actually refuse at runtime', () => {
  // Source-reading proves the modifier is present; this proves it does what it is there for. The two are
  // different claims and a gate that only reads text cannot make the second one.
  let CreateSpaceBody, UpdateSpaceBody, DeleteSpaceBody;
  before(async () => {
    ({ CreateSpaceBody, UpdateSpaceBody, DeleteSpaceBody } =
      await import('../../server/dist/spaces/body-schemas.js'));
  });

  it('refuses the reported typo instead of applying the rest', () => {
    const r = UpdateSpaceBody.safeParse({ label: 'x', validaitonMode: 'strict' });
    assert.equal(r.success, false);
    assert.match(JSON.stringify(r.error.issues), /unrecognized_keys/);
  });

  it('refuses a misspelt faceDescriptorDims rather than creating a default-width gallery', () => {
    const r = CreateSpaceBody.safeParse({ label: 'x', faceDescriptorDim: 512 });
    assert.equal(r.success, false);
  });

  it('still accepts a well-formed body', () => {
    // The half a strictness change breaks if it is wrong, and the reason `.strict()` alone was not enough on
    // the token routes: a body that round-trips must keep working.
    assert.equal(CreateSpaceBody.safeParse({ label: 'QA', id: 'qa' }).success, true);
    assert.equal(UpdateSpaceBody.safeParse({ label: 'QA' }).success, true);
    assert.equal(DeleteSpaceBody.safeParse({ confirm: true }).success, true);
  });

  it('still refuses a body with no updatable field at all', () => {
    // The `.refine` has to survive `.strict()` being chained in front of it.
    assert.equal(UpdateSpaceBody.safeParse({}).success, false);
  });
});

describe('a GET body PATCHed back still works — strip, THEN be strict', () => {
  // The half that would have made this a regression dressed as a fix. `.strict()` alone turned a
  // round-tripped body into a 400 on the token mint route once already; the fix there was a strip PLUS
  // strictness, and neither alone was sufficient. The `meta` strip here exists for the same report.
  let stripServerOwnedSpace, UpdateSpaceBody, CreateSpaceBody;
  before(async () => {
    ({ stripServerOwnedSpace, UpdateSpaceBody, CreateSpaceBody } =
      await import('../../server/dist/spaces/body-schemas.js'));
  });

  /** What `GET /api/spaces/:id` actually emits, taken from a live scratch instance on 2026-08-15. */
  const AS_RETURNED = {
    id: 'general', label: 'General', builtIn: true, folders: [], usageGiB: 0,
    indexStatus: 'building', meta: { purpose: 'x' },
  };

  it('drops every field a listing emits that a PATCH does not accept', () => {
    assert.deepEqual(stripServerOwnedSpace(AS_RETURNED, { forUpdate: true }),
      { label: 'General', meta: { purpose: 'x' } });
  });

  it('so the round-trip parses instead of 400ing', () => {
    assert.equal(UpdateSpaceBody.safeParse(stripServerOwnedSpace(AS_RETURNED, { forUpdate: true })).success, true);
  });

  it('the CREATE strip keeps `id` and `folders` — they are real inputs there', () => {
    // The gap CI caught. `mass-assignment.test.js` posts `{id, label, builtIn: true}` and requires a 201
    // with `builtIn` not injectable — so create must strip `builtIn` and must NOT strip `id`, or a caller's
    // chosen space id is silently replaced by a generated slug.
    const out = stripServerOwnedSpace({ id: 'qa', label: 'QA', folders: ['a'], builtIn: true, usageGiB: 3 });
    assert.deepEqual(out, { id: 'qa', label: 'QA', folders: ['a'] });
    assert.equal(CreateSpaceBody.safeParse(out).success, true);
  });

  it('`proxyFor` is a retired field: the CREATE strip leaves it in place and the create door refuses it by name, never as a strict-body typo', async () => {
    // Stripped, it would vanish and the space would be created without a word; left in, the strict parse alone would say only
    // "unrecognised key". The refusal names the field and what replaced it, and runs before the parse.
    const { retiredSpaceFieldError } = await import('../../server/dist/brain/retired-write-fields.js');
    const body = { label: 'QA', proxyFor: ['a'] };
    assert.deepEqual(stripServerOwnedSpace(body), body);
    assert.equal(CreateSpaceBody.safeParse(body).success, false, 'proxyFor is a declared create field again');
    const said = retiredSpaceFieldError(body);
    assert.match(said ?? '', /`proxyFor` was removed/);
    assert.match(said ?? '', /view_create/);
  });

  it('and a real typo is STILL refused after either strip', () => {
    // The failure mode of a too-generous strip: it would swallow exactly what strictness was added to catch.
    // `faceDescriptorDim` is in NEITHER list, because no response emits it.
    assert.equal(UpdateSpaceBody.safeParse(
      stripServerOwnedSpace({ ...AS_RETURNED, faceDescriptorDim: 512 }, { forUpdate: true })).success, false);
    assert.equal(CreateSpaceBody.safeParse(
      stripServerOwnedSpace({ label: 'QA', faceDescriptorDim: 512 })).success, false);
  });

  it('leaves a non-object alone rather than throwing', () => {
    assert.equal(stripServerOwnedSpace(null, { forUpdate: true }), null);
    assert.equal(stripServerOwnedSpace('nope'), 'nope');
    assert.deepEqual(stripServerOwnedSpace([1, 2]), [1, 2]);
  });
});
