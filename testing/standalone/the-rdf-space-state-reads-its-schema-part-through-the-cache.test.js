/**
 * `rdfSpaceState` reads a space's schema part (its term clashes, the first address no document can carry) through the schema verdict cache,
 * never by computing it inline (bundle-378, Q-976, S1, contract row 5).
 *
 * ## The rule
 *
 * Every module that resolves a space's RDF state calls `rdfSpaceState` (the member helper for the SPARQL query, Update and CONSTRUCT view,
 * the RDF export and Linked Data; and the schema export, the imports and the triple index's follower beside them). The cache sits inside
 * that one function, so no caller can skip it:
 *
 *  1. the body of `rdfSpaceState` calls `cachedSchemaVerdict` and calls neither `termClashes` nor `firstUnwritableAddress` itself;
 *  2. no module outside `rdf-space-state.ts` calls `firstUnwritableAddress`, and every module that calls `rdfSpaceState` is a tracked
 *     server source (derived with `git ls-files`, never a hand list), so the count of callers the cache serves is the count found.
 *
 * ## Seen red
 *
 * On 42c51f330 `rdfSpaceState` computes `termClashes` and `firstUnwritableAddress` inline, on every call.
 *
 * Run: node --test testing/standalone/the-rdf-space-state-reads-its-schema-part-through-the-cache.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, SERVER_SOURCE_ROOT, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const STATE = 'server/src/rdf/rdf-space-state.ts';

/** The body of `export function <name>(` in `text`: from its first brace after the signature to the brace that closes it. */
function bodyOf(text, name) {
  const at = text.indexOf(`export function ${name}(`);
  assert.ok(at >= 0, `${STATE} declares no ${name}`);
  // The parameters hold no parenthesis, so the first `)` ends them; the body opens at the next brace (the return type holds none).
  const open = text.indexOf('{', text.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error(`${name}: no closing brace`);
}

describe('rdfSpaceState reads its schema part through the cache', () => {
  it('the body of rdfSpaceState asks cachedSchemaVerdict and computes no clash or address check inline', () => {
    const body = bodyOf(stripComments(readFileSync(join(REPO_ROOT, STATE), 'utf8')), 'rdfSpaceState');
    assert.match(body, /\bcachedSchemaVerdict\s*\(/, 'rdfSpaceState does not read the schema part through cachedSchemaVerdict');
    assert.doesNotMatch(body, /\btermClashes\s*\(/, 'rdfSpaceState computes the term clashes inline, on every call');
    assert.doesNotMatch(body, /\bfirstUnwritableAddress\s*\(/, 'rdfSpaceState computes the unwritable address inline, on every call');
  });

  it('every caller of rdfSpaceState is a tracked server source, and none checks the addresses around it', () => {
    const callers = [];
    const around = [];
    for (const file of trackedSources([SERVER_SOURCE_ROOT], { untracked: true, floor: 100 })) {
      const text = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
      if (/\brdfSpaceState\s*\(/.test(text.replace(/export function rdfSpaceState\s*\(/g, ''))) callers.push(file);
      if (file !== STATE && /\bfirstUnwritableAddress\s*\(/.test(text)) around.push(file);
    }
    assert.ok(callers.length > 0, 'no module calls rdfSpaceState: the scan stopped matching');
    assert.deepEqual(around, [], 'a module checks the stored addresses around rdfSpaceState and its cache');
  });
});
