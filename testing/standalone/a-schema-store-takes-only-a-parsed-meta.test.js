/**
 * The stores accept a meta only once it has been PARSED — a type-level rule, held by the compiler (`Q-216`).
 *
 * ## The rule
 *
 * `parseSpaceMeta` and `parseTypeSchema` (in `spaces/body-schemas.ts`) are the only things that mint a `ParsedSpaceMeta` /
 * `ParsedTypeSchema`. A brand has no runtime cost and no runtime test, and that is exactly why it needs a test of its own: a store whose
 * parameter quietly stays `SpaceMeta` accepts every unparsed value there is, compiles, and reads as protected. So this file COMPILES
 * a fixture against the built declarations and asks the compiler three things:
 *
 * 1. a parsed value is accepted by every store (the positive control — a brand that nothing can satisfy would pass every refusal below);
 * 2. a plain `SpaceMeta` is REFUSED by every store, and the brand cannot be forged by a literal — each as a `@ts-expect-error` line, so a
 *    store that starts accepting an unparsed meta turns TS2578 ("unused directive") and fails here, on the line that names it;
 * 3. a parsed value is still usable wherever the plain type is (the readers do not change).
 *
 * ## Stores covered, and the ones that are not
 *
 * `storeNetworkLayer`, `commitOwnMetaEdit` and `updateSpace`'s `meta`. The plan also brands the library store and space create; their
 * signatures are not fixed by the plan, so they are not pinned here and the derived gate in
 * `every-schema-storing-path-parses-through-the-one-body-schema.test.js` is what covers those callers.
 *
 * ## The harness is proven in both directions
 *
 * The last case compiles a deliberately wrong fixture (a `@ts-expect-error` above a line that compiles) and requires the TS2578 this file
 * relies on, so a compiler setup that stopped reporting it cannot make the rest pass.
 *
 * Run: node --test testing/standalone/a-schema-store-takes-only-a-parsed-meta.test.js
 * (requires a prior server build: it reads server/dist/**\/*.d.ts)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ts } from '../_shared/syntax-tree.mjs';
import { REPO_ROOT } from './_sources.mjs';

const VIRTUAL = resolve(REPO_ROOT, 'testing/standalone/__brand-fixture__.ts');

/** Compile `source` as a file that sits beside the tests, so its relative imports resolve to server/dist's declarations. */
function diagnosticsOf(source) {
  const config = ts.readConfigFile(join(REPO_ROOT, 'server/tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(REPO_ROOT, 'server'));
  const options = { ...parsed.options, noEmit: true, rootDir: undefined, outDir: undefined, declaration: false, declarationMap: false, sourceMap: false, noUnusedLocals: false, noUnusedParameters: false };
  const host = ts.createCompilerHost(options);
  const real = { getSourceFile: host.getSourceFile.bind(host), fileExists: host.fileExists.bind(host), readFile: host.readFile.bind(host) };
  host.fileExists = (f) => resolve(f) === VIRTUAL || real.fileExists(f);
  host.readFile = (f) => (resolve(f) === VIRTUAL ? source : real.readFile(f));
  // No getSourceFile override: the host's own reads the virtual file through the readFile above.
  const program = ts.createProgram({ rootNames: [VIRTUAL], options, host });
  return ts.getPreEmitDiagnostics(program)
    .filter(d => d.file && resolve(d.file.fileName) === VIRTUAL)
    .map(d => {
      const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
      return `line ${line + 1}: TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0]}`;
    });
}

const IMPORTS = `
import { storeNetworkLayer, commitOwnMetaEdit } from '../../server/dist/spaces/effective-meta.js';
import { updateSpace } from '../../server/dist/spaces/spaces.js';
import type { ParsedSpaceMeta, ParsedTypeSchema } from '../../server/dist/spaces/body-schemas.js';
import { parseSpaceMeta, parseTypeSchema } from '../../server/dist/spaces/body-schemas.js';
import type { SpaceMeta, TypeSchema } from '../../server/dist/config/types.js';
`;

describe('the stores take only a parsed meta', () => {
  it('the two parsers exist and the brand types are declared where the stores can name them', () => {
    const diagnostics = diagnosticsOf(`${IMPORTS}
void parseSpaceMeta; void parseTypeSchema;
declare const a: ParsedSpaceMeta; declare const b: ParsedTypeSchema;
void a; void b;
`);
    assert.deepEqual(diagnostics, [], 'body-schemas.ts must export parseSpaceMeta, parseTypeSchema, ParsedSpaceMeta and ParsedTypeSchema');
  });

  it('a parsed meta is accepted by every store, and a plain one is refused by each', () => {
    const diagnostics = diagnosticsOf(`${IMPORTS}
declare const parsed: ParsedSpaceMeta;
declare const plain: SpaceMeta;
declare const body: unknown;
void parseSpaceMeta(body);

// 1. the positive control
storeNetworkLayer('network', 'space', parsed);
commitOwnMetaEdit('space', () => parsed);
updateSpace('space', { meta: parsed });

// 2. the refusals — each line must be an error, or the directive is unused and the compiler says so
// @ts-expect-error a plain SpaceMeta is not a parsed one: storeNetworkLayer
storeNetworkLayer('network', 'space', plain);
// @ts-expect-error a plain SpaceMeta is not a parsed one: commitOwnMetaEdit
commitOwnMetaEdit('space', () => plain);
// @ts-expect-error a plain SpaceMeta is not a parsed one: updateSpace
updateSpace('space', { meta: plain });
// @ts-expect-error the brand cannot be minted by writing a literal
const forged: ParsedSpaceMeta = { purpose: 'forged' };
void forged;
`);
    assert.deepEqual(diagnostics, [], 'a store accepts a meta that nothing parsed, or the brand cannot be satisfied:\n  ' + diagnostics.join('\n  '));
  });

  it('a parsed type schema cannot be forged either, and both parsed values read as the plain types', () => {
    const diagnostics = diagnosticsOf(`${IMPORTS}
declare const parsedMeta: ParsedSpaceMeta;
declare const parsedType: ParsedTypeSchema;
declare const plainType: TypeSchema;

// 3. the readers do not change: a parsed value is a SpaceMeta / a TypeSchema
const asMeta: SpaceMeta = parsedMeta;
const asType: TypeSchema = parsedType;
void asMeta; void asType;

// @ts-expect-error a plain TypeSchema is not a parsed one
const forgedType: ParsedTypeSchema = plainType;
void forgedType;
`);
    assert.deepEqual(diagnostics, [], diagnostics.join('\n'));
  });

  it('the harness reports an unused directive (so a green run above means the lines ARE errors)', () => {
    const diagnostics = diagnosticsOf(`
// @ts-expect-error this line compiles, so the directive is unused
const fine: number = 1;
void fine;
`);
    assert.ok(diagnostics.some(d => /TS2578/.test(d)), `the compiler did not report an unused @ts-expect-error: ${JSON.stringify(diagnostics)}`);
  });

  it('the fixture reads the built declarations, not stale ones (the build is the subject)', () => {
    const d = readFileSync(join(REPO_ROOT, 'server/dist/spaces/effective-meta.d.ts'), 'utf8');
    assert.ok(/storeNetworkLayer/.test(d) && /commitOwnMetaEdit/.test(d), 'server/dist does not declare the stores: build the server first');
  });
});
