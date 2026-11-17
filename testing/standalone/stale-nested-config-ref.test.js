/**
 * A config write through a NESTED reference is lost if a reload lands first.
 *
 * ## Where this came from
 *
 * `loader.ts` mutates the top-level config object in place on reload, precisely so that a handler holding
 * `const cfg = getConfig()` across an await still saves onto fresh data. Its own comment names the leak in
 * that scheme:
 *
 *   > a reference held to a NESTED object (a single `space` out of `cfg.spaces`) is still detached, because
 *   > the arrays are replaced wholesale. Those sites are listed in ARCHITECTURE-TODO and want `mutateConfig`.
 *
 * They were not listed — the item had been dropped from that file while the code kept pointing at it.
 * Found 2026-08-01 by grepping source TODO markers rather than trusting the tracker.
 *
 * ## Why it is not theoretical, which is what had to be established first
 *
 * A reload happens at RUNTIME from three places, and two of them are reachable by a **remote peer**:
 * the config-file watcher (`applyConfigFromDisk`), `POST /api/sync/members`, and `POST /api/sync/votes`.
 * So a peer casting a vote can reload the config while a local network join is awaiting a bcrypt hash —
 * and every site that matches the dangerous shape is in exactly that code (two in `networks/join.ts`, one
 * in the token prefix backfill).
 *
 * ## What this pins
 *
 * The loss itself, against the real loader — no server, no Mongo. Then that `mutateConfig` is the fix, so
 * the repair is demonstrated rather than asserted. The scan for the SHAPE lives in the same suite, so a new
 * site cannot appear without failing here.
 *
 * Run: node --test testing/standalone/stale-nested-config-ref.test.js
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { trackedSources, SERVER_CODE_ROOTS } from './_sources.mjs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let loadConfig, saveConfig, reloadConfig, mutateConfig, getConfig;
let dir, cfgPath;

const seed = () => ({
  instanceId: 'i-1',
  instanceLabel: 'Test',
  spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }],
  tokens: [],
  networks: [{
    id: 'n1', label: 'Net One', type: 'democratic', spaces: ['general'],
    members: [{ instanceId: 'i-1', label: 'Test', url: 'https://a.test' }],
    pendingRounds: [], votingDeadlineHours: 24,
  }],
});

describe('a write through a nested config reference', () => {
  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ythril-nested-'));
    cfgPath = path.join(dir, 'config.json');
    process.env['CONFIG_PATH'] = cfgPath;
    // Imported AFTER CONFIG_PATH is set: the loader reads it once, at module load.
    ({ loadConfig, saveConfig, reloadConfig, mutateConfig, getConfig } =
      await import('../../server/dist/config/loader.js'));
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  beforeEach(() => {
    writeFileSync(cfgPath, JSON.stringify(seed(), null, 2), 'utf8');
    loadConfig();
  });

  const onDisk = () => JSON.parse(readFileSync(cfgPath, 'utf8'));

  it('survives when NO reload happens — so the test is about the reload, not about the pattern', () => {
    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === 'n1');
    net.members.push({ instanceId: 'i-2', label: 'Peer', url: 'https://b.test' });
    saveConfig(cfg);
    assert.equal(onDisk().networks[0].members.length, 2, 'the ordinary path must work');
  });

  it('IS LOST when a reload lands between the find and the write', () => {
    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === 'n1');

    // What a peer's vote or member update does mid-await. Nothing about it is exotic: it is the same
    // `reloadConfig()` two sync routes call on every request.
    reloadConfig();

    net.members.push({ instanceId: 'i-2', label: 'Peer', url: 'https://b.test' });
    saveConfig(getConfig());

    assert.equal(onDisk().networks[0].members.length, 1,
      'the pushed member is expected to be LOST — this is the defect being pinned, not desired behaviour');
  });

  it('the top-level reference is NOT affected, which is why this leak is easy to miss', () => {
    // `cfg` itself stays valid across a reload — that is what the in-place mutation buys. Only the nested
    // object detaches, so the same handler can look correct in one line and be broken in the next.
    const cfg = getConfig();
    reloadConfig();
    cfg.instanceLabel = 'Renamed';
    saveConfig(cfg);
    assert.equal(onDisk().instanceLabel, 'Renamed');
  });

  it('mutateConfig is the fix: the write survives the same reload', () => {
    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === 'n1');
    assert.ok(net, 'bound before the await, as the real handlers do');

    reloadConfig();   // the same interference

    mutateConfig(fresh => {
      const freshNet = fresh.networks.find(n => n.id === 'n1');
      freshNet.members.push({ instanceId: 'i-2', label: 'Peer', url: 'https://b.test' });
    });

    assert.equal(onDisk().networks[0].members.length, 2, 'mutateConfig re-reads, applies, and saves');
  });
});

describe('no NEW site holds a nested config reference across an await and writes through it', () => {
  const files = trackedSources(SERVER_CODE_ROOTS);
  /**
   * Blanks comments IN PLACE, so reported line numbers match the file.
   *
   * The first version deleted comment lines outright and then reported the line index of the stripped
   * text — which named `join.ts:169` for code that lives at 212. A gate that points at the wrong line is
   * worse than no gate: it sends the reader to innocent code and, when they find nothing wrong there, it
   * teaches them the gate is noise.
   */
  const strip = s => s
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n\r]/g, ' '))
    .replace(/^(\s*)\/\/.*$/gm, (_m, indent) => indent);

  /**
   * The three sites this was found at, each fixed by routing the write through `mutateConfig`. Listed as
   * an allowlist ONLY so a regression at the same line is caught rather than assumed fixed — the scan
   * below is what finds a new one, and it takes the binding name from the code rather than guessing.
   */
  const FIXED = new Set([]);

  /**
   * Scoped to the binding's own block, by brace depth.
   *
   * A fixed-line window reported two innocent sites: a `record` in a cache fast path whose only write
   * happens in a different block (through `healPrefix`, which already re-resolves by id), and a `freshNet`
   * bound AFTER its bcrypt so there is no window at all — the awaits the window saw were in later code.
   * Both would have failed this gate forever, and a gate that fails on correct code is one people delete.
   *
   * So the scan follows the binding's scope: from the binding line, count braces and stop when the block
   * that declared it closes. Nothing outside that block can be writing through this binding.
   */
  function scanFile(src) {
    const lines = strip(src).split(/\r?\n/);
    const hits = [];
    lines.forEach((line, i) => {
      const bind = line.match(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\w+\.)*(?:spaces|tokens|networks)\b[^=]*\.find\(/);
      if (!bind) return;
      const name = bind[1];
      const writeRe = new RegExp(
        `\\b${name}\\.[A-Za-z_$][\\w$]*\\s*(?:=[^=]|\\+\\+|--|\\.push\\(|\\.splice\\()|\\bdelete\\s+${name}\\.`);

      let depth = 0, sawAwait = false;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (/\bawait\b/.test(l)) sawAwait = true;
        // A write through the binding only matters once an await could have reloaded the config.
        if (sawAwait && writeRe.test(l)) { hits.push({ line: i + 1, name, awaitFirst: true, at: j + 1 }); break; }
        depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
        if (depth < 0) break;   // the block that declared the binding has closed
      }
    });
    return hits;
  }

  it('finds none', () => {
    // Floor the enumeration first: `git ls-files` returning nothing — a moved directory, a changed pathspec —
    // would make this gate pass while scanning zero files.
    assert.ok(files.length > 100, `only ${files.length} tracked sources scanned`);
    const offenders = [];
    for (const f of files) {
      for (const h of scanFile(readFileSync(f, 'utf8'))) {
        const at = `${f.split('\\').join('/')}:${h.line}`;
        if (!FIXED.has(at)) offenders.push(`${at} (binds ${h.name}, written at :${h.at})`);
      }
    }
    assert.deepEqual(offenders, [],
      'route the write through mutateConfig, or move the await out of the window — a reload during it\n'
      + 'detaches this reference and the write is silently lost:\n  ' + offenders.join('\n  '));
  });

  it('the scan itself detects the shape, so "finds none" is not vacuous', () => {
    // A gate that can only pass is not a gate. This is the dangerous shape, inline.
    const sample = [
      'async function f() {',
      '  const cfg = getConfig();',
      '  const net = cfg.networks.find(n => n.id === id);',
      '  const hash = await bcrypt.hash(token, 10);',
      '  net.members.push({ hash });',
      '  saveConfig(cfg);',
      '}',
    ].join('\n');
    assert.equal(scanFile(sample).length, 1, 'the scan must catch the shape it exists to catch');

    // And the two shapes that are NOT it: the await after the binding's block, and no await at all.
    const safeNoAwait = [
      'function g() {',
      '  const net = cfg.networks.find(n => n.id === id);',
      '  net.members.push({});',
      '  saveConfig(cfg);',
      '}',
    ].join('\n');
    assert.equal(scanFile(safeNoAwait).length, 0, 'no await means no reload window');

    const safeAwaitFirst = [
      'async function h() {',
      '  const hash = await bcrypt.hash(token, 10);',
      '  const net = cfg.networks.find(n => n.id === id);',
      '  net.members.push({ hash });',
      '  saveConfig(cfg);',
      '}',
    ].join('\n');
    assert.equal(scanFile(safeAwaitFirst).length, 0, 'binding AFTER the await is the fix, not a finding');
  });
});
