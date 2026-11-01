/**
 * Every request-body limit the config declares (`BodyLimitsConfig`, `server/src/config/body-limits.ts`) is in `config/config.example.json`, as a
 * positive whole number (bundle-40 pre-ship D2, `Q-267`).
 *
 * ## What it prevents
 *
 * The example is where an operator finds the keys a config may carry. `importBodyMaxBytes` and `importMaxDocuments` were added beside
 * `maxUploadBodyBytes` in the code and not in the example, so the limits of a restore were found only by reading the integrator's docs; and
 * `maxChunkedUploadBytes` had never been there. The keys are read from the interface's declaration, so a limit added later is owed here too.
 *
 * Run: `node --test testing/standalone/every-request-body-limit-is-in-the-example-config.test.js`
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

/** The keys of `interface BodyLimitsConfig { ... }` in `src`, comments blanked. */
function limitKeysOf(src) {
  const body = /export\s+interface\s+BodyLimitsConfig\s*\{([^}]*)\}/.exec(blankComments(src))?.[1];
  if (body === undefined) return null;
  return [...body.matchAll(/^\s*(\w+)\??\s*:/gm)].map(m => m[1]);
}

describe('every request-body limit is in the example config', () => {
  it('the reader finds an interface\'s keys and not its comments', () => {
    assert.deepEqual(limitKeysOf('export interface BodyLimitsConfig {\n  /** a: b */\n  a?: number;\n  // c: d\n  bee: number;\n}'), ['a', 'bee']);
    assert.equal(limitKeysOf('export interface Other { a?: number }'), null);
  });

  it('each key of BodyLimitsConfig is in config/config.example.json as a positive whole number', () => {
    const keys = limitKeysOf(fs.readFileSync(path.join(REPO_ROOT, 'server/src/config/body-limits.ts'), 'utf8'));
    assert.ok(keys && keys.length >= 4 && keys.includes('importBodyMaxBytes'), `the limits did not derive: ${JSON.stringify(keys)}`);
    const example = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config/config.example.json'), 'utf8').replace(/^﻿/, ''));
    const wrong = keys.filter(k => !(Number.isSafeInteger(example[k]) && example[k] > 0));
    assert.deepEqual(wrong, [], `config/config.example.json lacks, or holds no positive whole number for: ${wrong.join(', ')}`);
  });
});
