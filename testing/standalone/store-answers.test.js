/**
 * "Does the store answer?" — the question a walk asks when one operation hung, to tell a hung SPACE from a dead STORE
 * (`Q-274`, bundle-53 G8).
 *
 * ## What is pinned
 *
 * - the ping is sent as `{ ping: 1, maxTimeMS: 3000 }` with an abort `signal`, on the raw client's `admin` database, and raced with a
 *   timer at the same figure that answers `false`. Without that clock a ping against a store that stopped answering waits for server
 *   selection after the pool cleared: 54 s was measured (probe P6). The driver's own `timeoutMS` is used for nothing (`Q-716`);
 * - the answer is a boolean and the function NEVER throws (a client that is not connected yet is `false`: nothing to ask);
 * - the answer is memoised for 10 s, so a walk that fails a hundred records asks once, not a hundred times (P-2).
 *
 * The ping goes through the raw client, deliberately outside `getDb()`: a ping carries its own `maxTimeMS` and `signal`, and a scope's bound
 * on a ping about the bound would be a bound about itself. The real-store half is
 * `a-store-answers-ping-ends-in-its-bound-db.test.js`.
 *
 * Run: node --test testing/standalone/store-answers.test.js   (requires a prior build of server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStoreAnswers, storeAnswers, STORE_ANSWERS_TTL_MS } from '../../server/dist/db/store-answers.js';
import { createProbeCache } from '../../server/dist/util/cached-probe.js';

/** A client whose `admin` db records every command, and answers or fails as told. */
function fake(behave = 'ok') {
  const sent = [];
  const client = {
    db: (name) => ({
      command: async (cmd, opts) => {
        sent.push({ db: name, cmd, opts });
        if (behave === 'fails') throw new Error('MongoOperationTimeoutError: Timed out');
        return { ok: 1 };
      },
    }),
  };
  return { sent, client };
}

function make(behave, { client } = {}) {
  const f = fake(behave);
  const clock = { t: 0 };
  const answers = createStoreAnswers({ client: client ?? (() => f.client), cache: createProbeCache({ now: () => clock.t }) });
  return { ...f, clock, answers };
}

describe('storeAnswers', () => {
  it('sends { ping: 1, maxTimeMS: 3000 } to the admin database with an abort signal and no timeoutMS', async () => {
    const { sent, answers } = make('ok');
    assert.equal(await answers(), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].db, 'admin');
    assert.deepEqual(sent[0].cmd, { ping: 1, maxTimeMS: 3000 });
    assert.ok(sent[0].opts.signal instanceof AbortSignal, 'the ping carries no signal: a call the timer gave up on would stay on its connection');
    assert.equal('timeoutMS' in sent[0].opts, false, 'the driver\'s client-side timeout was set on the ping');
  });

  it('takes the ping\'s bound as an argument', async () => {
    const { sent, answers } = make('ok');
    await answers(1500);
    assert.equal(sent[0].cmd.maxTimeMS, 1500);
  });

  it('is false past the bound when the ping never settles, and the ping\'s signal is aborted', async () => {
    const hold = setInterval(() => {}, 60_000); // the ping's timer is unref'd on purpose: the case holds the loop open itself
    try {
      const { sent, answers } = make('ok', { client: () => ({ db: () => ({ command: (cmd, opts) => { sent.push({ cmd, opts }); return new Promise(() => {}); } }) }) });
      const t0 = Date.now();
      assert.equal(await answers(40), false);
      assert.ok(Date.now() - t0 >= 30, 'answered before the bound');
      assert.equal(sent[0].opts.signal.aborted, true, 'a ping the timer gave up on was left running on its connection');
    } finally {
      clearInterval(hold);
    }
  });

  it('is false when the ping fails', async () => {
    const { answers } = make('fails');
    assert.equal(await answers(), false);
  });

  it('is false, not an exception, when there is no client: the store has not been connected yet', async () => {
    const { answers } = make('ok', { client: () => { throw new Error('MongoDB not connected'); } });
    assert.equal(await answers(), false);
  });

  it('is memoised for 10 s, a false included', async () => {
    for (const behave of ['ok', 'fails']) {
      const { sent, clock, answers } = make(behave);
      for (let i = 0; i < 50; i++) await answers();
      assert.equal(sent.length, 1, `${behave}: fifty asks, one ping`);
      clock.t = STORE_ANSWERS_TTL_MS - 1;
      await answers();
      assert.equal(sent.length, 1, `${behave}: inside the 10 s`);
      clock.t = STORE_ANSWERS_TTL_MS;
      await answers();
      assert.equal(sent.length, 2, `${behave}: at the 10 s it asks again`);
    }
  });

  it('callers arriving during one ping share it', async () => {
    const { sent, answers } = make('ok');
    const all = await Promise.all(Array.from({ length: 8 }, () => answers()));
    assert.deepEqual(all, Array(8).fill(true));
    assert.equal(sent.length, 1);
  });

  it('the default instance, with no connection made, answers false and does not throw', async () => {
    assert.equal(await storeAnswers(), false);
  });
});
