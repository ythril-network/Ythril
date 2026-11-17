/**
 * The fields a stored record document declares, read from its TypeScript interface the way the compiler assembles it:
 * the interface's own members, every interface it `extends` (transitively), and every module augmentation
 * (`declare module '../config/types.js' { interface FileMetaDoc { … } }`) anywhere in `server/src`.
 *
 * ## What it prevents (Q-792 part 8)
 *
 * A gate that lists a record's fields by hand, or reads only the interface body, misses what an `extends` adds
 * (`StampSkewable.stampSkew`, `SchemaStamped.schemaFingerprint`) and what a module declares beside its only writer
 * (`FileMetaDoc.retiredBy`). The export/import round trip was compared on `seq` and one content key, so a field the
 * export or the import dropped stayed green; face descriptors once slipped into exports past a design that edited a
 * field list by hand. A field set read from the type itself grows with the type.
 *
 * Interfaces are looked up in the TRACKED sources of `server/src/config` (`trackedSources`), comments stripped before
 * any read; each name must be declared exactly once there, or the read throws rather than guessing.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources, SERVER_CODE_ROOTS } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { balancedFrom } from './_structural-window.mjs';

const CONFIG_DIR = 'server/src/config';

const read = (rel) => stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'));

let cache = null;
/** Every tracked `.ts` source under server/src, comments stripped, read once. */
function sources() {
  if (cache) return cache;
  const files = trackedSources(SERVER_CODE_ROOTS).filter(f => f.endsWith('.ts'));
  assert.ok(files.length >= 200, `only ${files.length} tracked server sources — the enumeration broke`);
  cache = files.map(rel => ({ rel, text: read(rel) }));
  return cache;
}

/** Split an interface body (without its braces) into members at the semicolons and newlines of its own depth. */
function membersOf(body) {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { if (c === quote && body[i - 1] !== '\\') quote = null; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (depth === 0 && c === ';') { out.push(body.slice(start, i)); start = i + 1; }
  }
  out.push(body.slice(start));
  return out.map(s => s.trim()).filter(Boolean);
}

/** `{ name, type, optional }` per member of one interface body. */
function parseMembers(body, label) {
  return membersOf(body).map((m) => {
    const hit = m.match(/^(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:\s*([\s\S]+)$/);
    assert.ok(hit, `${label}: a member this reader cannot parse: ${JSON.stringify(m.slice(0, 80))} — teach _record-doc-fields.mjs`);
    return { name: hit[1], optional: hit[2] === '?', type: hit[3].replace(/\s+/g, ' ').trim() };
  });
}

/** The one declaration of `interface name` in server/src/config: its file, its `extends` names and its members. */
function declarationOf(name) {
  const re = () => new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?interface\\s+${name}\\b([^{]*)\\{`, 'g');
  const hits = [];
  for (const s of sources().filter(f => f.rel.startsWith(`${CONFIG_DIR}/`))) {
    for (const m of s.text.matchAll(re())) hits.push({ rel: s.rel, at: m.index + m[0].length - 1, head: m[1] });
  }
  assert.equal(hits.length, 1, `interface ${name}: ${hits.length} declaration(s) in ${CONFIG_DIR} (${hits.map(h => h.rel).join(', ')}) — want exactly one`);
  const [{ rel, at, head }] = hits;
  const text = sources().find(s => s.rel === rel).text;
  const body = balancedFrom(text, at, `interface ${name}`).slice(1, -1);
  const ext = head.match(/\bextends\s+([\s\S]+)$/);
  const bases = ext ? ext[1].split(',').map(b => b.trim().replace(/<[\s\S]*$/, '')).filter(Boolean) : [];
  return { rel, bases, members: parseMembers(body, `${rel} interface ${name}`) };
}

/** Members module augmentations add to `interface name` anywhere in server/src. */
function augmentationsOf(name) {
  const out = [];
  for (const s of sources()) {
    for (const m of s.text.matchAll(/declare\s+module\s+'([^']+)'\s*\{/g)) {
      if (!/(?:^|\/)types(?:-[\w-]+)?\.js$/.test(m[1])) continue;
      const block = balancedFrom(s.text, m.index + m[0].length - 1, `${s.rel} declare module`);
      for (const i of block.matchAll(new RegExp(`\\binterface\\s+${name}\\b[^{]*\\{`, 'g'))) {
        const body = balancedFrom(block, i.index + i[0].length - 1, `${s.rel} augmentation of ${name}`).slice(1, -1);
        out.push(...parseMembers(body, `${s.rel} augmentation of ${name}`).map(f => ({ ...f, from: s.rel })));
      }
    }
  }
  return out;
}

/**
 * The fields of a record document interface, `extends` and augmentation followed: `[{ name, type, optional, from }]`,
 * own members first in declaration order, then each base's, then augmentations. A name declared twice (a base and the
 * interface both) is listed once, the interface's own spelling winning.
 */
export function recordDocFields(name, seen = new Set()) {
  assert.ok(!seen.has(name), `interface ${name} extends itself through ${[...seen].join(' -> ')}`);
  seen.add(name);
  const { rel, bases, members } = declarationOf(name);
  const fields = members.map(f => ({ ...f, from: `${rel} ${name}` }));
  for (const b of bases) fields.push(...recordDocFields(b, new Set(seen)));
  fields.push(...augmentationsOf(name));
  const byName = new Map();
  for (const f of fields) if (!byName.has(f.name)) byName.set(f.name, f);
  return [...byName.values()];
}
