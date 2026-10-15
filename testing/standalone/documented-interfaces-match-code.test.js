/**
 * An interface block in the docs must list the same fields as the interface it copies.
 *
 * ## The failure this catches, reported from outside
 *
 * `06-spaces-api.md` documents `TypeSchema` as a TypeScript block. It listed three fields. The real
 * interface has five public ones — `$ref` and `retention` were missing, and `retention` had been shipped,
 * built an editor in the admin UI, and documented **in a different file** (`04-brain-api.md`).
 *
 * An integrator re-ingesting the guides on every deploy asked whether per-type retention was documented
 * "anywhere we have not looked", because their recall over `06-spaces-api.md` could not surface a field
 * that file never named. They were right, and they were careful enough to ask rather than announce it.
 * The reason it matters to them specifically is the mirror image of this bug: they had once written a
 * `PATCH` against `chronoRetention`, a key the docs described and the implementation never shipped — and a
 * deep-merge `PATCH` against a key that does not exist returns success and changes nothing.
 *
 * ## Why no existing gate caught it
 *
 * Every docs-coverage gate here asks whether a thing is MENTIONED. `retention` **was** mentioned, in
 * `04-brain-api.md`, so those gates were satisfied and correct to be. What nothing checked was the second
 * copy: an interface block is a duplicate of a type declaration, and duplicates drift. Drift needs two
 * copies compared, not one copy counted.
 *
 * A prose omission is a gap. An **enumeration** that omits something is worse — it reads as complete, so it
 * does not invite the question that a gap does. That is the whole reason this gate compares in both
 * directions: a documented field that no longer exists is the same defect wearing the other hat, and it is
 * the one that produces a silent no-op `PATCH`.
 *
 * Run: node --test testing/standalone/documented-interfaces-match-code.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * Each documented block, and the declaration it is a copy of.
 *
 * A hardcoded list cannot silently empty — see `gates-cannot-pass-vacuously` for why that exemption
 * applies — but each entry still asserts it FOUND both blocks, because a renamed interface would otherwise
 * turn this gate into one that compares nothing.
 */
const PAIRS = [
  // Both moved from `config/types.ts` to the `config/types-knowledge.ts` leaf in Q-3. This gate caught the move
  // by failing, which is the "assert it FOUND both blocks" property above doing exactly its job — a path that
  // silently resolved to nothing would have turned it into a gate that compares nothing and passes.
  { name: 'TypeSchema', doc: 'docs/integration-guide/06a-schema-api.md', src: 'server/src/config/types-knowledge.ts' },
  { name: 'PropertySchema', doc: 'docs/integration-guide/06a-schema-api.md', src: 'server/src/config/types-knowledge.ts' },
];

/** Strip comments so a field named only in prose about the type cannot satisfy the comparison. */
const withoutComments = (text) =>
  text.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of `interface <name> { … }`, brace-matched so a nested object type does not end it early. */
function interfaceBody(text, name) {
  const m = new RegExp(`(?:export\\s+)?interface\\s+${name}\\s*\\{`).exec(text);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  for (; i < text.length && depth > 0; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
  }
  return depth === 0 ? text.slice(start, i - 1) : null;
}

/**
 * Field names declared at the TOP level of an interface body.
 *
 * Depth-tracked, so `retention?: { days?: number }` contributes `retention` and not `days`. Fields whose
 * name starts with `_` are skipped: they are marked `@internal` in the source, never appear in stored
 * config, and documenting them would be wrong rather than merely absent.
 */
function fieldNames(body) {
  const out = [];
  let depth = 0;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (depth === 0) {
      const m = /^([A-Za-z_$][\w$]*)\??\s*:/.exec(trimmed);
      if (m && !m[1].startsWith('_')) out.push(m[1]);
    }
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
  }
  return out;
}

describe('a documented interface block lists what the real interface declares', () => {
  for (const pair of PAIRS) {
    it(`${pair.name} — the doc block and the declaration agree`, () => {
      const srcBody = interfaceBody(withoutComments(read(pair.src)), pair.name);
      const docBody = interfaceBody(withoutComments(read(pair.doc)), pair.name);

      assert.ok(srcBody !== null,
        `interface ${pair.name} was not found in ${pair.src} — it was renamed or moved, which makes this `
        + 'gate compare nothing. Re-point it rather than deleting the entry.');
      assert.ok(docBody !== null,
        `no \`interface ${pair.name}\` block in ${pair.doc} — if the block was removed on purpose, remove `
        + 'this pair too, deliberately.');

      const inCode = fieldNames(srcBody);
      const inDocs = fieldNames(docBody);

      // The enumeration floor. A brace-matching or regex change that returned an empty body would make
      // both lists empty and every comparison below pass while examining nothing.
      assert.ok(inCode.length >= 3,
        `only parsed ${inCode.length} field(s) out of ${pair.name} in ${pair.src}; the parse broke, not the docs`);

      const missing = inCode.filter(f => !inDocs.includes(f));
      assert.deepEqual(missing, [],
        `${pair.doc} documents ${pair.name} without ${missing.join(', ')}. The block is an ENUMERATION, so `
        + 'it reads as complete and does not invite the question a prose gap would. Being documented in '
        + 'another file does not fix it: a reader searching this type searches here.');

      const invented = inDocs.filter(f => !inCode.includes(f));
      assert.deepEqual(invented, [],
        `${pair.doc} documents ${pair.name}.${invented.join(', ')}, which the code does not declare. This is `
        + 'the worse direction: a PATCH written against a key that does not exist deep-merges to a success '
        + 'code and changes nothing, so the integrator is told it worked.');
    });
  }

  // SpaceMeta has no code block in the docs: its keys are documented in prose and tables across the spaces and schema
  // pages, and a second copy of the interface would be one more enumeration to rot. So the question is the other half
  // only — every key the interface declares is NAMED there — which is what a reader searching for a key needs.
  it('SpaceMeta — every key the interface declares is named in the spaces or schema docs', () => {
    const body = interfaceBody(withoutComments(read('server/src/config/types-knowledge.ts')), 'SpaceMeta');
    assert.ok(body !== null, 'interface SpaceMeta was not found in server/src/config/types-knowledge.ts — re-point this case');
    const keys = fieldNames(body);
    assert.ok(keys.length >= 8, `only parsed ${keys.length} SpaceMeta key(s); the parse broke, not the docs`);
    const docs = ['docs/integration-guide/06-spaces-api.md', 'docs/integration-guide/06a-schema-api.md'].map(read).join('\n');
    const unnamed = keys.filter(k => !docs.includes(`\`${k}\``) && !docs.includes(`\`meta.${k}`));
    assert.deepEqual(unnamed, [], `SpaceMeta declares ${unnamed.join(', ')}, which neither 06-spaces-api nor 06a-schema-api names: `
      + 'a meta key a caller can set and no page mentions is a capability nobody knows about.');
  });
});
