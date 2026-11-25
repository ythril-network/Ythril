/**
 * Every type, property, record and schema address of a space comes from ONE resolver, `server/src/rdf/term-iri.ts` (Q-748, slice A).
 *
 * ## The defect this prevents
 *
 * The later slices (the record's RDF form, the schema as OWL and SHACL, the export doors) all need names. If each built its own
 * (`base + 'entity/' + id`), the first id holding a space, a `/` or a `>` would break one door and not another, and two doors would
 * give one record two addresses. So the resolver is the only builder, and a source gate below refuses a second one:
 *
 * - `resolveTermIri(meta, kind, type, prop?)`: an explicit `iri` on the type or property wins; else `<vocab><kind>/<seg(type)>`, and
 *   `#<frag(prop)>` for a property (the Direct Mapping's shape, slice S). An untyped entity is the class `ythril:Untyped` and its
 *   properties are `<vocab>entity#<frag(prop)>`; a file has no type, so its properties are `<vocab>file#<frag(prop)>`.
 * - `recordIri(meta, kind, id)`: `<base><kind>/<seg(id)>`; a file's path is encoded segment by segment and joined by `/`.
 * - `agentIri`, `graphIri`, `ontologyIri`, `versionIri(fp)`.
 * - RDF is off by default: every function throws `rdf_not_enabled` for a meta with no `rdf`, or with `rdf.enabled: false`.
 *
 * ## The source gate
 *
 * No module but the resolver imports `iriSegment`, writes the `/ld/` path of a base, concatenates onto `YTHRIL_NS` or onto a space's
 * `rdf.base` / `rdf.vocab`, and no module under `server/src/rdf/` carries a second encoder (`encodeURIComponent`). Proven on a planted
 * module first, so an empty scan cannot pass.
 *
 * The `/ld/` rule is literal: any line with a quote and then `/ld/` is a site (an address is built by joining it to a value, and a rule that
 * looked for the join missed `const LD = '/ld/'; pub + LD + id` and `pub.concat('/ld/', id)`). Three things are no address and are exempt
 * (bundle-271, Q-758): a route pattern (a string starting `'/ld/:`, as `'GET /ld/:spaceId/...'` does), a prefix test (`startsWith('/ld/')`),
 * and a line named in `a-term-iri-is-one-rule-for-every-type-and-property.allow.json` with its reason and a review date (the sentence a
 * refusal answers, which names the path).
 *
 * Run: node --test testing/standalone/a-term-iri-is-one-rule-for-every-type-and-property.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readTrackedSources, SERVER_CODE_ROOTS } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { allowProblem } from '../../tools/flow-checks/_allow.mjs';

const termIri = await import('../../server/dist/rdf/term-iri.js').catch(() => ({}));
const vocabulary = await import('../../server/dist/rdf/ythril-vocabulary.js').catch(() => ({}));
const fn = (name) => {
  assert.equal(typeof termIri[name], 'function', `${name} is not exported by server/src/rdf/term-iri.ts: the one resolver has no home`);
  return termIri[name];
};

const BASE = 'https://ythril.example.org/ld/space-1/';
const VOCAB = `${BASE}vocab/`;
const META = {
  rdf: { enabled: true, base: BASE, vocab: VOCAB, baseEpoch: 0 },
  typeSchemas: {
    entity: {
      person: { iri: 'http://schema.org/Person', propertySchemas: { email: { type: 'string', iri: 'http://schema.org/email' }, 'nick name': { type: 'string' } } },
      'odd/type': { propertySchemas: { 'a#b': { type: 'number' } } },
    },
    edge: { knows: { propertySchemas: { since: { type: 'date' } } } },
    fact: { note: {} },
    chrono: { event: {} },
  },
};

describe('the resolver: one rule for every type and property', () => {
  it('an explicit iri on a type and on a property wins', () => {
    assert.equal(fn('resolveTermIri')(META, 'entity', 'person'), 'http://schema.org/Person');
    assert.equal(fn('resolveTermIri')(META, 'entity', 'person', 'email'), 'http://schema.org/email');
  });
  it('without one, a type is the document <vocab><kind>/<type> and its property the fragment #<prop>, every name encoded', () => {
    assert.equal(fn('resolveTermIri')(META, 'entity', 'person', 'nick name'), `${VOCAB}entity/person#nick%20name`);
    assert.equal(fn('resolveTermIri')(META, 'entity', 'odd/type'), `${VOCAB}entity/odd%2Ftype`);
    assert.equal(fn('resolveTermIri')(META, 'entity', 'odd/type', 'a#b'), `${VOCAB}entity/odd%2Ftype#a%23b`);
    assert.equal(fn('resolveTermIri')(META, 'edge', 'knows'), `${VOCAB}edge/knows`);
    assert.equal(fn('resolveTermIri')(META, 'edge', 'knows', 'since'), `${VOCAB}edge/knows#since`);
    assert.equal(fn('resolveTermIri')(META, 'fact', 'note'), `${VOCAB}fact/note`);
    assert.equal(fn('resolveTermIri')(META, 'chrono', 'event'), `${VOCAB}chrono/event`);
  });
  it('a type the schema does not declare is still named by the vocab rule', () => {
    assert.equal(fn('resolveTermIri')(META, 'entity', 'robot'), `${VOCAB}entity/robot`);
  });
  it('an untyped entity is ythril:Untyped, its properties fragments of entity; a file property is file#<prop>', () => {
    assert.equal(typeof vocabulary.YTHRIL_NS, 'string', 'YTHRIL_NS is exported by server/src/rdf/ythril-vocabulary.ts');
    assert.equal(fn('resolveTermIri')(META, 'entity', null), `${vocabulary.YTHRIL_NS}Untyped`);
    assert.equal(fn('resolveTermIri')(META, 'entity', null, 'colour'), `${VOCAB}entity#colour`);
    assert.equal(fn('resolveTermIri')(META, 'file', null, 'camera model'), `${VOCAB}file#camera%20model`);
  });
  it('a record, a file, an agent, the graph, the ontology and a version each have one address', () => {
    assert.equal(fn('recordIri')(META, 'entity', 'x y>z'), `${BASE}entity/x%20y%3Ez`);
    assert.equal(fn('recordIri')(META, 'edge', 'e-1'), `${BASE}edge/e-1`);
    assert.equal(fn('recordIri')(META, 'file', 'docs/a b/c.pdf'), `${BASE}file/docs/a%20b/c.pdf`);
    assert.equal(fn('recordIri')(META, 'file', 'docs/../x'), `${BASE}file/docs/%2E%2E/x`);
    assert.equal(fn('agentIri')(META, 'inst "1"'), `${BASE}agent/inst%20%221%22`);
    assert.equal(fn('graphIri')(META), BASE);
    assert.equal(fn('ontologyIri')(META), `${BASE}schema`);
    assert.equal(fn('versionIri')(META, 'ab12'), `${BASE}schema/ab12`);
  });
  it('the prefixes a writer declares are the standard ones and the space vocab', () => {
    const prefixes = fn('prefixesFor')(META);
    assert.equal(prefixes.vocab, VOCAB);
    assert.equal(prefixes.ythril, vocabulary.YTHRIL_NS);
    for (const p of ['rdf', 'rdfs', 'xsd', 'owl', 'sh', 'schema', 'time', 'dcterms', 'prov']) assert.equal(typeof prefixes[p], 'string', p);
  });
});

describe('an explicit iri is part of the schema', () => {
  it('a type and a property take an iri, and changing one changes the schema fingerprint', async () => {
    const pkg = await import('../../schema/dist/index.js');
    const internal = await import('../../schema/dist/internal.js');
    const typed = pkg.parseTypeSchema('entity', 'person', { iri: 'http://schema.org/Person', propertySchemas: { email: { type: 'string', iri: 'http://schema.org/email' } } });
    assert.ok(typed.ok, `the type body refuses iri: ${JSON.stringify(typed.refusal ?? typed)}`);
    const bad = pkg.parseTypeSchema('entity', 'person', { iri: 'Person' });
    assert.ok(!bad.ok, 'a relative iri is refused');
    const fp = (iri) => internal.schemaFingerprintTextOf({ typeSchemas: { entity: { person: { iri } } } });
    assert.notEqual(fp('http://schema.org/Person'), fp('https://example.org/Person'), 'an iri change changes the fingerprint');
  });
});

describe('RDF is off by default, and nothing is named until it is switched on', () => {
  for (const [what, meta] of [['no rdf at all', { typeSchemas: META.typeSchemas }], ['rdf switched off', { ...META, rdf: { ...META.rdf, enabled: false } }]]) {
    it(`${what}: every function throws rdf_not_enabled`, () => {
      for (const call of [
        () => fn('resolveTermIri')(meta, 'entity', 'person'), () => fn('recordIri')(meta, 'entity', 'a'), () => fn('agentIri')(meta, 'i'),
        () => fn('graphIri')(meta), () => fn('ontologyIri')(meta), () => fn('versionIri')(meta, 'f'), () => fn('prefixesFor')(meta),
      ]) {
        assert.throws(call, (err) => err?.code === 'rdf_not_enabled', 'answers rdf_not_enabled');
      }
    });
  }
});

// ── The source gate: no module but the resolver builds an address ─────────────────────────────────────────────────────────────────

const RESOLVER = 'server/src/rdf/term-iri.ts';
const ENCODER = 'schema/src/iri.ts';
const VOCABULARY = 'server/src/rdf/ythril-vocabulary.ts';

/** The lines of the server that spell `/ld/` and are no address, each `{ file, contains, reason, reviewBy }`: the line of `file` holding `contains`. */
const ALLOWED = JSON.parse(readFileSync(new URL('./a-term-iri-is-one-rule-for-every-type-and-property.allow.json', import.meta.url), 'utf8')).entries;
/** A route pattern (`'/ld/:spaceId/...'`, `'GET /ld/:...'`) and a prefix test: what the `/ld/` rule leaves alone on a line. */
const NO_ADDRESS = /(['"`])(?:[A-Z]+ )?\/ld\/:[^'"`]*\1|\bstartsWith\(\s*(['"`])\/ld\/\2\s*\)/g;

/**
 * The places `text` (the source of `file`) builds an RDF address by hand. Comments are blanked (line numbers kept); a re-export is no use.
 * A line an entry of `allowed` names is excused, and `excused` collects the entries that excused one.
 */
function handBuiltIriSites(file, text, allowed = [], excused = new Set()) {
  if (file === RESOLVER || file === ENCODER) return [];
  const sites = [];
  const lines = blankComments(text).split('\n');
  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    if (/^\s*export\s*\{[^}]*\}\s*from\s/.test(line)) return;
    if (/\biri(?:Segment|Fragment)\b/.test(line)) sites.push(`${at} uses an address encoder (only the resolver encodes a name)`);
    // The `/ld/` rule is literal: a quote, then `/ld/`, however the address is joined to a value (an interpolation, `+`, `concat`, a constant
    // holding the segment). What a line may spell besides: a route pattern and a prefix test (the Linked Data door serves them, bundle-271,
    // Q-758), blanked before the rule asks; and a line the allow list names.
    const entry = allowed.find(a => a.file === file && line.includes(a.contains));
    if (entry) excused.add(entry);
    else if (/['"`][^'"`]*\/ld\//.test(line.replace(NO_ADDRESS, ''))) sites.push(`${at} writes the /ld/ path of a base (only the resolver does)`);
    if (file !== VOCABULARY && /\bYTHRIL_NS\s*\+|\$\{\s*YTHRIL_NS\s*\}/.test(line)) sites.push(`${at} concatenates onto YTHRIL_NS`);
    if (/\brdf\??\.(?:base|vocab)\s*\+|\$\{[^}]*\brdf\??\.(?:base|vocab)\s*\}/.test(line)) sites.push(`${at} concatenates onto a space's rdf base or vocab`);
    if (file.startsWith('server/src/rdf/') && /\bencodeURI(?:Component)?\s*\(/.test(line)) sites.push(`${at} carries a second encoder`);
  });
  return sites;
}

describe('the source gate', () => {
  it('is proven on a planted module: each way of building an address by hand is named', () => {
    const planted = [
      "import { iriSegment } from 'the-schema-package';",
      "const f = iriFragment(prop);",
      "const base = `${url}/ld/${id}/`;",
      "const t = YTHRIL_NS + 'Entity';",
      "const r = meta.rdf.base + 'entity/' + id;",
      'const s = `${meta.rdf?.vocab}x`;',
    ].join('\n');
    assert.equal(handBuiltIriSites('server/src/api/planted.ts', planted).length, 6);
    // Joined by `+` is built too, and so is every join that hides the literal from a shape-matching rule: a constant holding the segment, `concat`.
    assert.equal(handBuiltIriSites('server/src/api/planted.ts', "const a = publicUrl + '/ld/' + id + '/';\nconst b = url + '/ld/x';").length, 2);
    assert.equal(handBuiltIriSites('server/src/api/planted.ts', "const LD = '/ld/';\nconst a = pub + LD + id;").length, 1, 'a constant holding the segment');
    assert.equal(handBuiltIriSites('server/src/api/planted.ts', "const a = pub.concat('/ld/', id);").length, 1, 'a concat');
    // A route pattern and a prefix test are no address; a sentence that names the path is one unless the allow list names its line.
    const named = "r.get('/ld/:spaceId/:kind/:id', h);\nf('GET /ld/:spaceId/schema/:fp', h);\nif (p.startsWith('/ld/')) x();";
    assert.deepEqual(handBuiltIriSites('server/src/api/planted.ts', named), [], 'a route or a prefix test builds no address');
    assert.equal(handBuiltIriSites('server/src/api/planted.ts', "const a = '/ld/:x' + pub + '/ld/';").length, 1, 'a route pattern does not excuse an address built on the same line');
    const sentence = "const s = 'an address under <public url>/ld/<space>/ resolves';";
    assert.equal(handBuiltIriSites('server/src/api/planted.ts', sentence).length, 1, 'a sentence naming the path is a site until its line is allowed');
    const excused = new Set();
    const allow = [{ file: 'server/src/api/planted.ts', contains: 'an address under <public url>', reason: 'a sentence a refusal answers', reviewBy: '2099-01-01' }];
    assert.deepEqual(handBuiltIriSites('server/src/api/planted.ts', sentence, allow, excused), [], 'an allowed line is excused');
    assert.equal(excused.size, 1, 'the entry that excused it is recorded');
    assert.equal(handBuiltIriSites('server/src/api/other.ts', sentence, allow).length, 1, 'an entry excuses its own file only');
    assert.equal(handBuiltIriSites('server/src/rdf/planted.ts', 'const x = encodeURIComponent(id);').length, 1);
    assert.deepEqual(handBuiltIriSites(RESOLVER, planted), [], 'the resolver itself is the one builder');
  });
  it('no module of the server or the schema package builds an RDF address but the resolver', () => {
    const sources = readTrackedSources([...SERVER_CODE_ROOTS], { untracked: true });
    const excused = new Set();
    const sites = sources.flatMap(({ file, text }) => handBuiltIriSites(file, text, ALLOWED, excused));
    assert.deepEqual(sites, [], 'ask server/src/rdf/term-iri.ts for the address instead');
    assert.ok(sources.some(s => s.file === RESOLVER), 'the resolver is in the scan');
    const stale = ALLOWED.filter(a => !excused.has(a));
    assert.deepEqual(stale.map(a => `${a.file}: ${a.contains}`), [], 'an allowed line that excuses nothing any more is removed from the allow list');
  });
  it('the allow list carries a reason and a review date that is not past', () => {
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(allowProblem(ALLOWED, today), null);
  });
});
