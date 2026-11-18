/**
 * A 100 000-character record id or file path that names nothing is answered in a few hundred bytes that still say WHAT was not found, on
 * the tool door, in every tool that quotes one (`Q-367`).
 *
 * ## The finding
 *
 * `update_fact` with a 100 000-character `id` answered `Error: Fact '<the id>' not found`: a refusal as large as the question. The
 * id is the caller's, and a refusal that carries it whole is a way to make this server write, log and ship 100 kB per call. The sentence
 * was written at each site; it is now built by one function (`notFoundSentence`, `util/errors.ts`) that cuts the value
 * (`peerText`, 256 characters, saying how many were cut).
 *
 * ## What is held, per tool
 *
 *  - the call is refused (an error result, 404 on the REST door of the same dispatch);
 *  - the text is under a ceiling of a few hundred bytes, whatever the size of the id;
 *  - it still names the kind of thing that was not found (`Fact`, `Edge`, `Entity`, `Chrono entry`, `File`, `Path`) and the front of
 *    the id, so the caller can find which one it sent;
 *  - it says how much was cut (`…(+N chars)`), and the id is nowhere in it whole;
 *  - an ordinary short id still comes back whole, in the words it always had (`Fact 'abc' not found`).
 *
 * ## Seen red
 *
 * On 873508ac every tool below answers the id whole (a text of over 100 000 characters).
 *
 * Run: a Mongo the harness accepts (`_mongo-harness.mjs`), then node --test <this file> (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';

const skip = await mongoSkipReason();

const SPACE = 'notfoundspace';
const FRONT = 'FRONTOFTHEVALUE';
const HUGE = FRONT + 'x'.repeat(100_000 - FRONT.length);
/** A few hundred bytes: the noun, the quoted window (256 characters), the cut count and the sentence round it. */
const CEILING = 600;
const CUT_MARK = /…\(\+\d+ chars\)/;

/** Each tool that quotes a record id or a path in its not-found answer: the call that names nothing, and the noun the text keeps. */
const TOOLS = [
  { tool: 'update_fact', noun: 'Fact', args: (v) => ({ space: SPACE, id: v, fact: 'changed' }) },
  { tool: 'delete_fact', noun: 'Fact', args: (v) => ({ space: SPACE, id: v }) },
  { tool: 'update_edge', noun: 'Edge', args: (v) => ({ space: SPACE, id: v, label: 'changed' }) },
  { tool: 'delete_edge', noun: 'Edge', args: (v) => ({ space: SPACE, id: v }) },
  { tool: 'update_entity', noun: 'Entity', args: (v) => ({ space: SPACE, id: v, description: 'changed' }) },
  { tool: 'delete_entity', noun: 'Entity', args: (v) => ({ space: SPACE, id: v }) },
  { tool: 'delete_entity_preview', noun: 'Entity', args: (v) => ({ space: SPACE, id: v }) },
  { tool: 'update_chrono', noun: 'Chrono entry', args: (v) => ({ space: SPACE, id: v, title: 'changed' }) },
  { tool: 'delete_chrono', noun: 'Chrono entry', args: (v) => ({ space: SPACE, id: v }) },
  { tool: 'delete_link', noun: 'Link', args: (v) => ({ space: SPACE, id: v }) },
  { tool: 'delete_file', noun: 'File', args: (v) => ({ space: SPACE, path: v }) },
  { tool: 'read_file', noun: 'File', args: (v) => ({ space: SPACE, path: v }) },
];

let door;

describe('a not-found answer to a huge id or path', { skip }, () => {
  before(async () => {
    door = await openToolDoor({ suite: 'notfoundhuge', spaces: [{ id: SPACE, label: SPACE, folders: [], completeLinkage: true }] });
  });
  after(async () => { await door?.close(); });

  for (const { tool, noun, args } of TOOLS) {
    describe(tool, () => {
      let out;
      before(async () => { out = await door.call(tool, args(HUGE)); });

      it('is refused', () => {
        assert.equal(out.result.isError, true, `${tool} did not refuse: ${out.text.slice(0, 200)}`);
      });

      it(`answers in under ${CEILING} characters`, () => {
        assert.ok(out.text.length < CEILING, `${tool} answered ${out.text.length} characters for a ${HUGE.length}-character value: ${out.text.slice(0, 120)}…`);
      });

      it(`still names the kind of thing not found (${noun}) and the front of the value, and says how much was cut`, () => {
        assert.ok(out.text.includes(noun), `${tool}: the answer does not say ${noun}: ${out.text.slice(0, 200)}`);
        assert.ok(out.text.includes(FRONT), `${tool}: the answer does not name the front of the value: ${out.text.slice(0, 200)}`);
        assert.match(out.text, CUT_MARK, `${tool}: the answer does not say how many characters were cut`);
        assert.ok(!out.text.includes(HUGE), `${tool}: the whole value is in the answer`);
      });
    });
  }

  it('an ordinary short id is still answered whole, in the words it always had', async () => {
    const fact = await door.call('update_fact', { space: SPACE, id: 'no-such-fact', fact: 'changed' });
    assert.equal(fact.text, "Error: Fact 'no-such-fact' not found");
    const file = await door.call('delete_file', { space: SPACE, path: 'no-such-file.txt' });
    assert.match(file.text, /File 'no-such-file\.txt' not found in space 'notfoundspace'/);
  });
});
