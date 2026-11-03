/**
 * Each render sidecar's image has ONE tag everywhere it is named, and both compose files pass its caps through (Q-611).
 *
 * ## What happened
 *
 * Q-611 changes the source of `sidecars/doc-render` and `sidecars/doc-office`. Both are `build:` services with a pinned
 * `image:` tag, and `docker compose up` builds a `build:` service only when the tagged image is MISSING: a host that already
 * holds `ythril-doc-render:0.1.0` keeps running the old, unclamped sidecar after the upgrade and nothing says so. The tag
 * therefore has to move with the source, and it is written in three places that have to agree:
 *
 *  - `docker-compose.yml`, where an operator runs it;
 *  - `testing/docker-compose.test.yml`, which the test stack starts;
 *  - `.github/workflows/ci.yml`, whose integration job pre-builds each image with the warm layer cache and then starts the stack
 *    with `--no-build --pull never`, so a tag the workflow did not build is an image the job cannot find.
 *
 * Three spellings of one name: bump two of them and CI fails late and far from the cause (a container that does not exist), or,
 * worse, passes against an image built from a stale tag. The caps (`RENDER_MAX_PIXELS`, `RENDER_MAX_RESPONSE_BYTES`) are
 * likewise only operator-settable if the compose service passes them into the container.
 *
 * ## The rule
 *
 * - For `doc-render` and `doc-office`: the `image:` of both compose files and the `tags:` of the workflow step that builds
 *   `sidecars/<name>` are the same string, and it carries a version.
 * - Both compose files declare, for both services, an `environment` entry for each cap, taking its value from a variable of the
 *   cap's own name (`RENDER_MAX_PIXELS: ${RENDER_MAX_PIXELS:-}`): an unset variable reaches the sidecar as an empty string, which
 *   it reads as "use my default".
 *
 * Run: node --test testing/standalone/the-sidecar-image-tag-is-one-tag-and-the-caps-are-passed-through.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadCompose, environmentOf } from '../_shared/compose-file.mjs';
import { loadCi } from '../_shared/ci-workflow.mjs';

const SIDECARS = ['doc-render', 'doc-office'];
const CAPS = ['RENDER_MAX_PIXELS', 'RENDER_MAX_RESPONSE_BYTES'];

/** The `tags:` of every workflow step that builds `sidecars/<name>`, flattened across jobs. */
export function workflowTags(doc, name) {
  const tags = [];
  for (const job of Object.values(doc?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (step?.with?.context === `sidecars/${name}` && step.with.tags) {
        tags.push(...String(step.with.tags).split(/[\s,]+/).filter(Boolean));
      }
    }
  }
  return tags;
}

/** Everything wrong with how the three places name one sidecar image. */
export function tagViolations(name, prodImage, testImage, ciTags) {
  const v = [];
  const want = `ythril-${name}:`;
  if (!prodImage?.startsWith(want) || prodImage.length === want.length) v.push(`docker-compose.yml: ${name} has no versioned image tag (${prodImage})`);
  if (testImage !== prodImage) v.push(`${name}: the test stack's image is ${testImage} and production's is ${prodImage}`);
  if (ciTags.length === 0) v.push(`${name}: no ci.yml step builds sidecars/${name}, so the integration job's --no-build start has no image`);
  for (const t of ciTags) if (t !== prodImage) v.push(`${name}: ci.yml builds ${t}, but the compose files run ${prodImage}`);
  return v;
}

/** What is wrong with how one compose service passes the caps through. */
export function passthroughViolations(label, service) {
  const v = [];
  const env = environmentOf(service);
  for (const cap of CAPS) {
    const value = String(env[cap] ?? '');
    if (!new RegExp(`^\\$\\{${cap}(:-[^}]*)?\\}$`).test(value)) v.push(`${label}: ${cap} is not passed through from a variable of that name (got ${JSON.stringify(env[cap])})`);
  }
  return v;
}

const prod = loadCompose('docker-compose.yml');
const test = loadCompose('testing/docker-compose.test.yml');
const ci = loadCi();

describe('a render sidecar image has one tag everywhere it is named', () => {
  for (const name of SIDECARS) {
    it(`${name}: both compose files and the workflow that builds it say the same tag`, () => {
      const found = tagViolations(name, prod.services[name]?.image, test.services[name]?.image, workflowTags(ci, name));
      assert.deepEqual(found, [], found.join('\n'));
    });

    it(`${name}: both compose files pass the caps through`, () => {
      const found = [
        ...passthroughViolations(`docker-compose.yml ${name}`, prod.services[name]),
        ...passthroughViolations(`testing/docker-compose.test.yml ${name}`, test.services[name]),
      ];
      assert.deepEqual(found, [], found.join('\n'));
    });
  }
});

describe('the gate itself', () => {
  const ciDoc = (tags) => ({ jobs: { integration: { steps: [{ with: { context: 'sidecars/doc-render', tags } }, { run: 'x' }] } } });

  it('a consistent trio is clean', () => {
    assert.deepEqual(tagViolations('doc-render', 'ythril-doc-render:0.2.0', 'ythril-doc-render:0.2.0', ['ythril-doc-render:0.2.0']), []);
  });

  it('flags a test stack on another tag, a workflow on another tag, no workflow step, and an unversioned image', () => {
    assert.ok(tagViolations('doc-render', 'ythril-doc-render:0.2.0', 'ythril-doc-render:0.1.0', ['ythril-doc-render:0.2.0']).some(m => /test stack/.test(m)));
    assert.ok(tagViolations('doc-render', 'ythril-doc-render:0.2.0', 'ythril-doc-render:0.2.0', ['ythril-doc-render:0.1.0']).some(m => /ci\.yml builds/.test(m)));
    assert.ok(tagViolations('doc-render', 'ythril-doc-render:0.2.0', 'ythril-doc-render:0.2.0', []).some(m => /no ci\.yml step/.test(m)));
    assert.ok(tagViolations('doc-render', 'ythril-doc-render', 'ythril-doc-render', ['ythril-doc-render']).some(m => /no versioned/.test(m)));
  });

  it('reads the tags of the step that builds the sidecar, and only that one', () => {
    assert.deepEqual(workflowTags(ciDoc('ythril-doc-render:0.2.0'), 'doc-render'), ['ythril-doc-render:0.2.0']);
    assert.deepEqual(workflowTags(ciDoc('ythril-doc-render:0.2.0'), 'doc-office'), []);
  });

  it('flags a cap that is not passed through, or passed from another variable', () => {
    const ok = { environment: { RENDER_MAX_PIXELS: '${RENDER_MAX_PIXELS:-}', RENDER_MAX_RESPONSE_BYTES: '${RENDER_MAX_RESPONSE_BYTES:-}' } };
    assert.deepEqual(passthroughViolations('x', ok), []);
    assert.equal(passthroughViolations('x', {}).length, 2);
    assert.equal(passthroughViolations('x', { environment: { ...ok.environment, RENDER_MAX_PIXELS: '${OTHER:-}' } }).length, 1);
  });
});
