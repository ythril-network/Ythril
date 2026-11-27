/**
 * Two MCP answers that differ only in their timing durations are equal as raw text once the durations are set aside; any other difference is not
 * (`Q-976`, Full run 45986715572: the red-team indistinguishability case failed on the figures alone).
 *
 * The answers below are the two the failed run compared, cut to the lines that matter.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mcpAnswerSansDurations, mcpPhasesOf } from '../_shared/mcp-answer-sans-durations.mjs';

const answer = (timing, message = "Error: Space '<id>' not found") =>
  `event: message\ndata: {"result":{"_meta":{"ythril/server-timing":${timing}},"content":[{"type":"text","text":"${message}"}],"isError":true},"jsonrpc":"2.0","id":1}\n\n`;

const SLOW = '{"total":{"dur":215,"count":1},"auth":{"dur":211.64,"count":1},"rate":{"dur":0.08,"count":3},"door":{"dur":3.27,"count":1}}';
const FAST = '{"total":{"dur":2.19,"count":1},"auth":{"dur":0.02,"count":1},"rate":{"dur":0.03,"count":3},"door":{"dur":2.14,"count":1}}';
const EXPONENT = '{"total":{"dur":1e-7,"count":1},"auth":{"dur":0,"count":1},"rate":{"dur":0.03,"count":3},"door":{"dur":2.14,"count":1}}';

describe('an MCP answer with its durations set aside', () => {
  it('two answers that differ only in their durations are equal', () => {
    assert.notEqual(answer(SLOW), answer(FAST));
    assert.equal(mcpAnswerSansDurations(answer(SLOW)), mcpAnswerSansDurations(answer(FAST)));
    assert.equal(mcpAnswerSansDurations(answer(SLOW)), mcpAnswerSansDurations(answer(EXPONENT)));
  });

  it('sets only the durations: the phase names, the counts and the rest of the answer stay', () => {
    const zeroed = mcpAnswerSansDurations(answer(SLOW));
    assert.equal(zeroed, answer('{"total":{"dur":0,"count":1},"auth":{"dur":0,"count":1},"rate":{"dur":0,"count":3},"door":{"dur":0,"count":1}}'));
  });

  it('a different phase, a different count or a different message still tells two answers apart', () => {
    const base = mcpAnswerSansDurations(answer(FAST));
    assert.notEqual(base, mcpAnswerSansDurations(answer(FAST.replace('"door"', '"rights"'))), 'a phase only one answer ran');
    assert.notEqual(base, mcpAnswerSansDurations(answer(FAST.replace('"count":3', '"count":4'))), 'a phase run a different number of times');
    assert.notEqual(base, mcpAnswerSansDurations(answer(FAST, "Error: Space '<id>' is hidden")), 'a different message');
  });

  it('a duration written in the message text is not a figure and stays', () => {
    const text = answer(FAST, 'took \\"dur\\":5');
    assert.ok(mcpAnswerSansDurations(text).includes('took \\"dur\\":5'));
  });

  it('an answer with no timing comes back as it went in', () => {
    assert.equal(mcpAnswerSansDurations('data: {"result":{}}'), 'data: {"result":{}}');
  });
});

describe('the phases an MCP answer names', () => {
  it('are the phase names with their counts, in the server\'s order', () => {
    assert.deepEqual(mcpPhasesOf(answer(SLOW)), ['total:1', 'auth:1', 'rate:3', 'door:1']);
    assert.deepEqual(mcpPhasesOf(answer(SLOW)), mcpPhasesOf(answer(FAST)));
  });

  it('differ when a phase or a count differs', () => {
    assert.notDeepEqual(mcpPhasesOf(answer(FAST)), mcpPhasesOf(answer(FAST.replace('"door"', '"rights"'))));
    assert.notDeepEqual(mcpPhasesOf(answer(FAST)), mcpPhasesOf(answer(FAST.replace('"count":3', '"count":4'))));
  });

  it('are never read from an answer that has none', () => {
    assert.throws(() => mcpPhasesOf('data: {"result":{}}'), /carries no ythril\/server-timing/);
    assert.throws(() => mcpPhasesOf(answer('{}')), /names no phase/);
  });
});
