/**
 * Every `ythril:` term an export writes is declared in the one vocabulary table, and the published vocabulary is generated from it
 * (Q-749, design r4 §5.1, §8; owner, 2026-11-18, the vocabulary address and the property rule).
 *
 * ## The defect this prevents
 *
 * - A mapper that spells `ythril:` IRIs by hand writes a term nobody declared, and a consumer who follows the address finds nothing.
 * - The namespace written twice (once as a literal in the mapper) cannot move without a hunt: `YTHRIL_NS` is the one spelling, and this
 *   test checks that it is USED, never its value.
 * - A vocabulary page written by hand drifts from the table, and the property rule on it from the rule the record states: the page and the
 *   Turtle file are GENERATED from `ythril-vocabulary.ts` (`vocabularyTurtle()`, `vocabularyPage()` in `server/src/rdf/vocabulary-docs.ts`),
 *   and this test fails when a file and its source differ. After a change to the table, regenerate both files from those two functions.
 *
 * ## What it holds
 *
 * - every `ythril:` IRI the mapper emits for a fixture of every record kind starts with `YTHRIL_NS`, names a declared term, and is a class
 *   where a class is used (`rdf:type` objects) and a property where a property is used;
 * - `ythrilIri(name)` refuses an undeclared name; the table's names are unique, safe as local names and each has a comment;
 * - the terms the schema export will write (design r4 §6) are declared too, so the one published page covers the bundle;
 * - no module under `server/src/rdf/` but the vocabulary names the address as a literal;
 * - `docs/rdf/ythril.ttl` and `docs/rdf/ythril-vocabulary.md` equal what the generators answer; the Turtle is read by `n3` and declares
 *   every term; the page OPENS with the property rule text of `ythril-vocabulary.ts` and links decision record 23.
 *
 * Run: node --test testing/standalone/every-ythril-term-is-declared-in-the-vocabulary.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Parser } from 'n3';
import { readTrackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const vocab = await import('../../server/dist/rdf/ythril-vocabulary.js').catch(() => ({}));
const mapper = await import('../../server/dist/rdf/record-triples.js').catch(() => ({}));
const docs = await import('../../server/dist/rdf/vocabulary-docs.js').catch(() => ({}));

const repoFile = (rel) => new URL(`../../${rel}`, import.meta.url);
/** A tracked text file as the generators write it: a Windows checkout may hold it with CRLF line ends. */
const readText = (rel) => readFileSync(repoFile(rel), 'utf8').replace(/\r\n/g, '\n');
const NS = vocab.YTHRIL_NS;
const need = (mod, where, name) => {
  assert.equal(typeof mod[name], 'function', `${name} is not exported by ${where}`);
  return mod[name];
};
const declared = () => {
  assert.ok(Array.isArray(vocab.YTHRIL_TERMS) && vocab.YTHRIL_TERMS.length > 0, 'YTHRIL_TERMS is the exported term table');
  return new Map(vocab.YTHRIL_TERMS.map((t) => [t.name, t]));
};

const BASE = 'https://ythril.example.org/ld/space-1/';
const META = { rdf: { enabled: true, base: BASE, vocab: `${BASE}vocab/`, baseEpoch: 0 }, typeSchemas: { entity: { person: {} }, chrono: { event: {} }, edge: { knows: {} } } };
const SHARED = { author: { instanceId: 'i', instanceLabel: 'L' }, createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-01T10:00:00Z', superseded: true, schemaFingerprint: 'fp' };
const FIXTURE = [
  ['entity', { _id: 'e', name: 'n', type: 'person', tags: ['t'], description: 'd', properties: { a: 1 }, ...SHARED }],
  ['entity', { _id: 'u', name: 'n', tags: [], ...SHARED }],
  ['fact', { _id: 'f', fact: 't', type: 'note', tags: [], ...SHARED }],
  ['chrono', { _id: 'c', title: 't', type: 'event', startsAt: '2026-01-01T00:00:00Z', endsAt: '2026-01-02T00:00:00Z', status: 'upcoming', confidence: 0.5, tags: [], recurrence: { freq: 'daily', interval: 1, until: '2027-01-01' }, contentRedacted: true, ...SHARED }],
  ['edge', { _id: 'k', from: 'e', to: 'u', label: 'knows', type: 'x', weight: 1, tags: [], ...SHARED }],
  ['link', { _id: 'l', from: 'f', fromKind: 'fact', to: 'e', toKind: 'entity', ...SHARED }],
  ['file', { _id: 'p', path: 'p', tags: [], sizeBytes: 3, sha256: 'ab', createdAt: SHARED.createdAt, updatedAt: SHARED.updatedAt }],
];

describe('every ythril: IRI an export writes is a declared term', () => {
  for (const edgeDetails of ['rdf12', 'reification']) {
    it(`over every record kind (${edgeDetails}): under YTHRIL_NS, declared, a class as a type and a property as a predicate`, () => {
      const terms = declared();
      const record = need(mapper, 'server/src/rdf/record-triples.ts', 'recordTriples');
      let seen = 0;
      const check = (term, as) => {
        if (term.kind === 'triple') { check(term.subject, 'subject'); check(term.predicate, 'predicate'); check(term.object, 'object'); return; }
        if (term.kind !== 'iri' || !term.value.startsWith(NS)) return;
        const def = terms.get(term.value.slice(NS.length));
        assert.ok(def, `${term.value} is written by the mapper but declared in no row of YTHRIL_TERMS`);
        if (as === 'type') assert.equal(def.kind, 'class', `${term.value} is used as a class`);
        if (as === 'predicate') assert.equal(def.kind, 'property', `${term.value} is used as a property`);
        seen++;
      };
      for (const [kind, doc] of FIXTURE) {
        for (const q of record(META, kind, doc, { edgeDetails }).quads) {
          check(q.predicate, 'predicate');
          check(q.object, q.predicate.value.endsWith('#type') ? 'type' : 'object');
        }
      }
      assert.ok(seen >= 12, `the fixture should reach the ythril: terms (saw ${seen})`);
    });
  }
});

describe('the term table', () => {
  it('names are unique, safe local names, each with a class-or-property kind and a comment', () => {
    declared();
    const names = vocab.YTHRIL_TERMS.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, 'a term is declared twice');
    for (const t of vocab.YTHRIL_TERMS) {
      assert.match(t.name, /^[A-Za-z][A-Za-z0-9]*$/, `${t.name} is a safe local name`);
      assert.ok(t.kind === 'class' || t.kind === 'property', `${t.name} has a kind`);
      assert.ok(typeof t.comment === 'string' && t.comment.trim().length > 0, `${t.name} has a comment`);
    }
  });
  it('ythrilIri names a declared term under YTHRIL_NS and refuses a name nobody declared', () => {
    const ythrilIri = need(vocab, 'server/src/rdf/ythril-vocabulary.ts', 'ythrilIri');
    assert.equal(ythrilIri('Entity'), `${NS}Entity`);
    assert.throws(() => ythrilIri('notDeclaredAnywhere'), /not declared/i);
  });
  it('the terms the schema export writes (design r4 §6) are declared, so the one published page covers the bundle', () => {
    const terms = declared();
    for (const name of ['mergeFn', 'namingPattern', 'endpointFrom', 'endpointTo', 'retentionDays', 'retentionContentDays', 'suppressEmbeddings', 'whenDuePasses',
      'rule', 'ruleName', 'ruleExpression', 'ruleMessage', 'ruleKinds', 'unresolvedRef', 'requiredEdgeProperty', 'validationMode', 'strictLinkage']) {
      assert.ok(terms.has(name), `ythril:${name} is named by design r4 §6 and is not declared`);
    }
  });
});

describe('the address has one spelling', () => {
  it('no module under server/src/rdf/ but the vocabulary writes the ythril namespace as a literal (the constant is used, never its value)', () => {
    const files = readTrackedSources(['server/src/rdf'], { untracked: true, floor: 2 }).filter((f) => f.file !== 'server/src/rdf/ythril-vocabulary.ts');
    assert.ok(files.length >= 1, 'the scan reaches the rdf modules beside the vocabulary');
    const hits = [];
    for (const f of files) blankComments(f.text).split('\n').forEach((line, i) => { if (/w3id\.org\/ythril/.test(line)) hits.push(`${f.file}:${i + 1}`); });
    assert.deepEqual(hits, [], 'only ythril-vocabulary.ts spells the address');
  });
});

describe('the published vocabulary is generated from the table', () => {
  const turtle = () => need(docs, 'server/src/rdf/vocabulary-docs.ts', 'vocabularyTurtle')();
  const page = () => need(docs, 'server/src/rdf/vocabulary-docs.ts', 'vocabularyPage')();

  it('docs/rdf/ythril.ttl is what vocabularyTurtle() answers', () => {
    assert.ok(existsSync(repoFile('docs/rdf/ythril.ttl')), 'docs/rdf/ythril.ttl exists');
    assert.equal(readText('docs/rdf/ythril.ttl'), turtle(),'docs/rdf/ythril.ttl differs from the table: regenerate it from vocabularyTurtle()');
  });
  it('docs/rdf/ythril-vocabulary.md is what vocabularyPage() answers', () => {
    assert.ok(existsSync(repoFile('docs/rdf/ythril-vocabulary.md')), 'docs/rdf/ythril-vocabulary.md exists');
    assert.equal(readText('docs/rdf/ythril-vocabulary.md'), page(),'docs/rdf/ythril-vocabulary.md differs from the table: regenerate it from vocabularyPage()');
  });
  it('the Turtle is read by n3 and declares every term as a class or property with its label and comment, defined by the namespace', () => {
    const quads = new Parser({ format: 'Turtle' }).parse(turtle());
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    for (const t of declared().values()) {
      const s = `${NS}${t.name}`;
      const about = quads.filter((q) => q.subject.value === s);
      const kind = t.kind === 'class' ? 'http://www.w3.org/2000/01/rdf-schema#Class' : 'http://www.w3.org/1999/02/22-rdf-syntax-ns#Property';
      assert.ok(about.some((q) => q.predicate.value === RDF_TYPE && q.object.value === kind), `${s} is declared a ${t.kind}`);
      assert.ok(about.some((q) => q.predicate.value === 'http://www.w3.org/2000/01/rdf-schema#label' && q.object.value === t.name), `${s} has its label`);
      assert.ok(about.some((q) => q.predicate.value === 'http://www.w3.org/2000/01/rdf-schema#comment' && q.object.value === t.comment), `${s} has its comment`);
      assert.ok(about.some((q) => q.predicate.value === 'http://www.w3.org/2000/01/rdf-schema#isDefinedBy'), `${s} is defined by the namespace`);
    }
  });
  it('the page OPENS with the property rule of ythril-vocabulary.ts, links decision record 23 and lists every term', () => {
    assert.equal(typeof vocab.PROPERTY_RULE_TEXT, 'string');
    const lines = page().split('\n');
    assert.match(lines[0], /^# /, 'the page starts with its title');
    const firstParagraph = lines.slice(1).join('\n').trim().split(/\n\s*\n/)[0];
    assert.equal(firstParagraph, vocab.PROPERTY_RULE_TEXT, 'the first paragraph under the title is the property rule, verbatim');
    const link = /\]\((\.\.\/decisions\/23-[^)]+\.md)\)/.exec(page());
    assert.ok(link, 'the page links decision record 23');
    assert.ok(existsSync(new URL(link[1], repoFile('docs/rdf/ythril-vocabulary.md'))), `the linked record exists (${link[1]})`);
    for (const t of declared().values()) assert.ok(page().includes(`\`ythril:${t.name}\``), `the page lists ythril:${t.name}`);
  });
  it('the page states the address by the constant and says where it redirects', () => {
    assert.ok(page().includes(NS), 'the page states the namespace address');
    assert.match(page(), /redirect/i, 'the page says the address redirects');
  });
});
