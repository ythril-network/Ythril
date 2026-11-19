/**
 * A member that missed a passed rebase (offline for the whole voting period, so its adoption refused the round as past its deadline) is told,
 * never left naming the space by another base without knowing it (Q-748; design r4 §4.1 rule 4: "a higher epoch this member holds no round
 * for" is a named conflict).
 *
 * Where a network sends its schema as a layer (pub/sub and braintree, from the upstream), the layer carries the upstream's `rdf` with its
 * higher `baseEpoch`. The member keeps its own base (nothing moves a stored base but a landed round) and the effective-meta recompute records
 * the conflict beside that network (`NetworkConfig.rdfBaseConflicts`), which the RDF doors answer 409 on. A layer at the epoch of a passed
 * round still to land here is early and records nothing; a layer that agrees clears it.
 *
 * Run: node --test testing/standalone/a-member-that-missed-a-rebase-is-told-by-the-conflict.test.js (after the server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SELF = 'aaaaaaaa-0000-4000-8000-000000005e1f';
const UP = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const OLD = { enabled: true, base: 'https://old.example.org/ld/notes/', vocab: 'https://old.example.org/ld/notes/vocab/', baseEpoch: 0 };
const NEW = { enabled: true, base: 'https://new.example.org/ld/notes/', vocab: 'https://new.example.org/ld/notes/vocab/', baseEpoch: 1 };

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-missed-rebase-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

let loader, effective, settle;
before(async () => {
  loader = await import('../../server/dist/config/loader.js');
  fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
    instanceId: SELF, instanceLabel: 'self', tokens: [],
    spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }, { id: 'notes', label: 'Notes', folders: [], meta: { rdf: OLD } }],
    networks: [{
      id: 'net-1', label: 'Net', type: 'pubsub', origin: 'joined', syncSchedule: '', spaces: ['notes'], votingDeadlineHours: 24,
      createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
      members: [{ instanceId: UP, label: 'Publisher', url: 'https://a1.example', tokenHash: 'h', direction: 'pull' }],
    }],
  }), { mode: 0o600 });
  loader.loadConfig();
  effective = await import('../../server/dist/spaces/effective-meta.js');
  settle = await import('../../server/dist/spaces/rdf-settle.js');
});
after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } });

const net = () => loader.getConfig().networks[0];
const space = () => loader.getConfig().spaces.find(s => s.id === 'notes');
function layer(rdf, rounds = []) {
  net().schemaLayers = { notes: { rdf } };
  net().pendingRounds = rounds;
  effective.recomputeEffectiveMeta('notes', true);
}

describe('a member that missed a passed rebase', () => {
  it('keeps its own base and is told: the layer\'s higher epoch, with no round held for it, is a conflict beside that network', () => {
    layer(NEW);
    assert.equal(space().meta.rdf.base, OLD.base, 'a layer moved the stored base');
    const conflict = settle.rdfBaseConflictOf(loader.getConfig(), 'notes');
    assert.deepEqual(conflict, { held: { base: OLD.base, vocab: OLD.vocab, epoch: 0 }, offered: [{ networkId: 'net-1', base: NEW.base, vocab: NEW.vocab, epoch: 1 }] });
  });
  it('a layer at the epoch of a passed round still to land here is early, and records nothing', () => {
    const passed = {
      roundId: 'r-1', type: 'space_rebase', spaceId: 'notes', rebase: { base: NEW.base, vocab: NEW.vocab, epoch: 1 }, subjectInstanceId: UP,
      subjectLabel: 'Publisher', subjectUrl: '', openedAt: new Date().toISOString(), deadline: new Date(Date.now() + 3_600_000).toISOString(),
      votes: [{ instanceId: UP, vote: 'yes', castAt: new Date().toISOString() }], concluded: true, passed: true,
    };
    layer(NEW, [passed]);
    assert.equal(settle.rdfBaseConflictOf(loader.getConfig(), 'notes'), undefined);
  });
  it('a layer that agrees clears it', () => {
    layer(NEW);
    assert.ok(settle.rdfBaseConflictOf(loader.getConfig(), 'notes'));
    layer(OLD);
    assert.equal(settle.rdfBaseConflictOf(loader.getConfig(), 'notes'), undefined);
  });
});
