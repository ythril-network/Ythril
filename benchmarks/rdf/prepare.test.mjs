/**
 * The Ythril-loadable variant of a BSBM dataset (Q-759): what `prepare.mjs` changes, and that it changes nothing
 * else. Every case drives the transform over an N-Triples text and reads the OUTPUT, never the transform's own
 * bookkeeping, so a wrong decision shows in the lines that come out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareText, prepareFile, VARIANT } from './prepare.mjs';

const RDF_TYPE = '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>';
const SUB = '<http://www.w3.org/2000/01/rdf-schema#subClassOf>';
const cls = (n) => `<http://ex.test/c/${n}>`;
const subj = (n) => `<http://ex.test/s/${n}>`;
const type = (s, c) => `${subj(s)} ${RDF_TYPE} ${cls(c)} .`;
const sub = (a, b) => `${cls(a)} ${SUB} ${cls(b)} .`;
const SEE_ALSO = '<http://www.w3.org/2000/01/rdf-schema#seeAlso>';
/** The statement that keeps a subject's generator address as a plain string (what the Ythril run maps parameters by). */
const addr = (iri) => `${iri} ${SEE_ALSO} "${iri.slice(1, -1)}" .`;
const isAddr = (l) => l.includes(SEE_ALSO);
const runAll = (lines) => prepareText(`${lines.join('\n')}\n`).text.split('\n').slice(0, -1);
/** The rewritten statements only: the address block the variant ends with is judged by its own cases. */
const run = (lines) => runAll(lines).filter((l) => !isAddr(l));
const typesOf = (out, s) => out.filter((l) => l.startsWith(`${subj(s)} ${RDF_TYPE} `));

test('a subject with three rdf:type statements keeps only the most specific one, wherever it is stated', () => {
  // c3 < c2 < c1, stated middle-first so that "first" and "last" are both wrong answers.
  const out = run([sub(2, 1), sub(3, 2), type('a', 2), type('a', 3), type('a', 1)]);
  assert.deepEqual(typesOf(out, 'a'), [type('a', 3)]);
});

test('the superclass chain is followed transitively, not one step', () => {
  // c4 < c3 < c2: c2 is two steps above c4, so a one-step check keeps both.
  const out = run([sub(4, 3), sub(3, 2), type('a', 2), type('a', 4)]);
  assert.deepEqual(typesOf(out, 'a'), [type('a', 4)]);
});

test('the subClassOf statements may come after the type statements they decide', () => {
  const out = run([type('a', 1), type('a', 2), type('a', 3), sub(3, 2), sub(2, 1)]);
  assert.deepEqual(typesOf(out, 'a'), [type('a', 3)]);
});

test('a subject with one type keeps it, even a class that has subclasses', () => {
  const out = run([sub(2, 1), type('root', 1), type('leaf', 2)]);
  assert.deepEqual(typesOf(out, 'root'), [type('root', 1)]);
  assert.deepEqual(typesOf(out, 'leaf'), [type('leaf', 2)]);
});

test('two types neither of which is above the other: the one the data places in its hierarchy stays', () => {
  // The BSBM shape: bsbm:Product (outside the hierarchy) and ProductTypeN (inside it).
  const out = run([sub(9, 8), type('a', 'Product'), type('a', 9)]);
  assert.deepEqual(typesOf(out, 'a'), [type('a', 9)]);
  const flipped = run([sub(9, 8), type('b', 9), type('b', 'Product')]);
  assert.deepEqual(typesOf(flipped, 'b'), [type('b', 9)]);
});

test('two unrelated types and no hierarchy: exactly one stays, the first stated', () => {
  const out = run([type('a', 'X'), type('a', 'Y')]);
  assert.deepEqual(typesOf(out, 'a'), [type('a', 'X')]);
});

test('every subject is decided on its own types', () => {
  // Two separate hierarchies, so each subject's answer is a different class.
  const out = run([sub(2, 1), sub(4, 3), type('a', 1), type('b', 3), type('a', 2), type('b', 'Z'), type('b', 4)]);
  assert.deepEqual(typesOf(out, 'a'), [type('a', 2)]);
  assert.deepEqual(typesOf(out, 'b'), [type('b', 4)]);
});

test('the rdfs:subClassOf statements themselves are all kept, as they are', () => {
  const lines = [sub(3, 2), sub(2, 1), type('a', 1), type('a', 3)];
  const out = run(lines);
  assert.deepEqual(out.filter((l) => l.includes(SUB)), [sub(3, 2), sub(2, 1)]);
});

test('a language-tagged literal becomes the plain string with the same lexical form', () => {
  const p = '<http://ex.test/p>';
  // The fourth literal ends in an escaped backslash, so the quote after it is the real closing one.
  const out = run([`${subj(1)} ${p} "caramels crawlers"@en .`, `${subj(2)} ${p} "x"@en-US .`, `${subj(3)} ${p} "a \\"quoted\\" word"@de .`, `${subj(4)} ${p} "back\\\\"@en .`]);
  assert.deepEqual(out, [`${subj(1)} ${p} "caramels crawlers" .`, `${subj(2)} ${p} "x" .`, `${subj(3)} ${p} "a \\"quoted\\" word" .`, `${subj(4)} ${p} "back\\\\" .`]);
});

test('what only looks like a language tag is left alone: typed literals, plain text, an escaped quote, an IRI', () => {
  const p = '<http://ex.test/p>';
  const keep = [
    `${subj(1)} ${p} "5"^^<http://www.w3.org/2001/XMLSchema#integer> .`,
    `${subj(2)} ${p} "mail a@en now" .`,
    `${subj(3)} ${p} "ends with an escaped quote \\"@en" .`,
    `${subj(4)} ${p} <http://ex.test/x@en> .`,
    `${subj(5)} ${p} "a quote then a tag \\"@en . and the text goes on" .`,
    '# a remark that ends like a tagged statement "x"@en .',
    '   # the same, indented "x"@de .',
    'not a statement, but it has "x"@en . in the middle and goes on',
  ];
  assert.deepEqual(run(keep), keep);
});

test('every other line passes through byte for byte: comments, blanks, CRLF, bytes that are not UTF-8, no final newline', () => {
  const bytes = Buffer.concat([
    Buffer.from('# a comment line\r\n\r\n', 'latin1'),
    Buffer.from(`${subj(1)} <http://ex.test/p> "caf`, 'latin1'), Buffer.from([0xc3, 0xa9, 0xff, 0xfe]), Buffer.from('" .\r\n', 'latin1'),
    Buffer.from(`${subj(2)} <http://ex.test/p> "  padded  " .   `, 'latin1'),
  ]);
  const out = Buffer.from(prepareText(bytes.toString('latin1')).text, 'latin1');
  // Only the address block is added, on a line of its own after the unterminated last line.
  const expected = Buffer.concat([bytes, Buffer.from(`\n${addr(subj(1))}\n${addr(subj(2))}\n`, 'latin1')]);
  assert.ok(out.equals(expected), 'the output bytes differ from the input bytes plus the address block');
});

test('every subject that is an address keeps it: one rdfs:seeAlso statement with the address as a plain string, after all other statements', () => {
  const p = '<http://ex.test/p>';
  const out = runAll([
    `${subj(1)} ${p} "one" .`, `${subj(2)} ${p} ${subj(1)} .`, `${subj(1)} ${p} "again" .`,
    `_:b0 ${p} "blank" .`, `${subj(3)} ${p} <http://ex.test/only-an-object> .`,
  ]);
  assert.deepEqual(out.filter(isAddr), [addr(subj(1)), addr(subj(2)), addr(subj(3))], 'one per subject, in the order they first appear, none for a blank node or an object');
  assert.deepEqual(out.slice(0, 5).filter(isAddr), [], 'the block follows every other statement');
  assert.equal(out.length, 5 + 3);
  assert.ok(out.filter(isAddr).every((l) => l.endsWith('" .')), 'the object is a literal: an address object would be read as the record itself');
});

test('the address string is the subject\'s address, escaped as N-Triples, so a quote or backslash cannot end the string early', () => {
  const odd = '<http://ex.test/a"b\\c>';
  const out = runAll([`${odd} <http://ex.test/p> "x" .`]);
  assert.deepEqual(out.filter(isAddr), [`${odd} ${SEE_ALSO} "http://ex.test/a\\"b\\\\c" .`]);
});

test('a text with no subject that is an address gains nothing, and one ending in a newline gains no blank line', () => {
  assert.equal(prepareText('').text, '');
  assert.equal(prepareText('_:a <http://ex.test/p> "x" .\n').text, '_:a <http://ex.test/p> "x" .\n');
  const text = prepareText(`${subj(1)} <http://ex.test/p> "x" .\n`).text;
  assert.equal(text, `${subj(1)} <http://ex.test/p> "x" .\n${addr(subj(1))}\n`);
});

test('the variant is named for its rules: the second adds the address statements', () => {
  assert.equal(VARIANT, 'ythril-loadable-2');
  assert.equal(prepareText(`${subj(1)} <http://ex.test/p> "x" .\n`).stats.addressStatements, 1);
});

test('the output is stable: two runs over one file give the same bytes, the same sha256 and the same counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b271-prepare-'));
  try {
    const src = join(dir, 'in.nt');
    writeFileSync(src, `${[sub(2, 1), type('a', 1), type('a', 2), `${subj('a')} <http://ex.test/p> "t"@en .`, type('b', 1)].join('\n')}\n`);
    const one = prepareFile(src, join(dir, 'one.nt'));
    const two = prepareFile(src, join(dir, 'two.nt'));
    assert.equal(one.sha256, two.sha256);
    assert.equal(readFileSync(join(dir, 'one.nt')).toString('latin1'), readFileSync(join(dir, 'two.nt')).toString('latin1'));
    assert.equal(one.sha256, createHash('sha256').update(readFileSync(join(dir, 'one.nt'))).digest('hex'), 'the reported sha256 is not the file\'s');
    assert.equal(one.bytes, readFileSync(join(dir, 'one.nt')).length);
    assert.deepEqual(readFileSync(join(dir, 'one.nt'), 'latin1').split('\n').slice(0, -1), [
      sub(2, 1), type('a', 2), `${subj('a')} <http://ex.test/p> "t" .`, type('b', 1), addr(cls(2)), addr(subj('a')), addr(subj('b')),
    ]);
    // 5 statements in, 4 rewritten and 3 addresses out: one type dropped, one literal re-tagged, one subject decided.
    assert.deepEqual([one.inputTriples, one.triples, one.droppedTypeStatements, one.retaggedLiterals, one.multiTypedSubjects, one.addressStatements], [5, 7, 1, 1, 1, 3]);
    assert.equal(one.variant, VARIANT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the file reader and the text transform agree on a file read in small chunks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b271-prepare-'));
  try {
    const lines = [sub(2, 1), type('é', 1), type('é', 2), `${subj(7)} <http://ex.test/p> "té"@en .`];
    const text = `${lines.join('\n')}\n`;
    const src = join(dir, 'in.nt');
    writeFileSync(src, Buffer.from(text, 'latin1'));
    prepareFile(src, join(dir, 'out.nt'), { chunkBytes: 7 });
    assert.equal(readFileSync(join(dir, 'out.nt')).toString('latin1'), prepareText(text).text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file with nothing to change comes out identical but for the address block, bytes that are not UTF-8 included', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b271-prepare-'));
  try {
    const bytes = Buffer.concat([Buffer.from(`${type('a', 1)}\r\n${subj(1)} <http://ex.test/p> "caf`, 'latin1'), Buffer.from([0xe9, 0xff]), Buffer.from('" .\n# last', 'latin1')]);
    writeFileSync(join(dir, 'in.nt'), bytes);
    const r = prepareFile(join(dir, 'in.nt'), join(dir, 'out.nt'), { chunkBytes: 11 });
    const expected = Buffer.concat([bytes, Buffer.from(`\n${addr(subj('a'))}\n${addr(subj(1))}\n`, 'latin1')]);
    assert.ok(readFileSync(join(dir, 'out.nt')).equals(expected), 'the output bytes differ from the input bytes plus the address block');
    assert.equal(r.sha256, createHash('sha256').update(expected).digest('hex'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the result holds the two rules over the whole output: one type per subject, no language tag', () => {
  const p = '<http://ex.test/p>';
  const lines = [sub(2, 1), sub(3, 2), sub(5, 4)];
  for (let i = 0; i < 40; i++) lines.push(type(i, 1), type(i, i % 2 ? 3 : 5), type(i, 'Product'), `${subj(i)} ${p} "w${i}"@en .`);
  const out = run(lines);
  const seen = new Map();
  for (const l of out) {
    const m = /^(<[^>]*>) <http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#type> /.exec(l);
    if (m) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
    assert.ok(!/"@[A-Za-z-]+ \.$/.test(l), `a language tag is left in: ${l}`);
  }
  assert.equal(seen.size, 40);
  assert.deepEqual([...new Set(seen.values())], [1]);
});
