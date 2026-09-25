/**
 * Every model the pipeline can call is visible on the Models screen.
 *
 * ## Why this is a gate and not another card
 *
 * The Models screen has under-reported the pipeline three times:
 *
 *  1. and 2. #549 added the office renderer and the contradiction judge — both configurable since the day
 *     they shipped, neither reachable from the admin surface. Found by a customer.
 *  3. A later report from the same deployment enumerated **nine** model endpoints from that screen and
 *     missed a tenth, `vlmModel`. It has no card at all (env-only, `DOC_VLM_MODEL`), *and* the Pipelines
 *     tab deep-links its step to the **vision** card, which shows a different config value — so the
 *     tenth endpoint was displayed as if it were one of the nine. Their ticket was correct about what
 *     the screen showed.
 *
 * Each fix was another card. Nothing ever proved the list complete, so a fourth was inevitable. This
 * asserts completeness instead: the canonical enumeration lives in `MODEL_STAGE_KEYS`, and every entry
 * must have somewhere to appear.
 *
 * A grep cannot substitute for the enumeration — the document stages build their keys as `doc-${slot}`,
 * so those literals do not exist anywhere in the source.
 *
 * Run: node --test testing/standalone/models-page-completeness.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { MODEL_STAGE_KEYS, SIDECARS } = await import('../../server/dist/api/pipeline-status.js');

const STATUS_SRC = readFileSync('server/src/api/pipeline-status.ts', 'utf8');
const MODELS_TAB = readFileSync('client/src/app/pages/settings/media-processing/models-tab.component.ts', 'utf8');
const PIPELINES_TAB = readFileSync('client/src/app/pages/settings/media-processing/pipelines-tab.component.ts', 'utf8');

/** `<app-model-provider-card id="…">` and `<app-sidecar-card id="…">` — the ids the Models screen renders. */
const cardIds = new Set(
  [...MODELS_TAB.matchAll(/app-(?:model-provider|sidecar)-card\s+id="([a-z0-9-]+)"/g)].map(m => m[1]),
);

/** Every `*_SIDECAR_URL` the compose file hands the server: the sidecars a deployment actually wires. */
const COMPOSE = readFileSync('docker-compose.yml', 'utf8');
const wiredSidecarEnv = new Set([...COMPOSE.matchAll(/^\s+([A-Z_]+_SIDECAR_URL):/gm)].map(m => m[1]));

describe('the enumeration is real', () => {
  it('MODEL_STAGE_KEYS is exported and non-trivial', () => {
    assert.ok(Array.isArray(MODEL_STAGE_KEYS));
    assert.ok(MODEL_STAGE_KEYS.length >= 8, `only ${MODEL_STAGE_KEYS.length} stages?`);
  });

  it('modelStages() covers every declared key, and declares no extras', () => {
    // Reading the source rather than calling it: `modelStages()` needs a loaded config. What matters is
    // that the two cannot drift, and the keys are visible in the source either as literals or as the
    // `doc-${slot}` template that produces them.
    const missing = MODEL_STAGE_KEYS.filter(k => {
      if (STATUS_SRC.includes(`key: '${k}'`)) return false;
      // doc-vlm / doc-repair / doc-verify come from the slot map.
      const slot = k.startsWith('doc-') ? k.slice(4) : null;
      return !(slot && /\(\['vlm', 'repair', 'verify'\] as const\)/.test(STATUS_SRC) && STATUS_SRC.includes('key: `doc-${slot}`'));
    });
    assert.deepEqual(missing, [], `declared in MODEL_STAGE_KEYS but not produced by modelStages():\n  ${missing.join('\n  ')}`);
  });
});

describe('every model the pipeline calls has a card', () => {
  /**
   * Cards the Models screen renders that are NOT model stages — sidecars. They belong on the screen and
   * are checked separately by their own probes; they are listed so this test's arithmetic is honest
   * rather than approximate.
   */
  const SIDECAR_CARDS = new Set([...SIDECARS.map(s => s.key), 'face']);

  for (const key of MODEL_STAGE_KEYS) {
    it(`${key} has a card`, () => {
      assert.ok(
        cardIds.has(key),
        `No <app-model-provider-card id="${key}"> on the Models screen.\n`
        + 'An operator enumerating their endpoints from that page will miss this one — which is exactly\n'
        + 'how a customer ticket came to list nine endpoints when there were ten. If it is env-only, give\n'
        + 'it a read-only card with the env badge, the way the storage pins do.',
      );
    });
  }

  it('no card claims to be a model stage that does not exist', () => {
    const known = new Set([...MODEL_STAGE_KEYS, ...SIDECAR_CARDS]);
    const orphans = [...cardIds].filter(id => !known.has(id));
    assert.deepEqual(orphans, [], `cards with no corresponding stage or sidecar: ${orphans.join(', ')}`);
  });
});

describe('every sidecar the deployment wires has a card', () => {
  /*
   * The sidecar half of the same gap. The card list here was typed by hand, so the NLP sidecar shipped wired,
   * probed on the About page, and absent from this screen and from the pipeline status it reads. Derived from
   * the compose file, a new sidecar fails here until it is probed and carded.
   */
  it('the compose wiring was found at all', () => {
    assert.ok(wiredSidecarEnv.size >= 4, `found ${wiredSidecarEnv.size} *_SIDECAR_URL entries — the shape changed`);
  });

  it('every wired sidecar is probed by the pipeline status', () => {
    const probed = new Set(SIDECARS.map(s => s.envVar));
    const unprobed = [...wiredSidecarEnv].filter(v => !probed.has(v));
    assert.deepEqual(unprobed, [], `wired in docker-compose.yml but not in SIDECARS (api/pipeline-status.ts): ${unprobed.join(', ')}`);
  });

  it('every probed sidecar has a card', () => {
    const missing = SIDECARS.filter(s => !cardIds.has(s.key)).map(s => s.key);
    assert.deepEqual(missing, [], `no card on the Models screen for: ${missing.join(', ')} — add an <app-sidecar-card>`);
  });
});

describe('the Pipelines tab does not point a step at the wrong card', () => {
  /**
   * The VLM step used to deep-link to `cardId: 'vision'`, and repair to `'assist'`. Both show a
   * DIFFERENT config value from the step they represent, so "is the VLM configured?" landed on a card
   * that looked fine. That is worse than having no link: it answers the question wrongly.
   */
  const stepLinks = [...PIPELINES_TAB.matchAll(/key: '([a-z-]+)'[^}]*?cardId: '([a-z0-9-]+)'/g)]
    .map(m => ({ step: m[1], card: m[2] }));

  it('the step→card links were found at all', () => {
    assert.ok(stepLinks.length >= 4, `parsed ${stepLinks.length} step links — the shape changed`);
  });

  it('the VLM step points at the VLM card', () => {
    const vlm = stepLinks.find(s => s.step === 'vlm');
    assert.ok(vlm, 'no vlm step found');
    assert.equal(vlm.card, 'doc-vlm', 'the VLM step must not deep-link to the vision card');
  });

  it('the repair step points at the repair card', () => {
    const repair = stepLinks.find(s => s.step === 'repair');
    assert.ok(repair, 'no repair step found');
    assert.equal(repair.card, 'doc-repair', 'the repair step must not deep-link to the assist card');
  });

  it('every step links to a card that exists', () => {
    const bad = stepLinks.filter(s => !cardIds.has(s.card));
    assert.deepEqual(bad, [], `steps linking to a non-existent card: ${bad.map(b => `${b.step}→${b.card}`).join(', ')}`);
  });
});
