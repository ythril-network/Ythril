/**
 * A nested config reference held across an await is orphaned by a reload — and the write that
 * commits it then lands nowhere.
 *
 * The config watcher reloads `config.json` whenever it changes on disk. `reloadConfig` refreshes the
 * config object IN PLACE, so a top-level reference (`const cfg = getConfig()`) survives. A reference
 * INTO it does not: `cfg.spaces` and `cfg.tokens` are replaced wholesale, so a `space` or `token`
 * object looked up before the await is a detached orphan afterwards.
 *
 * That is not theoretical. It has now produced two real defects:
 *
 *   - a token's lookup-prefix backfill written to an orphaned record, leaving the token on the slow
 *     full-scan path forever (fixed in #348);
 *   - a space rename committed to an orphaned space object, so the collections moved, the API
 *     returned 200, and config kept the OLD id — a rename that silently did not happen.
 *
 * The rename case is the nastier of the two because every signal says success. These tests pin the
 * mechanism itself, without a database, so the next read-modify-write across an await has something
 * to fail against.
 *
 * Run: node --test testing/standalone/config-detached-refs.test.js
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-detach-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH; // read at module load — set before importing

let loader;

const readDisk = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

function seed() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    instanceId: 'test-instance', instanceLabel: 'test', tokens: [], networks: [
      { id: 'net1', label: 'Net 1', type: 'club', spaces: [], members: [], pendingRounds: [], createdAt: '2026-01-01T00:00:00Z' },
    ],
    spaces: [{ id: 'alpha', label: 'Alpha', builtIn: false, folders: [] }],
  }, null, 2), { mode: 0o600 });
  loader.loadConfig();
}

describe('a reload detaches nested references', () => {
  before(async () => { loader = await import('../../server/dist/config/loader.js'); });
  beforeEach(() => seed());

  it('the config object itself survives a reload — that is why top-level writes are safe', () => {
    const cfg = loader.getConfig();
    loader.reloadConfig();
    assert.equal(cfg, loader.getConfig(), 'refreshed in place, so the same object stays current');
  });

  it('but a reference INTO it does not', () => {
    const cfg = loader.getConfig();
    const space = cfg.spaces.find(s => s.id === 'alpha');
    loader.reloadConfig();
    assert.notEqual(
      space, loader.getConfig().spaces.find(s => s.id === 'alpha'),
      'cfg.spaces is replaced wholesale, so the held object is now an orphan',
    );
  });

  it('committing through the orphan loses the change — and reports success', () => {
    // This is the shape that produced the silent rename: look up, await something slow, mutate the
    // object you looked up, save. Nothing throws. Nothing warns.
    const cfg = loader.getConfig();
    const space = cfg.spaces.find(s => s.id === 'alpha');

    loader.reloadConfig();          // stands in for the watcher firing mid-await

    space.id = 'renamed';           // mutating the orphan
    loader.saveConfig(cfg);

    assert.equal(
      readDisk().spaces[0].id, 'alpha',
      'the rename was lost: the write "succeeded" and the id never changed',
    );
  });

  it('re-resolving by id inside mutateConfig commits it', () => {
    const cfg = loader.getConfig();
    const space = cfg.spaces.find(s => s.id === 'alpha');
    const heldId = space.id;

    loader.reloadConfig();          // orphan the reference again

    loader.mutateConfig(fresh => {
      const live = fresh.spaces.find(s => s.id === heldId);
      live.id = 'renamed';
    });

    assert.equal(readDisk().spaces[0].id, 'renamed', 'the rename lands');
  });

  it('mutateConfig also preserves a change another writer made meanwhile', () => {
    // Re-reading is what makes this safe, so it must not trample the file it re-read.
    const cfg = loader.getConfig();
    cfg.spaces.push({ id: 'beta', label: 'Beta', builtIn: false, folders: [] });
    loader.saveConfig(cfg);

    loader.mutateConfig(fresh => {
      fresh.spaces.find(s => s.id === 'alpha').label = 'Alpha Renamed';
    });

    const disk = readDisk();
    assert.equal(disk.spaces.find(s => s.id === 'alpha').label, 'Alpha Renamed');
    assert.ok(disk.spaces.some(s => s.id === 'beta'), 'the other writer\'s space must survive');
  });

  // ── The invite finalize shape: push into a nested array across a slow await ──────────────────
  //
  // `POST /api/invite/finalize` looks up `net = cfg.networks.find(...)`, then `await bcrypt.hash`
  // (deliberately slow), then pushes the new member into `net.members` and saves. If the watcher
  // reloads during the hash, `net` is an orphan and the join is written to nowhere — the caller gets
  // 200 with the membership silently absent. Same failure as the rename above; this pins it for the
  // networks array specifically, which is the collection the invite path mutates.

  it('a network member pushed through a pre-reload reference is lost — and reports success', () => {
    const cfg = loader.getConfig();
    const net = cfg.networks.find(n => n.id === 'net1');   // taken BEFORE the (simulated) await

    loader.reloadConfig();                                  // watcher fires during bcrypt

    net.members.push({ instanceId: 'joiner', label: 'Joiner' }); // mutating the orphan
    loader.saveConfig(cfg);

    assert.equal(
      readDisk().networks.find(n => n.id === 'net1').members.length, 0,
      'the join was lost: saveConfig persisted the pre-reload snapshot',
    );
  });

  it('re-finding the network AFTER the reload commits the join — the finalize fix', () => {
    const cfg = loader.getConfig();
    cfg.networks.find(n => n.id === 'net1');                // the stale lookup the old code kept

    loader.reloadConfig();                                  // watcher fires during bcrypt

    // The fix: re-read and re-find immediately before mutating, exactly as invite.ts now does.
    const fresh = loader.getConfig();
    const liveNet = fresh.networks.find(n => n.id === 'net1');
    liveNet.members.push({ instanceId: 'joiner', label: 'Joiner' });
    loader.saveConfig(fresh);

    const persisted = readDisk().networks.find(n => n.id === 'net1').members;
    assert.equal(persisted.length, 1, 'the join lands');
    assert.equal(persisted[0].instanceId, 'joiner');
  });

  it('a network deleted during the window is not resurrected by the fresh re-find', () => {
    // invite.ts returns 409 rather than recreating the network from a stale snapshot. The primitive
    // that makes that possible: after a reload that removed the network, re-finding it yields
    // undefined, so the handler can detect the deletion instead of pushing into a ghost.
    const cfg = loader.getConfig();
    cfg.networks.find(n => n.id === 'net1');

    // Another writer deletes the network, then the watcher reloads our view from that new state.
    const other = loader.getConfig();
    other.networks = other.networks.filter(n => n.id !== 'net1');
    loader.saveConfig(other);
    loader.reloadConfig();

    assert.equal(
      loader.getConfig().networks.find(n => n.id === 'net1'), undefined,
      'the fresh re-find must report the network gone, so finalize can 409 instead of resurrecting it',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The response side of the same mechanism
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('invite generate — the RESPONSE is built from fresh config, not the entry snapshot', () => {
  const src = fs.readFileSync(new URL('../../server/src/api/invite.ts', import.meta.url), 'utf8');
  const generateAt = src.indexOf("inviteRouter.post('/generate'");
  const applyAt = src.indexOf("inviteRouter.post('/apply'");
  const handler = src.slice(generateAt, applyAt);

  it('re-reads config after the slow awaits rather than reusing the entry snapshot', () => {
    // This handler generates an RSA-4096 key pair and bcrypt-hashes the handshake id before it
    // responds — both deliberately slow. The config snapshot taken on entry can be hundreds of
    // milliseconds stale by the time the response is assembled, so an admin correcting `publicUrl`
    // in that window would have the invite hand out the OLD url anyway. No lost write, but a wrong
    // answer that looks authoritative.
    // The hash lives in `openSession` (api/invite-sessions.ts) since the store moved; awaiting it is the slow step.
    const hashAt = handler.indexOf('await openSession(');
    const refreshAt = handler.indexOf('const fresh = getConfig();');
    assert.ok(hashAt > 0, 'expected the awaited session open (which bcrypt-hashes the id) to still be in this handler');
    assert.ok(refreshAt > hashAt, 'config must be re-read AFTER the slow awaits, not before');
  });

  it('builds both stale-able response fields from the fresh read', () => {
    // `publicUrl` and the network's `spaces` are the two fields the joining instance acts on.
    // From where the RESPONSE BODY is assembled, not from `res.status(201)`. The 201 line now sends a
    // `bundle` built a few lines above it -- the same object, one indirection later -- and anchoring on the
    // send call read past the very fields this case is about.
    const responseAt = handler.indexOf('const bundle = {');
    assert.ok(responseAt > 0, 'the response body is no longer assembled as `bundle` -- re-anchor this');
    const response = handler.slice(responseAt);
    assert.match(handler.slice(0, responseAt), /const baseUrl = \(fresh\.publicUrl/,
      'the invite URL must come from the fresh config');
    assert.match(response, /spaces: freshNet\.spaces/,
      'the advertised space list must come from the freshly re-found network');
  });

  it('drops the session when the network vanished during the window', () => {
    // A live invite pointing at a network that no longer exists is worse than no invite: the
    // handshake would be accepted right up until apply, then fail with nothing to explain it.
    assert.match(handler, /dropSession\(sessionKey\)/,
      'a network deleted mid-handshake must invalidate the session it created');
  });
});
