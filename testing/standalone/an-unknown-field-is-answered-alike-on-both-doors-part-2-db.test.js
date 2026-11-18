/**
 * An unknown top-level field on a brain write is answered ALIKE on every door — the second half of the cases (i) to (p) (bundle-128, Q-320 with
 * Q-494/495/496; design-v3 section 8.1; case (o), the setting's own write and read paths, is `b128-contract`'s).
 *
 * ## Why two files
 *
 * The cases were one file (`an-unknown-field-is-answered-alike-on-both-doors-db.test.js` holds (a) to (h) and the rule's full statement), cut in two by case
 * letter so the halves run side by side: every case asks the same question of every judged subject on three doors, and the time was the sum of all of
 * them. The doors, the fixtures, the derivation of the subjects and the readings are `_unknown-field-doors.mjs`, shared, so neither half can drift from
 * the other; `the-unknown-field-cases-are-held-by-two-files-once-each` holds that the two declare every case once.
 *
 * ## What this half holds
 *
 * - (i) a chrono update of only `superseded` is a real edit on every door; (j) a near-miss key carries `did you mean`, and a key too large to measure is
 *   cut once and answered within a bound; (k) `linkFiles` is unknown on an entity and on file metadata; (l) a stored record whose connections failed
 *   keeps its 5xx and the unknown rows, a plain store failure carries none; (m) at most ten names are rowed, then `…(+N more)`, at exactly ten, eleven and
 *   twelve names, and unknown rows sit outside the schema cut; (n) bulk judges its items; (p) `waitForEmbedding` is declared and honoured.
 * - Each case starts on a space no earlier case wrote to (`cleanSpace`), and reads the stored documents in one round trip (`snapshot`).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/an-unknown-field-is-answered-alike-on-both-doors-part-2-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { holdsWithin } from '../_shared/wait-for.mjs';
import {
  skip, DIMS, UNKNOWN, UNKNOWN_VALUE, S, SCHEMA_SPACE, EMBED_SPACE, IGNORED, RECORD_COLLECTIONS, WIDE,
  door, NAME_QUOTED, REFUSAL_NAMES_MAX, SUBJECTS, cutOnce, uniq, fmt, DOORS, FIXTURES,
  openUnknownFieldDoors, closeUnknownFieldDoors, cleanSpace, http_, mcpCall, ask, unknownRows, snapshot, setMode, seed, requestOf, acceptedOf,
  threeDoors, freshFixtures, rowProblems, assertSubjectSet, judged, withKey,
} from './_unknown-field-doors.mjs';

const requireFromServer = createRequire(path.resolve('server/package.json'));
const driverLib = path.dirname(requireFromServer.resolve('mongodb'));
const { Server } = requireFromServer(path.join(driverLib, 'sdam', 'server.js'));
const { PoolClearedError } = requireFromServer(path.join(driverLib, 'cmap', 'errors.js'));
const { MongoNetworkTimeoutError } = requireFromServer('mongodb');

describe('an unknown field on a brain write is answered alike on both doors, part 2 (b128 parity)', { skip }, () => {
  before(() => openUnknownFieldDoors('b128-parity-doors-2'));
  beforeEach(cleanSpace);
  after(closeUnknownFieldDoors);

  // ── (i) chrono superseded ────────────────────────────────────────────────────────────────────────────────────────

  for (const mode of ['absent', 'refuse']) {
    it(`(i) PATCH chrono {superseded:true} succeeds and is stored on every door, in ${mode === 'absent' ? 'warn' : 'refuse'}`, async () => {
      setMode(S, mode);
      const failures = [];
      try {
        const s = SUBJECTS.find(x => x.op === 'chrono.update');
        assert.ok(s, 'no chrono update subject was derived');
        for (const which of DOORS) {
          const fx = await FIXTURES['chrono.update']();
          const a = await ask(which, requestOf(fx, { payload: { superseded: true } }));
          const stored = await door.mongo.col(`${S}_chrono`).findOne({ _id: fx.addr.id });
          if (a.refused) failures.push(`${which}: refused ${a.status}: ${a.error.slice(0, 160)}`);
          if (stored?.superseded !== true) failures.push(`${which}: the stored entry has superseded=${fmt(stored?.superseded)}`);
        }
      } finally { setMode(S, 'absent'); }
      assert.deepEqual(failures, [], 'superseded is an accepted key of the chrono update, so a body of only that key is a real edit on REST as it is on MCP');
    });
  }

  // ── (j) near-misses, and a key too large to measure ──────────────────────────────────────────────────────────────

  const distance = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let diag = row[0]; row[0] = i;
      for (let j = 1; j <= b.length; j++) { const up = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1)); diag = up; }
    }
    return row[b.length];
  };

  for (const mode of ['absent', 'refuse']) {
    it(`(j) a misspelt accepted key carries "did you mean" — by a deleted letter and by case alone — and an unrelated key does not, in ${mode === 'absent' ? 'warn' : 'refuse'}`, async () => {
      setMode(S, mode);
      const failures = [];
      try {
        for (const s of judged().filter(x => x.op !== 'entity.merge')) {
          const fx0 = await FIXTURES[s.op]();
          const accepted = acceptedOf(fx0);
          const target = accepted.find(k => k.length >= 6 && /^[a-z]/.test(k) && (() => { const typo = k.slice(0, 2) + k.slice(3); return accepted.every(o => o === k || distance(typo, o) > 1) && !accepted.includes(typo); })());
          if (!target) { failures.push(`${s.op}: no accepted key of the tool is a safe near-miss target — ${fmt(accepted)}`); continue; }
          const typo = target.slice(0, 2) + target.slice(3);
          const caseOnly = target[0].toUpperCase() + target.slice(1);
          const { answers } = await threeDoors(s, { extra: withKey([typo, 1], [caseOnly, 1], [UNKNOWN, 1]) });
          for (const which of DOORS) {
            const rows = unknownRows(answers[which].data);
            for (const [name, hint] of [[typo, true], [caseOnly, true], [UNKNOWN, false]]) {
              const row = rows.find(r => r.field === name);
              const has = typeof row?.reason === 'string' && row.reason.includes(` — did you mean '${target}'?`);
              if (!row) failures.push(`${s.op} ${which}: no row for ${name} (${answers[which].status})`);
              else if (has !== hint) failures.push(`${s.op} ${which}: ${name} ${hint ? 'lacks' : 'wrongly carries'} the hint for ${target}: ${fmt(row.reason)}`);
            }
          }
        }
      } finally { setMode(S, 'absent'); }
      assert.deepEqual(failures, [], 'the suggestion is computed for the keys that are rowed, against the accepted set, and a case-only difference counts');
    });
  }

  it('(j) a megabyte key is answered within a time bound, its name cut and no suggestion computed for it', async () => {
    setMode(S, 'absent');
    const failures = [];
    const subject = SUBJECTS.find(s => s.op === 'entity.create');
    const huge = 'x'.repeat(1 << 20);
    for (const which of DOORS) {
      const fx = await FIXTURES['entity.create']();
      const t0 = Date.now();
      const a = await ask(which, requestOf(fx, { extra: { [huge]: 1 } }));
      const ms = Date.now() - t0;
      const rows = unknownRows(a.data);
      if (ms > 5000) failures.push(`${which}: ${ms} ms for one oversized key`);
      if (rows.length !== 1 || rows[0].code !== 'unknown_field') failures.push(`${which}: the oversized key was not answered as one unknown row (${a.status}): ${fmt(rows).slice(0, 200)}`);
      // Cut ONCE, by the one renderer of a caller's name: a name cut a second time comes out as a different string. (This
      // read NAME_QUOTED + 8, a hand margin that a single cut's `…(+N more chars)` suffix already exceeds.)
      else if (rows[0].field !== cutOnce(huge)) failures.push(`${which}: the row quotes ${rows[0].field.length} characters of a key, not the key cut once at NAME_QUOTED=${NAME_QUOTED} (${cutOnce(huge).length})`);
    }
    assert.ok(subject, 'no entity create subject');
    assert.deepEqual(failures, [], 'a caller\'s key is cut before it is measured, so a huge one costs the same as a short one');
  });

  // ── (k) link keys the tool does not declare ──────────────────────────────────────────────────────────────────────

  it('(k) linkFiles is an unknown key on an entity and on file metadata, on every door: the write is stored, it is not counted as a field, and no link is stored from it', async () => {
    setMode(S, 'absent');
    const failures = [];
    const ghost = crypto.randomUUID();
    for (const s of judged().filter(x => ['entity.update', 'file.meta.update'].includes(x.op))) {
      for (const which of DOORS) {
        const fx = await FIXTURES[s.op]();
        const a = await ask(which, requestOf(fx, { extra: { linkFiles: [ghost] } }));
        const rows = unknownRows(a.data);
        if (a.refused) failures.push(`${s.op} ${which}: valid fields plus linkFiles was refused ${a.status}: ${a.error.slice(0, 200)}`);
        if (!rows.some(r => r.field === 'linkFiles' && String(r.reason).startsWith(IGNORED))) failures.push(`${s.op} ${which}: linkFiles is not named as ignored: ${fmt(a.data?.warnings)}`);
        // Nothing was linked: no link record names the ghost file. (The audit log is not read back: its change list is an allowlist
        // with no link fields for these operations, so a read-back could never fail.)
        const linked = await door.mongo.col(`${S}_links`).findOne({ to: ghost });
        if (linked) failures.push(`${s.op} ${which}: a link to the ghost file was stored from a field the write does not take: ${fmt(linked)}`);
      }
    }
    // A body of nothing but the unknown link key has nothing to update: the refusal names the accepted fields, and the key is still named.
    // Asked of the entity update, whose route carries a "nothing to update" refusal today (file metadata's does not).
    const entityUpdate = await FIXTURES['entity.update']();
    const only = await ask('rest', requestOf(entityUpdate, { payload: {}, extra: { linkFiles: [ghost] } }));
    if (only.status !== 400 || !/^At least one of /.test(only.error)) failures.push(`entity.update REST {linkFiles} alone: answered ${only.status} ${only.error.slice(0, 160)} — an unknown link key must not count as something to update`);
    if (!unknownRows(only.data).some(r => r.field === 'linkFiles')) failures.push(`entity.update REST {linkFiles} alone: the refusal does not name linkFiles: ${fmt(only.data)}`);
    assert.deepEqual(failures, [], 'link helpers read only the classes the record kind holds, so an undeclared link key is neither written, audited nor counted');
  });

  // ── (l) a stored record whose connections failed; a plain store failure ──────────────────────────────────────────

  /** Fail every driver command (or only the writes) on the named collections of the space, then run `fn`. */
  async function withStoreFault({ collections, writesOnly }, fn) {
    const real = Server.prototype.command;
    const WRITES = new Set(['insert', 'update', 'delete', 'findAndModify']);
    const names = new Set(collections.map(c => `${S}_${c}`));
    Server.prototype.command = async function fault(op, ...rest) {
      if (names.has(op?.ns?.collection) && (!writesOnly || WRITES.has(op?.commandName))) {
        throw new PoolClearedError({ address: 'harness:27017', serverError: new MongoNetworkTimeoutError('harness fault') });
      }
      return real.call(this, op, ...rest);
    };
    try { return await fn(); } finally { Server.prototype.command = real; }
  }

  it('(l) a stored record whose connections failed keeps its 5xx and carries the unknown rows on every door; a plain store failure carries none', async () => {
    setMode(S, 'absent');
    const failures = [];
    const withEdges = judged().filter(s => acceptedOf({ tool: s.tool, addr: {} }).includes('edges'));
    assert.ok(withEdges.length >= 4, `only ${withEdges.length} subject(s) take inline edges — the case ran over too little`);
    for (const s of withEdges) {
      const far = await seed('entity');
      const fxs = await freshFixtures(s.op);
      const answers = {};
      const before = await snapshot();
      for (const [i, which] of DOORS.entries()) {
        const req = requestOf(fxs[i], { extra: { edges: [{ to: far, label: 'rel' }], [UNKNOWN]: UNKNOWN_VALUE } });
        answers[which] = await withStoreFault({ collections: ['edges'], writesOnly: true }, () => ask(which, req));
      }
      for (const which of DOORS) {
        const a = answers[which];
        if (a.status < 500 || !a.data?.written?.id) failures.push(`${s.op} ${which}: not the connections-not-written answer (${a.status}): ${fmt(a.data)}`);
        const bad = rowProblems(unknownRows(a.data), { outcome: 'stored', names: [UNKNOWN] }).filter(p => !p.includes('does not start with'));
        if (bad.length) failures.push(`${s.op} ${which}: ${bad.join('; ')}`);
      }
      try { assert.deepEqual(unknownRows(answers.mcp.data), unknownRows(answers.rest.data)); assert.deepEqual(unknownRows(answers.tool.data), unknownRows(answers.rest.data)); }
      catch { failures.push(`${s.op}: the rows on the connections-not-written answer differ by door`); }
      if (s.op.endsWith('.create') && before === await snapshot()) failures.push(`${s.op}: nothing was stored, so this was not a stored record whose connections failed`);
    }
    // The other half of the rule: nothing stored and the cause a store failure — no rows, on any door.
    for (const s of judged().filter(x => x.op === 'entity.create' || x.op === 'fact.create')) {
      const fxs = await freshFixtures(s.op);
      const before = await snapshot();
      for (const [i, which] of DOORS.entries()) {
        const a = await withStoreFault({ collections: RECORD_COLLECTIONS, writesOnly: false }, () => ask(which, requestOf(fxs[i], { extra: { [UNKNOWN]: UNKNOWN_VALUE } })));
        if (a.status < 500) failures.push(`${s.op} ${which}: a failing store was answered ${a.status}`);
        if (unknownRows(a.data).length) failures.push(`${s.op} ${which}: a plain store failure carries unknown rows ${fmt(unknownRows(a.data))}`);
      }
      if (before !== await snapshot()) failures.push(`${s.op}: the failing store left documents behind`);
    }
    assert.deepEqual(failures, [], 'rows ride on a stored record whose connections failed, and on nothing a store failure refused outright');
  });

  // ── (m) bounds ───────────────────────────────────────────────────────────────────────────────────────────────────

  const names = (n) => Array.from({ length: n }, (_, i) => `uk${String(i).padStart(2, '0')}`);
  for (const [n, rowed, more] of [[10, 10, 0], [11, 10, 1], [12, 10, 2]]) {
    for (const mode of ['absent', 'refuse']) {
      it(`(m) ${n} unknown names are ${rowed} rows${more ? ` and one "…(+${more} more)"` : ''}, in ${mode === 'absent' ? 'warn' : 'refuse'}, the same on every door`, async () => {
        setMode(S, mode);
        const failures = [];
        try {
          for (const s of judged()) {
            const { answers } = await threeDoors(s, { extra: Object.fromEntries(names(n).map(k => [k, 1])) });
            for (const which of DOORS) {
              const rows = unknownRows(answers[which].data);
              const named = rows.filter(r => !String(r.field).startsWith('…'));
              const overflow = rows.filter(r => String(r.field).startsWith('…'));
              if (named.length !== rowed) failures.push(`${s.op} ${which}: ${named.length} named row(s), expected ${rowed}`);
              if (more === 0 && overflow.length) failures.push(`${s.op} ${which}: an overflow row for exactly ${REFUSAL_NAMES_MAX} names: ${fmt(overflow)}`);
              if (more > 0 && (overflow.length !== 1 || !overflow[0].field.includes(`(+${more} more)`) || overflow[0].code !== 'unknown_field')) failures.push(`${s.op} ${which}: expected one "(+${more} more)" row with the code, got ${fmt(overflow)}`);
              if (mode === 'refuse' && overflow.some(r => 'value' in r)) failures.push(`${s.op} ${which}: the overflow row of a refusal carries a value`);
            }
            try { assert.deepEqual(unknownRows(answers.mcp.data), unknownRows(answers.rest.data)); assert.deepEqual(unknownRows(answers.tool.data), unknownRows(answers.rest.data)); }
            catch { failures.push(`${s.op}: the rows differ by door`); }
          }
        } finally { setMode(S, 'absent'); }
        assert.deepEqual(failures, [], 'at most REFUSAL_NAMES_MAX names are rowed and the rest are counted, identically on every door');
      });
    }
  }

  it('(m) twenty schema warnings and one unknown key: the unknown row is present, first, and outside the schema cut', async () => {
    setMode(SCHEMA_SPACE, 'absent');
    const failures = [];
    const properties = Object.fromEntries(WIDE.map(k => [k, 'not a number']));
    const body = { name: uniq('wide'), type: 'wide', properties, [UNKNOWN]: UNKNOWN_VALUE };
    const rest = await http_('POST', `/api/brain/spaces/${SCHEMA_SPACE}/entities`, body);
    const mcp = await mcpCall('save_entity', { space: SCHEMA_SPACE, ...body });
    const tool = await http_('POST', '/api/save_entity', { space: SCHEMA_SPACE, ...body });
    for (const [which, data, status] of [['rest', rest.body, rest.status], ['mcp', mcp.sc, mcp.status], ['tool', tool.body?.data, tool.status]]) {
      const rows = Array.isArray(data?.warnings) ? data.warnings : [];
      const schemaRows = rows.filter(r => r.code !== 'unknown_field' && !String(r.reason).startsWith('unknown field'));
      if (rows.length === 0 || rows[0].field !== UNKNOWN || rows[0].code !== 'unknown_field') failures.push(`${which} (answered ${status}): the unknown row is not first among ${rows.length} row(s): ${fmt(rows.slice(0, 2))}`);
      if (schemaRows.length !== 20) failures.push(`${which}: ${schemaRows.length} schema row(s) beside the unknown one, expected the cut of 20`);
    }
    if (rest.body?.warningsTruncated !== true) failures.push('rest: warningsTruncated is not set although 21 schema rows were cut to 20');
    assert.deepEqual(failures, [], 'the unknown rows sit outside MAX_ROWS, so twenty schema rows cannot push them out');
  });

  // ── (n) bulk ─────────────────────────────────────────────────────────────────────────────────────────────────────

  const bulkOn = (which, body) => which === 'rest'
    ? ask('rest', { rest: { method: 'POST', url: `/api/brain/spaces/${S}/bulk`, body: JSON.stringify(body) } })
    : ask(which, { tool: { name: 'save_bulk', args: { space: S, ...body } } });
  const bulkErrors = (a) => (a.data?.errors ?? []);
  const unknownErrors = (a) => bulkErrors(a).filter(e => String(e.reason).startsWith('unknown_field'));

  it('(n) warn: an item with an unknown key is written and one "unknown_field:" row names it, with the accepted list once — a chrono item\'s recurrence is accepted and stored', async () => {
    assertSubjectSet();
    setMode(S, 'absent');
    const failures = [];
    assert.ok(SUBJECTS.some(s => s.op === 'bulk.write'), 'the bulk route is not among the derived subjects');
    for (const which of DOORS) {
      const t = uniq('bulk');
      const body = {
        // The second fact is refused for ANOTHER reason (nothing to store), and keeps its unknown rows beside that reason.
        facts: [{ fact: `${t} fact`, uk_fact: 1 }, { fact: '', uk_other_reason: 1 }],
        entities: [{ name: `${t} entity`, type: 'thing', uk_entity: 1 }],
        chrono: [{ title: `${t} chrono`, type: 'event', startsAt: '2026-01-01T00:00:00.000Z', recurrence: { freq: 'daily' }, uk_chrono: 1 }],
      };
      const a = await bulkOn(which, body);
      const rows = unknownErrors(a);
      if (a.refused) failures.push(`${which}: refused ${a.status}: ${a.error.slice(0, 200)}`);
      for (const [type, key] of [['fact', 'uk_fact'], ['entity', 'uk_entity'], ['chrono', 'uk_chrono']]) {
        const mine = rows.filter(r => r.type === type && r.index === 0);
        if (mine.length !== 1 || !mine[0].reason.includes(key)) failures.push(`${which}: expected one unknown_field row for the ${type} item naming ${key}, got ${fmt(mine)}`);
      }
      if (rows.some(r => r.reason.includes('recurrence'))) failures.push(`${which}: recurrence is read and stored by the chrono item, so it is not unknown: ${fmt(rows)}`);
      if (rows.filter(r => /accepts:/.test(r.reason)).length !== 1) failures.push(`${which}: the accepted list must appear once per batch`);
      const chrono = await door.mongo.col(`${S}_chrono`).findOne({ title: `${t} chrono` });
      if (chrono?.recurrence?.freq !== 'daily') failures.push(`${which}: the chrono item's recurrence was not stored: ${fmt(chrono?.recurrence)}`);
      if (!await door.mongo.col(`${S}_facts`).findOne({ fact: `${t} fact` })) failures.push(`${which}: the fact item was not written`);
      if (a.data?.inserted?.entities !== 1) failures.push(`${which}: the entity item was not written: ${fmt(a.data?.inserted)}`);
      const other = bulkErrors(a).filter(r => r.type === 'fact' && r.index === 1).map(r => r.reason).join(' | ');
      if (!other.includes('missing required field') || !other.includes('uk_other_reason')) failures.push(`${which}: the item refused for another reason lost its unknown rows: ${fmt(other)}`);
    }
    // Control, held in every mode: the TOP level of a batch names collections, and an unknown name there is refused outright, on every door.
    for (const mode of ['absent', 'refuse']) {
      setMode(S, mode);
      try {
        for (const which of DOORS) {
          const a = await bulkOn(which, { facts: [{ fact: uniq('top') }], [UNKNOWN]: 1 });
          if (a.status !== 400 || !a.error.includes(UNKNOWN)) failures.push(`${mode} ${which}: a top-level unknown key was answered ${a.status}: ${a.error.slice(0, 160)}`);
        }
      } finally { setMode(S, 'absent'); }
    }
    assert.deepEqual(failures, [], 'a warn batch writes the item and says what it did not take, on both doors');
  });

  it('(n) the rows of a batch are the same on every door, and a batch is capped at 50 unknown rows then "(+N more items)"; each item names at most 10 keys then "(+N more)"', async () => {
    assertSubjectSet();
    setMode(S, 'absent');
    const failures = [];
    const answers = {};
    for (const which of DOORS) {
      const t = uniq('cap');
      answers[which] = await bulkOn(which, { facts: Array.from({ length: 55 }, (_, i) => ({ fact: `${t} ${i}`, [`uk_item_${i}`]: 1 })) });
    }
    for (const which of DOORS) {
      const rows = unknownErrors(answers[which]);
      const overflow = rows.filter(r => /\(\+\d+ more items\)/.test(r.reason));
      const named = rows.filter(r => !/\(\+\d+ more items\)/.test(r.reason));
      if (named.length !== 50) failures.push(`${which}: ${named.length} per-item unknown row(s), expected the cap of 50`);
      if (overflow.length !== 1 || !overflow[0].reason.includes('(+5 more items)')) failures.push(`${which}: expected one "(+5 more items)" row, got ${fmt(overflow)}`);
      if ((answers[which].data?.inserted?.facts ?? 0) !== 55) failures.push(`${which}: ${answers[which].data?.inserted?.facts} of 55 items written under warn`);
    }
    const many = await bulkOn('rest', { facts: [{ fact: uniq('many'), ...Object.fromEntries(names(12).map(k => [k, 1])) }] });
    const row = unknownErrors(many)[0];
    if (!row || !/\(\+2 more\)/.test(row.reason) || names(10).some(k => !row.reason.includes(k)) || row.reason.includes(names(12)[10])) failures.push(`one item with 12 unknown keys: expected 10 named and "(+2 more)", got ${fmt(row)}`);
    for (const which of ['mcp', 'tool']) {
      try { assert.deepEqual(unknownErrors(answers[which]).map(r => r.reason.replace(/\d+/g, '#')), unknownErrors(answers.rest).map(r => r.reason.replace(/\d+/g, '#'))); }
      catch { failures.push(`${which}: the unknown rows differ from REST's`); }
    }
    assert.deepEqual(failures, [], 'bulk bounds what it says about unknown keys, per item and per batch, and every door says the same');
  });

  it('(n) refuse: the item is rejected (207), a $ref dependant is told why, the other items proceed; an item refused for another reason keeps its unknown rows', async () => {
    assertSubjectSet();
    setMode(S, 'refuse');
    const failures = [];
    try {
      for (const which of DOORS) {
        const t = uniq('refuse');
        const far = await seed('entity');
        const body = {
          facts: [{ fact: `${t} fine` }, { fact: `${t} bad`, uk_refused: 1 }, { fact: '', uk_other_reason: 1 }],
          entities: [{ $ref: 'gone', name: `${t} entity`, type: 'thing', uk_ref: 1 }],
          edges: [{ from: '$ref:gone', to: far, label: 'dep' }],
        };
        const before = await snapshot();
        const a = await bulkOn(which, body);
        const rows = bulkErrors(a);
        if (which === 'rest' && a.status !== 207) failures.push(`rest: answered ${a.status}, not 207`);
        if (!await door.mongo.col(`${S}_facts`).findOne({ fact: `${t} fine` })) failures.push(`${which}: the clean item did not proceed`);
        if (await door.mongo.col(`${S}_facts`).findOne({ fact: `${t} bad` })) failures.push(`${which}: the item with an unknown key was written under refuse`);
        if (await door.mongo.col(`${S}_entities`).findOne({ name: `${t} entity` })) failures.push(`${which}: the entity with an unknown key was written under refuse`);
        if (!rows.some(r => r.type === 'fact' && r.index === 1 && r.reason.includes('uk_refused'))) failures.push(`${which}: no row says why fact[1] was rejected: ${fmt(rows)}`);
        const other = rows.filter(r => r.type === 'fact' && r.index === 2).map(r => r.reason).join(' | ');
        if (!other.includes('uk_other_reason')) failures.push(`${which}: the second fact (empty AND carrying an unknown key) is not rejected with its unknown key named: ${fmt(other)}`);
        const dependant = rows.filter(r => r.type === 'edge' && r.index === 0).map(r => r.reason).join(' | ');
        if (!dependant.includes('uk_ref')) failures.push(`${which}: the $ref dependant was not told why its reference failed: ${fmt(dependant)}`);
        if (before === await snapshot()) failures.push(`${which}: nothing at all was written, the clean item included`);
      }
    } finally { setMode(S, 'absent'); }
    assert.deepEqual(failures, [], 'refuse rejects the item through the batch\'s own reject, so a dependant is told and the rest proceed');
  });

  // ── (p) Q-495: waitForEmbedding is declared and honoured ─────────────────────────────────────────────────────────

  it('(p) waitForEmbedding on a create is honoured on every door: the vector is stored when the call returns (entity, chrono and edge declared it nowhere on MCP)', async () => {
    const failures = [];
    const creates = judged().filter(s => FIXTURES[s.op] && s.op.endsWith('.create') && s.op !== 'link.create');
    assert.ok(creates.length >= 4, `only ${creates.length} embedding create(s) found`);
    // A write that honours the option has the vector as the call returns; the short poll only rides out the store's own latency.
    const vectorOf = async (collection, id) => {
      let vector = null;
      await holdsWithin(async () => {
        const doc = await door.mongo.col(`${EMBED_SPACE}_${collection}`).findOne({ _id: id });
        vector = Array.isArray(doc?.embedding) && doc.embedding.length === DIMS ? doc.embedding : null;
        return vector;
      }, 3_000, 10, { what: `the vector of ${collection} ${id}` });
      return vector;
    };
    const collectionOf = { 'entity.create': 'entities', 'fact.create': 'facts', 'edge.create': 'edges', 'chrono.create': 'chrono' };
    for (const s of creates) {
      for (const which of DOORS) {
        // The embedding space: its own ends for an edge, so the write embeds a record of its own.
        const fx = await FIXTURES[s.op]();
        if (s.op === 'edge.create') {
          const mk = async (n) => (await http_('POST', `/api/brain/spaces/${EMBED_SPACE}/entities`, { name: uniq(n), type: 'thing' })).body._id;
          fx.payload = { ...fx.payload, from: await mk('from'), to: await mk('to') };
        }
        const a = await ask(which, requestOf(fx, { space: EMBED_SPACE, extra: { waitForEmbedding: true } }));
        const id = which === 'rest' ? a.data?._id : (a.data?._id ?? a.data?.id);
        if (a.refused || !id) { failures.push(`${s.op} ${which}: waitForEmbedding was ${a.refused ? `refused ${a.status}` : 'answered without an id'}: ${a.error.slice(0, 160)}`); continue; }
        if (!await vectorOf(collectionOf[s.op], id)) failures.push(`${s.op} ${which}: no vector was stored although waitForEmbedding was asked`);
      }
    }
    assert.deepEqual(failures, [], 'the option REST has always read is declared by the MCP tool too, so it is neither refused nor ignored there');
  });
});
