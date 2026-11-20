/**
 * A rename moves the recorded RDF base conflict with its space (bundle-269, review finding 2).
 *
 * ## What it holds
 *
 * `NetworkConfig.rdfBaseConflicts` is keyed by the LOCAL id of a space, so a rename that moves the network's other per-space keys and
 * misses this one lifts the refusal silently (the export under the new id is served) and hands it to a space created later under the old
 * id. After a rename the conflict stands under the new id (the export of the renamed space is refused as before, the accept finds its
 * offer), nothing is left under the old id, and a network that does not carry the space is left as it is.
 *
 * The leave's half is `a-recorded-rdf-base-conflict-leaves-with-its-space.test.js`.
 *
 * Run: node --test testing/standalone/a-rename-moves-the-recorded-rdf-base-conflict.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const settle = await import('../../server/dist/spaces/rdf-settle.js');
const { applySpaceRenameToConfig } = await import('../../server/dist/spaces/rename.js');

const OLD = { enabled: true, base: 'https://old.example.org/ld/notes/', vocab: 'https://old.example.org/ld/notes/vocab/', baseEpoch: 0 };
const OFFERED = 'https://one.example.org/ld/notes/';
const netOf = (id, spaces) => ({ id, label: id, type: 'closed', spaces: [...spaces], members: [{ instanceId: 'p1' }], pendingRounds: [] });
const configOf = (...networks) => ({ spaces: [{ id: 'notes', label: 'notes', meta: { rdf: OLD } }], networks, tokens: [], views: [] });

/** A network carrying `notes`, with the conflict a member's higher base made. */
function conflicted(id = 'net-1') {
  const net = netOf(id, ['notes']);
  const spaces = [{ id: 'notes', label: 'notes', meta: { rdf: OLD } }];
  assert.equal(settle.takeServedRdfBases(net, spaces, { notes: { base: OFFERED, vocab: `${OFFERED}vocab/`, baseEpoch: 1 } }, 'p1'), true, 'the fixture recorded no conflict');
  return net;
}

describe('a rename moves the recorded conflict with its space', () => {
  it('the conflict stands under the new id and none is left under the old one', () => {
    const net = conflicted();
    const cfg = configOf(net);
    applySpaceRenameToConfig(cfg, cfg.spaces[0], 'notes', 'notes-2');
    assert.deepEqual(Object.keys(net.rdfBaseConflicts ?? {}), ['notes-2'], `the conflict is under ${JSON.stringify(Object.keys(net.rdfBaseConflicts ?? {}))}`);
    assert.ok(settle.rdfBaseConflictOf({ networks: [net] }, 'notes-2'), 'the export of the renamed space is served: a rename lifted the refusal');
    assert.equal(settle.rdfBaseConflictOf({ networks: [net] }, 'notes'), undefined, 'a space created under the old id inherits the refusal');
  });

  it('the offers it holds are untouched, so an accept still finds its offer', () => {
    const net = conflicted();
    const before = JSON.stringify(net.rdfBaseConflicts.notes);
    const cfg = configOf(net);
    applySpaceRenameToConfig(cfg, cfg.spaces[0], 'notes', 'notes-2');
    assert.equal(JSON.stringify(net.rdfBaseConflicts['notes-2']), before);
  });

  it('a network that does not carry the space is not touched', () => {
    const net = conflicted();
    const bystander = netOf('net-2', []);
    bystander.rdfBaseConflicts = { notes: net.rdfBaseConflicts.notes };
    const cfg = configOf(net, bystander);
    applySpaceRenameToConfig(cfg, cfg.spaces[0], 'notes', 'notes-2');
    assert.deepEqual(Object.keys(bystander.rdfBaseConflicts), ['notes'], 'a rename re-keyed an entry of a network that does not carry the space');
  });
});
