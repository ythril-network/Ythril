/**
 * An RDF file of any order reads back from the import's sorted spool as the same groups: all quads of one subject in one graph, a record's
 * parts with their record (bundle-270 S5, Q-753 line 3).
 *
 * ## The rule
 *
 * A record's quads may be anywhere in a foreign file, and the export itself writes the asserted edge apart from its reifier, so the translator
 * can only see a record whole after a sort on disk. The sort must give the same groups whatever order the file was in, in an order every
 * machine agrees on (addresses compared by UTF-16 code unit, never by locale), keep the quads of one subject in the order they arrived (a
 * stable sort), keep a blank node of one graph apart from the same label in another, deliver a chrono's `#start` and `#end` nodes with the
 * chrono (the reverse addressing says which addresses are parts), carry any literal through its line format unchanged, and keep what it
 * spools unreadable on disk when a master secret is configured, as the admin import's spool is.
 *
 * The run size is cut to a few kilobytes so every case sorts through many runs and more than one merge level.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  spoolModule, tempFolder, cleanupFolders, namesIn, bytesIn, namesAt,
  iri, blank, lit, q, streamOf, groupsOf,
} from './_rdf-import-spool-doors.mjs';

after(cleanupFolders);

const BASE = 'https://data.example.org/ld/s5/';
const P = (local) => iri(`https://vocab.example.org/${local}`);
const G2 = iri('https://graphs.example.org/second');
const SMALL_RUNS = { runBytes: 4096 };

/** A deterministic shuffle (a linear congruential generator), so a failure is the same on every run. */
function shuffled(items, seed = 7) {
  const out = items.slice();
  let s = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 400 subjects of five quads each, in the space's graph and a second, IRIs and blank nodes, and three chronos with their time nodes. */
function fixture() {
  const quads = [];
  for (let i = 0; i < 400; i += 1) {
    const graph = i % 3 === 0 ? G2 : undefined;
    const subject = i % 5 === 0 ? blank(`in-b${i % 40}`) : iri(`${BASE}entity/e${String(i).padStart(4, '0')}`);
    for (let k = 0; k < 5; k += 1) quads.push(q(subject, P(`p${k}`), lit(`value ${i}.${k}`), graph));
  }
  for (const c of ['c1', 'c2', 'c3']) {
    const record = `${BASE}chrono/${c}`;
    quads.push(q(iri(record), P('a'), iri('http://www.w3.org/2006/time#Interval')));
    quads.push(q(iri(record), P('hasBeginning'), iri(`${record}#start`)));
    quads.push(q(iri(`${record}#start`), P('inXSDDateTime'), lit('2026-01-01T00:00:00', { datatype: 'http://www.w3.org/2001/XMLSchema#dateTime' })));
    quads.push(q(iri(`${record}#end`), P('inXSDDateTime'), lit('2026-02-01T00:00:00', { datatype: 'http://www.w3.org/2001/XMLSchema#dateTime' })));
  }
  return quads;
}

const quadText = (quad) => JSON.stringify([quad.graph?.value ?? null, quad.subject, quad.predicate, quad.object]);
const groupKeyOf = (g) => [g.graph?.value ?? '', g.subject.kind === 'iri' ? `i${g.subject.value}` : `b${g.subject.id}`];

async function spoolOf(quads, label, bounds = SMALL_RUNS) {
  const { sortedSpool, openImportFolder } = await spoolModule();
  assert.equal(typeof sortedSpool, 'function', 'import-spool.ts exports no sortedSpool');
  const folder = await openImportFolder(tempFolder(label));
  const spool = await sortedSpool(streamOf(quads), folder, { names: await namesAt(BASE), bounds });
  return { spool, folder, groups: await groupsOf(spool) };
}

describe('a scattered file groups as a contiguous one', { timeout: 60_000 }, () => {
  it('the same quads in a shuffled and in a subject-contiguous order give the same groups, each subject once, every quad once', async () => {
    const quads = fixture();
    const contiguous = await spoolOf(quads, 'contiguous');
    const scattered = await spoolOf(shuffled(quads), 'scattered');
    const view = (groups) => groups.map(g => ({ key: g.key, quads: g.quads.map(quadText).sort() }));
    assert.deepEqual(view(scattered.groups), view(contiguous.groups), 'the shuffled file grouped differently from the contiguous one');
    assert.equal(scattered.groups.flatMap(g => g.quads).length, quads.length, 'a quad was lost or doubled');
    assert.deepEqual(scattered.groups.flatMap(g => g.quads.map(quadText)).sort(), quads.map(quadText).sort(), 'the quads that came back are not the quads that went in');
    assert.equal(new Set(scattered.groups.map(g => g.key)).size, scattered.groups.length, 'a subject came back in two groups');
    assert.equal(scattered.spool.quads, quads.length, 'the spool counts every quad');
    assert.equal(scattered.spool.subjects, scattered.groups.length, 'the spool counts its distinct subjects as the groups it yields');
    assert.equal(scattered.spool.largestSubjectQuads, Math.max(...scattered.groups.map(g => g.quads.length)));
    for (const g of scattered.groups) {
      for (const quad of g.quads) assert.equal(quad.graph?.value, g.graph?.value, `a quad of graph ${quad.graph?.value} came in the group of graph ${g.graph?.value}`);
    }
  });

  it('a chrono\'s #start and #end nodes come with the chrono, wherever they stood, and the group is the record\'s', async () => {
    const quads = shuffled(fixture(), 11);
    const { groups } = await spoolOf(quads, 'parts');
    for (const c of ['c1', 'c2', 'c3']) {
      const record = `${BASE}chrono/${c}`;
      const own = groups.filter(g => g.quads.some(x => x.subject.value?.startsWith(record)));
      assert.equal(own.length, 1, `the quads of ${c} and its time nodes came in ${own.length} groups`);
      assert.deepEqual(own[0].subject, iri(record), 'the group is the record\'s, not its time node\'s');
      assert.deepEqual(own[0].quads.map(x => x.subject.value).sort(), [record, record, `${record}#end`, `${record}#start`]);
    }
    assert.ok(!groups.some(g => g.subject.value?.includes('#')), 'a time node was a group of its own');
  });

  it('a blank node is keyed with its graph: one label in two graphs is two subjects, and in one graph one', async () => {
    const quads = [
      q(blank('in-x'), P('a'), lit('default 1')),
      q(blank('in-x'), P('a'), lit('second 1'), G2),
      q(iri(`${BASE}entity/zz`), P('a'), lit('between')),
      q(blank('in-x'), P('b'), lit('default 2')),
      q(blank('in-x'), P('b'), lit('second 2'), G2),
    ];
    const { groups } = await spoolOf(quads, 'blank');
    const of = groups.filter(g => g.subject.kind === 'blank');
    assert.equal(of.length, 2, 'the label in two graphs is not two subjects');
    assert.deepEqual(of.map(g => g.quads.map(x => x.object.value)).sort(), [['default 1', 'default 2'], ['second 1', 'second 2']]);
    assert.notEqual(of[0].key, of[1].key, 'the two subjects share one key');
  });

  it('groups come in graph-then-subject order by code unit, never by locale, and two runs agree byte for byte', async () => {
    // By code unit: 'B' (0x42) < 'a' (0x61) < 'é' (0xE9) < a surrogate pair (0xD83D...) < U+FF5E < U+FFFD. By code point the emoji is last;
    // by locale 'a' < 'B' < 'é'. Only the code-unit order is the same on every machine.
    const locals = ['�', 'é', 'a', '😀', 'B', '～'];
    const quads = shuffled(locals.flatMap(l => [q(iri(`${BASE}entity/${l}`), P('x'), lit(l)), q(iri(`${BASE}entity/${l}`), P('x'), lit(l), G2)]), 3);
    const first = await spoolOf(quads, 'order1');
    const second = await spoolOf(quads, 'order2');
    const keys = first.groups.map(groupKeyOf);
    for (let i = 1; i < keys.length; i += 1) {
      const [g0, s0] = keys[i - 1];
      const [g1, s1] = keys[i];
      assert.ok(g0 < g1 || (g0 === g1 && s0 < s1), `group ${i} (${JSON.stringify(keys[i])}) does not follow ${JSON.stringify(keys[i - 1])} by code unit`);
    }
    assert.deepEqual(first.groups.filter(g => !g.graph).map(g => g.subject.value.slice(`${BASE}entity/`.length)), ['B', 'a', 'é', '😀', '～', '�']);
    assert.deepEqual(second.groups, first.groups, 'two runs over the same file gave different groups');
  });

  it('the quads of one subject come back in the order they arrived, across every run and merge', async () => {
    const quads = [];
    for (let k = 0; k < 120; k += 1) {
      quads.push(q(iri(`${BASE}entity/stable`), P('order'), lit(`#${k}`)));
      for (let n = 0; n < 6; n += 1) quads.push(q(iri(`${BASE}entity/noise${(k * 7 + n) % 50}`), P('n'), lit(`noise ${k} ${n} ${'x'.repeat(40)}`)));
    }
    const { groups } = await spoolOf(quads, 'stable');
    const stable = groups.find(g => g.subject.value === `${BASE}entity/stable`);
    assert.deepEqual(stable.quads.map(x => x.object.value), Array.from({ length: 120 }, (_, k) => `#${k}`), 'the sort is not stable for equal keys');
  });

  it('a literal that holds a newline, a tab, a quote, a backslash, a NUL, a line separator or a lone surrogate comes back as it went in', async () => {
    const hard = ['two\nlines', 'a\ttab', 'a "quote"', 'back\\slash', 'nul\u0000here', `line${String.fromCharCode(0x2028)}sep`, 'lone \uD800 surrogate', '\r\n', '\t', ''];
    const quads = hard.map((value, i) => q(iri(`${BASE}entity/hard${i}\tx`), P(`p\n${i}`), lit(value, i % 2 ? { language: 'en' } : { datatype: 'https://dt.example.org/t\u0000' })));
    quads.push(q(iri(`${BASE}edge/r1`), P('reifies'), { kind: 'triple', subject: blank('in-a'), predicate: P('knows'), object: lit('x\ny') }));
    const { groups } = await spoolOf(quads, 'literals');
    const back = groups.flatMap(g => g.quads).map(quadText).sort();
    assert.deepEqual(back, quads.map(quadText).sort(), 'a literal, an address or a triple term did not survive the spool');
  });

  it('with a master secret configured, nothing a quad says is on disk in plain, and it reads back whole', async () => {
    const key = 'b'.repeat(64);
    const before = process.env.YTHRIL_MASTER_KEY;
    process.env.YTHRIL_MASTER_KEY = key;
    try {
      const secret = 'a-value-nobody-may-read-on-disk';
      const quads = fixture().concat([q(iri(`${BASE}entity/secret`), P('s'), lit(secret))]);
      const { folder, groups } = await spoolOf(quads, 'secret');
      assert.ok(namesIn(folder.dir).length > 0, 'the spool left nothing on disk to look at');
      assert.ok(!bytesIn(folder.dir).includes(Buffer.from(secret)), 'a literal is on disk in plain under a master secret');
      assert.ok(!bytesIn(folder.dir).includes(Buffer.from(`${BASE}entity/`)), 'an address is on disk in plain under a master secret');
      assert.ok(groups.some(g => g.quads.some(x => x.object.value === secret)), 'the encrypted spool did not read back');
    } finally {
      if (before === undefined) delete process.env.YTHRIL_MASTER_KEY; else process.env.YTHRIL_MASTER_KEY = before;
    }
  });
});
