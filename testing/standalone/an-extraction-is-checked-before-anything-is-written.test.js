/**
 * A bad extraction is refused before the first record is written, and every problem is named at once.
 *
 * ## The failure this exists for
 *
 * The writer makes hundreds of requests per conversation. An undeclared type, or an edge drawn between the
 * wrong kinds of thing, is a 400 from the instance — arriving on request 340, with 339 records already
 * stored. What is left is a space holding most of a conversation: interpretable, wrong, and saying nothing
 * about it. A benchmark run against it reports a number.
 *
 * The quieter half is keys. An extraction refers to its own records by a local `key`, because it is written
 * before anything has an id. A claim naming a key nothing defines produces a link that is simply absent — the
 * instance stores a perfectly valid record with one fewer link and reports success. Nothing anywhere fails.
 *
 * ## Why the validator must report all of them
 *
 * Each round trip through the validator is a round trip through a model. A validator that stops at the first
 * problem turns one bad extraction into a dozen re-runs, so this asserts the count as well as the content.
 *
 * ## The fixtures are literal on purpose
 *
 * A fixture derived from the schema would assert that the code equals itself. These name types and labels the
 * real schema declares, and the gate that keeps THOSE honest is the schema's own — if `works_at` stops being
 * person-to-organization, that gate fails, not this one.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { validateExtraction, SUPERSEDES } from '../../benchmarks/writer/validate-extraction.mjs';

/** A minimal schema in the shape `space/schema.json` holds, so the validator is exercised, not mocked. */
const SCHEMA = [
  { knowledgeType: 'entity', typeName: 'person', schema: { propertySchemas: {} } },
  { knowledgeType: 'entity', typeName: 'organization', schema: { propertySchemas: {} } },
  { knowledgeType: 'entity', typeName: 'place', schema: { propertySchemas: {} } },
  { knowledgeType: 'edge', typeName: 'works_at', schema: { endpoints: { from: ['person'], to: ['organization'] } } },
  { knowledgeType: 'chrono', typeName: 'event', schema: { propertySchemas: {} } },
  { knowledgeType: 'fact', typeName: 'utterance', schema: { propertySchemas: {} } },
];

/** A file with nothing wrong with it. Each test breaks exactly one thing. */
const good = () => ({
  conversationId: 'conv-x',
  sessions: [{ date: '2023-05-08', text: 'Ada: hello' }],
  entities: [
    { key: 'ada', type: 'person', name: 'Ada', description: 'An engineer who joined Acme in March 2021.' },
    { key: 'acme', type: 'organization', name: 'Acme', description: "Ada's employer since March 2021." },
  ],
  edges: [{ label: 'works_at', from: 'ada', to: 'acme', properties: { since: '2021-03-01' } }],
  chrono: [{ key: 'joined', type: 'event', title: 'Ada joined Acme', date: '2021-03-01', entities: ['ada'] }],
  claims: [{
    text: 'Ada started working at Acme in March 2021.', speaker: 'Ada', statedOn: '2023-05-08',
    entities: ['ada', 'acme'], chrono: ['joined'], sourceTurns: ['D1:1'],
  }],
});

const problemsFor = mutate => {
  const e = good();
  mutate(e);
  return validateExtraction(e, SCHEMA);
};

describe('a good file passes', () => {
  test('nothing is reported', () => {
    assert.deepEqual(validateExtraction(good(), SCHEMA), []);
  });
});

describe('what the instance would refuse, found first', () => {
  test('an entity type the schema does not declare', () => {
    const p = problemsFor(e => { e.entities[0].type = 'wizard'; });
    assert.equal(p.length, 1);
    assert.match(p[0], /wizard.*does not declare/);
  });

  test('an edge label the schema does not declare', () => {
    const p = problemsFor(e => { e.edges[0].label = 'vibes_with'; });
    assert.match(p.join(' '), /vibes_with.*does not declare/);
  });

  test('an edge whose end is the wrong kind of thing', () => {
    // `works_at` runs person to organization. An organization at the `from` end is a graph that means
    // something nobody wrote, and the instance refuses it — on request 340.
    const p = problemsFor(e => { e.edges[0].from = 'acme'; });
    assert.equal(p.length, 1);
    assert.match(p[0], /from is a 'organization' and the label allows person/);
  });

  test('a date that is not YYYY-MM-DD, wherever it appears', () => {
    assert.match(problemsFor(e => { e.chrono[0].date = 'last year'; }).join(' '), /not YYYY-MM-DD/);
    assert.match(problemsFor(e => { e.claims[0].statedOn = '2023'; }).join(' '), /not YYYY-MM-DD/);
    assert.match(problemsFor(e => { e.edges[0].properties.since = 'March'; }).join(' '), /not YYYY-MM-DD/);
    assert.match(problemsFor(e => { e.sessions[0].date = '08-05-2023'; }).join(' '), /not YYYY-MM-DD/);
  });
});

describe('what the instance would NOT catch, which is the point', () => {
  test('a claim linking to an entity key nothing defines', () => {
    // The instance sees a valid claim with one fewer link and stores it. Nothing fails, and the graph has a
    // hole in it that reads later as a retrieval result.
    const p = problemsFor(e => { e.claims[0].entities = ['ada', 'ghost']; });
    assert.equal(p.length, 1);
    assert.match(p[0], /entity key 'ghost', which nothing defines/);
  });

  test('a claim linking to a chrono key nothing defines', () => {
    assert.match(problemsFor(e => { e.claims[0].chrono = ['nope']; }).join(' '), /chrono key 'nope'/);
  });

  test('an edge end naming no entity at all', () => {
    assert.match(problemsFor(e => { e.edges[0].to = 'nowhere'; }).join(' '), /to is 'nowhere', which no entity defines/);
  });

  test('a chrono entry linking to an entity key nothing defines', () => {
    assert.match(problemsFor(e => { e.chrono[0].entities = ['ghost']; }).join(' '), /entity key 'ghost'/);
  });

  test('two records claiming the same key', () => {
    // The wording changed when the three key spaces became one: "redefines" described an entity clashing
    // with an entity, and the rule now covers a claim clashing with either. The message names BOTH records
    // because "this key is taken" without saying by what is a hunt through the file.
    assert.match(problemsFor(e => { e.entities[1].key = 'ada'; }).join(' '),
      /entities\[1\] uses the key 'ada', which entities\[0\] already defines/);
  });
});

describe('what a claim must carry', () => {
  test('a speaker, because a claim nobody can attribute is not auditable', () => {
    assert.match(problemsFor(e => { delete e.claims[0].speaker; }).join(' '), /no speaker/);
  });

  test('source turns, or nothing can trace it back to the transcript', () => {
    assert.match(problemsFor(e => { e.claims[0].sourceTurns = []; }).join(' '), /names no sourceTurns/);
  });

  test('text', () => {
    assert.match(problemsFor(e => { delete e.claims[0].text; }).join(' '), /has no text/);
  });
});

/**
 * A model's output must not enter the graph as a plain fact, and a person's must not leave it.
 *
 * `attributed: true` means the graph records that a claim was SAID, not that it is SO — the distinction a
 * citation makes between *"Vasari wrote that Leonardo painted the Mona Lisa"* and the painting fact itself.
 * It exists because a corpus can be a conversation with an AI: measured on `longmemeval_s`, 54 of the 896
 * evidence-bearing turns are the assistant's, and reading them shows world knowledge that may be right,
 * stale or invented — a restaurant's signature dishes, the processes at three named refineries.
 *
 * BOTH DIRECTIONS, because only one of them is loud. A missing mark puts a guess in the graph beside the
 * user's own words; a mark on a PERSON's claim retires a real fact from every reader that filters on it,
 * and nothing ever contradicts that.
 */
describe('a claim an assistant originated says so', () => {
  test('an assistant claim with no mark is refused', () => {
    const problems = problemsFor(e => { e.claims[0].speaker = 'assistant'; });
    assert.match(problems.join(' '), /not marked/);
  });

  test('and the refusal says what to do when it was really the user\'s fact', () => {
    // The commonest case by far — 32 of those 54 turns repeat over half of the user's own words back at
    // them. A refusal that only says "add the mark" would get the mark added to the user's fact.
    const problems = problemsFor(e => { e.claims[0].speaker = 'assistant'; });
    assert.match(problems.join(' '), /set `speaker` to them/);
  });

  test('a person\'s claim carrying the mark is refused too', () => {
    const problems = problemsFor(e => { e.claims[0].attributed = true; });
    assert.match(problems.join(' '), /speaker is 'Ada', who is a person/);
  });

  test('a correctly marked assistant claim passes', () => {
    assert.deepEqual(problemsFor(e => {
      e.claims[0].speaker = 'assistant';
      e.claims[0].attributed = true;
    }), []);
  });

  test('the speaker match is whole-value, so a person named Ai is not a model', () => {
    // A substring test would mark every claim by anybody whose name contains those letters, in a corpus
    // whose participants are named — which is every corpus but this one.
    assert.deepEqual(problemsFor(e => {
      e.entities[0].name = 'Ai';
      e.claims[0].speaker = 'Aisha';
    }), []);
  });
});

describe('a record must be worth retrieving', () => {
  test('a claim that is a transcript line is refused', () => {
    /*
     * The failure this whole layer exists to avoid. A line of dialogue names nobody a search can find and
     * dates nothing: 'I went yesterday' has no subject and no date in it, and an embedding sees only those
     * words. Store lines and the graph retrieves exactly as well as the raw transcript, which is what it is
     * supposed to beat — measured, it did, to within half a point.
     */
    const p = problemsFor(e => { e.claims[0].text = 'Ada: I started at Acme in March.'; });
    assert.equal(p.length, 1);
    assert.match(p[0], /transcript line rather than a resolved fact/);
  });

  test('an entity with no description is refused', () => {
    // A bare name embeds as two or three words and loses every search it takes part in, while still
    // occupying a ranked slot a claim would have used. Measured at about ten points of rank-1 accuracy.
    const p = problemsFor(e => { delete e.entities[0].description; });
    assert.equal(p.length, 1);
    assert.match(p[0], /has no description/);
  });

  test('a fact that merely contains a colon is not mistaken for one', () => {
    // The check looks for a leading `Name: `, so a sentence with a colon in it must pass.
    const p = problemsFor(e => { e.claims[0].text = 'Ada named three reasons: pay, people and place.'; });
    assert.deepEqual(p, []);
  });
});

describe('the claim layer is complete', () => {
  test('a turn in no claim is reported, when the sessions say which turns they had', () => {
    // Measured: keeping only the turns that seemed to say something covered 34.6% of a conversation and
    // scored worse on every measure than storing the raw turns. The graph looked fine — it was just
    // missing two thirds of what was said.
    const e = good();
    e.sessions[0].turns = ['D1:1', 'D1:2', 'D1:3'];
    const p = validateExtraction(e, SCHEMA);
    assert.equal(p.length, 1);
    assert.match(p[0], /2 of 3 turns are in no claim \(D1:2, D1:3\)/);
  });

  test('and says nothing when every turn is covered', () => {
    const e = good();
    e.sessions[0].turns = ['D1:1'];
    assert.deepEqual(validateExtraction(e, SCHEMA), []);
  });

  test('a file whose sessions carry no turn ids is not refused', () => {
    // The writer has no transcript to compare against, and inventing a failure there would block a caller
    // who is not running a benchmark at all.
    assert.deepEqual(validateExtraction(good(), SCHEMA), []);
  });
});

describe('supersession — a claim that retired another', () => {
  /*
   * ## Why a claim needs a `key` at all, when nothing needed one before
   *
   * Entities and chrono entries carry a local `key` because something points at them. Claims never did,
   * because nothing did. Supersession is the first thing that points at a claim: *"the August answer
   * replaced the May one"* is an edge between two claims, and an edge names its ends by key.
   *
   * So a claim's `key` is OPTIONAL — the overwhelming majority of claims are still pointed at by nothing —
   * and one namespace covers all three kinds, because an edge end is a key and says nothing about which
   * collection it is in.
   *
   * ## The rule that matters, and it is not "every retirement has a successor"
   *
   * A retirement often has no successor: *"she left Acme"* with no new employer is a real thing to record.
   * So `superseded: true` stands alone and is never required to have an edge.
   *
   * The implication runs the other way and it is the one worth gating: if X supersedes Y, then Y is not
   * true any more. An edge drawn without the mark leaves both claims ranking as current, which is the whole
   * defect supersession exists to fix — and it would be invisible, because the edge looks like the fix.
   */
  const superseding = e => {
    e.claims[0].key = 'worked-at-acme';
    e.claims[0].superseded = true;
    e.claims.push({
      key: 'works-at-beta', text: 'Ada left Acme and started at Beta in June 2023.',
      speaker: 'Ada', statedOn: '2023-05-08', entities: ['ada'], sourceTurns: ['D1:2'],
    });
    e.edges.push({ label: 'supersedes', from: 'works-at-beta', to: 'worked-at-acme' });
  };

  test('a claim-to-claim supersedes edge is accepted', () => {
    assert.deepEqual(problemsFor(superseding), []);
  });

  test('a retirement with NO successor is accepted', () => {
    // "She left and has not started anywhere new" is a retirement with nothing replacing it. Requiring an
    // edge would make that unsayable, and the model would invent a successor to satisfy the validator.
    assert.deepEqual(problemsFor(e => { e.claims[0].superseded = true; }), []);
  });

  test('a supersedes edge whose target is NOT marked is refused', () => {
    const p = problemsFor(e => { superseding(e); delete e.claims[0].superseded; });
    assert.equal(p.length, 1, `expected one problem, got: ${p.join(' | ')}`);
    assert.match(p[0], /supersedes.*worked-at-acme.*superseded/);
  });

  test('a supersedes edge between two ENTITIES is refused', () => {
    // Two entities that turn out to be one thing is a MERGE, and merging is what `aliases` is for. Drawing
    // this instead would leave two nodes where the whole point of the graph is that there is one.
    const p = problemsFor(e => { e.edges.push({ label: 'supersedes', from: 'ada', to: 'acme' }); });
    assert.match(p.join(' '), /supersedes.*claims/);
  });

  test('an edge end naming a claim key is resolved, not reported as dangling', () => {
    // The pre-existing dangling-key check knew only about entities. A claim key would have read as a
    // reference to nothing — and the message would have been confidently wrong.
    const p = problemsFor(superseding);
    assert.ok(!p.join(' ').includes('defines no'), `no key may read as dangling: ${p.join(' | ')}`);
  });

  test('one key used by two records is refused, whatever kinds they are', () => {
    // One namespace is what lets an edge end be a bare key. Two records sharing one means an edge points at
    // whichever the writer happened to resolve last, silently.
    const p = problemsFor(e => { superseding(e); e.claims[1].key = 'ada'; });
    assert.match(p.join(' '), /'ada'.*(twice|more than once|already)/);
  });

  test('superseded must be a boolean, not a string', () => {
    // "false" is truthy. A mark whose whole job is to be believed must not be coerced.
    assert.match(problemsFor(e => { e.claims[0].superseded = 'true'; }).join(' '), /superseded.*boolean/);
  });
});

describe('the second copy of the supersedes label is compared, not trusted', () => {
  test('the harness and the server spell it the same', () => {
    /*
     * The validator cannot import the server's constant: it runs in the benchmark harness, which must work
     * without a TypeScript build having happened. So the name exists twice — and a second copy of a fact is
     * only survivable while something compares the two. A coverage check that the label is MENTIONED
     * somewhere would pass with them spelled differently, which is exactly the state that produces an edge
     * the server refuses, on whichever request reaches it.
     */
    const src = readFileSync('server/src/spaces/schema-validation.ts', 'utf8');
    const block = /SERVER_WRITTEN_EDGE_LABELS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src);
    assert.ok(block, 'SERVER_WRITTEN_EDGE_LABELS is gone from the server, so this gate compares nothing');
    const labels = [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
    assert.ok(labels.length >= 1, 'the server declares no server-written edge labels — read the file, not this gate');
    assert.ok(labels.includes(SUPERSEDES),
      `the harness writes '${SUPERSEDES}' and the server's server-written labels are [${labels.join(', ')}]. `
      + 'A space carrying an edge allowlist would refuse the harness edge.');
  });
});

describe('the floors', () => {
  test('every problem is reported, not the first', () => {
    // A validator that stops at one turns a bad extraction into a dozen round trips through a model.
    const p = problemsFor(e => {
      e.entities[0].type = 'wizard';
      e.edges[0].label = 'vibes_with';
      e.claims[0].statedOn = 'yesterday';
      e.chrono[0].entities = ['ghost'];
    });
    assert.equal(p.length, 4, `expected four problems, got: ${p.join(' | ')}`);
  });

  test('an extraction with no claims is refused rather than written as an empty space', () => {
    assert.match(problemsFor(e => { e.claims = []; }).join(' '), /no claims/);
  });

  test('an empty schema is refused rather than validating everything', () => {
    // With nothing declared, strict mode validates NOTHING — so a file checked against an empty schema
    // passes and the space accepts anything. That reads as a clean run.
    const p = validateExtraction(good(), []);
    assert.equal(p.length, 1);
    assert.match(p[0], /schema loaded with no entity types/);
  });

  test('something that is not an extraction at all', () => {
    assert.deepEqual(validateExtraction(null, SCHEMA), ['the extraction is not an object']);
  });
});
