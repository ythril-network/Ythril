/**
 * The face-descriptor width is refused by the space's STATE, not by which surface asked.
 *
 * ## The question that produced this, and why it was a good question
 *
 * `faceDescriptorDims` was create-only. The reason given everywhere — schema, guide, code comment — is about
 * stored vectors: *"a populated gallery cannot be re-dimensioned: its stored vectors have not moved, so
 * re-declaring the width would leave every existing descriptor unmatchable."*
 *
 * The canary operator, 2026-08-20T1012Z, asked whether that binds when there is nothing stored to strand. They
 * had fourteen spaces, three images between them — two of which are page renders our own conversion pipeline
 * extracted from a scanned invoice — and not one face descriptor at any width. Their framing was the useful
 * part: *"we are asking whether the guard is 'no stored faces may be invalidated' or 'no, categorically'."*
 *
 * **It was the first, and the API was enforcing the second.** `ensureVectorSearchIndex` refuses on
 * `existing && !dimsMatch && refuseWidthChange` — index-existence based. With no index and no descriptor there
 * is nothing to refuse. The restriction lived in the API surface, which was broader than the mechanism needed.
 *
 * ## What this file pins, and what it deliberately does not
 *
 * The refusal is pure enough to test without a database only in its no-op arm, so most of this reads the two
 * doors and asserts they call ONE implementation of the rule. That is the specific defect this repo produces
 * most: one rule, two implementations, the weaker one winning. A DB-backed test lives in the Docker suite and
 * proves an empty space's width actually moves.
 *
 * Run: node --test testing/standalone/face-width-refused-by-state-not-surface.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { statementFrom, blockAfter } from './_structural-window.mjs';

const strip = (t) => t.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const GUARD = readFileSync('server/src/spaces/face-width-change.ts', 'utf8');
const GUARD_CODE = strip(GUARD);
const REST = strip(readFileSync('server/src/api/spaces.ts', 'utf8'));
const MCP = strip(readFileSync('server/src/mcp/tools/spaces.ts', 'utf8'));
const SCHEMAS = strip(readFileSync('server/src/spaces/body-schemas.ts', 'utf8'));
const VECTOR = strip(readFileSync('server/src/spaces/vector-index.ts', 'utf8'));

describe('the guard checks BOTH facts, and neither alone', () => {
  it('counts stored descriptors', () => {
    // Not inferred from the image count: a face chunk outlives its parent image being deleted long enough to
    // matter, so "no images" is not "no descriptors".
    assert.match(GUARD_CODE, /faceEmbedding: \{ \$exists: true \}/,
      'the populated check must count face chunks directly');
    assert.match(GUARD_CODE, /countDocuments/, 'and count them, not sample them');
  });

  it('and asks what width the index is actually built at', () => {
    assert.match(GUARD_CODE, /faceIndexWidth\(/,
      'an empty index at another width is still an index; rebuilding one is not creating one');
  });

  it('both checks are reachable — neither short-circuits the other away', () => {
    // The failure this would be: returning after the descriptor count, so a space with no descriptors and an
    // index at 128 is told it may move to 512, and the index build then refuses it after a 200.
    const fn = GUARD_CODE.indexOf('export async function refuseFaceWidthChange');
    assert.ok(fn > -1, 'the guard is gone — re-anchor this gate');
    const body = blockAfter(GUARD_CODE, GUARD_CODE.indexOf(')', fn), 'refuseFaceWidthChange');
    const stored = body.indexOf('storedFaceDescriptorCount');
    const built = body.indexOf('faceIndexWidth');
    assert.ok(stored > -1 && built > stored,
      'both facts must be consulted, descriptors first — the index check must not be unreachable');
  });

  it('a no-op width is allowed, whatever the gallery holds', () => {
    // Refusing a no-op would make a client that re-sends its whole config unable to save an unrelated edit —
    // the round-trip failure the server-owned-field strip exists to prevent one level up.
    const fn = GUARD_CODE.indexOf('const effective = currentConfigured');
    assert.ok(fn > -1, 'the effective-width resolution is gone — re-anchor this gate');
    assert.match(statementFrom(GUARD_CODE, GUARD_CODE.indexOf('if (requested === effective)', fn),
      'the no-op arm'), /return null/, 'an unchanged width must return before either query runs');
  });

  it('and the no-op comparison uses the SAME default the index build uses', () => {
    // If the guard treated "unset" as anything other than FACE_DESCRIPTOR_DIMS, a caller sending 128 to an
    // unset space would be told it is a change, and one sending 512 might be told it is not.
    assert.match(GUARD_CODE, /currentConfigured \?\? FACE_DESCRIPTOR_DIMS/,
      'unset must resolve to the same constant `initSpace` builds at');
  });
});

describe('both doors call the SAME guard', () => {
  it('REST calls it, and before the planner', () => {
    const at = REST.indexOf('refuseFaceWidthChange(');
    assert.ok(at > -1, 'the REST door does not check the state — the field would apply unconditionally');
    const planner = REST.indexOf('planSpaceMetaUpdate({');
    assert.ok(planner > at,
      'the check must precede the planner, or a refused change is planned and audited before being declined');
  });

  it('MCP calls it too, and no second copy of the queries exists', () => {
    assert.match(MCP, /refuseFaceWidthChange\(/,
      'the MCP door must call the shared guard, not re-derive the rule');
    // The specific way this defect returns: one door counting descriptors itself.
    assert.doesNotMatch(MCP, /faceEmbedding: \{ \$exists: true \}/,
      'a second copy of the populated check on the MCP door is the two-implementations defect');
    assert.doesNotMatch(REST, /faceEmbedding: \{ \$exists: true \}/,
      'and the same on the REST door');
  });

  it('the field is on BOTH bodies with the same bounds', () => {
    // Parity of the parameter, which CLAUDE.md names as the half that hides. Bounds counted rather than
    // eyeballed: a wider bound on one door is a narrowing on the other, dressed as an omission.
    const bounded = [...SCHEMAS.matchAll(/faceDescriptorDims: z\.number\(\)\.int\(\)\.min\(64\)\.max\(4096\)\.optional\(\)/g)];
    assert.equal(bounded.length, 2,
      `create and update must both carry the field with identical bounds; found ${bounded.length}`);
    // COUNTED, not matched. The first draft used `assert.match` and SURVIVED narrowing update_space's bound to
    // 128-512: the pattern found `save_space`'s field, which still said 64-4096, and reported success. Two
    // tools declare this parameter, so a sample proves nothing about which one it found.
    const mcpBounds = [...MCP.matchAll(/faceDescriptorDims: \{\s*type: 'integer', minimum: (\d+), maximum: (\d+)/g)];
    assert.equal(mcpBounds.length, 2,
      `create_space and update_space must both declare the parameter; found ${mcpBounds.length}`);
    for (const m of mcpBounds) {
      assert.deepEqual([m[1], m[2]], ['64', '4096'],
        'both MCP tools must declare the REST range, or the dispatcher refuses what REST accepts');
    }
  });

  it('it is on NEITHER strip list, which is what makes the refusal reachable', () => {
    // A field on the strip list is deleted before any handler sees it, so the caller gets a 200 for a change
    // that did not happen. That is worse than a refusal and it is silent.
    const create = SCHEMAS.indexOf('CREATE_ONLY_SPACE_FIELDS');
    const owned = SCHEMAS.indexOf('SERVER_OWNED_SPACE_FIELDS');
    assert.ok(create > -1 && owned > -1, 're-anchor this gate: a strip list was renamed');
    for (const [label, at] of [['CREATE_ONLY_SPACE_FIELDS', create], ['SERVER_OWNED_SPACE_FIELDS', owned]]) {
      assert.doesNotMatch(statementFrom(SCHEMAS, at, label), /faceDescriptorDims/,
        `${label} must not carry faceDescriptorDims — a stripped field is a silent 200`);
    }
  });
});

describe('faceIndexWidth answers a different question from faceDescriptorDimsFor', () => {
  it('it returns null for an absent index instead of falling back', () => {
    /*
     * The two read the same index and must NOT share an implementation.
     * `faceDescriptorDimsFor` answers "what width should I validate against", so a miss has to yield a usable
     * number and it falls back to FACE_DESCRIPTOR_DIMS. That is fatal here: the guard needs to tell "no index"
     * from "an index that happens to be 128", and a fallback makes those the same answer — which would report
     * a rebuild as a free create.
     */
    const at = VECTOR.indexOf('export async function faceIndexWidth');
    assert.ok(at > -1, 'faceIndexWidth is gone — the guard cannot distinguish absent from 128');
    const body = blockAfter(VECTOR, VECTOR.indexOf(')', at), 'faceIndexWidth');
    assert.match(body, /if \(!found\) return null;/, 'an absent index must be null, not a default');
    assert.doesNotMatch(body, /FACE_DESCRIPTOR_DIMS/,
      'a fallback here conflates "no index" with "an index at the default width"');
  });

  it('and it is NOT cached, unlike its neighbour', () => {
    // The neighbour caches because it runs per image. This runs per width change, so there is nothing to
    // amortise — and a cached answer is the stalest possible input to "does an index exist".
    const at = VECTOR.indexOf('export async function faceIndexWidth');
    const body = blockAfter(VECTOR, VECTOR.indexOf(')', at), 'faceIndexWidth');
    assert.doesNotMatch(body, /faceDimsBySpace/, 'the width-change guard must not read a cache');
  });
});

describe('the surfaces no longer claim it is create-only', () => {
  it('no MCP description still says CREATE-ONLY', () => {
    // A schema description is the authoritative reference — `help()` says so in as many words — and a stale
    // sentence there is invisible: nobody reports a capability they were told they did not have. That is the
    // documented cost of "filter applied after vector search", which made a whole fleet avoid filtered recall.
    assert.doesNotMatch(MCP, /CREATE-ONLY/,
      'a tool still tells callers the width cannot be changed, which is now false');
  });

  it('and the guide changed its own words with it', () => {
    // Asserted on the PERMISSION, not on a phrase that could survive the opposite claim. The first draft
    // matched /never held a face/ and passed against a paragraph that used those words to say the change was
    // refused anyway — a coverage check dressed as an accuracy check.
    for (const [file, must] of [
      ['docs/integration-guide/05c-face-recognition.md', /can be changed afterwards/i],
      ['docs/integration-guide/06-spaces-api.md', /both \*\*accept\*\* the field/],
      ['docs/userguide/04a-media-and-embedding.md', /can be moved to a new width/],
    ]) {
      const text = readFileSync(file, 'utf8');
      assert.match(text, must, `${file} still describes the width as unchangeable`);
      assert.doesNotMatch(text, /faceDescriptorDims` cannot be changed after creation/,
        `${file} carries the old absolute claim`);
    }
  });
});

/**
 * What survives from `face-width-is-create-only.test.js`, which this file replaces.
 *
 * That file asserted two things, and its own header said which mattered: *"Only the second is a real guard.
 * The first is what stops an operator being told 'yes' and then discovering their gallery is silently
 * unsearchable."* The second — `refuseWidthChange` at the index build — is untouched and is asserted here.
 *
 * The first was `UpdateSpaceBody` must NOT accept the field, and that assertion is now false. Its REASON
 * survives though, and it is the reason this feature answers 409 rather than dropping the field: an operator
 * must never be told yes and given no. A refusal that names the count or the width is a better answer to that
 * requirement than an absent parameter, because an absent parameter cannot explain itself.
 *
 * The two files are merged rather than left side by side. One rule with two homes is how a gate ends up
 * agreeing with a version of the code that no longer exists — and that file would have gone on passing while
 * asserting the opposite of the shipped behaviour, had the ratchet not been the thing that caught it.
 */
describe('what the index build still refuses, whatever the API accepts', () => {
  const IDX = strip(readFileSync('server/src/spaces/vector-index.ts', 'utf8'));
  const LIFE = strip(readFileSync('server/src/spaces/lifecycle.ts', 'utf8'));

  it('the index is sized from the SPACE, not from the built-in constant', () => {
    assert.match(IDX, /faceDescriptorDims/,
      'the index build ignores the space setting, so every space is built at the default and the field is inert');
  });

  it('and it still refuses to re-dimension an EXISTING index', () => {
    // The real guard, and the reason the API layer can afford to be permissive: a width that reached an
    // existing space some other way — a hand-edited config.json, a restore, a future code path — is refused
    // at the build rather than applied. The API check is the courtesy; this is the protection.
    assert.match(IDX, /refuseWidthChange:\s*true/,
      'the face index would be rebuilt at a new width, orphaning every stored vector');
  });

  it('an absent width is omitted from the stored space, not defaulted to a number', () => {
    // A stored `128` reads as a deliberate choice. Absent reads as "nobody chose", which is the truth — and it
    // is what lets the width-change guard treat unset and 128 as the same effective width without guessing.
    assert.match(LIFE, /opts\.faceDescriptorDims\s*\?\s*\{\s*faceDescriptorDims/,
      'createSpace writes a width unconditionally; absent and default become indistinguishable');
  });
});
