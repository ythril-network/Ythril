/**
 * Phase 8 of the conversation extractor — the timeline (`F-31`, DECOMPOSITION.md 8.1–8.4, with 3.9 and 3.11).
 *
 * A claim with a resolved date becomes a candidate event (8.1). The decision model answers three things about
 * it, in one request per claim: its status among completed / upcoming / cancelled / unclear (8.2 — `active` and
 * `overdue` are not options, so they cannot be written), whether it is merely ongoing with no stated start
 * (8.4), and — only when the conversation handed both ends — whether it genuinely lasted more than a day (3.9).
 * Code then applies the policy: unclear, ongoing, or no usable date means no chrono entry, and the date lives in
 * the claim. A span needs both ends handed AND a confident multi-day (3.11).
 *
 * Run: node --test testing/standalone/the-extractor-builds-its-timeline.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let buildTimeline;
before(async () => { ({ buildTimeline } = await import('../../server/dist/extractor/conversation/timeline.js')); });

const day = (value, extra = {}) => ({ precision: 'day', value, approximate: false, asOf: '2023-05-15', ...extra });
const model = (a) => { const calls = []; return { calls, decide: async (state, questions) => {
  calls.push({ state, questions });
  return { backend: 'jev', model: 'j', answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { type: q.type, ...a(id, q) }])) };
} }; };
const say = ({ status = 'completed', ongoing = 0.1, multi = 0.1 } = {}) => (id) =>
  id === 'status' ? { choice: status, probabilities: null, confidence: null } : id === 'ongoing' ? { noul: ongoing } : { noul: multi };

describe('what becomes an event', () => {
  it('a claim with a resolved day, completed, is an event on that day titled by the claim', async () => {
    const r = await buildTimeline([{ text: 'Ada adopted Luna on 9 May 2023.', entityIds: ['p1'], dates: [day('2023-05-09')] }], model(say()).decide);
    assert.deepEqual(r.events.map(e => [e.date, e.status, e.title, e.endsAt]), [['2023-05-09', 'completed', 'Ada adopted Luna on 9 May 2023.', undefined]]);
    assert.deepEqual(r.events[0].entityIds, ['p1']);
  });

  it('a claim with no day is not asked about at all', async () => {
    const m = model(say());
    const r = await buildTimeline([{ text: 'Ada moved in the spring.', entityIds: [], dates: [{ precision: 'none', approximate: false, asOf: '2023-05-15' }] }], m.decide);
    assert.equal(m.calls.length, 0);
    assert.deepEqual(r.events, []);
  });

  it('unclear, a refusal, or merely ongoing means no chrono entry — the date stays in the claim', async () => {
    const c = [{ text: 'Ada started a diet on 9 May 2023.', entityIds: [], dates: [day('2023-05-09')] }];
    assert.deepEqual((await buildTimeline(c, model(say({ status: 'unclear' })).decide)).events, []);
    assert.deepEqual((await buildTimeline(c, model(say({ ongoing: 0.9 })).decide)).events, []);
    assert.deepEqual((await buildTimeline(c, model((id) => (id === 'status' ? { choice: null, invalid: 'x' } : { noul: 0 })).decide)).events, []);
  });

  it('status comes only from the four options — active and overdue cannot be written', async () => {
    const m = model(say());
    await buildTimeline([{ text: 'x on 9 May 2023', entityIds: [], dates: [day('2023-05-09')] }], m.decide);
    assert.deepEqual(Object.keys(m.calls[0].questions.status.criteria).sort(), ['cancelled', 'completed', 'unclear', 'upcoming']);
  });
});

describe('a span needs both ends handed AND a confident multi-day', () => {
  const weekend = day('2023-05-13', { endsAt: '2023-05-14' });
  it('camping last weekend: both ends, lasted more than a day → a span', async () => {
    const r = await buildTimeline([{ text: 'Ada went camping on 13–14 May 2023.', entityIds: [], dates: [weekend] }], model(say({ multi: 0.9 })).decide);
    assert.deepEqual([r.events[0].date, r.events[0].endsAt], ['2023-05-13', '2023-05-14']);
  });
  it('a concert last weekend: both ends, an evening → no event, the date is in the claim', async () => {
    const r = await buildTimeline([{ text: 'Ada saw a concert on the weekend of 13 May 2023.', entityIds: [], dates: [weekend] }], model(say({ multi: 0.1 })).decide);
    assert.deepEqual(r.events, []);
  });
  it('the multi-day question is asked only when both ends were handed', async () => {
    const m = model(say());
    await buildTimeline([{ text: 'x on 9 May 2023', entityIds: [], dates: [day('2023-05-09')] }], m.decide);
    assert.ok(!('multiDay' in m.calls[0].questions));
  });
});
