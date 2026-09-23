/**
 * External face model — consent gate and response hardening.
 *
 * This endpoint receives face crops, which are biometric data. Two properties carry that weight:
 *
 *  1. **It cannot be reached without consent.** `egressConsented()` requires `acknowledgedHost` to
 *     match the host of `baseUrl`. The API enforces the same rule on write, but this is the check that
 *     survives a config edited on disk — the write path is not the only way a value gets into config.
 *  2. **A provider's answer is not trusted.** A descriptor of the wrong width would not fail loudly; it
 *     would corrupt every similarity score in the gallery, so the wrong shape is dropped here.
 *
 * Run: node --test testing/standalone/face-external.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let faceEndpointConsented;

before(async () => {
  // The rule is shared by every egressing slot since F-31 (`config/egress-consent.ts`); the face model is one.
  ({ egressConsented: faceEndpointConsented } = await import('../../server/dist/config/egress-consent.js'));
});

/** The rule is a pure function of the endpoint block, so it needs no config plumbing to test. */
const withFaceCfg = (externalModel, fn) => fn(externalModel);

describe('faceEndpointConsented — the consent gate', () => {
  it('is false when no endpoint is configured', () => {
    assert.equal(withFaceCfg(undefined, (c) => faceEndpointConsented(c)), false);
    assert.equal(withFaceCfg({}, (c) => faceEndpointConsented(c)), false);
  });

  it('is FALSE when an endpoint is set but no host was acknowledged', () => {
    // The whole point: configuring an endpoint must not by itself start sending faces anywhere.
    const ready = withFaceCfg({ baseUrl: 'https://faces.example.com/embed' }, (c) => faceEndpointConsented(c));
    assert.equal(ready, false);
  });

  it('is FALSE when the acknowledgment names a DIFFERENT host', () => {
    // Consent is per-host. Re-pointing the URL after acknowledging must revoke it, or the acknowledgment
    // becomes a one-time click that authorises every future destination.
    const ready = withFaceCfg(
      { baseUrl: 'https://elsewhere.example.net/embed', acknowledgedHost: 'faces.example.com' },
      (c) => faceEndpointConsented(c),
    );
    assert.equal(ready, false);
  });

  it('is true only when the acknowledged host matches', () => {
    const ready = withFaceCfg(
      { baseUrl: 'https://faces.example.com/embed', acknowledgedHost: 'faces.example.com' },
      (c) => faceEndpointConsented(c),
    );
    assert.equal(ready, true);
  });

  it('is false for a malformed URL rather than throwing', () => {
    const ready = withFaceCfg({ baseUrl: 'not a url', acknowledgedHost: 'x' }, (c) => faceEndpointConsented(c));
    assert.equal(ready, false);
  });
});

describe('the source enforces its own guarantees', () => {
  const src = readFileSync(new URL('../../server/src/files/media/face-external.ts', import.meta.url), 'utf8');

  it('uses ssrfSafeFetch, never a bare fetch', () => {
    // The URL is admin-settable through the API; a plain fetch would follow a redirect into link-local
    // metadata, and validating at write time cannot cover DNS changing before the call.
    assert.ok(src.includes('ssrfSafeFetch('), 'must call ssrfSafeFetch');
    assert.ok(!/[^f]\bfetch\(/.test(src.replace(/ssrfSafeFetch\(/g, '')), 'no bare fetch(');
  });

  it('rejects any descriptor that is not the width THIS SPACE was built at', () => {
    // The width check moved into `face-descriptor.ts` so the first unexpected width is REPORTED rather than
    // skipped in silence. This asserts both halves for THIS path: that the file still defers to the helper,
    // and that the helper still enforces the width — checking only the call would pass against a helper that
    // had stopped checking anything.
    //
    // Scope, because this comment used to overstate it: these assertions cover the EXTERNAL path only. They
    // once claimed "both embedding paths share one rule" while reading a single file, and the in-process path
    // kept its own `!== 128` literal underneath that claim for a full release. The cross-path property lives
    // in `face-width-is-never-a-literal.test.js`, which discovers the paths instead of naming them.
    assert.ok(src.includes('isUsableDescriptor('), 'the width check must still happen');
    const guard = readFileSync(new URL('../../server/src/files/media/face-descriptor.ts', import.meta.url), 'utf8');
    assert.match(guard, /embedding\.length === expectedDims/,
      'face-descriptor.ts no longer compares the width, so nothing does');
    // The width is per SPACE now, resolved from that space's own index, so the guard must take it as an
    // argument rather than reading a module constant. `FACE_DESCRIPTOR_DIMS` survives only as the default
    // for a caller with no space in hand — asserting on it here would pin the old fixed-width rule.
    assert.match(guard, /expectedDims: number = FACE_DESCRIPTOR_DIMS/,
      'the guard no longer accepts a per-space width; a space built at 512 would be judged against 128');
    assert.match(src, /isUsableDescriptor\([^)]*expectedDims/,
      'face-external.ts calls the guard without the resolved width');
    assert.ok(src.includes('Number.isFinite'), 'NaN/Infinity must be rejected');
  });

  it('the vector index is built at the width the embedders check against', () => {
    // Three copies of this number used to exist: the index, and each embedding path. They MUST agree — an
    // index built at one width with vectors written at another gives a cosine search that ranks nothing
    // correctly and reports no error at all. This keeps the INDEX copy honest; the two embedding copies are
    // kept honest by `face-width-is-never-a-literal.test.js`. Splitting that out is deliberate — asserting
    // the three-way property here, where only the index is read, is how the third copy survived unnoticed.
    const idx = readFileSync(new URL('../../server/src/spaces/vector-index.ts', import.meta.url), 'utf8');
    assert.match(idx, /'faceEmbedding'/, 'the face index is gone from vector-index.ts — re-point this');
    assert.ok(idx.includes('FACE_DESCRIPTOR_DIMS'),
      'the face index writes its own width instead of reading the constant the embedders enforce');
    assert.ok(!idx.includes("'files', 128,"), 'the face index width is a literal again');
  });

  it('caps how many faces a provider can return', () => {
    assert.ok(src.includes('MAX_FACES'), 'an unbounded provider response must be capped');
  });

  it('returns null rather than throwing, so the caller can fall back', () => {
    assert.ok(src.includes('return null'), 'failure must degrade to in-process recognition');
  });
});

describe('the embedder falls back instead of dropping faces', () => {
  const src = readFileSync(new URL('../../server/src/files/media/face-embedder.ts', import.meta.url), 'utf8');

  it('only loads the local model when the external provider did not answer', () => {
    // Initialising `human` regardless would pay the model-load cost on every image for nothing.
    const idx = src.indexOf('detectFacesExternal(');
    assert.ok(idx > 0, 'the external provider must be consulted');
    assert.ok(src.indexOf('await getHuman()') > idx, 'the local model must load AFTER, inside the fallback');
  });

  it('feeds both paths into the same per-face loop', () => {
    // Two copies of the gallery/threshold logic is how the paths would drift apart.
    assert.equal((src.match(/Process each detected face/g) ?? []).length, 1);
  });
});

describe('the external face endpoint honours the egress policy', () => {
  const src = readFileSync(new URL('../../server/src/files/media/face-external.ts', import.meta.url), 'utf8');

  it('passes the private-endpoint policy for its own slot to the guard', () => {
    // Without it the guard rejects a self-hosted recogniser on a cluster address at RUNTIME, even though
    // the write path accepted it — a configurable feature that silently does not work. That was the one
    // real finding of the 2026-07-29 audit, and it was in this file.
    //
    // Slot-scoped since the per-endpoint permission landed, and this is the slot where that matters most:
    // the payload is face crops, i.e. biometric data. An operator widening egress for their embedding
    // server has said nothing about where biometrics may go.
    assert.ok(src.includes("allowPrivate: allowPrivateForSlot('faceExternal')"),
      'the operator private-endpoint policy for the faceExternal slot must reach the fetch');
  });

  it('is an EXTERNAL provider, so it is guarded rather than plain-fetched', () => {
    // Unlike the bundled Ollama/Whisper (local, private addresses, deliberately plain `fetch`), there is
    // no bundled face sidecar — this endpoint is operator-supplied by definition.
    assert.ok(src.includes('ssrfSafeFetch('));
    assert.ok(!/await fetch\(/.test(src));
  });
});
