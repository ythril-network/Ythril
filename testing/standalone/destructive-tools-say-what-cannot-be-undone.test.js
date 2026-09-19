/**
 * A destructive tool says so, and says what to do instead when the caller meant something gentler.
 *
 * ## X-2, the entity-management family
 *
 * `graph_merge` and `delete_entity` both described their mechanics accurately and neither said the word
 * that matters most to an agent deciding whether to call them: **irreversible**. An agent weighing a tool
 * call has no undo and no confirmation dialog; the schema is the only place that warning can live.
 *
 * ## The 409 that is not an error
 *
 * `graph_merge` is two-phase: call it with an empty resolution and it answers **409 with a conflict plan**.
 * That is the question being asked, not a failure — but a client with a generic retry-on-4xx path will hammer
 * it, and one with a generic fail-on-4xx path will report a merge as broken. The description now says the
 * first call is expected to 409.
 *
 * ## And the gentler thing they probably meant
 *
 * A caller reaching for `delete_entity` often wants the record to stop cluttering recall, not to be gone.
 * That is `suppressEmbeddings`, which keeps it readable and traversable — and a schema that does not
 * name the alternative is one where the destructive option is the only one anybody finds.
 *
 * A refusal under `strictLinkage` is the same shape: it is usually CORRECT, and reads as an obstacle unless
 * the description says it means the deletion would orphan something.
 *
 * Run: node --test testing/standalone/destructive-tools-say-what-cannot-be-undone.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('server/src/mcp/tools/entity.ts', 'utf8');
const tool = (name) => {
  const at = SRC.indexOf(`name: '${name}'`);
  assert.ok(at > 0, `${name} was not found — the scanner is wrong, not the code`);
  const next = SRC.indexOf("name: '", at + 20);
  return next === -1 ? SRC.slice(at) : SRC.slice(at, next);
};

const MERGE = tool('graph_merge');
const DELETE = tool('delete_entity');

describe('both say they cannot be undone', () => {
  for (const [label, text] of [['graph_merge', MERGE], ['delete_entity', DELETE]]) {
    it(`${label} says IRREVERSIBLE`, () => {
      // An agent has no undo and no confirmation dialog. The schema is where the warning has to live.
      assert.match(text, /IRREVERSIBLE/, 'say it in the description, not only in the docs');
    });
  }
});

describe('graph_merge: the 409 is the question, not a failure', () => {
  it('says the first call is expected to 409 with a plan', () => {
    // A generic retry-on-4xx client hammers it; a generic fail-on-4xx client reports a working merge as
    // broken. Both are avoidable by saying which status the happy path returns.
    assert.match(MERGE, /CONFLICT PLAN/, 'name what comes back');
    assert.match(MERGE, /expected path/,
      'say the 409 is expected — otherwise it reads as an error to handle');
  });

  it('says a partial resolution merges NOTHING', () => {
    assert.match(MERGE, /RESOLVE EVERY CONFLICT OR NOTHING HAPPENS/,
      'a half-merge would leave two records that are neither separate nor one');
  });

  it('says non-conflicting properties never appear in the plan', () => {
    // Otherwise a short plan looks like the tool missed something.
    assert.match(MERGE, /without appearing in the plan/,
      'a plan listing only conflicts is complete, not partial');
  });
});

describe('delete_entity: the alternative, and why a refusal is right', () => {
  it('names suppressEmbeddings as the gentler thing', () => {
    // The commonest actual intent — stop it cluttering recall — is not a delete at all.
    assert.match(DELETE, /suppressEmbeddings/,
      'a schema that does not name the alternative makes the destructive option the only discoverable one');
    assert.match(DELETE, /readable and traversable/, 'say what the alternative preserves');
  });

  it('says a strictLinkage refusal is usually CORRECT', () => {
    assert.match(DELETE, /usually correct/i,
      'it reads as an obstacle unless the description says it means an orphan would be created');
    assert.match(DELETE, /graph_merge/, 'point at the tool that resolves it properly');
  });

  it('explains the tombstone rather than just naming it', () => {
    assert.match(DELETE, /will not quietly resurrect/,
      'the tombstone exists so a peer does not re-add the record — say the consequence');
  });
});
