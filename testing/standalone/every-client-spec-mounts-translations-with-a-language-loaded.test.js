/**
 * Every client spec mounts translations through the spec module, which has a language loaded.
 *
 * The network layers panel's spec provided Transloco bare (`provideTransloco({ config })`, no loader, no
 * translation): every label it rendered logged "Missing translation for 'spaces.schema.layers.…'" into each
 * preflight, a dozen false warnings although every key is in every language file (found in bundle-236's
 * preflight, 2026-11-04). Noise like that buries the warning that is real.
 *
 * The rule: a spec takes Transloco from `getTranslocoModule` (client/src/app/testing/transloco-testing.ts), which
 * preloads `en` (empty by default, or the real file a spec hands it), or from the language-load helper
 * (client/src/app/testing/language-loads.ts), which installs a loader. A bare `provideTransloco(` in a spec is refused.
 *
 * Run: node --test testing/standalone/every-client-spec-mounts-translations-with-a-language-loaded.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';

const specs = trackedSources(['client/src'], { ext: ['.ts'], untracked: true }).filter(f => f.endsWith('.spec.ts'));

describe('every client spec mounts translations with a language loaded', () => {
  it('found the specs (the check itself works)', () => {
    assert.ok(specs.length >= 50, `only ${specs.length} client specs found`);
  });

  it('no spec provides Transloco bare', () => {
    const bare = specs.filter(f => /\bprovideTransloco\s*\(/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(bare, [], 'these specs mount Transloco with no language loaded, so every label logs a missing translation: use getTranslocoModule() from client/src/app/testing/transloco-testing.ts');
  });
});
