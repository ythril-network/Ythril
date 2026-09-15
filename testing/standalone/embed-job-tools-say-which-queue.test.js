/**
 * The embed-job tools say which QUEUE they act on, and how to read a job's two counters.
 *
 * ## The trap in the names
 *
 * `list_embed_jobs` reports BRAIN embed jobs. `retry_embed_media` sits in the same module, next to it,
 * with a name that reads as its remedy — and re-queues the MEDIA queue instead: captioning, transcription,
 * document extraction. It imports `files/media/job-queue.js`, which is a fact about the code rather than a
 * suspicion.
 *
 * So the obvious sequence — list the failed embed jobs, then retry the failed embeddings — silently acts on a
 * different queue and reports a count that has nothing to do with what was listed. Nothing in either
 * description said so. The tool for a brain record is `retry_embed_record`.
 *
 * Renaming is the real fix and is a breaking change to a tool name; until then, each description says which
 * queue it is, which is the half that can ship today.
 *
 * ## Two counters that answer different questions
 *
 * As of the transient-failure change, a job carries `attempts` (the permanent-failure budget) and
 * `transientFailures` (the embedder did not answer). A high `transientFailures` with `attempts` at zero is an
 * outage waiting itself out and needs nothing; a `failed` job with `attempts` at its maximum is a record that
 * cannot be embedded and needs its content fixed. Reading one without the other gives the wrong answer in
 * both directions, and the field is new this release so nobody has prior knowledge of it.
 *
 * Run: node --test testing/standalone/embed-job-tools-say-which-queue.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('server/src/mcp/tools/embed.ts', 'utf8');
/**
 * The tool's DESCRIPTION only — from `description:` to the next sibling key.
 *
 * Slicing "to the next `name: '`" reads too far: the next tool's doc comment sits above its object, so the
 * slice swallows it and a `doesNotMatch` assertion fails on a tool name that appears in the NEIGHBOUR's
 * prose. That is a false positive in the test, and it looked exactly like a real one.
 */
const at = (name) => {
  const i = SRC.indexOf(`name: '${name}'`);
  assert.ok(i > 0, `${name} was not found — the scanner is wrong, not the code`);
  return i;
};

const tool = (name) => {
  const start = at(name);
  const desc = SRC.indexOf('description:', start);
  assert.ok(desc > start, `${name} has no description`);
  const end = SRC.slice(desc).search(/\n {2}(mutating|spaceRequired|inputSchema|async handle):/);
  assert.ok(end > 0, `could not find the end of ${name}'s description`);
  return SRC.slice(desc, desc + end);
};

/** The whole tool object, handler included — for pinning prose against what the code actually imports. */
const body = (name) => {
  const start = at(name);
  const end = SRC.indexOf('\nexport const ', start);
  return end === -1 ? SRC.slice(start) : SRC.slice(start, end);
};

const LIST = tool('list_embed_jobs');
const RETRY_ALL = tool('retry_embed_media');
const RETRY_ALL_BODY = body('retry_embed_media');

describe('the queue each tool acts on is stated', () => {
  it('the NAME says media now, so the description need not open with a correction', () => {
    // This required the description to LEAD with `THE MEDIA QUEUE, NOT THE BRAIN ONE`, because the tool was
    // called `retry_failed_embeddings` and a caller reading one line had to be stopped before acting. X-3
    // renamed it, so the correction stops being the first sentence and becomes history.
    //
    // Inverted rather than deleted: the rule never changed. Something must say which queue this acts on,
    // unmissably — only which of the name and the prose carries it has moved.
    assert.match(RETRY_ALL, /MEDIA, NOT THE BRAIN QUEUE/, 'still stated, just no longer as an apology');
    assert.match(RETRY_ALL, /`retry_failed_embeddings` until 3\.1/,
      'and the OLD name is named, so an integrator hitting an unknown-tool error can find out why');
    assert.match(RETRY_ALL, /retry_embed_record/, 'name the tool that does the brain-side job');
  });

  it('and that it really is the media queue, not a stale comment', () => {
    // Pinned against the import rather than trusting the prose either way — this is the assertion that makes
    // the description checkable rather than plausible.
    // Reads the whole tool object, not just the description — the import is in the handler, and the point of
    // this assertion is precisely that the two must agree.
    assert.match(RETRY_ALL_BODY, /files\/media\/job-queue\.js/,
      'if this ever switches to the brain queue, the description above becomes a lie and must change with it');
  });

  it('list_embed_jobs does NOT name a mutating tool, and says why', () => {
    // `mcp-help.test.js` refused the first draft: help() for a read-only token must not mention a tool that
    // token cannot reach, and this description named two. The warning about the confusing name therefore
    // lives on the mutating tool itself, where only a caller who can act on it sees it.
    //
    // What replaces it is the more useful fact anyway: an absent retry in help() means THIS TOKEN cannot
    // retry, not that no such tool exists — which is the wrong conclusion a read-only caller would otherwise
    // draw and report.
    assert.doesNotMatch(LIST, /retry_record_embedding|retry_failed_media_embeddings/,
      'a read-only tool must not advertise a mutating one');
    assert.match(LIST, /only REPORTS/, 'say what this tool does and does not do');
    assert.match(LIST, /cannot retry rather than that no such tool exists/,
      'pre-empt the wrong conclusion from an absent tool');
  });
});

describe('the two counters are explained', () => {
  it('says attempts is the permanent-failure budget', () => {
    assert.match(LIST, /PERMANENT-failure budget/, 'attempts is spent on what a retry cannot fix');
  });

  it('says transientFailures never goes terminal', () => {
    assert.match(LIST, /NEVER go terminal/,
      'an outage backs off instead of giving up — that is the whole point of the second counter');
  });

  it('gives the reading for each combination, which is the actionable half', () => {
    assert.match(LIST, /needs nothing from you/, 'high transientFailures, zero attempts: wait');
    assert.match(LIST, /needs the content fixed/, 'failed at max attempts: the record is the problem');
  });

  it('mentions the per-version revive, so an operator does not retry by hand after an upgrade', () => {
    assert.match(LIST, /once per server VERSION/,
      'an upgrade already retries everything that died under the old version');
  });
});
