/**
 * A write through a proxy reaches only the members the calling token reaches, on BOTH doors (Q-440, bundle-100, plan rev 2).
 *
 * ## What it was written against
 *
 * Base `612f50c4`. A token holding write on `qa` and nothing on `secret` wrote into `secret` through a wildcard proxy
 * (`POST /api/brain/spaces/allp/entities?targetSpace=secret` answered 201, and `save_entity` with `targetSpace: 'secret'` the
 * same), because `resolveWriteTarget` answers membership and never reach. The wildcard branch answered a space the token
 * cannot see (201) differently from one that does not exist (400 `not found`): an existence oracle. The REST deletes of an
 * edge and a link walked every member of the proxy, so the same token deleted an edge in `secret` (204). MCP checked the
 * tool's rung on the proxy id only, so a token READ-only on `qa` and write on the proxy wrote into `qa`, and
 * `retry_embed_media` through a proxy re-queued the failed jobs of a member the token only reads.
 *
 * ## The rule these cases hold, on REST and on MCP `callTool` alike
 *
 * - Order: exists -> reached -> is-a-proxy -> rung. A target the token does not reach is answered EXACTLY as a missing one
 *   (status and text, with the name the caller sent), and nothing lands in it: asserted on identity, by the record's own
 *   marker and by the id an answer named.
 * - A target the token reaches but without the rung the write needs is refused 403 and nothing lands.
 * - A refusal that lists members (`Specify targetSpace (one of: …)`) lists only the members the token reaches.
 * - A READ through the write-target resolver (the ingest status) needs the read rung, so a read-only token still reads it.
 * - REST `DELETE …/edges/:id` and `…/links/:id` through a proxy find a record only in a member the token reaches: one in an
 *   unreached member answers 404 and remains.
 * - MCP `retry_embed_media` through a proxy acts only on members where the token holds the tool's rung.
 *
 * Both a wildcard proxy (`proxyFor: ['*']`) and an explicit one over `[qa, secret]` are asked, because the defect lived
 * in the wildcard branch and the explicit branch shares the member-list refusals.
 *
 * ## Not asked here, and why
 *
 * `space_reindex` through a proxy (plan O5 names `embed.ts` reindex): the tool is instance-admin only (`admin: true` in the
 * dispatcher) and `planReindex` refuses a proxy before any member is touched, so no scoped token can reach the member walk
 * on this base and a case could not go red. The reindex member walk is held by the source gate's narrowing rule instead.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-proxy-write-reaches-only-what-the-token-reaches-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = await mongoSkipReason();
for (const k of ['SKIP_GLOBAL_RATE_LIMIT', 'SKIP_AUTH_RATE_LIMIT', 'SKIP_SYNC_RATE_LIMIT']) process.env[k] = 'true';
process.env['YTHRIL_RATE_LIMIT_PER_MINUTE'] ??= '1000000';

const QA = 'qa';
const SECRET = 'secret';
const MISSING = 'nosuch';
const WILD = 'allp';
const EXPLICIT = 'xp';
const PROXIES = [WILD, EXPLICIT];
const META = { suppressEmbeddings: true };

let door, app, base, callTool, ingestRuns, col, spaceCollection, SPACE_AREAS;
/** Tokens: `w` writes `qa` only; `r` reads `qa` only; `m` writes `qa` and reads `secret`. Each holds write on both proxies. */
const tok = {};
let adminKey;
let counter = 0;
const uniq = (label) => `${label}-${process.pid}-${++counter}`;
const fmt = (x) => JSON.stringify(x)?.slice(0, 240);

/** The writes asked, one per record kind; `marker` is the field a stored row carries the unique text in. */
const WRITES = [
  { op: 'entity.create', tool: 'save_entity', route: 'entities', marker: 'name', payload: (m) => ({ name: m, type: 'thing' }) },
  { op: 'fact.create', tool: 'save_fact', route: 'facts', marker: 'fact', payload: (m) => ({ fact: m }) },
  { op: 'chrono.create', tool: 'save_chrono', route: 'chrono', marker: 'title', payload: (m) => ({ title: m, type: 'event', startsAt: '2026-01-01T00:00:00.000Z' }) },
];

/** A rights row: `rung` in knowledge and files, read in schema and data quality, nothing in networks. */
const row = (rung) => Object.fromEntries(SPACE_AREAS.map(a => [a, a === 'knowledge' || a === 'files' ? rung : a === 'networks' ? 'none' : 'read']));

// ── doors ────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function rest(t, method, url, body) {
  const init = { method, headers: { Authorization: `Bearer ${t.key}` }, signal: AbortSignal.timeout(60_000) };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await fetch(`${base}${url}`, init);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { door: 'rest', status: r.status, refused: r.status >= 400, error: typeof json?.error === 'string' ? json.error : '', body: json, id: json?._id };
}

async function mcp(t, name, args) {
  const out = await callTool({ name, args, caller: { rights: t.rights, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: t.id, tokenLabel: t.id } });
  const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
  const refused = out.result.isError === true || out.status >= 400;
  const id = out.result.structuredContent?._id ?? out.result.structuredContent?.id ?? /\(ID ([0-9a-f-]{36})\)/.exec(text)?.[1];
  return { door: 'mcp', status: out.status, refused, error: refused ? text : '', body: out.result.structuredContent ?? null, id, text };
}

/** One write on one door, through `space`, naming `target` (undefined names none). */
function writeOn(which, t, w, space, target, marker) {
  const payload = w.payload(marker);
  if (which === 'rest') {
    const qs = target === undefined ? '' : `?targetSpace=${encodeURIComponent(target)}`;
    return rest(t, 'POST', `/api/brain/spaces/${space}/${w.route}${qs}`, payload);
  }
  return mcp(t, w.tool, { space, ...(target === undefined ? {} : { targetSpace: target }), ...payload });
}

/** The rows in `space` that carry `marker`, or the id an answer named: the identities a write could have left. */
async function landed(space, w, marker, id) {
  const c = col(spaceCollection(space, w.route));
  const or = [{ [w.marker]: marker }];
  if (id) or.push({ _id: id });
  return (await c.find({ $or: or }, { projection: { _id: 1 } }).toArray()).map(d => d._id);
}

/** An answer with the target name the caller sent replaced, so a refusal of `secret` compares with one of `nosuch`. */
const shape = (a, name) => ({ status: a.status, refused: a.refused, error: a.error.split(name).join('<target>') });

describe('a proxy write reaches only what the token reaches (Q-440)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({
      suite: 'q440-proxy-write-reach',
      spaces: [
        { id: QA, label: QA, folders: [], meta: META },
        { id: SECRET, label: SECRET, folders: [], meta: META },
        { id: WILD, label: WILD, folders: [], proxyFor: ['*'], meta: {} },
        { id: EXPLICIT, label: EXPLICIT, folders: [], proxyFor: [QA, SECRET], meta: {} },
      ],
    });
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    ({ ingestRuns } = await import('../../server/dist/extractor/ingest-runs.js'));
    ({ col } = await import('../../server/dist/db/mongo.js'));
    ({ spaceCollection } = await import('../../server/dist/db/space-collection.js'));
    ({ SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js'));
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'q440-admin', admin: true })).plaintext;
    const mint = async (name, perSpace) => {
      const { record, plaintext } = await tokens.createToken({ name, rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace } });
      return { key: plaintext, rights: record.rights, id: record.id ?? name };
    };
    tok.w = await mint('q440-write-qa', { [QA]: row('write'), [WILD]: row('write'), [EXPLICIT]: row('write') });
    tok.r = await mint('q440-read-qa', { [QA]: row('read'), [WILD]: row('write'), [EXPLICIT]: row('write') });
    tok.m = await mint('q440-media', { [QA]: row('write'), [SECRET]: row('read'), [WILD]: row('write'), [EXPLICIT]: row('write') });
    const { createApp } = await import('../../server/dist/app.js');
    app = await listenOnLoopback(http.createServer(createApp()));
    base = app.url;
  });

  after(async () => {
    await app?.close();
    await door?.close();
  });

  it('a write into a member the token does not reach is answered exactly as a missing space, and nothing lands there', async () => {
    const failures = [];
    for (const proxy of PROXIES) {
      for (const w of WRITES) {
        for (const which of ['rest', 'mcp']) {
          const marker = uniq(`${which}-${proxy}-${w.op}-secret`);
          const intoSecret = await writeOn(which, tok.w, w, proxy, SECRET, marker);
          const intoMissing = await writeOn(which, tok.w, w, proxy, MISSING, uniq(`${which}-${proxy}-${w.op}-missing`));
          const rows = await landed(SECRET, w, marker, intoSecret.id);
          const where = `${which} ${w.op} via ${proxy}`;
          if (!intoSecret.refused) failures.push(`${where}: a write into '${SECRET}' was ACCEPTED (${intoSecret.status})`);
          if (rows.length) failures.push(`${where}: a row landed in '${SECRET}': ${fmt(rows)}`);
          try { assert.deepEqual(shape(intoSecret, SECRET), shape(intoMissing, MISSING)); }
          catch { failures.push(`${where}: '${SECRET}' answered ${fmt(shape(intoSecret, SECRET))}, a missing space ${fmt(shape(intoMissing, MISSING))}`); }
        }
      }
    }
    assert.deepEqual(failures, [], 'a token reaching only qa must not write into secret through a proxy, and must not learn that secret exists');
  });

  it('control: a write into the member the token reaches lands there, on both doors and both proxies', async () => {
    const failures = [];
    for (const proxy of PROXIES) {
      for (const w of WRITES) {
        for (const which of ['rest', 'mcp']) {
          const marker = uniq(`${which}-${proxy}-${w.op}-qa`);
          const a = await writeOn(which, tok.w, w, proxy, QA, marker);
          const rows = await landed(QA, w, marker);
          if (a.refused) failures.push(`${which} ${w.op} via ${proxy}: refused ${a.status}: ${a.error.slice(0, 200)}`);
          else if (rows.length !== 1) failures.push(`${which} ${w.op} via ${proxy}: answered ${a.status} and ${rows.length} row(s) landed in '${QA}'`);
        }
      }
    }
    assert.deepEqual(failures, [], 'the reached member is a valid write target');
  });

  it('a proxy write that names no target lists only the members the token reaches', async () => {
    const failures = [];
    const w = WRITES[0];
    for (const proxy of PROXIES) {
      for (const which of ['rest', 'mcp']) {
        const a = await writeOn(which, tok.w, w, proxy, undefined, uniq('none'));
        const listed = /Specify targetSpace \(one of: ([^)]*)\)/.exec(a.error)?.[1];
        if (listed === undefined) { failures.push(`${which} via ${proxy}: no member list in ${fmt(a.error)}`); continue; }
        try { assert.deepEqual(listed.split(',').map(s => s.trim()).filter(Boolean), [QA]); }
        catch { failures.push(`${which} via ${proxy}: lists '${listed}'`); }
      }
      for (const which of ['rest', 'mcp']) {
        const a = await writeOn(which, tok.w, w, proxy, MISSING, uniq('missing'));
        if (a.error.includes(SECRET)) failures.push(`${which} via ${proxy}: refusing '${MISSING}' names '${SECRET}': ${fmt(a.error)}`);
      }
    }
    assert.deepEqual(failures, [], 'a refusal must not list a member the token cannot see');
  });

  it('a token read-only on qa is refused a write into qa through a proxy (403) on both doors, and nothing lands', async () => {
    const failures = [];
    for (const proxy of PROXIES) {
      for (const w of WRITES) {
        for (const which of ['rest', 'mcp']) {
          const marker = uniq(`${which}-${proxy}-${w.op}-ro`);
          const a = await writeOn(which, tok.r, w, proxy, QA, marker);
          const rows = await landed(QA, w, marker, a.id);
          const where = `${which} ${w.op} via ${proxy}`;
          if (a.status !== 403) failures.push(`${where}: answered ${a.status}${a.refused ? `: ${a.error.slice(0, 160)}` : ' (accepted)'}`);
          if (rows.length) failures.push(`${where}: a row landed in '${QA}': ${fmt(rows)}`);
        }
      }
    }
    assert.deepEqual(failures, [], 'the rung a write needs is held on the member it lands in, not on the proxy it was addressed through');
  });

  it('control: the read-only token reads an ingest run in qa through a proxy on both doors (the status read needs the read rung)', async () => {
    const run = ingestRuns.create(QA);
    const failures = [];
    for (const proxy of PROXIES) {
      const r = await rest(tok.r, 'GET', `/api/brain/spaces/${proxy}/ingest/${run.runId}?targetSpace=${QA}`);
      if (r.status !== 200 || r.body?.runId !== run.runId) failures.push(`rest via ${proxy}: ${r.status} ${fmt(r.body)}`);
      const m = await mcp(tok.r, 'ingest_status', { space: proxy, targetSpace: QA, runId: run.runId });
      if (m.refused || !m.text.includes(run.runId) && m.body?.runId !== run.runId) failures.push(`mcp via ${proxy}: ${fmt(m.text)}`);
    }
    assert.deepEqual(failures, [], 'a status read through the write-target resolver must be judged by the read rung');
  });

  it('an ingest run in a member the token does not reach is answered as one in a missing space, on both doors', async () => {
    const run = ingestRuns.create(SECRET);
    const failures = [];
    for (const proxy of PROXIES) {
      const rs = await rest(tok.w, 'GET', `/api/brain/spaces/${proxy}/ingest/${run.runId}?targetSpace=${SECRET}`);
      const rm = await rest(tok.w, 'GET', `/api/brain/spaces/${proxy}/ingest/${run.runId}?targetSpace=${MISSING}`);
      if (!rs.refused) failures.push(`rest via ${proxy}: the run in '${SECRET}' was served (${rs.status}) ${fmt(rs.body)}`);
      try { assert.deepEqual(shape(rs, SECRET), shape(rm, MISSING)); }
      catch { failures.push(`rest via ${proxy}: '${SECRET}' answered ${fmt(shape(rs, SECRET))}, a missing space ${fmt(shape(rm, MISSING))}`); }
      const ms = await mcp(tok.w, 'ingest_status', { space: proxy, targetSpace: SECRET, runId: run.runId });
      const mm = await mcp(tok.w, 'ingest_status', { space: proxy, targetSpace: MISSING, runId: run.runId });
      if (!ms.refused) failures.push(`mcp via ${proxy}: the run in '${SECRET}' was served: ${fmt(ms.text)}`);
      try { assert.deepEqual(shape(ms, SECRET), shape(mm, MISSING)); }
      catch { failures.push(`mcp via ${proxy}: '${SECRET}' answered ${fmt(shape(ms, SECRET))}, a missing space ${fmt(shape(mm, MISSING))}`); }
    }
    assert.deepEqual(failures, [], 'a run in an unreached member must not be readable through a proxy, nor distinguishable from none');
  });

  it('REST DELETE of an edge and of a link living in an unreached member, through a proxy, answers 404 and the record remains', async () => {
    const admin = { key: adminKey };
    const seed = async (route, body) => {
      const r = await rest(admin, 'POST', `/api/brain/spaces/${SECRET}/${route}`, body);
      assert.ok(!r.refused, `seeding ${route} in ${SECRET} failed: ${r.status} ${fmt(r.body)}`);
      return r.body._id;
    };
    const failures = [];
    for (const proxy of PROXIES) {
      const from = await seed('entities', { name: uniq('from'), type: 'thing' });
      const to = await seed('entities', { name: uniq('to'), type: 'thing' });
      const edgeId = await seed('edges', { from, to, label: uniq('rel') });
      const factId = await seed('facts', { fact: uniq('fact') });
      const linkId = await seed('links', { from: factId, fromKind: 'fact', to, toKind: 'entity' });
      for (const [route, id] of [['edges', edgeId], ['links', linkId]]) {
        const a = await rest(tok.w, 'DELETE', `/api/brain/spaces/${proxy}/${route}/${encodeURIComponent(id)}`);
        const still = await col(spaceCollection(SECRET, route)).countDocuments({ _id: id });
        if (a.status !== 404) failures.push(`DELETE ${route} via ${proxy}: answered ${a.status}`);
        if (still !== 1) failures.push(`DELETE ${route} via ${proxy}: the ${route.slice(0, -1)} in '${SECRET}' is GONE`);
      }
    }
    assert.deepEqual(failures, [], 'a delete through a proxy must walk only the members the token reaches');
  });

  it('MCP retry_embed_media through a proxy re-queues only the members where the token holds the files write rung', async () => {
    const jobs = (sp) => col(spaceCollection(sp, 'mediaJobs'));
    const failed = (id) => ({ _id: id, status: 'failed', attempts: 3, lastError: 'q440 seed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const qaJob = uniq('qa-job');
    const secretJob = uniq('secret-job');
    await jobs(QA).insertOne(failed(qaJob));
    await jobs(SECRET).insertOne(failed(secretJob));
    const a = await mcp(tok.m, 'retry_embed_media', { space: WILD });
    const qaAfter = (await jobs(QA).findOne({ _id: qaJob }))?.status;
    const secretAfter = (await jobs(SECRET).findOne({ _id: secretJob }))?.status;
    assert.ok(!a.refused, `retry_embed_media through ${WILD} was refused: ${a.text}`);
    assert.notEqual(qaAfter, 'failed', `control: the failed job in '${QA}' (files write) was not re-queued: ${a.text}`);
    assert.equal(secretAfter, 'failed', `the failed job in '${SECRET}', where the token holds files READ only, was re-queued (${secretAfter}): ${a.text}`);
  });
});
