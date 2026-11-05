/**
 * The `$ref` refusal is written once, in the package, and every door that stores or dry-runs a schema calls it (Q-668, 4', S6).
 *
 * ## The defect this prevents
 *
 * A meta whose `$ref` names a missing library entry, or an entry filed under another kind, is refused at 422 with one sentence. That
 * sequence — find the broken refs, answer `brokenRefsError`, find the wrong-kind refs, answer `wrongKindRefsError` — was written five
 * times: `schema/src/validate.ts`, `server/src/spaces/meta-update.ts`, `server/src/spaces/space-create.ts`, and twice in
 * `server/src/api/spaces.ts`, the last two with the "not found" sentence typed out by hand. The schema-validate door, whose claim is
 * that a dry run refuses what the save refuses, did not run it at all, so a broken `$ref` passed the dry run and failed the save.
 *
 * Now the package declares `libraryRefRefusal(typeSchemas, library?)`, the finders and their wording are package-internal, and:
 *
 * 1. no file outside `schema/src` CALLS `findBrokenLibraryRefs` or `findWrongKindLibraryRefs` — a call outside is a sixth copy of the
 *    sequence (scope: every tracked and uncommitted source of the repository, comments out);
 * 2. each door calls `libraryRefRefusal(` in the function that applies it: `validateSpaceMeta`, `planSpaceMetaUpdate`,
 *    `planSpaceCreate`, the two schema PUT handlers, and `beginSchemaValidate`.
 *
 * Run: node --test testing/standalone/the-library-ref-refusal-is-written-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { SCHEMA_PACKAGE_NAME } from './_relative-specifier.mjs';
import { blankComments, stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const THIS_FILE = relative(REPO_ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/');
/** A call of either finder — not an import, not a mention in prose. */
const FINDER_CALL = /(?<![\w$])(findBrokenLibraryRefs|findWrongKindLibraryRefs)\s*\(/g;
const CHECK = /(?<![\w$])libraryRefRefusal\s*\(/;

/** `file:line: call` for every finder call in `text`, comments blanked so the line numbers are the source's own. */
function finderCallsIn(file, text) {
  const code = blankComments(text);
  return [...code.matchAll(FINDER_CALL)].map(m => `${file}:${code.slice(0, m.index).split('\n').length}: ${m[1]}(`);
}

describe('the finder-call reader (proved on a planted copy)', () => {
  it('reports a call with its line, and ignores a comment, a declaration\'s neighbour and a longer name', () => {
    const planted = [
      '// findBrokenLibraryRefs(x) was called here once',
      `import { findBrokenLibraryRefs } from '${SCHEMA_PACKAGE_NAME}/internal';`,
      'const myfindBrokenLibraryRefs = () => 0;',
      'const broken = findBrokenLibraryRefs(meta.typeSchemas);',
      '/* findWrongKindLibraryRefs(meta) */ const wrong = findWrongKindLibraryRefs (meta.typeSchemas);',
    ].join('\n');
    assert.deepEqual(finderCallsIn('planted.ts', planted), ['planted.ts:4: findBrokenLibraryRefs(', 'planted.ts:5: findWrongKindLibraryRefs(']);
  });
});

describe('the $ref refusal is written once, in the package', () => {
  it('no file outside schema/src calls findBrokenLibraryRefs or findWrongKindLibraryRefs', () => {
    const files = trackedSources(['.'], { ext: ['.ts', '.js', '.mjs', '.cjs'], untracked: true, floor: 1000, exclude: [THIS_FILE] })
      .filter(f => !f.startsWith('schema/src/'));
    const calls = files.flatMap(f => finderCallsIn(f, readFileSync(join(REPO_ROOT, f), 'utf8')));
    assert.deepEqual(calls, [],
      'a finder is called outside the package: that is a copy of the $ref refusal. Call libraryRefRefusal(typeSchemas, library?) and '
      + `answer its message:\n${calls.join('\n')}`);
  });

  /** [file, the function or route that applies the refusal there]. */
  const DOORS = [
    ['schema/src/validate.ts', 'validateSpaceMeta'],
    ['server/src/spaces/meta-update.ts', 'planSpaceMetaUpdate'],
    ['server/src/spaces/space-create.ts', 'planSpaceCreate'],
    ['server/src/spaces/schema-validate-door.ts', 'beginSchemaValidate'],
  ];
  for (const [file, fn] of DOORS) {
    it(`${file}: ${fn} calls libraryRefRefusal`, () => {
      const body = bodyOf(stripComments(readFileSync(join(REPO_ROOT, file), 'utf8')), fn, `${file}:${fn}`);
      assert.match(body, CHECK, `${fn} in ${file} does not call libraryRefRefusal(`);
    });
  }

  for (const path of ['/:id/schema', '/:id/meta/typeSchemas/:knowledgeType/:typeName']) {
    it(`server/src/api/spaces.ts: PUT ${path} calls libraryRefRefusal`, () => {
      const src = stripComments(readFileSync(join(REPO_ROOT, 'server/src/api/spaces.ts'), 'utf8'));
      const starts = [...src.matchAll(/spacesRouter\.(?:get|post|put|patch|delete)\(\s*'([^']+)'/g)];
      const i = starts.findIndex(m => m[0].startsWith('spacesRouter.put(') && m[1] === path);
      assert.ok(i >= 0, `no PUT ${path} handler in server/src/api/spaces.ts: re-anchor this gate`);
      const handler = src.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : src.length);
      assert.match(handler, CHECK, `PUT ${path} does not call libraryRefRefusal(`);
    });
  }
});
