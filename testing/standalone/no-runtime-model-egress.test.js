/**
 * "Works fully offline" must be enforced, not asserted.
 *
 * ## The finding — Privacy audit lens
 *
 * `README.md` says **works fully offline** and `userguide.md` says "it needs no internet connection, which is the
 * point: the installs that most need [it]". The in-process embedding model made that untrue in a way nobody could
 * see.
 *
 * `env.allowRemoteModels` defaults to **`true`** in `@huggingface/transformers` (confirmed in the installed
 * `types/env.d.ts` at 3.8.1). `brain/embedding.ts` set `env.cacheDir` and nothing else, so `pipeline(…)` on a model
 * that was not in that cache **silently downloaded it from `huggingface.co`** — the instance's IP address and the
 * model id it asked for, to a third party, with no configuration and no log line. The image bakes exactly one model,
 * so every other id — and any id at all on a from-source install with an empty cache — was that request.
 *
 * The repo had already found this exact failure once. `docker-compose.yml` sets `HF_HUB_OFFLINE: "1"` on the
 * `unstructured` sidecar with a long comment explaining that `huggingface_hub` calls the hub even for models baked
 * into the image. Nobody connected it to the Node process, which is the one making the offline claim — and
 * transformers.js does not read that variable, so setting it stack-wide did nothing here.
 *
 * ## Why disabling remote loading is safe, and how that was established
 *
 * Not by reading — by loading. `getModelFile` consults its `FileCache` **before** it decides local-versus-remote, so
 * a populated `cacheDir` satisfies a load with remote fetching off. Against a real 523 MB cache:
 *
 *   - the baked model, `env.allowRemoteModels = false`  → **loaded**, no network;
 *   - a different model id, same conditions             → failed, naming a `node_modules/…/models/` path that has
 *                                                         nothing to do with Ythril's cache.
 *
 * The second result is why the loader rewrites that error: an operator would otherwise go looking in the wrong
 * place for a file that was never meant to be there.
 *
 * ## What this gate holds
 *
 * That the three levers stay in place — the flag is honoured, the miss is announced before it happens, and the image
 * sets the flag *after* the build-time warm step that legitimately downloads. It cannot prove no packet leaves the
 * host; it pins the decisions that made one leave.
 *
 * Run: node --test testing/standalone/no-runtime-model-egress.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markdownSectionFrom } from './_structural-window.mjs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/*
 * WHERE THE LOADER LIVES, since Q-99 part 1.
 *
 * The model is loaded by the inference CHILD, through `brain/local-pipeline.ts` — the one module that imports the
 * model library (`local-inference-structure.test.js` holds that, derived). This gate used to read `embedding.ts`;
 * it is re-pointed rather than re-run, because the old anchor (`function getLocalPipeline(`) is gone and a gate
 * whose slice is empty passes every assertion over it. Every case below is the SAME rule as before, against the
 * new home: the offline flag is honoured, the miss is announced first, a blocked miss explains itself. What changed
 * is that the loader is handed `offline` as an argument by the process that read the flags, because the child has
 * no config and must not guess; so "the variables are read" is asked of the brain sources, not of the loader.
 */
const LOADER = read('server/src/brain/local-pipeline.ts');
const DOCKERFILE = read('Dockerfile');

/** Every brain source, comments stripped: where the offline flags are READ, which is no longer the loader. */
const BRAIN = trackedSources('server/src/brain', { floor: 20, untracked: true })
  .map(f => stripComments(read(f))).join('\n');

/** The body of `loadLocalPipeline`, from its signature to the closing brace of the function. */
function loaderBody() {
  const at = LOADER.indexOf('function loadLocalPipeline(');
  assert.ok(at > 0, 'loadLocalPipeline is gone — this gate is pinned to it');
  const end = LOADER.indexOf('\n}', at);
  assert.ok(end > at, 'could not find the end of loadLocalPipeline');
  return LOADER.slice(at, end);
}

describe('the offline flag is honoured by the process that claims to be offline', () => {
  it('found the loader (the parse still works)', () => {
    // Without this the slices below could silently be empty and every assertion would pass by examining nothing.
    const body = loaderBody();
    assert.ok(body.includes('pipeline('), 'the loader no longer calls pipeline() — re-anchor this gate');
    assert.ok(body.length > 200, `the loader body sliced to ${body.length} chars, which cannot be right`);
  });

  it('maps the ecosystem offline variables onto allowRemoteModels', () => {
    // transformers.js reads NONE of these — they are Python's. That is exactly why the mapping has to exist here:
    // an operator air-gapping a stack sets HF_HUB_OFFLINE and reasonably expects the whole stack to obey.
    for (const v of ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'YTHRIL_MODELS_OFFLINE']) {
      assert.match(BRAIN, new RegExp(`['"\`]${v}['"\`]`),
        `${v} is not read — a stack-wide offline flag would silently not apply to the embedding model`);
    }
    assert.match(LOADER, /env\.allowRemoteModels\s*=\s*false/,
      'nothing sets env.allowRemoteModels = false, so the library default (true) still allows a runtime download');
    assert.match(loaderBody(), /if\s*\(\s*offline\s*\)/,
      'the switch is not conditional on the `offline` argument the caller resolved from those variables');
  });

  it('lets the child INHERIT those variables, or none of the above reaches the process that loads the model', () => {
    // The loader no longer reads the environment; the child does, at its entry, and passes `offline` in. The
    // child's environment is an allowlist, so a variable that is not on it is one the flag silently stops working
    // for — the operator sets HF_HUB_OFFLINE on the server and the child, which never sees it, downloads.
    const host = stripComments(read('server/src/brain/local-inference.ts'));
    for (const v of ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'YTHRIL_MODELS_OFFLINE', 'MODEL_CACHE_DIR']) {
      assert.match(host, new RegExp(`['"\`]${v}['"\`]`), `${v} is not on the child's environment allowlist`);
    }
  });

  it('announces the egress BEFORE it happens, naming the host', () => {
    // The order is the whole point. A warning after the fact is a log line about 274 MB that already left.
    const body = loaderBody();
    const warnAt = body.search(/\blog\??\.?\(\s*['"]warn['"]/);
    const loadAt = body.search(/await pipeline\(/);
    assert.ok(warnAt > 0, 'a cache miss with remote loading allowed must warn — otherwise the egress is silent');
    assert.ok(loadAt > 0, 'could not find the pipeline() load');
    assert.ok(warnAt < loadAt,
      'the warning must come BEFORE the load, or it reports a download that has already happened');
    assert.match(body.slice(warnAt, loadAt), /huggingface\.co/,
      'the warning must name the host the data goes to — "downloading the model" does not tell an operator '
      + 'that their IP reaches a third party');
  });

  it('a blocked miss explains itself in terms of Ythril, not node_modules', () => {
    // Measured: the library's own message points at `node_modules/@huggingface/transformers/models/…`, so an
    // operator goes looking in the wrong place for a file that was never meant to be there.
    //
    // Sliced to the CATCH BLOCK, not the whole loader. Asserting `cacheDir` and `HF_HUB_OFFLINE` anywhere in
    // the function passed with the entire rewrite deleted — both strings also occur in the warning above it.
    // Caught by mutating the block away, not by reading this file.
    const body = loaderBody();
    const at = body.indexOf('catch (err) {');
    assert.ok(at > 0, 'the load is unguarded, so the library\'s misleading message reaches the operator verbatim');
    const end = body.indexOf('throw err;', at);
    assert.ok(end > at, 'the catch block does not rethrow — a load failure would be swallowed');
    const handler = body.slice(at, end);

    assert.match(handler, /throw new Error\(/,
      'the handler must rethrow a rewritten error; the library\'s own message names a node_modules path that '
      + 'has nothing to do with where Ythril keeps its models');
    assert.match(handler, /MODEL_CACHE_DIR|cacheDir/, 'the rewritten error must name the cache the operator controls');
    assert.match(handler, /HF_HUB_OFFLINE/, 'the rewritten error must name the flag that blocked the load');
  });
});

describe('the published image enforces it', () => {
  it('sets the offline flag', () => {
    assert.match(DOCKERFILE, /^ENV HF_HUB_OFFLINE=1$/m,
      'the image must set HF_HUB_OFFLINE — the README promises an offline product and the image is the product');
  });

  it('sets it AFTER the build-time warm step, which must still be able to download', () => {
    // Ordering is load-bearing in both directions: before the warm RUN, the image cannot bake a model at all;
    // after it, the running container cannot fetch one. A gate that only checked presence would let a
    // well-meaning reorder break the build in a way no unit test sees.
    const warm = DOCKERFILE.indexOf('nomic-ai/nomic-embed-text-v1.5');
    const flag = DOCKERFILE.search(/^ENV HF_HUB_OFFLINE=1$/m);
    assert.ok(warm > 0, 'the model warm step is gone — re-anchor this gate');
    assert.ok(flag > warm,
      'HF_HUB_OFFLINE is set BEFORE the model download that bakes the cache, so the build cannot fetch it');
  });
});

describe('the claim and its enforcement are documented together', () => {
  it('the README says how offline operation is enforced', () => {
    // The bare claim was accurate about intent and wrong about mechanism. A reader deciding whether to put this
     // on an air-gapped network needs the mechanism.
    const readme = read('README.md');
    const at = readme.indexOf('Works fully offline');
    assert.ok(at > 0, 'the offline claim is gone from the README');
    // Prose, bounded by where the next subject starts. A character count on markdown is the worst case of all,
    // because prose gets re-flowed for readability by people who are not thinking about a test.
    assert.match(markdownSectionFrom(readme, at), /HF_HUB_OFFLINE/,
      'the claim must say what enforces it, or it is back to being an assertion');
  });

  it('the hosting guide documents the flag and what a miss does', () => {
    const doc = read('docs/integration-guide/02-hosting.md');
    const at = doc.indexOf('### Runtime Model Downloads');
    assert.ok(at > 0, 'the Runtime Model Downloads section is gone');
    const section = doc.slice(at, doc.indexOf('\n### ', at + 10));
    assert.match(section, /huggingface\.co/, 'the section must name the host a miss would reach');
    // `\s+` rather than a literal space: the sentence wraps, and a gate that fails on a line break is a gate
    // that gets appeased by reflowing a paragraph rather than by keeping the fact.
    assert.match(section, /IP\s+address/i, 'it must say what the request reveals, not just that one happens');
    assert.match(section, /HF_HUB_OFFLINE/, 'it must name the flag');
    assert.match(section, /before deciding\s+local-versus-remote|cache \*before\*/,
      'it must explain why the flag does not break the bundled model, or an operator will not dare set it');
  });
});
