/**
 * The licence and the third-party notices must be INSIDE the image.
 *
 * ## The failure this exists for — Legal & Compliance audit lens, finding 5
 *
 * The Dockerfile never copied `NOTICE` or `LICENSE` into the production stage. Confirmed against the published
 * artefact, not inferred:
 *
 *     $ docker run --rm --entrypoint sh ythril/ythril:2.2.5 -c 'ls /app/NOTICE /app/LICENSE /NOTICE /LICENSE'
 *     ls: cannot access '/app/NOTICE': No such file or directory
 *     ls: cannot access '/app/LICENSE': No such file or directory
 *     ls: cannot access '/NOTICE': No such file or directory
 *     ls: cannot access '/LICENSE': No such file or directory
 *
 * **The image is the primary distribution.** Most users never see the git repo, so the one place the notices are
 * legally required was the one place they were missing:
 *
 *   - **Apache-2.0 §4(d)** — a distribution of a work carrying a NOTICE file "must include a readable copy of the
 *     attribution notices contained within such NOTICE file". Ythril redistributes several Apache-2.0 works in
 *     this image: `@huggingface/transformers`, `sharp`, and the embedding model weights.
 *   - **MIT** — "The above copyright notice and this permission notice shall be included in all copies or
 *     substantial portions of the Software." An image is a copy.
 *
 * This one is different from the lens's other findings. Those were records that could not be checked; this was an
 * obligation the shipped artefact did not meet.
 *
 * ## What this checks, and what it cannot
 *
 * The Dockerfile instruction, because that runs everywhere and in milliseconds. Verifying a BUILT image needs a
 * build, which belongs in CI's image job rather than in a unit sweep — so this asserts the cause, and the release
 * verification script asserts the effect.
 *
 * Run: node --test testing/standalone/notice-ships-in-the-image.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** The image's app directory as a COPY destination (`WORKDIR /app`). */
const APP_DIR = /^(?:\.\/?|\/app\/?)$/;

/** Every `COPY` instruction of `dockerfile`: `{ fromStage, sources, dest }`, flags (`--chown`, `--from`) set apart. */
function copyLines(dockerfile) {
  return [...dockerfile.matchAll(/^COPY[ \t]+([^\r\n]+)/gm)].map(m => {
    const words = m[1].trim().split(/\s+/);
    const flags = words.filter(w => w.startsWith('--'));
    const paths = words.filter(w => !w.startsWith('--'));
    return { fromStage: flags.some(f => f.startsWith('--from=')), sources: paths.slice(0, -1), dest: paths[paths.length - 1] };
  });
}

/** The workspaces whose manifest ships its own LICENSE or NOTICE (`files`), from the root's `workspaces`. */
function ownNoticeWorkspaces() {
  const root = JSON.parse(read('package.json'));
  return (root.workspaces ?? []).filter(ws => {
    const files = JSON.parse(read(`${ws}/package.json`)).files ?? [];
    return files.includes('LICENSE') || files.includes('NOTICE');
  });
}

/** The image paths a publish workflow checks: each word of a `for f in …; do` loop whose body runs `test -s /app/$f`, as `/app/<word>`. */
function imageCheckedPaths(workflow) {
  const out = [];
  for (const m of workflow.matchAll(/for f in ([^;\r\n]+);\s*do\b([\s\S]*?)(?:\n\s*done\b|$(?![\s\S]))/g)) {
    if (!/test -s \/app\/\$f\b/.test(m[2])) continue;
    out.push(...m[1].trim().split(/\s+/).map(w => `/app/${w}`));
  }
  return out;
}

/** The production stage: from the last `FROM … AS production` to the end of the file. */
function productionStage(dockerfile) {
  const at = dockerfile.lastIndexOf('AS production');
  assert.ok(at > 0, 'could not find the production stage in the Dockerfile');
  return dockerfile.slice(at);
}

describe('the licence and notices ship inside the image', () => {
  const dockerfile = read('Dockerfile');
  const stage = productionStage(dockerfile);

  it('both files exist in the repo to begin with', () => {
    for (const f of ['NOTICE', 'LICENSE']) {
      assert.ok(existsSync(join(ROOT, f)), `${f} is missing from the repo`);
      assert.ok(read(f).length > 500, `${f} looks empty`);
    }
  });

  it('the production stage copies them in', () => {
    // Matched in the PRODUCTION stage specifically: a COPY in a builder stage would satisfy a whole-file grep and
    // ship nothing, since builder layers are discarded.
    //
    // Matched as a SOURCE of one COPY line, the bare root path, into the app directory (Q-668, B7): `\bNOTICE\b` anywhere on a COPY
    // line was also satisfied by `COPY schema/NOTICE ./schema/`, so the root file could go missing while a workspace's copy held the
    // assertion up.
    for (const f of ['NOTICE', 'LICENSE']) {
      assert.ok(copyLines(stage).some(c => !c.fromStage && c.sources.includes(f) && APP_DIR.test(c.dest)),
        `the production stage does not COPY the root ${f} into the app directory — the image would ship without it, which is what `
        + 'Apache-2.0 §4(d) and the MIT notice clause both require it not to do');
    }
  });

  it('a workspace that ships its own LICENSE and NOTICE has them copied beside it', () => {
    // The schema package is Apache-2.0 with its own LICENSE and NOTICE (owner, 2026-11-01), and the image carries the package
    // (`schema/package.json`, `schema/dist`). Its notices travel with it. Which workspaces: every one whose manifest ships a LICENSE
    // or NOTICE (`files`), read from the repository, so the next package with its own licence is covered on the day it is added.
    const shipping = ownNoticeWorkspaces();
    assert.ok(shipping.includes('schema'), `the workspaces read as shipping their own notices are [${shipping.join(', ')}]: schema is one`);
    const lines = copyLines(stage).filter(c => !c.fromStage);
    for (const ws of shipping) {
      for (const f of ['LICENSE', 'NOTICE']) {
        assert.ok(lines.some(c => c.sources.includes(`${ws}/${f}`) && new RegExp(`^(?:\\./|/app/)${ws}/?$`).test(c.dest)),
          `the production stage does not COPY ${ws}/${f} into ./${ws}/: the image carries ${ws} without its own ${f}`);
      }
    }
  });

  it('they are copied AFTER the dependencies arrive, so a licence edit does not rebuild the world', () => {
    // Ordering is not pedantry here: NOTICE changes on most dependency changes, and putting it above the
    // node_modules layer would invalidate ~890 MB every time somebody corrected a copyright line.
    //
    // Anchored on "whatever brings node_modules in", not on `npm ci`. The production stage no longer runs the
    // install — the toolchain moved to a `prod-deps` stage and the built tree is COPYed in, so this test asserted
    // the presence of a mechanism rather than the guarantee, and reported "could not find the dependency install"
    // for a change that kept the ordering perfectly intact.
    const deps = Math.min(
      ...[/npm ci/, /^COPY --from=prod-deps[^\n]*node_modules/m]
        .map(re => stage.search(re)).filter(i => i >= 0),
    );
    const copyNotice = stage.search(/^COPY[^\n]*\bNOTICE\b/m);
    assert.ok(Number.isFinite(deps) && deps > 0,
      'could not find where node_modules enters the production stage (neither an npm ci nor a COPY --from=prod-deps)');
    assert.ok(copyNotice > deps,
      'NOTICE is copied before the dependencies arrive, so editing it invalidates the node_modules layer');
  });

  it('the publish workflow asserts the EFFECT, not just the instruction', () => {
    // This gate checks the CAUSE, because it must run without Docker. Something has to check the artefact, or a
    // COPY that silently lands in the wrong directory passes every unit test there is.
    //
    // That check lives in the publish workflow, where an image exists to interrogate. Asserted here rather than
    // left as a convention: the two halves are useless apart, and the workflow is not somewhere a reader of this
    // file would think to look.
    const wf = read('.github/workflows/publish.yml');
    assert.match(wf, /test -s \/app\/\$f|test -s \/app\/NOTICE/,
      'the publish workflow must ask the built image whether the notices are actually in it');
    assert.match(wf, /for f in NOTICE LICENSE/,
      'the artefact check must cover both files');
  });

  it('the publish workflow asks the image for each workspace\'s own notices too', () => {
    // The effect half of the workspace COPY above (Q-668, B7): the paths the image is asked about, read from the loop that runs
    // `test -s /app/$f`, include `/app/<workspace>/LICENSE` and `/app/<workspace>/NOTICE` for each workspace shipping its own.
    const checked = imageCheckedPaths(read('.github/workflows/publish.yml'));
    assert.ok(checked.includes('/app/NOTICE') && checked.includes('/app/LICENSE'), `read the checked paths as [${checked.join(', ')}]: the parse is broken`);
    for (const ws of ownNoticeWorkspaces()) {
      for (const f of ['LICENSE', 'NOTICE']) {
        assert.ok(checked.includes(`/app/${ws}/${f}`), `the publish workflow never asks the image for /app/${ws}/${f}; it checks [${checked.join(', ')}]`);
      }
    }
  });
});

describe('the readers this gate stands on (proved on planted copies)', () => {
  it('a workspace copy alone does not stand in for the root copy', () => {
    const planted = 'FROM node AS production\nCOPY schema/NOTICE schema/LICENSE ./schema/\n';
    const lines = copyLines(planted);
    assert.equal(lines.length, 1);
    assert.ok(!lines.some(c => c.sources.includes('NOTICE')), 'schema/NOTICE was read as the root NOTICE');
    assert.deepEqual(copyLines('COPY --from=builder /build/NOTICE ./\n')[0].fromStage, true);
    assert.deepEqual(copyLines('COPY --chown=node NOTICE LICENSE ./\n')[0], { fromStage: false, sources: ['NOTICE', 'LICENSE'], dest: './' });
  });

  it('the publish loop is read as the paths it checks', () => {
    const wf = '        for f in NOTICE LICENSE schema/NOTICE; do\n          if docker run "$IMAGE" -c "test -s /app/$f"; then\n';
    assert.deepEqual(imageCheckedPaths(wf), ['/app/NOTICE', '/app/LICENSE', '/app/schema/NOTICE']);
    assert.deepEqual(imageCheckedPaths('for f in NOTICE LICENSE; do\n echo "$f"\ndone\n'), [], 'a loop that never tests /app/$f checks nothing');
  });
});
