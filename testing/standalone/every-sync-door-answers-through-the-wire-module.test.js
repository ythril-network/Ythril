/**
 * Every 2xx a sync door answers is built by `sync/wire-answer.ts` (bundle-81, design rev 8 §6, decision 23).
 *
 * ## The finding this holds
 *
 * A 6.0 client refuses an answer without `positions: 1` by throwing (`PeerPagesBySeq`), which ends the member's turn: that is what
 * keeps a 5.x peer from being synced with by the wrong rules. The refusal is only as good as the stamp, and the stamp is the
 * forgettable part: a route that answers `res.json({...})` by hand drops `positions: 1` (and, on a page, `through` and `head`),
 * and the 6.0 client then refuses ITS OWN peer. The module owns both builders (`pageAnswer`, `pushAnswer`) and both parsers, so
 * no route spells the stamp.
 *
 * ## What is derived
 *
 * - **The doors:** every route registered in the files of `server/src/api/sync/` that serve records or take them: the files that
 *   reference `acceptArrivingPage`, `writeArrivals`, `applyPeerTombstones`, `listTombstones` or the pager. Each 2xx
 *   `res.json(...)` / `res.status(2xx).json(...)` inside them is a site. Floor: five sites, and five distinct handlers.
 * - **The rule:** the argument of each such call is a call to `pageAnswer(` or `pushAnswer(`.
 * - **Named exemptions** (each asks another question and says so): the file-tombstone routes (their own ISO stream, untouched by
 *   positions) and `oneById` (one stored document, neither a page nor a push answer).
 * - **The stamp is spelled in one place:** `positions: 1` appears in no file of `server/src` but the module.
 *
 * ## Seen red
 *
 * Red on 9a7ab3f7: the module does not exist, and every 2xx site of `docs.ts` and `tombstones.ts` answers by hand. Mutation for the
 * newly covered part: replace one `pushAnswer({...})` with a bare object and the case names the route. Restore by hand.
 *
 * Run: node --test testing/standalone/every-sync-door-answers-through-the-wire-module.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const MODULE = 'server/src/sync/wire-answer.ts';
const BUILDERS = ['pageAnswer', 'pushAnswer'];
const PARSERS = ['parsePageAnswer', 'parsePushAnswer'];
const SITE_FLOOR = 5;
const SERVES_OR_TAKES_RECORDS = /\b(?:acceptArrivingPage|writeArrivals|applyPeerTombstones|listTombstones|readAfterSeq|readAfterPosition)\b/;

/** `{ key, why }` exemptions: a handler's key is the nearest preceding top-level function or route path. */
const EXEMPT = new Map([
  ['/file-tombstones', 'the file-tombstone stream is ISO-positioned and untouched by record positions (design rev 8 §3a)'],
  ['oneById', 'one stored document by id: neither a page nor a push answer'],
]);

/** The balanced argument of the call whose `(` is at `open`. */
function argumentAt(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i).trim();
  }
  return text.slice(open + 1).trim();
}

/** Every 2xx answer in `text`: `{ line, key, arg }`. A status read from a variable counts as possibly 2xx. */
export function twoXxAnswers(text) {
  const decls = [...text.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^\w+Router\.(?:get|post)\(\s*'([^']+)'/gm)]
    .map(m => ({ at: m.index, key: m[1] ?? m[2] }));
  const out = [];
  for (const m of text.matchAll(/\bres(?:\.status\(([^)]*)\))?\.json\(/g)) {
    const status = m[1];
    if (status !== undefined && /^[45]\d\d$/.test(status.trim())) continue;
    const arg = argumentAt(text, m.index + m[0].length - 1);
    const decl = [...decls].reverse().find(d => d.at < m.index);
    out.push({ line: text.slice(0, m.index).split('\n').length, key: decl?.key ?? '(none)', arg });
  }
  return out;
}

describe('the detector reads 2xx answers and their arguments', () => {
  it('finds a bare answer, a status-200 answer and skips an error', () => {
    const src = "syncDocsRouter.get('/x', a, async (req, res) => {\n res.json({ items });\n res.status(200).json(pageAnswer(rows, o));\n res.status(400).json({ error: 'x' });\n});";
    const found = twoXxAnswers(src);
    assert.equal(found.length, 2);
    assert.equal(found[0].arg, '{ items }');
    assert.match(found[1].arg, /^pageAnswer\(/);
    assert.equal(found[0].key, '/x');
  });
});

describe('every sync door answers through sync/wire-answer.ts', () => {
  it('the module exists, builds both kinds and parses both kinds', () => {
    assert.ok(existsSync(join(REPO_ROOT, MODULE)),
      `${MODULE} does not exist: no door has a builder, so each spells \`positions: 1\` by hand or not at all`);
    const code = blankComments(readFileSync(join(REPO_ROOT, MODULE), 'utf8'));
    for (const name of [...BUILDERS, ...PARSERS]) {
      assert.match(code, new RegExp(String.raw`export\s+(?:async\s+)?(?:function|const)\s+${name}\b`), `the module exports no ${name}`);
    }
  });

  it('every 2xx answer of a record door is built by pageAnswer or pushAnswer', () => {
    const files = trackedSources('server/src/api/sync', { floor: 5 })
      .filter(f => SERVES_OR_TAKES_RECORDS.test(blankComments(readFileSync(join(REPO_ROOT, f), 'utf8'))));
    assert.ok(files.length >= 2, `only ${files.length} record-door file(s) derived from api/sync: the derivation is broken`);
    const sites = files.flatMap(file => twoXxAnswers(blankComments(readFileSync(join(REPO_ROOT, file), 'utf8'))).map(s => ({ file, ...s })))
      .filter(s => !EXEMPT.has(s.key));
    assert.ok(sites.length >= SITE_FLOOR, `only ${sites.length} 2xx answer(s) found in ${files}: the scan is broken`);
    assert.ok(new Set(sites.map(s => `${s.file}:${s.key}`)).size >= SITE_FLOOR, 'the sites come from fewer than five handlers: the scan is broken');
    const byHand = sites.filter(s => !new RegExp(String.raw`^(?:${BUILDERS.join('|')})\s*\(`).test(s.arg))
      .map(s => `${s.file}:${s.line} (${s.key}) res.json(${s.arg.replace(/\s+/g, ' ').slice(0, 60)}…)`);
    assert.deepEqual(byHand, [],
      'a sync door answers by hand: it drops `positions: 1` (and a page\'s `through` and `head`), so a 6.0 peer refuses it. Build it with pageAnswer / pushAnswer\n  '
      + byHand.join('\n  '));
  });

  it('every named exemption still names a handler that exists', () => {
    const text = trackedSources('server/src/api/sync', { floor: 5 }).map(f => blankComments(readFileSync(join(REPO_ROOT, f), 'utf8'))).join('\n');
    for (const key of EXEMPT.keys()) {
      assert.ok(text.includes(key), `the exemption \`${key}\` names nothing in api/sync: it is stale`);
    }
  });

  it('`positions: 1` is spelled in the module and nowhere else in server/src', () => {
    assert.ok(existsSync(join(REPO_ROOT, MODULE)), `${MODULE} does not exist`);
    const spellers = trackedSources('server/src', { floor: 200 })
      .filter(f => f !== MODULE && /\bpositions\s*:\s*1\b/.test(blankComments(readFileSync(join(REPO_ROOT, f), 'utf8'))));
    assert.deepEqual(spellers, [], 'the version stamp is written by hand outside the module that owns it');
    assert.match(blankComments(readFileSync(join(REPO_ROOT, MODULE), 'utf8')), /\bpositions\s*:\s*1\b/, 'the module does not stamp `positions: 1`');
  });
});
