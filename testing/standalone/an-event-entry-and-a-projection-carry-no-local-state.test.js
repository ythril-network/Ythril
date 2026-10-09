/**
 * What an EVENT tells the outside about an edge, and what a caller's PROJECTION can ask the store for, carries no field
 * this instance keeps for itself (Q-439, design item 8).
 *
 * ## The rule
 *
 * An edge row holds state that is THIS instance's: its vector, the peer that delivered it, its retention stamp, and — since
 * Q-439 — the write guard that locks its subject in this instance's unique index. Three doors tell a record to the outside
 * besides a read's answer, and each was a way for that state to leave:
 *
 *  - an `edge.created` / `edge.updated` event, which is one `entry` for the webhook payload AND the live-view bus. It was
 *    built by spreading the stored row with only the vector blanked, so the retention stamp and the delivery stamp went out
 *    with it. `eventEntryOf` is the one function that builds it, and the edge writers call it.
 *  - a `filter` whose `projection` names the guard. An inclusion projection reaches any stored field it names, and the
 *    list of withheld fields only governs the exclusion the read adds itself. `withoutWriteGuard` is applied to the
 *    projection the store is handed.
 *  - an export, which streams the stored rows: `WRITE_GUARD_FIELDS` is in its projection beside the derived fields.
 *
 * ## What this holds, and why none of it is a list
 *
 *  - `eventEntryOf` removes EVERY member of `LOCAL_ONLY_FIELDS` — read from the module, floored — and keeps every other key.
 *  - `withoutWriteGuard` leaves no inclusion that names a `WRITE_GUARD_FIELDS` member, never produces an empty projection (the
 *    store reads `{}` as "every field"), and adds the exclusion when the caller named none.
 *  - EVERY `emitWebhookEvent` in `server/src` — the one function that is a webhook and a live-view event, whatever record kind
 *    it tells — builds its entry through `eventEntryOf`, or carries no stored row (an id, a path, a counter), or is a named
 *    exemption with its reason. The calls are derived from the tracked source with a floor, so an emit added next year is held to it.
 *  - The export's projection is built from `NOT_CARRIED_BY_BACKUP`, the derived fields and the write guards together.
 *
 * Run: node --test testing/standalone/an-event-entry-and-a-projection-carry-no-local-state.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readTrackedSources } from './_sources.mjs';

const { eventEntryOf } = await import('../../server/dist/brain/read-projection.js');
const { withoutWriteGuard } = await import('../../server/dist/brain/projection.js');
const { LOCAL_ONLY_FIELDS, WRITE_GUARD_FIELDS, DERIVED_LOCAL_FIELDS, NOT_CARRIED_BY_BACKUP } = await import('../../server/dist/sync/local-only-fields.js');

const withoutComments = (t) => t.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

/** The index just past the bracket that closes the one at `open`, reading strings and template literals as opaque. */
function closeOf(s, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [pairs[s[open]]];
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) { stack.pop(); if (stack.length === 0) return i + 1; }
  }
  throw new Error(`no closing bracket for the one at ${open}`);
}

/** The top-level comma-separated parts of the text between two brackets. */
function topLevelParts(inner) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "'" || c === '"' || c === '`') { for (i++; i < inner.length && inner[i] !== c; i++) if (inner[i] === '\\') i++; continue; }
    if (c === '(' || c === '[' || c === '{') { i = closeOf(inner, i) - 1; continue; }
    if (c === ',') { parts.push(inner.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(inner.slice(start).trim());
  return parts.filter(Boolean);
}

/**
 * Every `emitWebhookEvent({ ... })` call in the product source — DERIVED from `git ls-files`, so a writer added next year is held
 * to the rule. `emitWebhookEvent` is the one function that is both a webhook and a live-view bus event, so these are every way a
 * record is told to the outside by a write.
 */
function emitsIn(file, text) {
  const out = [];
  for (const m of text.matchAll(/emitWebhookEvent\(/g)) {
    if (/function\s+$/.test(text.slice(0, m.index))) continue;
    const open = m.index + m[0].length - 1;
    const call = text.slice(open + 1, closeOf(text, open) - 1).trim();
    if (!call.startsWith('{')) continue;
    const props = topLevelParts(call.slice(1, call.lastIndexOf('}')));
    const prop = (name) => props.find(p => p === name || p.startsWith(`${name}:`));
    const entry = prop('entry');
    const event = prop('event');
    if (!entry || !event) continue;
    out.push({
      file,
      event: (/'([^']+)'/.exec(event) ?? [null, event.replace(/^event:\s*/, '')])[1],
      entry: entry === 'entry' ? 'entry' : entry.replace(/^entry:\s*/, ''),
    });
  }
  return out;
}

const EMITS = readTrackedSources('server/src', { floor: 300 }).flatMap(({ file, text }) => emitsIn(file, withoutComments(text)));

/** Emits whose entry is a system's own report, not a stored record of this space — said with the reason, keyed `file:event`. */
const NOT_A_RECORD = {
  'server/src/brain/dupe-scanner.ts:duplicate.detected': 'a summary the scanner builds of two candidates (ids, names, scores), not a stored row',
  'server/src/sync/linkage-check.ts:link_violation.created': 'a link-violation report, a document of its own with no retention stamp, vector or write guard',
  'server/src/sync/change-notes.ts:change_note.received': 'a network change note assembled field by field from the wire, not a stored record',
};

/**
 * Does this emit tell a record through `eventEntryOf`, or tell no stored row at all? An entry is told when it is exempt with a
 * reason, is `eventEntryOf(...)`, or is an object literal that spreads nothing and carries no embedding (a counter, an id, a
 * path) once every `eventEntryOf(...)` inside it is taken out.
 */
function told({ file, event, entry }) {
  if (`${file}:${event}` in NOT_A_RECORD) return true;
  let rest = entry;
  for (let at = rest.indexOf('eventEntryOf('); at >= 0; at = rest.indexOf('eventEntryOf(')) {
    rest = `${rest.slice(0, at)}E${rest.slice(closeOf(rest, at + 'eventEntryOf'.length))}`;
  }
  if (rest === 'E') return true;
  return rest.startsWith('{') && !/\.\.\.|embedding/.test(rest);
}

describe('an event entry carries no field this instance keeps for itself', () => {
  it('removes every local-only field and keeps every other key, without touching the row it was given', () => {
    assert.ok(LOCAL_ONLY_FIELDS.size >= 4, `the local-only set is ${LOCAL_ONLY_FIELDS.size} fields - the derivation read nothing`);
    const stored = { _id: 'e1', from: 'a', to: 'b', label: 'knows', seq: 7, description: 'd', properties: { k: 1 } };
    for (const f of LOCAL_ONLY_FIELDS) stored[f] = `a-local-${f}`;
    const before = JSON.stringify(stored);
    const entry = eventEntryOf(stored);
    assert.deepEqual(Object.keys(entry).filter(k => LOCAL_ONLY_FIELDS.has(k)), [],
      `an event entry carries ${Object.keys(entry).filter(k => LOCAL_ONLY_FIELDS.has(k)).join(', ')}`);
    assert.deepEqual(Object.keys(entry).sort(), ['_id', 'description', 'from', 'label', 'properties', 'seq', 'to']);
    assert.equal(JSON.stringify(stored), before, 'the stored row was changed by building its event entry');
  });

  it('every event any writer emits tells a record through it, or tells no record at all', () => {
    const bypass = EMITS.filter(e => !told(e)).map(e => `${e.file}: ${e.event} -> ${e.entry}`);
    assert.deepEqual(bypass, [],
      'these events build their entry from a stored row without `eventEntryOf` (the retention stamp, the delivery stamp and the '
      + `write guard are this instance's own and leave with it):\n  ${bypass.join('\n  ')}`);
  });

  it('the scan found the emits, spanning every record kind (floor), and every exemption still names an emit', () => {
    assert.ok(EMITS.length >= 25, `found ${EMITS.length} emitWebhookEvent call(s) in server/src - the scan reads nothing`);
    for (const kind of ['edge', 'entity', 'fact', 'chrono']) {
      assert.ok(EMITS.some(e => e.event.startsWith(`${kind}.`) && /eventEntryOf\(/.test(e.entry)),
        `no ${kind}.* event builds its entry through eventEntryOf - the scan lost the ${kind} writer`);
    }
    const keys = new Set(EMITS.map(e => `${e.file}:${e.event}`));
    assert.deepEqual(Object.keys(NOT_A_RECORD).filter(k => !keys.has(k)), [], 'an exemption names an emit that no longer exists - delete it');
    for (const [k, why] of Object.entries(NOT_A_RECORD)) assert.ok(why.length > 10, `${k} is exempt without a reason`);
  });

  it('the entry check tells a spread of a stored row from a counter literal (it is red on the old spelling)', () => {
    assert.equal(told({ event: 'edge.created', entry: '{ ...edge, embedding: undefined }', file: 'x.ts' }), false);
    assert.equal(told({ event: 'entity.merged', entry: '{ survivor: { ...survivor, embedding: undefined }, absorbedId: a }', file: 'x.ts' }), false);
    assert.equal(told({ event: 'entity.updated', entry: 'doc', file: 'x.ts' }), false);
    assert.equal(told({ event: 'edge.created', entry: 'eventEntryOf(edge)', file: 'x.ts' }), true);
    assert.equal(told({ event: 'entity.merged', entry: '{ survivor: eventEntryOf(survivor), absorbedId: a }', file: 'x.ts' }), true);
    assert.equal(told({ event: 'edge.deleted', entry: '{ _id }', file: 'x.ts' }), true);
  });
});

describe('a caller\'s projection cannot ask the store for the write guard', () => {
  const GUARDS = [...WRITE_GUARD_FIELDS];
  it('has a write guard to hold the projection to', () => assert.ok(GUARDS.length >= 1));

  it('an exclusion, or none at all, gains the exclusion of every guard', () => {
    for (const given of [{}, { embedding: 0 }, { description: 0, embedding: 0 }]) {
      const out = withoutWriteGuard(given);
      for (const g of GUARDS) assert.equal(out[g], 0, `${JSON.stringify(given)} does not withhold ${g}: ${JSON.stringify(out)}`);
      for (const [k, v] of Object.entries(given)) assert.equal(out[k], v, `${k} was changed`);
    }
  });

  it('an inclusion loses every guard it names and keeps the rest', () => {
    for (const g of GUARDS) {
      assert.deepEqual(withoutWriteGuard({ label: 1, [g]: 1 }), { label: 1 });
    }
  });

  it('an inclusion that names ONLY a guard is the id alone, never an empty projection (which the store reads as every field)', () => {
    for (const g of GUARDS) {
      assert.deepEqual(withoutWriteGuard({ [g]: 1 }), { _id: 1 });
      assert.deepEqual(withoutWriteGuard({ _id: 0, [g]: 1 }), { _id: 1 });
    }
  });
});

describe('the export streams no write guard', () => {
  it('builds its projection from NOT_CARRIED_BY_BACKUP, which holds the derived fields AND the write guards', () => {
    const src = withoutComments(readFileSync('server/src/app.ts', 'utf8'));
    const m = /const projection = Object\.fromEntries\(\[([^\]]*)\]\.map/.exec(src);
    assert.ok(m, 'the export projection is not built the way this gate reads it - re-anchor it');
    assert.match(m[1], /\.\.\.NOT_CARRIED_BY_BACKUP/, 'the export no longer reads the one set a backup leaves out');
    assert.ok(NOT_CARRIED_BY_BACKUP.size >= 1);
    for (const f of [...DERIVED_LOCAL_FIELDS, ...WRITE_GUARD_FIELDS]) {
      assert.ok(NOT_CARRIED_BY_BACKUP.has(f), `${f} streams in an export: a backup would carry this instance's own state (a lock, a vector) to another`);
    }
  });
});
