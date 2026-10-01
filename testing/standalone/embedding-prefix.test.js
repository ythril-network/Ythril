/**
 * Embedding task prefixes — the string that actually gets embedded.
 *
 * The bug this pins: `embed()` prefixed the text INSIDE the local branch, so the moment an HTTP endpoint
 * was configured the prefix vanished. Nothing errored. Retrieval just got worse, which is why it survived
 * a release. The fix is structural — one preparation site, before the branch — so most of these tests are
 * about the invariant that keeps it that way, not just about the strings.
 *
 * Run: node --test testing/standalone/embedding-prefix.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { balancedFrom } from './_structural-window.mjs';

let prepareInput, resolvePrefixScheme;

before(async () => {
  ({ prepareInput, resolvePrefixScheme } = await import('../../server/dist/brain/embedding.js'));
});

describe('resolvePrefixScheme — what `auto` means', () => {
  it('is nomic for the bundled local model', () => {
    // The bundled model IS nomic and the local path always prefixed. Anything else here would silently
    // invalidate every existing local corpus on upgrade.
    assert.equal(resolvePrefixScheme({}), 'nomic');
    assert.equal(resolvePrefixScheme({ prefixScheme: 'auto' }), 'nomic');
  });

  it('is none for an HTTP endpoint', () => {
    // Not because none is right — it is usually wrong — but because it is what external corpora were
    // embedded under. `auto` is a compatibility default; correctness is opt-in and needs a reindex.
    assert.equal(resolvePrefixScheme({ baseUrl: 'http://ollama:11434' }), 'none');
    assert.equal(resolvePrefixScheme({ baseUrl: 'http://ollama:11434', prefixScheme: 'auto' }), 'none');
  });

  it('an explicit scheme wins over both, endpoint or not', () => {
    assert.equal(resolvePrefixScheme({ prefixScheme: 'none' }), 'none');
    assert.equal(resolvePrefixScheme({ baseUrl: 'http://ollama:11434', prefixScheme: 'nomic' }), 'nomic');
    assert.equal(resolvePrefixScheme({ baseUrl: 'http://ollama:11434', prefixScheme: 'qwen' }), 'qwen');
  });
});

describe('prepareInput — the prefix reaches BOTH paths', () => {
  const NOMIC = { prefixScheme: 'nomic' };
  const OLLAMA_NOMIC = { baseUrl: 'http://ollama:11434', prefixScheme: 'nomic' };

  it('marks document and query differently', () => {
    assert.equal(prepareInput('hello', 'document', NOMIC), 'search_document: hello');
    assert.equal(prepareInput('hello', 'query', NOMIC), 'search_query: hello');
  });

  it('produces the SAME string with and without an endpoint — this is the bug', () => {
    // Before the fix these differed: the local one was prefixed, the endpoint one was raw. Same model,
    // same config, two different vectors for the same sentence.
    for (const task of ['document', 'query']) {
      assert.equal(prepareInput('hello', task, OLLAMA_NOMIC), prepareInput('hello', task, NOMIC));
    }
  });

  it('adds nothing under `none`', () => {
    const cfg = { prefixScheme: 'none' };
    assert.equal(prepareInput('hello', 'document', cfg), 'hello');
    assert.equal(prepareInput('hello', 'query', cfg), 'hello');
  });

  it('qwen instructs the QUERY only and leaves passages bare', () => {
    // Applying the nomic shape to Qwen would be worse than applying nothing, so the asymmetry is the
    // point of having per-family schemes rather than one boolean.
    const cfg = { prefixScheme: 'qwen' };
    assert.equal(prepareInput('hello', 'document', cfg), 'hello');
    assert.ok(prepareInput('hello', 'query', cfg).startsWith('Instruct:'));
    assert.ok(prepareInput('hello', 'query', cfg).endsWith('hello'));
  });

  it('`auto` on a default install still yields the historical nomic prefixes', () => {
    assert.equal(prepareInput('hello', 'query', {}), 'search_query: hello');
  });
});

describe('the structure that prevents the bug coming back', () => {
  const src = readFileSync(new URL('../../server/src/brain/embedding.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function embed('));

  it('embed() prepares its input ONCE, before the local/HTTP branch', () => {
    // The whole defect was ordering: prefixing after the branch means only one branch gets it.
    const prep = body.indexOf('prepareInput(');
    const branch = body.indexOf('if (cfg.baseUrl)');
    assert.ok(prep > 0, 'embed() must call prepareInput');
    assert.ok(branch > 0, 'the local/HTTP branch must still exist');
    assert.ok(prep < branch, 'prepareInput must run BEFORE the branch, or one path loses the prefix');
    assert.equal((body.match(/prepareInput\(/g) ?? []).length, 1, 'exactly one preparation site');
  });

  it('neither branch embeds the raw `text` argument', () => {
    // `text` is the unprefixed parameter. Once prepareInput exists, every downstream use must be `input`;
    // a stray `text` is the bug reappearing.
    assert.ok(!/embedViaHttp\(text\b/.test(body), 'the HTTP path must send the prepared input');
    // The local branch used to call `pipe(input, …)`, and this asserted there was no `pipe(text`. Since Q-99 part 1
    // the local branch hands the string to the inference host, so that negative would be VACUOUS: nothing in
    // the file calls `pipe(` any more, and a regression to `runLocalInference({ input: text, … })` would pass it.
    // Re-pointed at the call that exists: it must be given `input`, and the raw `text` must appear nowhere in its
    // arguments. (`embed-calls-the-inference-host.test.js` holds the behavioural half.)
    const at = body.indexOf('runLocalInference(');
    assert.ok(at > 0, 'the local branch no longer calls the inference host — re-anchor this gate');
    const args = balancedFrom(body, at, 'the runLocalInference arguments');
    assert.match(args, /\binput\b/, 'the local path must hand the host the prepared input');
    assert.ok(!/\btext\b/.test(args), 'the local path is handing the host the raw, unprefixed text');
    assert.ok(!/\bpipe\s*\(/.test(body), 'embed() is calling a pipeline itself again, on the main thread');
  });

  it('the HTTP body sends the prepared input, not the raw text', () => {
    assert.ok(/input: imageBytes|input\s*[,}]/.test(src.slice(src.indexOf('embedViaHttp'))),
      'the request body must carry the prepared input');
    assert.ok(!/input:\s*text\b/.test(src), 'never send the unprefixed text');
  });
});

describe('the scheme is part of the corpus identity', () => {
  it('the API accepts prefixScheme as a patchable embedding field', () => {
    const api = readFileSync(new URL('../../server/src/api/media-config.ts', import.meta.url), 'utf8');
    assert.ok(/prefixScheme:\s*z\.enum\(\['auto', 'none', 'nomic', 'qwen'\]\)/.test(api),
      'the strict() patch schema must know the field, or saving it 400s');
  });

  // The client half — reindex prompt and save payload — is covered behaviourally in
  // `media-processing-state.service.spec.ts`, not by grepping this source. A grep here passed even with
  // the field spliced out of the template literal, because the identifier still appeared in the file.

  it('an env pin renders the field read-only like every other embedding field', () => {
    const loader = readFileSync(new URL('../../server/src/config/loader.ts', import.meta.url), 'utf8');
    assert.ok(loader.includes("EMBEDDING_PREFIX_SCHEME"), 'the env pin must exist');
    assert.ok(loader.includes("locked.push('embedding.prefixScheme')"),
      'a pinned field must be reported in lockedByInfra or the UI offers an edit that silently does nothing');
  });
});
