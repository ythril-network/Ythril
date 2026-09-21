/**
 * Two vocabulary entries the corpus proved wrong by using them — one that nothing can reach, and one whose
 * absence split a relation in half.
 *
 * ## `active` cannot be written honestly
 *
 * The status was offered for something *"under way across the conversation — a course being taken, a build
 * in progress"*. Three extractions used it and all three reported the same problem: **`date` is defined as
 * the day it started, and an ongoing thing has no stated start.** One anchored a dance-studio venture to the
 * day it was announced and said so — *"the announcement day is the best available anchor, not a stated
 * start; the same slot would be a fabrication for anything less sharply announced."*
 *
 * And the record duplicates one that already exists: the studio is an `organization` entity in the same
 * file. **A chrono entry is a dated thing; something merely ongoing is a subject with a lifespan, which is
 * what an entity is for.** Founding it, launching it and closing it are events. Being open is not. That is
 * the argument that retired `plan`, applied one step further.
 *
 * ## `knows.kind` can say `ex_partner` and cannot say partner
 *
 * Two extractions hit this and **worked around it differently** — one left a bare `knows` with no `kind`,
 * the other used `family_of` with `relation: "partner"` on the ground that a partner is nearer kin than an
 * acquaintance. Both are defensible, both recorded their reasoning, and the corpus ended up holding one
 * relation under two labels so that a query for either finds half the partners.
 *
 * **A missing enum entry does not leave a visible hole. It leaves two populations that each look complete.**
 *
 * Run: node --test testing/standalone/the-status-and-relation-vocabularies-fit-what-people-say.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateExtraction } from '../../benchmarks/writer/validate-extraction.mjs';
import { loadSpaceDefinition } from '../../benchmarks/writer/write-space.mjs';

const { entries } = loadSpaceDefinition();

const base = (over = {}) => ({
  conversationId: 'conv-x',
  sessions: [{ date: '2023-07-17', turns: ['D1:1'] }],
  entities: [
    { key: 'ada', type: 'person', name: 'Ada', description: 'Ada, one of the two speakers.' },
    { key: 'bea', type: 'person', name: 'Bea', description: "Ada's partner, mentioned across the conversation." },
  ],
  chrono: [{ key: 'k', type: 'event', title: 'Ada went to the parade', date: '2023-07-15',
    status: 'completed', entities: ['ada'] }],
  claims: [{ text: 'Ada went to the parade.', speaker: 'Ada', statedOn: '2023-07-17',
    entities: ['ada'], chrono: ['k'], sourceTurns: ['D1:1'] }],
  ...over,
});

describe('`active` is gone', () => {
  it('REFUSES it, and the message says where an ongoing thing belongs', () => {
    const problems = validateExtraction(
      base({ chrono: [{ key: 'k', type: 'event', title: 'Jon ran his dance studio', date: '2023-01-20',
        status: 'active', entities: ['ada'] }] }), entries);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /status 'active'/);
    assert.match(problems[0], /entity/i, 'the refusal must say where the thing goes instead, or it is a wall');
  });

  it('and the three that remain are still accepted', () => {
    for (const status of ['completed', 'upcoming', 'cancelled']) {
      assert.deepEqual(validateExtraction(
        base({ chrono: [{ key: 'k', type: 'event', title: 't', date: '2023-07-15', status, entities: ['ada'] }] }),
        entries), [], `'${status}' was refused`);
    }
  });
});

describe('a partner has a label', () => {
  it('`knows` accepts `partner`', () => {
    assert.deepEqual(validateExtraction(
      base({ edges: [{ label: 'knows', from: 'ada', to: 'bea', properties: { kind: 'partner' } }] }),
      entries), []);
  });

  it('and `ex_partner` still works, because the pair is the point', () => {
    // Retiring the old one would be the opposite mistake: a conversation that says somebody's ex is exactly
    // the case the enum already handled, and the fix is that it can now say both.
    assert.deepEqual(validateExtraction(
      base({ edges: [{ label: 'knows', from: 'ada', to: 'bea', properties: { kind: 'ex_partner' } }] }),
      entries), []);
  });

  it('a kind the schema does not declare is still refused', () => {
    assert.ok(validateExtraction(
      base({ edges: [{ label: 'knows', from: 'ada', to: 'bea', properties: { kind: 'sweetheart' } }] }),
      entries).length >= 1, 'an undeclared kind was accepted, so the enum is not being read');
  });
});

describe('the committed corpus uses neither of the retired shapes', () => {
  it('no extraction carries a chrono entry with status `active`', async () => {
    const { readdirSync, readFileSync, existsSync } = await import('node:fs');
    const dir = 'benchmarks/locomo/extractions';
    const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : [];
    assert.ok(files.length >= 2, `only ${files.length} extractions — the sweep would be vacuous`);
    let chrono = 0;
    const offenders = [];
    for (const f of files) {
      for (const c of JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')).chrono ?? []) {
        chrono++;
        if (c.status === 'active') offenders.push(`${f}: ${c.key}`);
      }
    }
    // The floor: every assertion here is an absence, and a corpus with no chrono entries passes it silently.
    assert.ok(chrono >= 1, 'no extraction has any chrono entry at all, so this asserts nothing');
    assert.deepEqual(offenders, []);
  });
});
