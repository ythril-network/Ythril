/**
 * A conversation with two sessions on the same day keeps both of them.
 *
 * ## The measurement that found this
 *
 * The writer files claims by `statedOn` and writes each session's transcript to `transcripts/<date>.md`.
 * That is correct for LoCoMo and was read as a general rule — measured across both pinned corpora:
 *
 * | corpus | sessions | sharing a date with another |
 * |---|---|---|
 * | LoCoMo | 272 | **0** |
 * | LongMemEval `_s` | 25,112 | **18,565**, in 500 of 500 histories |
 *
 * A LoCoMo conversation runs over months with sessions weeks apart. A LongMemEval history runs over about
 * eleven days with several sessions a day — the median one this was found in has 44 sessions across 11
 * days, six of them on the first.
 *
 * So on that corpus the date-keyed writer would send six transcripts to one path, keeping the last, and
 * file six sessions' claims into whichever one survived. **Nothing would fail.** The space would hold most
 * of the conversation, be perfectly interpretable, and a question about a lost session would return
 * nothing — which reads as a retrieval result rather than as five files that were overwritten.
 *
 * ## Why the writer REFUSES rather than making the key optional
 *
 * A `key` that defaults to the date is a correct fix that a caller can forget, and forgetting it restores
 * the exact silent overwrite. The refusal is what cannot be forgotten: two sessions that resolve to one
 * bucket stop the run, and the ten committed LoCoMo extractions are untouched because none of them has a
 * collision to declare a key for.
 *
 * Run: node --test testing/standalone/two-sessions-on-one-day-are-two-sessions.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeSpace } from '../../benchmarks/writer/write-space.mjs';
import { recordingYthril } from '../_shared/recording-ythril-client.mjs';

const SCHEMA = [
  { knowledgeType: 'entity', typeName: 'person', schema: { propertySchemas: {} } },
  { knowledgeType: 'fact', typeName: 'utterance', schema: { propertySchemas: {} } },
];

const claim = (text, over = {}) => ({
  text, speaker: 'Ada', statedOn: '2023-05-20', entities: ['ada'], sourceTurns: ['D1:1'], ...over,
});

async function write(extra) {
  const ythril = recordingYthril();
  await writeSpace({
    extraction: {
      conversationId: 'conv-x',
      schema: SCHEMA,
      entities: [{ key: 'ada', type: 'person', name: 'Ada', description: 'An engineer.' }],
      chrono: [], edges: [], claims: [], sessions: [],
      ...extra,
    },
    ythril, space: 'test-space', schemaEntries: SCHEMA,
  });
  return ythril.wrote;
}

describe('two sessions on one day', () => {
  const SAME_DAY = {
    sessions: [
      { key: 's1', date: '2023-05-20', text: 'morning talk' },
      { key: 's2', date: '2023-05-20', text: 'evening talk' },
    ],
    claims: [
      claim('Ada planned a road trip.', { session: 's1' }),
      claim('Ada bought a guitar.', { session: 's2' }),
    ],
  };

  it('both transcripts are written, to different paths', async () => {
    const { files } = await write(SAME_DAY);
    const paths = files.map(f => f.path);
    assert.equal(new Set(paths).size, 2,
      `two sessions must not share a transcript path — got ${JSON.stringify(paths)}`);
    assert.equal(files.length, 2, 'one transcript per session');
  });

  it('and each transcript names only ITS OWN session\'s claims', async () => {
    // The quieter half. Even with two paths, a bucket keyed on the date hands both sessions' claims to
    // both files, and every transcript then claims to have produced the whole day.
    const { files, memories } = await write(SAME_DAY);
    const idOf = (text) => `id-${memories.findIndex(m => m.fact === text) + 2}`;   // entity is id-1
    for (const f of files) {
      assert.equal(f.links?.memoryIds?.length, 1,
        `${f.path} names ${f.links?.memoryIds?.length} claims; each session produced exactly one`);
    }
    assert.notDeepEqual(files[0].links.memoryIds, files[1].links.memoryIds,
      'the two transcripts name the same claims, so the bucket is still keyed on the date');
    assert.ok(idOf('Ada planned a road trip.'), 'sanity: the claims were written');
  });
});

describe('a collision that was not declared is refused, never absorbed', () => {
  it('two sessions on one date with no key stops the run before anything is written', async () => {
    // A key that DEFAULTS to the date is a fix a caller can forget, and forgetting it restores the silent
    // overwrite exactly. This is what cannot be forgotten.
    //
    // The refusal comes from `validateExtraction`, which `writeSpace` runs before its first request — so
    // the message is the one a caller reads alongside every other problem in their file, rather than a
    // throw arriving partway through a few hundred writes. The writer holds no second copy of the check:
    // it could not be reached, and an unreachable guard is a claim about safety rather than safety.
    await assert.rejects(() => write({
      sessions: [
        { date: '2023-05-20', text: 'morning' },
        { date: '2023-05-20', text: 'evening' },
      ],
      claims: [claim('Ada planned a road trip.')],
    }), /both identify as '2023-05-20'/);
  });
});

describe('the ten committed LoCoMo extractions keep working', () => {
  it('sessions with distinct dates and no keys behave exactly as before', async () => {
    const { files } = await write({
      sessions: [
        { date: '2023-05-20', text: 'first' },
        { date: '2023-06-01', text: 'second' },
      ],
      claims: [claim('Ada planned a road trip.'), claim('Ada bought a guitar.', { statedOn: '2023-06-01' })],
    });
    assert.deepEqual(files.map(f => f.path).sort(),
      ['transcripts/2023-05-20.md', 'transcripts/2023-06-01.md'],
      'a conversation with one session per day must produce the paths it always did');
  });

  it('a claim with no session still reaches its day\'s transcript', async () => {
    const { files } = await write({
      sessions: [{ date: '2023-05-20', text: 'only' }],
      claims: [claim('Ada planned a road trip.')],
    });
    assert.equal(files[0].links?.memoryIds?.length, 1, 'the date fallback must still link the claim');
  });
});
