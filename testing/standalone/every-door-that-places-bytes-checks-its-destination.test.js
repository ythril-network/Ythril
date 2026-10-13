/**
 * Every door that places bytes or a directory checks its destination first — or says why it need not (bundle-44, Q-351).
 *
 * ## What this holds
 *
 * `a-destination-blocked-by-a-file-is-refused-alike-db.test.js` drives the doors that exist today. This is the half that keeps the
 * NEXT door honest: a route or tool handler that stores bytes, creates a directory, moves a path or stages a chunked upload must
 * ask `assertDestinationReachable` (`files/destination.ts`) BEFORE it does — or sit in {@link EXEMPT} with the reason its path is
 * not a caller's. A door written without the call answers a destination blocked by a file with the filesystem's own failure (REST
 * 500, MCP 400 with the server's data path), which is the defect the sibling test holds for the doors that existed.
 *
 * ## How the subjects are found — derived, not listed
 *
 * The placing callees are not named here. They are READ from the doors' own imports: every name a source under `server/src/`
 * outside `files/` imports from a placement module (`PLACEMENT_MODULES`) is a callee that places bytes unless
 * {@link NOT_PLACING} says, with a reason, that it does not. A new placing function exported from those modules is therefore a
 * finding in every door that imports it until someone decides — the default is the safe one, and an alias
 * (`import { writeFile as writeSpaceFile }`) is found under its local name. The modules themselves are checked against the tree:
 * a `files/` module that holds a byte-placing primitive and is not in `PLACEMENT_MODULES` fails.
 *
 * Every call of such a name must sit inside a route handler (`async (req, res) =>`) or a tool's `async handle(` with an
 * `assertDestinationReachable(` call EARLIER in that same handler — not in a comment, not in the next handler, not after the write.
 * `moveFileCascade` may instead be guarded inside its own body, before its first irreversible step (the one cascade both move doors
 * share is one place to hold, and the test below holds it).
 *
 * ## What it concludes, and what it does not
 *
 * About every call site, in the door layers and the other non-`files/` code that imports a placement module, of what those modules
 * export. Not about `files/` itself: the check is at the doors, not inside `writeFile`, so the pipeline's and the extractors' writers
 * keep their own failure handling (plan D5). Floors guard the scan; the self-tests at the end run the rule over source written in
 * the test, so a scanner that stopped seeing handlers, or read a comment as a call, fails here and not silently.
 *
 * Run: node --test testing/standalone/every-door-that-places-bytes-checks-its-destination.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readTrackedSources, REPO_ROOT } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { bodyOf, enclosingBlockAround, enclosingBlockMatching } from './_structural-window.mjs';

const SRC = 'server/src';
const GUARD = 'assertDestinationReachable';
const DESTINATION_MODULE = `${SRC}/files/destination.ts`;

/** The modules whose exports can put bytes or a directory somewhere. A module in `files/` holding a placing primitive and absent here fails. */
const PLACEMENT_MODULES = Object.freeze(['files', 'store-file', 'chunks', 'stored-bytes', 'move-cascade']
  .map(m => `${SRC}/files/${m}.ts`));

/** What a placement module's own code does that puts bytes or a directory on disk. Read from the tree, so a new module holding one is found. */
const PRIMITIVE = () => /\b(?:writeStored|pipeToStored|moveStored|commitStaged|mkdirPrivate)\s*\(|\bfsp?\.(?:rename|mkdir|writeFile|copyFile)\s*\(/;

/**
 * Exports of the placement modules that do NOT place bytes or a directory at a caller's path, each with why. A name not here is
 * a placing callee. The reasons are claims about the callee, so they are what a reviewer reads, not a list to be kept short.
 */
const NOT_PLACING = Object.freeze({
  readFileWindow: 'reads', listDir: 'reads', openStoredRead: 'reads', statStored: 'reads', isMissingPath: 'classifies an error',
  StoredFileUnreadable: 'an error class', getUploadReceived: 'reads the staged byte count', parseContentRange: 'parses a header',
  hashStagedChunks: 'reads staged chunks, writes nothing', discardStagedChunks: 'removes staged chunks',
  deleteStoredIfPresent: 'removes bytes; a delete places nothing', recordStoredFile: 'records the row of bytes already placed by the caller',
  peerBytesShadowed: 'a question about a tombstone, writes nothing', cleanupStaleChunks: 'removes stale staged chunks',
  ensureSpaceFilesDir: 'creates a space\'s own root, a path the instance names, never a caller\'s',
});

/**
 * Source files whose placing calls are not a caller's destination, each with why. Each entry must still match a real site (a stale
 * exemption fails), and an entry names a FILE: a second placing door added to an exempt file is not seen, which is the cost of the
 * granularity and why the reasons are about the whole file.
 */
const EXEMPT = Object.freeze({
  [`${SRC}/api/conflicts.ts`]: 'conflict resolution moves a conflict copy within the space between two paths the conflict record names; nothing there is a caller-chosen destination',
  [`${SRC}/api/spaces.ts`]: 'writes `_schema-backup-<timestamp>.json` at the space root, a name the instance builds, never a caller path',
  [`${SRC}/sync/file-sync.ts`]: 'a pulled arrival: a destination blocked by a local file is a sync conflict (decided there), not a refusal to a caller',
  [`${SRC}/extractor/conversation/write-extraction.ts`]: 'writes the extraction\'s own transcript paths, derived by the instance',
  [`${SRC}/spaces/_shared.ts`]: 'writes the schema snapshot at the space root, a name the instance builds',
});

/** Strip comments keeping line numbers, so a reported line is the original's. */
const code = (text) => blankComments(text);
const lineOf = (text, at) => text.slice(0, at).split('\n').length;

/** `import { a, type B, c as d } from '<rel>'` statements: the module they resolve to, and each value name as `{ name, local }`. */
function importsOf(file, blanked) {
  const out = [];
  for (const m of blanked.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.{1,2}\/[^']+)'/g)) {
    const target = path.posix.join(path.posix.dirname(file), m[2]).replace(/\.js$/, '.ts');
    const names = m[1].split(',').map(s => s.trim()).filter(s => s && !/^type\s/.test(s)).map(s => {
      const [name, local] = s.split(/\s+as\s+/).map(x => x.trim());
      return { name, local: local ?? name };
    });
    out.push({ target, names });
  }
  return out;
}

/** The innermost route handler or tool `handle` containing `at`, as `{ start, text }`, or null. */
function handlerAt(blanked, at) {
  const OPENER = /\basync\s+handle\s*\(|\basync\s*\(\s*(?:req|request)\b/;
  const block = enclosingBlockMatching(blanked, at, OPENER, 'handlerAt');
  return block === null ? null : { start: blanked.indexOf(block), text: block };
}

/** Every call of `local` in `blanked`: where it is, and whether the handler around it asked the guard first. */
function sitesOf(blanked, local) {
  const sites = [];
  // a declaration of the same name (`function storeFile(`) is not a call: refused by the pattern itself, not by a window behind it
  for (const m of blanked.matchAll(new RegExp(`(?<![.\\w$])(?<!\\bfunction\\s+)${local}\\s*\\(`, 'g'))) {
    const h = handlerAt(blanked, m.index);
    // A guard EARLIER in the handler whose own block still contains the site: one inside an `if` or a `try` that closed before the
    // site (the chunked branch of an upload handler, say) says nothing about a write the single-request branch makes after it.
    const guarded = h !== null && [...blanked.slice(h.start, m.index).matchAll(new RegExp(`\\b${GUARD}\\s*\\(`, 'g'))].some(g => {
      const guardAt = h.start + g.index;
      const block = enclosingBlockAround(blanked, guardAt, 'guard block');
      const from = blanked.indexOf(block, h.start);
      return from >= 0 && from <= guardAt && m.index < from + block.length;
    });
    sites.push({ at: m.index, line: lineOf(blanked, m.index), inHandler: h !== null, guarded });
  }
  return sites;
}

/** Whether `moveFileCascade` asks the guard before its first irreversible step, read from its own body. */
function cascadeGuardsItself(cascadeSource) {
  const body = bodyOf(code(cascadeSource), 'moveFileCascade', 'moveFileCascade');
  const guard = body.search(new RegExp(`\\b${GUARD}\\s*\\(`));
  if (guard < 0) return { guards: false, why: `moveFileCascade never calls ${GUARD}` };
  for (const step of ['holdJobsForMove', 'writePendingFileTombstones', 'actUnderPendingTombstones', 'moveFile']) {
    const at = body.search(new RegExp(`\\b${step}\\s*\\(`));
    if (at >= 0 && at < guard) return { guards: false, why: `${GUARD} comes after ${step}, which already changed something` };
  }
  return { guards: true, why: '' };
}

const all = readTrackedSources(SRC, { floor: 300 });
const nonFiles = all.filter(f => !f.file.startsWith(`${SRC}/files/`));
const text = (file) => all.find(f => f.file === file)?.text ?? (existsSync(path.join(REPO_ROOT, file)) ? readFileSync(path.join(REPO_ROOT, file), 'utf8') : null);

/** Every placing call site in the non-`files/` code: `{ file, name, local, line, inHandler, guarded }`. */
function placingSites() {
  const found = [];
  for (const { file, text: src } of nonFiles) {
    const blanked = code(src);
    for (const imp of importsOf(file, blanked)) {
      if (!PLACEMENT_MODULES.includes(imp.target)) continue;
      for (const { name, local } of imp.names) {
        if (name in NOT_PLACING) continue;
        const sites = sitesOf(blanked, local);
        found.push({ file, name, local, imported: true, sites });
      }
    }
  }
  return found;
}

describe('every door that places bytes or a directory checks its destination first', () => {
  it('the module that answers "can this destination be created" exists and exports the guard', () => {
    const src = text(DESTINATION_MODULE);
    assert.ok(src !== null, `${DESTINATION_MODULE} does not exist: the destination check has no home, so every door would spell its own`);
    assert.match(code(src), new RegExp(`export\\s+(?:async\\s+)?function\\s+${GUARD}\\b`), `${DESTINATION_MODULE} does not export ${GUARD}`);
  });

  it('the placement modules are the ones the tree says hold a byte-placing primitive', () => {
    const holders = all.filter(f => /^server\/src\/files\/[\w-]+\.ts$/.test(f.file) && PRIMITIVE().test(code(f.text))).map(f => f.file);
    assert.ok(holders.length >= 3, `only ${holders.length} files/ module(s) hold a placing primitive — the derivation is broken, not the code`);
    const missing = holders.filter(h => !PLACEMENT_MODULES.includes(h) && h !== DESTINATION_MODULE);
    assert.deepEqual(missing, [], `these files/ modules place bytes or a directory and are not in PLACEMENT_MODULES, so their callers are not scanned: ${missing}`);
    for (const m of PLACEMENT_MODULES) assert.ok(text(m) !== null, `${m} is in PLACEMENT_MODULES and does not exist — re-anchor this gate`);
  });

  it('the scan finds the doors: a floor, and the three files that hold them by name', () => {
    const found = placingSites();
    const doorSites = found.filter(f => !(f.file in EXEMPT)).flatMap(f => f.sites.map(s => ({ ...s, file: f.file })));
    assert.ok(doorSites.length >= 6, `only ${doorSites.length} placing call site(s) outside the exempt files — the scan has stopped seeing the doors`);
    const files = new Set(doorSites.map(s => s.file));
    for (const door of [`${SRC}/api/files.ts`, `${SRC}/api/files-upload.ts`, `${SRC}/mcp/tools/file.ts`]) {
      assert.ok(files.has(door), `${door} holds route or tool handlers that place bytes and the scan found no call in it`);
    }
  });

  it('a placing function imported by a door and never called in it is a finding (passed by reference is not a check)', () => {
    const unseen = placingSites().filter(f => !(f.file in EXEMPT) && f.sites.length === 0).map(f => `${f.file}: ${f.local}`);
    assert.deepEqual(unseen, [], `imported from a placement module and never called here, so no handler can have guarded it: ${unseen}`);
  });

  it('every placing call in a door is inside a handler that asked the destination guard first, or its file is exempt with a reason', () => {
    const cascade = cascadeGuardsItself(readFileSync(path.join(REPO_ROOT, `${SRC}/files/move-cascade.ts`), 'utf8'));
    const unguarded = [];
    for (const f of placingSites()) {
      if (f.file in EXEMPT) continue;
      for (const s of f.sites) {
        if (s.guarded) continue;
        if (f.name === 'moveFileCascade' && s.inHandler && cascade.guards) continue;
        unguarded.push(`${f.file}:${s.line}  ${f.local}(…)  ${s.inHandler ? `no ${GUARD}( earlier in its handler` : 'not inside a route handler or tool handle'}`);
      }
    }
    assert.deepEqual(unguarded, [], `a destination blocked by a file reaches the filesystem from these call sites (REST 500, MCP 400 with the data path):\n  ${unguarded.join('\n  ')}`);
  });

  it('the move cascade, which both move doors share, asks the guard before its first irreversible step', () => {
    const r = cascadeGuardsItself(readFileSync(path.join(REPO_ROOT, `${SRC}/files/move-cascade.ts`), 'utf8'));
    assert.ok(r.guards, `files/move-cascade.ts: ${r.why} — a refused destination must not leave a tombstone or a held job behind it`);
  });

  it('every NOT_PLACING row still names something a door imports (a stale row is a decision nobody re-reads)', () => {
    const imported = new Set();
    for (const { file, text: src } of nonFiles) {
      for (const imp of importsOf(file, code(src))) if (PLACEMENT_MODULES.includes(imp.target)) for (const n of imp.names) imported.add(n.name);
    }
    const stale = Object.keys(NOT_PLACING).filter(n => !imported.has(n));
    assert.deepEqual(stale, [], `NOT_PLACING names that no source imports from a placement module any more: ${stale}`);
  });

  it('every exemption states its reason and still matches a real placing call (a stale exemption hides the next door in that file)', () => {
    const live = new Set(placingSites().filter(f => f.sites.length > 0).map(f => f.file));
    for (const [file, why] of Object.entries(EXEMPT)) {
      assert.ok(why.length > 30, `${file}: an exemption without a real reason`);
      assert.ok(live.has(file), `${file} is exempt but holds no placing call any more — delete the row, or the exemption now covers a door nobody has seen`);
    }
  });

  describe('the scanner itself, over source written here', () => {
    const door = (body) => `import { storeFile as put } from '../files/store-file.js';\nrouter.post('/x', async (req, res) => {\n${body}\n});\nrouter.get('/y', async (req, res) => {\n  res.json({});\n});\n`;
    const verdict = (src) => sitesOf(code(src), 'put').map(s => s.guarded);

    it('a call after the guard, in the same handler, is guarded — through an alias', () => {
      assert.deepEqual(verdict(door(`  await ${GUARD}(spaceId, abs);\n  await put(spaceId, p, bytes);`)), [true]);
    });
    it('a call BEFORE the guard is not', () => {
      assert.deepEqual(verdict(door(`  await put(spaceId, p, bytes);\n  await ${GUARD}(spaceId, abs);`)), [false]);
    });
    it('a guard inside a branch that closed before the call does not cover a call after it (chunked branch, then the single write)', () => {
      const branch = `  if (range) {\n    await ${GUARD}(spaceId, abs);\n    await put(spaceId, p, chunk);\n  }\n  await put(spaceId, p, bytes);`;
      assert.deepEqual(verdict(door(branch)), [true, false]);
    });
    it('a guard at the top of the handler covers a call in a nested branch', () => {
      assert.deepEqual(verdict(door(`  await ${GUARD}(spaceId, abs);\n  if (range) {\n    try {\n      await put(spaceId, p, bytes);\n    } catch (e) { throw e; }\n  }`)), [true]);
    });
    it('a guard in ANOTHER handler does not cover it', () => {
      const src = door('  await put(spaceId, p, bytes);').replace("res.json({});", `await ${GUARD}(spaceId, abs); res.json({});`);
      assert.deepEqual(verdict(src), [false]);
    });
    it('a guard that is only mentioned in a comment is not a guard', () => {
      assert.deepEqual(verdict(door(`  // ${GUARD}(spaceId, abs) is called by the caller\n  /* ${GUARD}(x) */\n  await put(spaceId, p, bytes);`)), [false]);
    });
    it('a call outside any handler is reported as such', () => {
      const sites = sitesOf(code(`import { storeFile as put } from '../files/store-file.js';\nexport async function helper() { await put(a, b, c); }\n`), 'put');
      assert.deepEqual(sites.map(s => s.inHandler), [false]);
    });
    it('a tool handle counts as a handler', () => {
      const src = `export const t = {\n  name: 'x',\n  async handle(ctx) {\n    await ${GUARD}(a, b);\n    await put(a, b, c);\n  },\n};\n`;
      assert.deepEqual(verdict(src), [true]);
    });
    it('the cascade check reads order: the guard after the first step fails', () => {
      const after = 'export async function moveFileCascade(a, b, c) {\n  await holdJobsForMove(a);\n  await ' + GUARD + '(a, b);\n  await moveFile(a, b, c);\n}\n';
      const before = 'export async function moveFileCascade(a, b, c) {\n  await ' + GUARD + '(a, b);\n  await holdJobsForMove(a);\n  await moveFile(a, b, c);\n}\n';
      assert.equal(cascadeGuardsItself(after).guards, false);
      assert.equal(cascadeGuardsItself(before).guards, true);
      assert.equal(cascadeGuardsItself('export async function moveFileCascade(a) {\n  await moveFile(a);\n}\n').guards, false);
    });
  });
});
