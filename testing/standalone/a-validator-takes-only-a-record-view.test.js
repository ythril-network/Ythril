/**
 * Rules see a RECORD VIEW built by one function, and a validator accepts nothing else (F-46, ruling R6-3).
 *
 * ## What it prevents
 *
 * Every validator used to be handed whatever the caller had in its hand: `validateEntity(meta, { name, type, properties })`,
 * `validateEdge(meta, { label, properties })`, `validateFact(meta, { type, properties })`. A rule reads `self.title`,
 * `self.description`, `self.tags` — and a caller that passes a partial record does not get an error, it gets a rule that
 * silently stops applying: "absent means the rule does not apply" is the right reading of a missing PROPERTY and the wrong one of
 * a missing record field. Eleven call sites pass partial records today (the sync arrival check, the dry run, the merge, the
 * stored-edge scan, the four classifiers), each correct for the one rule it was written for.
 *
 * So the view is built in ONE place and the validators accept only it:
 *
 * 1. **`recordViewOf(kind, mergedRecord)`** (`brain/record-view.ts`) folds the record's own spelling into the view's: `title` is the
 *    entity's `name`, the fact's `fact`, the chrono entry's `title` (`endpointNameField`, the one map of it); an edge has a `label`
 *    and no title and never `from`/`to` (an inline edge is validated before its ends exist). Nothing else leaves: no vector, no
 *    author, no sequence number. It COPIES — a validator is handed a value, not the document the caller is about to mutate.
 * 2. **`RecordView` is a type nothing else can make**: a plain object with the same fields is a type error, and so is a cast.
 *    Held by the compiler (`@ts-expect-error` per validator, below) and by a gate that finds the one definition and no forgery.
 * 3. **Every caller passes one**: derived from the syntax tree of every validator call in the server (never a list of callers),
 *    with a floor, so the caller added next year is covered by what this file reads and not by what its author remembered.
 *
 * ## Why this is red on the base
 *
 * `brain/record-view.ts` does not exist, so the shape tests fail on import and the compiler cases on `TS2307`; the caller gate
 * names every call that hands a validator a literal today.
 *
 * Run: node --test testing/standalone/a-validator-takes-only-a-record-view.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { parseSource, ts, unwrapExpression, lineOf } from '../_shared/syntax-tree.mjs';
import { recordViewOf, recordOf, REPO_DIST } from './_cel-rules.mjs';

const { endpointNameField } = await import(`${REPO_DIST}brain/entity-refs.js`);

/** Fields no view may carry: derived by the local embedder, written by the server, or a peer's. */
const NEVER_IN_A_VIEW = ['embedding', 'embeddingModel', 'matchedText', 'author', 'seq', '_id', 'spaceId', 'createdAt', 'updatedAt', 'deliveredBy', 'syncBase'];

describe('the view of a record', () => {
  it('carries the same title the record\'s own spelling gives it, derived from the one map of those spellings', async () => {
    for (const kind of ['entity', 'fact', 'chrono']) {
      const record = recordOf[kind]();
      const view = await recordViewOf(kind, record);
      assert.equal(view.title, record[endpointNameField(kind)], `${kind}: the view's title is not the record's ${endpointNameField(kind)}`);
      assert.equal(view.type, record.type, `${kind}: type`);
    }
  });

  it('an edge has its label and no title, and never its ends', async () => {
    const view = await recordViewOf('edge', recordOf.edge({ label: 'owns' }));
    assert.equal(view.label, 'owns');
    for (const absent of ['title', 'from', 'to']) {
      assert.ok(!(absent in view), `an edge view carries '${absent}': a rule could read it, and an inline edge's ends do not exist when it is validated`);
    }
  });

  it('carries description, tags and properties for every kind, and fills what the record lacks', async () => {
    for (const kind of ['entity', 'edge', 'fact', 'chrono']) {
      const view = await recordViewOf(kind, recordOf[kind]({ description: 'about', tags: ['a', 'b'], properties: { k: 1 } }));
      assert.deepEqual(view.tags, ['a', 'b'], `${kind}: tags`);
      assert.deepEqual(view.properties, { k: 1 }, `${kind}: properties`);
      if (kind !== 'fact') assert.equal(view.description, 'about', `${kind}: description`);
    }
    const bare = await recordViewOf('entity', { name: 'Bare', type: 'thing' });
    assert.equal(bare.description, '', 'a record with no description has an empty one: title, type, description and tags are always there');
    assert.deepEqual(bare.tags, []);
    assert.deepEqual(bare.properties, {});
  });

  it('carries nothing else: no vector, no author, no sequence number', async () => {
    const heavy = { embedding: [0.1, 0.2], embeddingModel: 'm', matchedText: 'snippet', author: { instanceId: 'x' }, seq: 7, _id: 'id', spaceId: 's',
      createdAt: 'then', updatedAt: 'now', deliveredBy: 'peer', syncBase: {} };
    for (const kind of ['entity', 'edge', 'fact', 'chrono']) {
      const view = await recordViewOf(kind, recordOf[kind](heavy));
      const leaked = NEVER_IN_A_VIEW.filter(k => k in view);
      assert.deepEqual(leaked, [], `${kind}: the view carries ${leaked.join(', ')}`);
    }
  });

  it('is a copy: changing the record afterwards does not change the view', async () => {
    const record = recordOf.entity({ tags: ['a'], properties: { k: 1 } });
    const view = await recordViewOf('entity', record);
    record.properties['k'] = 2;
    record.tags.push('b');
    record.name = 'Renamed';
    assert.deepEqual(view.properties, { k: 1 });
    assert.deepEqual(view.tags, ['a']);
    assert.equal(view.title, 'Acme');
  });
});

describe('a validator accepts only a record view (the compiler holds it)', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-record-view-typecheck-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const spec = (file) => {
    const rel = path.relative(dir, path.join(REPO_ROOT, 'server', 'src', file)).split(path.sep).join('/').replace(/\.ts$/, '.js');
    return rel;
  };
  const header = () => `import { validateEntity, validateEdge, validateFact, validateChrono } from '${spec('spaces/schema-validation.ts')}';
import { recordViewOf } from '${spec('brain/record-view.ts')}';
import type { RecordView } from '${spec('brain/record-view.ts')}';
`;

  /** Compile `source` as a file of its own; the status and the compiler's words are the verdict. */
  function compile(name, source) {
    fs.writeFileSync(path.join(dir, `${name}.ts`), `${header()}${source}`);
    fs.writeFileSync(path.join(dir, `${name}.tsconfig.json`), JSON.stringify({
      extends: path.join(REPO_ROOT, 'tsconfig.base.json').split(path.sep).join('/'),
      compilerOptions: {
        noEmit: true, declaration: false, declarationMap: false, sourceMap: false,
        // The scratch folder is outside the repository: say where the node typings are, or every server file fails for want of `process`.
        typeRoots: [path.join(REPO_ROOT, 'node_modules', '@types').split(path.sep).join('/')], types: ['node'],
      },
      files: [`${name}.ts`],
    }));
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(dir, `${name}.tsconfig.json`)],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 180_000 });
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
  }

  it('the control: a view built by recordViewOf is accepted by every validator (a failure below is the argument\'s, not the setup\'s)', () => {
    const r = compile('control', `
const meta = {};
export const e = validateEntity(meta, recordViewOf('entity', { name: 'n', type: 't', description: '', tags: [], properties: {} }));
export const g = validateEdge(meta, recordViewOf('edge', { from: 'a', to: 'b', label: 'l', description: '', tags: [], properties: {} }));
export const f = validateFact(meta, recordViewOf('fact', { fact: 'f', type: 't', tags: [], properties: {} }));
export const c = validateChrono(meta, recordViewOf('chrono', { title: 't', type: 't', description: '', tags: [], properties: {} }));
`);
    assert.equal(r.status, 0, r.out);
  });

  it('a partial record, as the validators have always been handed one, is a type error for each of the four', () => {
    const r = compile('partial', `
const meta = {};
// @ts-expect-error a partial record is not a RecordView
export const e = validateEntity(meta, { name: 'n', type: 't', properties: {} });
// @ts-expect-error a partial record is not a RecordView
export const g = validateEdge(meta, { label: 'l', properties: {} });
// @ts-expect-error a partial record is not a RecordView
export const f = validateFact(meta, { type: 't', properties: {} });
// @ts-expect-error a partial record is not a RecordView
export const c = validateChrono(meta, { type: 't', properties: {} });
`);
    assert.equal(r.status, 0, `one of the four validators still takes a partial record (an unused @ts-expect-error is TS2578):\n${r.out}`);
  });

  it('a plain object with every field of the view is not a view either: the type cannot be made by hand', () => {
    const r = compile('forged', `
// @ts-expect-error only recordViewOf makes a RecordView
export const forged: RecordView = { title: 't', type: 't', description: '', tags: [], properties: {} };
const meta = {};
// @ts-expect-error the same fields, written out, are not a RecordView
export const e = validateEntity(meta, { title: 't', type: 't', description: '', tags: [], properties: {} });
`);
    assert.equal(r.status, 0, `a RecordView can be written by hand:\n${r.out}`);
  });
});

describe('every caller of a validator passes a view', () => {
  const SERVER = 'server/src';
  const VALIDATOR_FILE = 'server/src/spaces/schema-validation.ts';

  /** The validators, read from the module that defines them: `validate<Kind>`, exported. */
  const validatorNames = () => [...stripComments(fs.readFileSync(path.join(REPO_ROOT, VALIDATOR_FILE), 'utf8'))
    .matchAll(/export function (validate(?:Entity|Edge|Fact|Chrono))\(/g)].map(m => m[1]);

  /** The identifiers a file binds to a view: `const v = recordViewOf(...)`, or any binding / parameter typed `RecordView`. */
  function viewBindings(sf) {
    const names = new Set();
    const visit = (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
        const init = n.initializer && unwrapExpression(n.initializer);
        if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'recordViewOf') names.add(n.name.text);
        if (n.type && /\bRecordView\b/.test(n.type.getText(sf))) names.add(n.name.text);
      }
      if (ts.isParameter(n) && ts.isIdentifier(n.name) && n.type && /\bRecordView\b/.test(n.type.getText(sf))) names.add(n.name.text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return names;
  }

  /** Every call of a validator outside its own module, with the verdict on its record argument. */
  function callers() {
    const names = new Set(validatorNames());
    const out = [];
    for (const file of trackedSources([SERVER], { exclude: [VALIDATOR_FILE] })) {
      const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      if (![...names].some(n => text.includes(`${n}(`))) continue;
      const sf = parseSource(file, text);
      const bound = viewBindings(sf);
      const visit = (n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.has(n.expression.text)) {
          const arg = n.arguments[1] && unwrapExpression(n.arguments[1]);
          const direct = arg && ts.isCallExpression(arg) && ts.isIdentifier(arg.expression) && arg.expression.text === 'recordViewOf';
          const viaBinding = arg && ts.isIdentifier(arg) && bound.has(arg.text);
          out.push({ where: `${file}:${lineOf(sf, n)}`, validator: n.expression.text, ok: Boolean(direct || viaBinding), arg: arg?.getText(sf).slice(0, 80) });
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    return out;
  }

  it('the validators are found in their own module, and the callers are found in the server (a floor, so an empty scan is not a clean one)', () => {
    assert.deepEqual(validatorNames().sort(), ['validateChrono', 'validateEdge', 'validateEntity', 'validateFact'],
      'the validators this gate reads are not the four it was written for: re-anchor it');
    assert.ok(callers().length >= 8, `only ${callers().length} validator call(s) found in ${SERVER}: the scan is broken, not the code`);
  });

  it('no caller hands a validator a literal, a partial record or a variable it did not get from recordViewOf', () => {
    const wrong = callers().filter(c => !c.ok);
    assert.deepEqual(wrong.map(c => `${c.where} ${c.validator}(meta, ${c.arg})`), [],
      'these validator calls are handed something other than a RecordView: a rule that reads self.title or self.description would silently stop applying there');
  });

  it('recordViewOf and RecordView are defined once, in brain/record-view.ts, and nothing casts its way to one', () => {
    const defs = [];
    const casts = [];
    for (const file of trackedSources([SERVER])) {
      const text = stripComments(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      if (/\bexport (?:function|const) recordViewOf\b/.test(text)) defs.push(`${file}: recordViewOf`);
      if (/\bexport (?:type|interface) RecordView\b/.test(text)) defs.push(`${file}: RecordView`);
      if (file !== 'server/src/brain/record-view.ts' && /\bas (?:unknown as )?RecordView\b|<RecordView>/.test(text)) casts.push(file);
    }
    assert.deepEqual(defs.sort(), ['server/src/brain/record-view.ts: RecordView', 'server/src/brain/record-view.ts: recordViewOf'],
      'the view is not built by exactly one function in brain/record-view.ts');
    assert.deepEqual(casts, [], 'a cast to RecordView forges the type the validators rely on');
  });
});
