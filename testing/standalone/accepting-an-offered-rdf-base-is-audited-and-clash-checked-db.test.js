/**
 * An admin accepting the RDF base a peer of a voted network offered is audited and term-clash checked like any other base move (Q-748,
 * slice A-fix, review finding 7).
 *
 * The accept moves every address the space gives out. It used to take `meta` out of the write before the audit snapshot was taken, so the
 * `space.update` row showed no `rdf` change at all, and no merged meta was built, so the term-clash rule was never asked. Now:
 *
 * - the `space.update` change list names `rdf.base`, `rdf.vocab` and `rdf.baseEpoch`, before and after;
 * - an accept that would leave an explicit `iri` under the accepted vocab (or any other clash) is refused 422 `rdf_term_clash`, and the
 *   base, the conflict and the meta stay as they were.
 *
 * Run: node --test testing/standalone/accepting-an-offered-rdf-base-is-audited-and-clash-checked-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { P1 } from './_vote-round-sites.mjs';

const dir = tempInstanceDir('ythril-rdf-accept-');
const skip = await mongoSkipReason();
const OLD = { enabled: true, base: 'https://old.example.org/ld/notes/', vocab: 'https://old.example.org/ld/notes/vocab/', baseEpoch: 0 };
const NEW = 'https://new.example.org/ld/notes/';
const conflictOf = (space) => ({ held: { base: OLD.base, vocab: OLD.vocab, epoch: 0 },
  offered: [{ networkId: 'net', memberId: P1, base: NEW, vocab: `${NEW}vocab/`, epoch: 1 }] });

describe('accepting an offered RDF base', { skip }, () => {
  let inst, metaUpdate, auditChanges;
  before(async () => {
    await openTestMongo('rdf_accept_audit');
    inst = await bootSchemaInstance(dir, {
      spaces: [
        { id: 'notes', label: 'Notes', folders: [], meta: { rdf: OLD } },
        // An explicit address under the vocab the network moved to: a clash once that vocab is this space's.
        { id: 'clashy', label: 'Clashy', folders: [], meta: { rdf: OLD, typeSchemas: { entity: { Person: { iri: `${NEW}vocab/entity/Human` } } } } },
      ],
      networks: [{
        id: 'net', label: 'Net', type: 'closed', origin: 'created', syncSchedule: '', spaces: ['notes', 'clashy'], votingDeadlineHours: 24,
        createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
        members: [{ instanceId: P1, label: 'Peer', url: 'https://a1.example', tokenHash: 'h', direction: 'both' }],
        rdfBaseConflicts: { notes: conflictOf('notes'), clashy: conflictOf('clashy') },
      }],
    });
    metaUpdate = await import('../../server/dist/spaces/meta-update.js');
    ({ auditChanges } = await import('../../server/dist/audit/audit-changes.js'));
  });
  after(async () => {
    inst?.close();
    await closeTestMongo();
  });

  const spaceOf = (id) => inst.loader.getConfig().spaces.find(s => s.id === id);
  const accept = { meta: { rdf: { enabled: true, base: NEW, rebase: true } } };

  it('the space.update change list names the base, the vocab and the epoch, before and after', () => {
    const decision = metaUpdate.planSpaceMetaUpdate({ spaceId: 'notes', space: spaceOf('notes'), body: structuredClone(accept), ifMatch: undefined });
    assert.equal(decision.ok, true, JSON.stringify(decision.refusal ?? null));
    assert.ok(decision.plan.acceptRdf, 'the write was not read as an accept');
    const changes = auditChanges('space.update', decision.plan.audit.before, decision.plan.audit.after);
    const of = (field) => changes.find(c => c.field === field);
    assert.deepEqual(of('rdf.base'), { field: 'rdf.base', from: OLD.base, to: NEW }, `the accept moved the base unaudited: ${JSON.stringify(changes)}`);
    assert.deepEqual(of('rdf.vocab'), { field: 'rdf.vocab', from: OLD.vocab, to: `${NEW}vocab/` });
    assert.deepEqual(of('rdf.baseEpoch'), { field: 'rdf.baseEpoch', from: 0, to: 1 });
  });

  it('an accept that leaves a term clash is refused 422 rdf_term_clash and moves nothing', async () => {
    const answer = await inst.doors['space-patch']('clashy', accept.meta);
    assert.equal(answer.status, 422, `the accept skipped the term-clash rule: ${answer.text.slice(0, 300)}`);
    assert.match(answer.text, /rdf_term_clash/);
    assert.deepEqual(spaceOf('clashy').meta.rdf, OLD);
    assert.ok(inst.loader.getConfig().networks[0].rdfBaseConflicts?.clashy, 'a refused accept cleared the conflict');
  });
});
