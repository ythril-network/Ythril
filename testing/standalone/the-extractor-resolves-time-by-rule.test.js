/**
 * The conversation extractor's load and time phases are code, and the rules they implement are the
 * extraction prompt's own (`F-31`, DECOMPOSITION.md §1 and §3).
 *
 * Every expected date below is worked from a rule the prompt states in words, on a calendar where the
 * weekdays are checkable: 2023-05-01 is a Monday, so 05-10 is a Wednesday, 05-12 a Friday, 05-13 a Saturday,
 * 05-14 a Sunday. A failure here is either the resolver breaking a written rule, or the rule changing — in
 * which case the prompt section named in the test is the thing to re-read first.
 *
 * Run: node --test testing/standalone/the-extractor-resolves-time-by-rule.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let loadConversation, ConversationSourceError, find, resolve, chronoDatesFor, weekdayOf;
before(async () => {
  ({ loadConversation, ConversationSourceError } = await import('../../server/dist/extractor/conversation/load.js'));
  ({ findTemporalExpressions: find, resolveExpression: resolve, chronoDatesFor, weekdayOf }
    = await import('../../server/dist/extractor/conversation/time.js'));
});

/** Find the single expression in `text` and resolve it against `on`. */
const r = (text, on, opts) => {
  const found = find(text);
  assert.equal(found.length, 1, `expected one expression in "${text}", found ${JSON.stringify(found.map(f => f.text))}`);
  return resolve(found[0].expr, on, opts);
};

describe('the calendar this file is written against', () => {
  it('2023-05-10 is a Wednesday and 05-14 a Sunday', () => {
    assert.equal(weekdayOf('2023-05-10'), 3);
    assert.equal(weekdayOf('2023-05-14'), 0);
  });
});

describe('load (§1)', () => {
  const src = () => ({ sessions: [
    { date: '2023-05-20', time: '18:00', turns: [{ speaker: 'Ada', text: 'evening' }] },
    { date: '2023-05-08', turns: [{ speaker: 'Ada', text: 'first' }, { speaker: 'Bo', text: 'hi' }] },
    { date: '2023-05-20', time: '09:00', turns: [{ speaker: 'Ada', text: 'morning' }] },
  ] });

  it('orders by date, then time, never by page position (1.2)', () => {
    const c = loadConversation(src());
    assert.deepEqual(c.sessions.map(s => s.turns[0].text), ['first', 'morning', 'evening']);
  });

  it('keys a shared day apart, and ids every turn (1.3, 1.4)', () => {
    const c = loadConversation(src());
    assert.deepEqual(c.sessions.map(s => s.key), ['2023-05-08', '2023-05-20-1', '2023-05-20-2']);
    assert.deepEqual(c.sessions[0].turns.map(t => t.id), ['2023-05-08:1', '2023-05-08:2']);
  });

  it('refuses what it cannot read, naming every problem, never guessing (1.1)', () => {
    assert.throws(() => loadConversation({ sessions: [
      { date: '2023-02-30', turns: [{ speaker: 'Ada', text: 'x' }] },
      { date: '2023-05-01', time: '25:00', turns: [] },
    ] }), (e) => e instanceof ConversationSourceError && e.problems.length === 3);
  });
});

describe('"Last Tuesday" means the most recent Tuesday (3.3)', () => {
  it('said on a Wednesday, last Tuesday is yesterday', () => assert.equal(r('last Tuesday', '2023-05-10').value, '2023-05-09'));
  it('said on a Friday, last Friday is seven days back, not today', () => assert.equal(r('last Friday', '2023-05-12').value, '2023-05-05'));
  it('said on a Friday, see you Friday is seven days forward…', () => assert.equal(r('see you Friday', '2023-05-12').value, '2023-05-19'));
  it('…unless the exchange places it today (3.4, handed in)', () =>
    assert.equal(r('see you Friday', '2023-05-12', { placesToday: true }).value, '2023-05-12'));
  it('a bare weekday resolves to nothing until its direction is judged', () =>
    assert.equal(r('we met Friday', '2023-05-10').precision, 'none'));
});

describe('weekends (3.5)', () => {
  it('last weekend on a Monday is the one just gone', () => {
    const x = r('last weekend', '2023-05-15');
    assert.deepEqual([x.value, x.endsAt], ['2023-05-13', '2023-05-14']);
  });
  it('last weekend on a Sunday is the PREVIOUS one — a weekend containing today is not last', () => {
    const x = r('last weekend', '2023-05-14');
    assert.deepEqual([x.value, x.endsAt], ['2023-05-06', '2023-05-07']);
  });
  it('this weekend on a Saturday is today and tomorrow', () => {
    const x = r('this weekend', '2023-05-13');
    assert.deepEqual([x.value, x.endsAt], ['2023-05-13', '2023-05-14']);
  });
  it('this weekend on a Wednesday is the coming one', () => {
    const x = r('this weekend', '2023-05-10');
    assert.deepEqual([x.value, x.endsAt], ['2023-05-13', '2023-05-14']);
  });
  it('next weekend on a Wednesday is the one after the coming Saturday', () => {
    const x = r('next weekend', '2023-05-10');
    assert.deepEqual([x.value, x.endsAt], ['2023-05-20', '2023-05-21']);
  });
});

describe('offsets and approximations (3.6, 3.7)', () => {
  it('yesterday and the day before', () => {
    assert.equal(r('yesterday', '2023-05-24').value, '2023-05-23');
    assert.equal(r('the day before yesterday', '2023-05-24').value, '2023-05-22');
  });
  it('three weeks ago is a day', () => assert.equal(r('three weeks ago', '2023-05-24').value, '2023-05-03'));
  it('two months ago is a MONTH, not a day', () => {
    const x = r('two months ago', '2023-05-24');
    assert.deepEqual([x.precision, x.value], ['month', '2023-03']);
  });
  it('about three weeks ago stays approximate — no day is derived', () => {
    const x = r('about three weeks ago', '2023-05-24');
    assert.equal(x.precision, 'none');
    assert.equal(x.approximate, true);
    assert.equal(x.asOf, '2023-05-24');
  });
  it('a few days ago is approximate by nature', () => assert.equal(r('a few days ago', '2023-05-24').approximate, true));
  it('for about three weeks is a length, not a point', () => assert.equal(r('for about three weeks now', '2023-05-24').precision, 'none'));
  it('sometime in the spring gets no day', () => assert.equal(r('sometime in the spring', '2023-05-24').precision, 'none'));
  it('last week gets no day, only its window as context', () => {
    const x = r('last week', '2023-05-10');
    assert.equal(x.precision, 'none');
    assert.deepEqual(x.window, { from: '2023-05-01', to: '2023-05-07' });
  });
  it('an absolute day, with and without a year', () => {
    assert.equal(r('on 7 May 2023', '2023-06-01').value, '2023-05-07');
    assert.equal(r('May 7th', '2023-06-01').value, '2023-05-07');
  });
});

describe('what reaches the timeline (3.10, 3.11): endsAt is how long it LASTED, never the doubt', () => {
  const weekend = () => r('last weekend', '2023-05-15');
  it('camping last weekend — both ends handed, took more than a day → a span', () =>
    assert.deepEqual(chronoDatesFor(weekend(), true), { date: '2023-05-13', endsAt: '2023-05-14' }));
  it('the concert last weekend — both ends handed, took an evening → nothing, the date goes in the claim', () =>
    assert.equal(chronoDatesFor(weekend(), false), null));
  it('last week I got married — an offset makes the session date wrong → nothing', () =>
    assert.equal(chronoDatesFor(r('last week', '2023-05-15'), false), null));
  it('about three weeks ago → nothing, however it is judged', () =>
    assert.equal(chronoDatesFor(r('about three weeks ago', '2023-05-15'), true), null));
  it('yesterday → that day', () => assert.deepEqual(chronoDatesFor(r('yesterday', '2023-05-15'), false), { date: '2023-05-14' }));
  it('two months ago → nothing: a month is not a day', () =>
    assert.equal(chronoDatesFor(r('two months ago', '2023-05-15'), false), null));
});

describe('the tagger finds several, never overlapping, longest first', () => {
  it('in one sentence', () => {
    const found = find('I got back last weekend, and on Tuesday about three weeks ago I had started.');
    assert.deepEqual(found.map(f => f.text), ['last weekend', 'on Tuesday', 'about three weeks ago']);
  });
});

describe('classify turns, the code half (§2)', () => {
  let classifyTurns, splitCaptions, medianWithout;
  before(async () => {
    ({ classifyTurns, splitCaptions, medianWithout } = await import('../../server/dist/extractor/conversation/classify.js'));
  });
  const conv = (turns) => loadConversation({ sessions: [{ date: '2023-05-08', turns }] });

  it('a caption is split from the speech, and kept apart (2.1, 2.2)', () => {
    const x = splitCaptions('Look what I made! [image: a black-and-white bowl with a flower design]');
    assert.equal(x.speech, 'Look what I made!');
    assert.deepEqual(x.captions, ['a black-and-white bowl with a flower design']);
  });

  it('a photo and "Wow, great photo!" rides along; a photo with a real sentence does not (2.6)', () => {
    const [[a, b]] = classifyTurns(conv([
      { speaker: 'Mel', text: "Wow, that's a great photo! [image: two dogs in a field]" },
      { speaker: 'Mel', text: 'We adopted Bailey in August! [image: a dog]' },
    ]));
    assert.equal(a.ridesAlong, true);
    assert.equal(b.ridesAlong, false, 'a turn with its own fact must never ride along');
  });

  it('a pasted document is a candidate, with its reason; a normal turn is not (2.4)', () => {
    const doc = ['# Terms', '', '## Clause 4', 'The party of the first part…'.repeat(40)].join('\n');
    const [[short, pasted]] = classifyTurns(conv([
      { speaker: 'Dana', text: 'Can you read this for me?' },
      { speaker: 'Dana', text: doc },
    ]));
    assert.deepEqual(short.pasteReasons, []);
    assert.ok(pasted.pasteReasons.some(r => r === 'headings'), JSON.stringify(pasted.pasteReasons));
    assert.ok(pasted.pasteReasons.some(r => /chars against/.test(r)), JSON.stringify(pasted.pasteReasons));
  });

  it('the leave-one-out median agrees with the obvious one', () => {
    const naive = (xs, v) => { const c = [...xs]; c.splice(c.indexOf(v), 1); c.sort((a, b) => a - b);
      const n = c.length; return n === 0 ? 0 : n % 2 ? c[(n - 1) / 2] : (c[n / 2 - 1] + c[n / 2]) / 2; };
    for (const xs of [[5], [1, 9], [1, 2, 3], [4, 4, 4, 10], [3, 1, 4, 1, 5, 9, 2, 6]]) {
      const sorted = [...xs].sort((a, b) => a - b);
      for (const v of xs) assert.equal(medianWithout(sorted, v), naive(xs, v), `${JSON.stringify(xs)} without ${v}`);
    }
  });
});
