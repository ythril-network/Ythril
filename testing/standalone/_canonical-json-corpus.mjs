/**
 * The documents `canonical-json-is-made-once-and-keeps-the-merkle-bytes.test.js` hashes, kept apart so the pinned hashes
 * in that test were computed from exactly these values by the build BEFORE the extraction (bundle-23 wave 0, 9e8b307d +
 * the two earlier wave-0 commits, whose `brain/merkle.ts` still held its own `canonicalize`).
 *
 * Every shape the space hash can meet: nested objects and arrays, key order, unicode keys and values (astral and lone
 * surrogates), numbers JSON cannot spell, null, undefined fields and array slots, derived fields at the top and nested,
 * a Date, empty containers, an own `__proto__` key and the other two object-internal names. A literal fixture on purpose:
 * derived from the code under test it would assert that the code equals itself.
 */
const NUL = String.fromCharCode(0);

/** [name, collection, document] — each document has `_id` and `seq`, as `docLeaf` reads them. */
export const CORPUS = [
  ['an entity', 'entities', {
    _id: 'e1', seq: 7, spaceId: 'general', name: 'North Service', type: 'service', tags: ['b', 'a'],
    properties: { port: 8080, region: 'eu', nested: { z: 1, a: [1, 2, { y: true, b: false }] } },
    author: { instanceId: 'i1', instanceLabel: 'One' }, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
  }],
  ['the same entity, keys written in reverse', 'entities', {
    updatedAt: '2026-09-02T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', author: { instanceLabel: 'One', instanceId: 'i1' },
    properties: { nested: { a: [1, 2, { b: false, y: true }], z: 1 }, region: 'eu', port: 8080 },
    tags: ['b', 'a'], type: 'service', name: 'North Service', spaceId: 'general', seq: 7, _id: 'e1',
  }],
  ['unicode keys and values', 'facts', {
    _id: 'f1', seq: 1, 'ä': 'Zürich – 東京 🚀', z: 'z', Z: 'Z', 'é': 'é', '𝒜': 'astral key', '10': 'ten', '9': 'nine', '2': 'two',
    lone: '\ud800', mixed: 'a\udc00b', escapes: `quote " backslash \\ newline \n tab \t nul ${NUL} bell \u0007 line-sep  `,
  }],
  ['numbers', 'facts', {
    _id: 'f2', seq: 2, zero: 0, negZero: -0, half: 1.5, big: 1e21, small: 1e-7, safe: Number.MAX_SAFE_INTEGER,
    nan: NaN, inf: Infinity, ninf: -Infinity, list: [0, -0, NaN, Infinity, 3.14159, -2e-308],
  }],
  ['null everywhere', 'edges', { _id: 'g1', seq: 3, from: null, to: 'x', props: { a: null, b: [null, null] }, label: null }],
  ['undefined fields and slots', 'edges', {
    _id: 'g2', seq: 4, gone: undefined, kept: 1, nested: { gone: undefined, also: [undefined, 1, undefined] }, fn: () => 1,
  }],
  ['derived fields at the top and nested', 'memories', {
    _id: 'm1', seq: 5, fact: 'x', embedding: [0.1, 0.2], embeddingModel: 'm', matchedText: 't', _expireAt: new Date(0),
    _contentExpireAt: new Date(1), syncBase: { seq: 1 }, spaceId: 'general', _functionalGuard: 'k',
    properties: { embedding: [1], spaceId: 'nested', keep: 'yes', inner: { syncBase: 2, matchedText: 'n', stay: true } },
  }],
  ['a Date and empty containers', 'chrono', {
    _id: 'c1', seq: 6, when: new Date('2026-01-01T00:00:00Z'), emptyObj: {}, emptyArr: [], deep: { e: {}, a: [[], [{}]] },
  }],
  ['deep nesting', 'entities', { _id: 'e2', seq: 8, a: [{ b: [{ c: [{ d: [{ e: { f: [1, { g: 'h' }] } }] }] }] }] }],
  ['object-internal names as keys', 'entities', Object.assign(
    JSON.parse('{"_id":"e3","seq":9,"__proto__":{"polluted":true},"a":2,"properties":{"__proto__":{"x":1},"y":2}}'),
    { constructor: 'c', prototype: { p: 1 } })],
  ['booleans and strings that look like other things', 'facts', {
    _id: 'f3', seq: 10, t: true, f: false, s1: 'true', s2: 'null', s3: '1', s4: '', s5: '{}', s6: '[]',
  }],
];

/** A file's metadata, for `fileContentHash`, which hashes an INCLUSION projection of it through the same text. */
export const FILE_DOC = {
  _id: 'docs/a.md', seq: 11, spaceId: 'general', path: 'docs/a.md', sizeBytes: 12, sha256: 'ab'.repeat(32),
  description: 'Zürich 🚀', tags: ['y', 'x'], properties: { b: 1, a: { d: null, c: undefined } },
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
};
