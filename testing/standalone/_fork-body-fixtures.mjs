/**
 * Valid documents of every forking family, and a corpus of the awkward ones, for the tests of the body hash and the fork planner
 * (Q-624, design rev 4 sections 2 and 4, section 16 tests 1 and 23).
 *
 * ## What it answers
 *
 *  - {@link base}: *"a document of this family that passes its `Incoming*` schema"*, at seq 5, id `p`, so a case that wants a copy
 *    that differs in ONE thing starts from a copy that is valid;
 *  - {@link ALTERNATE}: *"a value that is not the base's, for each body field"*, so a per-field case ranges over the body fields the
 *    hash reports (`BODY_FIELDS_OF`) and fails, naming the field, when a field has no row here (a new body field cannot slip past the
 *    cases by being unknown to them);
 *  - {@link corpus}: *"the documents `divergesFrom(kind, x, x)` must be false for"*: valid ones, key orders, defaulted-against-absent
 *    fields, nested keys spelled like version metadata, unicode, rows a pre-fix `deleteFields` left with `null`, documents that fail
 *    their schema, and a document with no fields at all.
 *
 * A literal fixture on purpose: derived from the code under test it would assert that the code equals itself. The schema-passing
 * claim is checked against the real schema by the case that uses it.
 */

export const AUTHOR = Object.freeze({ instanceId: 'i1', instanceLabel: 'One' });
export const OTHER_AUTHOR = Object.freeze({ instanceId: 'i2', instanceLabel: 'Two' });
export const T0 = '2026-10-01T00:00:00.000Z';
export const T1 = '2026-10-02T00:00:00.000Z';

const common = (over) => ({ _id: 'p', spaceId: 's', author: { ...AUTHOR }, createdAt: T0, updatedAt: T0, seq: 5, ...over });

/** A valid document of `family` at seq 5. */
export function base(family, over = {}) {
  switch (family) {
    case 'facts': return common({ fact: 'the sky is blue', tags: ['a'], description: 'd', properties: { colour: 'blue' }, ...over });
    case 'entities': return common({ name: 'North', type: 'service', tags: ['a'], description: 'd', properties: { port: 8080 }, ...over });
    case 'edges': return common({ from: 'a', to: 'b', label: 'knows', tags: ['a'], description: 'd', weight: 1, properties: { since: 2020 }, ...over });
    case 'chrono': return common({ title: 'Launch', type: 'event', startsAt: T0, status: 'upcoming', tags: ['a'], description: 'd', properties: { room: 'A' }, ...over });
    default: throw new Error(`no fixture for the family ${family}`);
  }
}

/** The one field Review shows by word, per family: a body difference that every family has. */
export const MAIN_FIELD = Object.freeze({ facts: 'fact', entities: 'name', edges: 'description', chrono: 'title' });

/** A value that is not the base's, for every body field a document can carry, per family. A field without a row fails the case that ranges over the fields. */
export const ALTERNATE = Object.freeze({
  facts: { type: 'note', suppressEmbeddings: true, superseded: true, fact: 'the sky is grey', tags: ['b'], description: 'other', properties: { colour: 'grey' } },
  entities: { suppressEmbeddings: true, superseded: true, name: 'South', type: 'host', tags: ['b'], description: 'other', properties: { port: 9090 } },
  edges: {
    suppressEmbeddings: true, superseded: true, from: 'a2', to: 'b2', fromKind: 'fact', toKind: 'fact', label: 'knows-of', type: 'social', weight: 2,
    tags: ['b'], description: 'other', properties: { since: 2021 },
  },
  chrono: {
    suppressEmbeddings: true, superseded: true, title: 'Landing', description: 'other', type: 'deadline', startsAt: T1, endsAt: T1, status: 'active',
    confidence: 0.5, tags: ['b'], properties: { room: 'B' }, recurrence: { freq: 'weekly', interval: 2 },
  },
});

/** The fields the hash blanks when either copy of a chrono entry is redacted (`contentRedacted` and its stamp): they say how a copy was lapsed, not what it says. */
export const REDACTION_MARKS = Object.freeze(['contentRedacted', 'contentRedactedAt']);

/** The documents of the corpus: `[name, family, doc]`. */
export function corpus() {
  const out = [];
  const add = (name, family, doc) => out.push([name, family, doc]);
  for (const family of Object.keys(MAIN_FIELD)) {
    add(`${family}: valid`, family, base(family));
    add(`${family}: keys written in reverse`, family, Object.fromEntries(Object.entries(base(family)).reverse()));
    add(`${family}: no tags (defaulted against absent)`, family, (({ tags, ...rest }) => rest)(base(family)));
    add(`${family}: no properties`, family, (({ properties, ...rest }) => rest)(base(family)));
    add(`${family}: empty properties and tags`, family, base(family, { properties: {}, tags: [] }));
    add(`${family}: nested keys spelled like version metadata`, family, base(family, { properties: { author: 'x', seq: 3, pos: 9, forkOf: 'q', updatedAt: 'u', spaceId: 'z' } }));
    add(`${family}: unicode`, family, base(family, { [MAIN_FIELD[family]]: 'Zürich – 東京 🚀 \u0000 "quoted" \\ back' }));
    add(`${family}: local fields present`, family, base(family, { embedding: [0.1, 0.2], embeddingModel: 'm', matchedText: 't', _expireAt: new Date(0), syncBase: { seq: 1 }, deliveredBy: 'i9', pos: 4, posAtSeq: 5 }));
    add(`${family}: a different author and timestamps`, family, base(family, { author: { ...OTHER_AUTHOR }, createdAt: T1, updatedAt: T1 }));
    add(`${family}: description null (written by deleteFields before the fix; fails its schema)`, family, base(family, { description: null }));
    add(`${family}: missing a required field (fails its schema)`, family, (({ author, ...rest }) => rest)(base(family)));
    add(`${family}: a wrong type (fails its schema)`, family, base(family, { tags: 'not-a-list' }));
    add(`${family}: an undeclared key`, family, base(family, { unexpected: { deep: [1, 2] } }));
    add(`${family}: a fork row`, family, base(family, { _id: 'f1', forkOf: 'p' }));
    add(`${family}: no fields at all`, family, {});
    add(`${family}: only an id and a seq`, family, { _id: 'p', seq: 5 });
  }
  add('chrono: redacted', 'chrono', (({ description, ...rest }) => rest)(base('chrono', { contentRedacted: true, contentRedactedAt: T1 })));
  add('chrono: redacted marks without the redaction', 'chrono', base('chrono', { contentRedactedAt: T1 }));
  add('edges: weight null (written by deleteFields before the fix; fails its schema)', 'edges', base('edges', { weight: null }));
  add('edges: endpoint kinds set', 'edges', base('edges', { fromKind: 'fact', toKind: 'chrono' }));
  return out;
}
