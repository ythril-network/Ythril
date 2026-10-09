/**
 * Every door that accepts INLINE `edges` on a record write, each with the way to CALL it, to READ whether its record
 * exists afterwards, and to PROVOKE the record's own schema refusal on that door — the table
 * `an-inline-edge-refused-writes-nothing-on-every-door-db` walks.
 *
 * ## What it prevents
 *
 * A write whose inline edges are refused must leave NOTHING behind: no record, no edge, and the answer the door gives for
 * the record's own refusal. The rule is one sentence and it was broken on a different subset of doors every time it was
 * checked, because each check named the door it had in hand. A table that lists the doors in a test body is the same
 * defect with a later expiry date: the door added next year is simply not in it. So the doors are DERIVED, from what
 * each surface says it accepts, and the count is floored.
 *
 * ## Where the doors come from, and why two independent derivations
 *
 * - **MCP**, from the registered tools: a tool is a door when its `inputSchema` declares the record-level `edges`
 *   field (an array whose items carry `to` and `label`), at the top of the schema (`save_`/`update_` entity, fact,
 *   chrono) or on the items of a collection array (`save_bulk`). The built tool registry is the source, so a tool added
 *   next year with `...connectionSchemas()` in its schema is a door the moment it is registered.
 * - **REST**, from the mounted routes: a route is a door when its handler applies connections
 *   (`applyConnections(`) or hands the body to `bulkWrite(`. Read out of the source with `mountedRoutesWithSource`.
 *
 * `inlineEdgeDoors` THROWS when the two disagree — a door one surface has and the other lacks is the parity defect
 * (`CLAUDE.md`, "MCP and REST are ONE API with two doors"), and a table built from one side alone would report clean
 * about it. It also throws for a door it has no way to drive (a kind it holds no fixture for), because a door the table
 * cannot call is a door the rule silently stopped covering.
 *
 * ## Whole app, whole dispatch
 *
 * REST goes over real HTTP to the app (`createApp`), so an error reaches `app.ts`'s handler as it does for a client —
 * calling a route's handler alone would test a door no request reaches. MCP goes through `callTool`, the dispatch every
 * MCP request goes through. `_stalled-write-doors.mjs` is the first site of both; this reuses its `openStalledWriteDoors`
 * for the app, the token and the push-door fixture, and only changes what the spaces' schemas are.
 *
 * ## The oracle is computed per door, never written down
 *
 * What a door answers for the record's own refusal differs by door: REST POST answers `400`, REST PATCH `422`, bulk
 * answers `207` with an `errors` row, MCP answers its own status and structured body. `ownRefusal(door)` PROVOKES that
 * (an entity type the space does not allow) and hands back what the door said; the test then holds an inline-edge
 * refusal to it. A literal table of statuses would be a copy of the answer, and would stay green when both moved.
 *
 * ## What the table does not do
 *
 * It decides no rule about edges and holds no schema semantics beyond the fixtures below; it never reads a door's
 * source for its behaviour. `found` and `edgesIn` read the store, so a case asserts on the identities that are there and
 * not on a count.
 */
import fs from 'node:fs';
import { openStalledWriteDoors } from './_stalled-write-doors.mjs';
import { build } from './_push-door.mjs';
import { mountedRoutesWithSource } from './_routes.mjs';
import { CAPABILITIES } from './_capability-map.mjs';

/** Fixture ids: literal on purpose — a fixture deriving its expectations from the code under test asserts the code equals itself. */
export const IDS = Object.freeze({
  ALICE: 'cccccccc-0000-4000-8000-00000000a1ce',
  BOB: 'cccccccc-0000-4000-8000-00000000b0b0',
  DOC: 'cccccccc-0000-4000-8000-0000000d0c00',
  FACT_FAR: 'cccccccc-0000-4000-8000-0000000fac71',
  CHRONO_FAR: 'cccccccc-0000-4000-8000-0000000c4120',
  FILE_FAR: 'docs/real.txt',
  /** The record each UPDATE door edits, one per kind, and a second entity whose TYPE is outside `mentors`'s `from`. */
  UPD_ENTITY: 'cccccccc-0000-4000-8000-0000000e0001',
  UPD_DOC_ENTITY: 'cccccccc-0000-4000-8000-0000000e0002',
  UPD_FACT: 'cccccccc-0000-4000-8000-0000000fa001',
  UPD_CHRONO: 'cccccccc-0000-4000-8000-0000000c0001',
  /** A caller-chosen id for a create that must converge, and an id nothing is stored under. */
  CONVERGE: 'cccccccc-0000-4000-8000-0000000c0de1',
  NOBODY: 'cccccccc-0000-4000-8000-00000000dead',
});

/** The text a seeded record starts with, and what an edit door sets: the field a case reads back to tell "unchanged". */
export const SEED_DESCRIPTION = 'as seeded';
export const EDITED_DESCRIPTION = 'as edited by the door';

/**
 * The per-kind fixtures: where the record lives, the field a case marks it by, a record the space accepts, a record the
 * space refuses on its own (a `type` outside the declared allowlist — every kind validates that), and the seeded record
 * an update door edits.
 */
export const KINDS = Object.freeze({
  entity: {
    coll: 'entities', marker: 'name', bulkKey: 'entities', segment: 'entities', updId: IDS.UPD_ENTITY,
    valid: (m) => ({ name: m, type: 'person' }),
    ownInvalid: (m) => ({ name: m, type: 'widget' }),
    seed: (space, id, extra = {}) => build.entity(space, id, 3, { name: 'Seeded entity', type: 'person', description: SEED_DESCRIPTION, ...extra }),
  },
  fact: {
    coll: 'facts', marker: 'fact', bulkKey: 'facts', segment: 'facts', updId: IDS.UPD_FACT,
    valid: (m) => ({ fact: m, type: 'note' }),
    ownInvalid: (m) => ({ fact: m, type: 'widget' }),
    seed: (space, id, extra = {}) => build.fact(space, id, 3, { fact: 'Seeded fact', type: 'note', description: SEED_DESCRIPTION, ...extra }),
  },
  // A chrono type outside the allowlist is refused by the door's SHAPE check (a plain `400`), not by the schema — so the
  // record's own schema refusal is provoked with a property the type declares an enum for.
  chrono: {
    coll: 'chrono', marker: 'title', bulkKey: 'chrono', segment: 'chrono', updId: IDS.UPD_CHRONO,
    valid: (m) => ({ title: m, type: 'incident', startsAt: '2026-10-01T00:00:00.000Z', properties: { severity: 'low' } }),
    ownInvalid: (m) => ({ title: m, type: 'incident', startsAt: '2026-10-01T00:00:00.000Z', properties: { severity: 'extreme' } }),
    ownEdit: { properties: { severity: 'extreme' } },
    seed: (space, id, extra = {}) => build.chrono(space, id, 3, { title: 'Seeded chrono', type: 'incident', description: SEED_DESCRIPTION, properties: { severity: 'low' }, ...extra }),
  },
});

/** The edge label vocabulary of the fixture schema: `knows` is plain, `mentors` needs a `person` subject, `reports_to` is functional. */
export const LABELS = Object.freeze({ plain: 'knows', endpoints: 'mentors', functional: 'reports_to', undeclared: 'nonesuch' });

/** The schema every fixture space declares. */
export function fixtureTypeSchemas() {
  return {
    entity: { person: {}, document: {} },
    fact: { note: {} },
    chrono: { incident: { propertySchemas: { severity: { type: 'string', enum: ['low', 'high'], required: true } } } },
    edge: {
      [LABELS.plain]: {},
      [LABELS.endpoints]: { endpoints: { from: ['person'] } },
      [LABELS.functional]: { functional: true },
    },
  };
}

/**
 * Open the doors for `spaces` — `{ id, strictLinkage, validationMode }` each — and give each its schema.
 *
 * The spaces are registered by `openStalledWriteDoors` (so the app, the token and the indexes are the shared ones); their
 * meta is then rewritten in the config file and reloaded, which is how the sibling edge test sets a schema.
 */
export async function openInlineEdgeDoors({ suite, spaces, proxies = [] }) {
  const opened = await openStalledWriteDoors({ suite, spaces: spaces.map(s => s.id) });
  try {
    const path = process.env['CONFIG_PATH'];
    const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
    for (const s of spaces) {
      const entry = cfg.spaces.find(x => x.id === s.id);
      entry.meta = { ...entry.meta, validationMode: s.validationMode, strictLinkage: s.strictLinkage, typeSchemas: fixtureTypeSchemas() };
    }
    // A proxy owns no collections and no schema: it is configuration only, so it is added after the members are registered.
    for (const p of proxies) cfg.spaces.push({ id: p.id, label: p.id, folders: [], proxyFor: p.proxyFor });
    fs.writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
  } catch (err) {
    await opened.close();
    throw err;
  }
  return opened;
}

/** Empty `space`, then store the far ends and the records an update door edits. */
export async function seedInlineEdgeSpace(env, space) {
  const { door } = env;
  await door.wipe(space);
  await door.setCounter(space, 10);
  await door.coll(space, 'entities').insertMany([
    build.entity(space, IDS.ALICE, 3, { name: 'Alice', type: 'person' }),
    build.entity(space, IDS.BOB, 3, { name: 'Bob', type: 'person' }),
    build.entity(space, IDS.DOC, 3, { name: 'Handbook', type: 'document' }),
    KINDS.entity.seed(space, IDS.UPD_ENTITY),
    KINDS.entity.seed(space, IDS.UPD_DOC_ENTITY, { name: 'Seeded document', type: 'document' }),
  ]);
  await door.coll(space, 'facts').insertMany([
    build.fact(space, IDS.FACT_FAR, 3, { fact: 'a far fact', type: 'note' }),
    KINDS.fact.seed(space, IDS.UPD_FACT),
  ]);
  await door.coll(space, 'chrono').insertMany([
    build.chrono(space, IDS.CHRONO_FAR, 3, { title: 'a far chrono', type: 'incident' }),
    KINDS.chrono.seed(space, IDS.UPD_CHRONO),
  ]);
  await door.coll(space, 'files').insertOne(build.filemeta(space, IDS.FILE_FAR, 3));
}

/** The far end of each `toKind`: one that exists in a seeded space, and one that names nothing. */
export const FAR_ENDS = Object.freeze({
  entity: { exists: { to: IDS.BOB }, dangling: { to: 'cccccccc-0000-4000-8000-0000000d1a91' } },
  fact: { exists: { to: IDS.FACT_FAR, toKind: 'fact' }, dangling: { to: 'cccccccc-0000-4000-8000-0000000d1a92', toKind: 'fact' } },
  chrono: { exists: { to: IDS.CHRONO_FAR, toKind: 'chrono' }, dangling: { to: 'cccccccc-0000-4000-8000-0000000d1a93', toKind: 'chrono' } },
  file: { exists: { to: IDS.FILE_FAR, toKind: 'file' }, dangling: { to: 'docs/missing.txt', toKind: 'file' } },
});

/** The edge a case sends: `label` and a far end (`FAR_ENDS[kind].exists` or `.dangling`, or an explicit `{ to, toKind? }`). */
export const edge = (label, end) => ({ label, ...end });

// ── Derivation ─────────────────────────────────────────────────────────────────────────────────────────────────────

const SCHEMA_ARGS = { requiredSpace: { type: 'string' }, optionalSpace: { type: 'string' } };

/** Whether this schema node is the record-level inline `edges` field: an array whose items carry `to` and `label` and no `from`. */
const isInlineEdges = (node) => node?.type === 'array' && node.items?.properties?.to && node.items.properties.label && !node.items.properties.from;

/**
 * The MCP doors, read from the registered tools: `{ tool, kind, verb, bulk }`.
 * A top-level `edges` field is a `save_`/`update_` door; an array property whose items declare it is a bulk collection.
 */
async function mcpDoorsFromRegistry() {
  const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
  const out = [];
  for (const tool of ALL_TOOLS) {
    const props = tool.inputSchema(SCHEMA_ARGS)?.properties ?? {};
    if (isInlineEdges(props['edges'])) {
      const m = /^(save|update)_(\w+)$/.exec(tool.name);
      if (!m) throw new Error(`tool ${tool.name} declares inline edges but is not a save_/update_ tool — the door table does not know how to drive it`);
      out.push({ tool: tool.name, kind: m[2], verb: m[1] === 'save' ? 'create' : 'update', bulk: false });
    }
    for (const [key, node] of Object.entries(props)) {
      if (node?.type === 'array' && isInlineEdges(node.items?.properties?.['edges'])) {
        const kind = Object.keys(KINDS).find(k => KINDS[k].bulkKey === key);
        if (!kind) throw new Error(`tool ${tool.name} takes records with inline edges under \`${key}\`, which the door table holds no fixture for`);
        out.push({ tool: tool.name, kind, verb: 'create', bulk: true, collection: key });
      }
    }
  }
  return out;
}

/** The REST doors, read from the mounted routes: a handler that applies connections, or one that hands its body to `bulkWrite(`. */
function restDoorsFromRoutes() {
  const out = [];
  for (const r of mountedRoutesWithSource()) {
    const applies = /\bapplyConnections\s*\(/.test(r.source);
    const bulk = /\bbulkWrite\s*\(/.test(r.source);
    if (!applies && !bulk) continue;
    if (bulk) {
      for (const kind of Object.keys(KINDS)) out.push({ method: r.method, path: r.path, kind, verb: 'create', bulk: true, collection: KINDS[kind].bulkKey });
      continue;
    }
    const tail = r.path.split('/').filter(s => s && !s.startsWith(':')).pop();
    const kind = Object.keys(KINDS).find(k => KINDS[k].segment === tail);
    if (!kind) throw new Error(`${r.method} ${r.path} applies connections but its collection \`${tail}\` has no fixture in the door table`);
    out.push({ method: r.method, path: r.path, kind, verb: r.method === 'POST' ? 'create' : 'update', bulk: false });
  }
  return out;
}

/** The REST route a tool is documented as answering, from the capability map — the cross-check between the two derivations. */
function routeOfTool(tool) {
  const row = CAPABILITIES.find(([, t]) => t === tool);
  return row ? row[2] : null;
}

// ── Calling ────────────────────────────────────────────────────────────────────────────────────────────────────────

const CALLER = (env) => ({ rights: env.ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' });

async function restCall(env, method, path, body, headers = {}) {
  const r = await fetch(`${env.base}${path}`, {
    method, headers: { Authorization: `Bearer ${env.adminKey}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, text };
}

async function mcpCall(env, name, args) {
  const out = await env.callTool({ name, args, caller: CALLER(env) });
  const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
  return { status: out.status, body: out.result.structuredContent ?? {}, text, isError: out.result.isError === true };
}

/**
 * Read what a call answered as a refusal, or `null` when it was accepted.
 *
 * A single-record door refuses by status; a bulk door answers `207` and refuses the ITEM, in an `errors` row naming its
 * collection and index — so for bulk the refusal is that row (`row`), and a `status` is the transport's, not the record's.
 */
function refusalOf(door, answer) {
  if (door.bulk) {
    const errors = Array.isArray(answer.body?.errors) ? answer.body.errors : [];
    const row = errors.find(e => e.index === 0 && e.type === door.kind);
    return row ? { status: answer.status, row, text: answer.text } : null;
  }
  const refused = answer.status >= 400 || answer.isError === true;
  return refused ? { status: answer.status, body: answer.body, text: answer.text } : null;
}

// ── The table ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every door, for `env` (what `openInlineEdgeDoors` returned): `{ name, channel, verb, kind, bulk, send, found, edgesIn, stored }`.
 *
 * - `send(space, { fields, id, targetSpace, headers })` — `fields` is the record's own fields plus `edges`; `id` addresses the record an
 *   update door edits; `targetSpace` names the member when `space` is a proxy; `headers` (REST only — MCP has no `If-Match`) is e.g. a stale precondition.
 *   Answers `{ status, body, text, refusal }`, `refusal` being `null` when the write was accepted.
 * - `found(space, marker)` — the ids of every record of this door's kind carrying the marker. A create door's record is
 *   unknown beforehand, so the case marks it and looks it up — an identity, not a count.
 * - `stored(space, id)` — the record under an id, or `null`.
 * - `edgesIn(space)` — `{ from, to, label }` of every edge in the space.
 *
 * THROWS below `floor` doors, when the surfaces disagree about which doors exist, or for a door it cannot drive.
 */
export async function inlineEdgeDoors(env, { floor = 18 } = {}) {
  const mcp = await mcpDoorsFromRegistry();
  const rest = restDoorsFromRoutes();
  const key = (d) => `${d.kind}/${d.verb}${d.bulk ? '/bulk' : ''}`;
  const mcpKeys = new Set(mcp.map(key));
  const restKeys = new Set(rest.map(key));
  const onlyMcp = [...mcpKeys].filter(k => !restKeys.has(k));
  const onlyRest = [...restKeys].filter(k => !mcpKeys.has(k));
  if (onlyMcp.length > 0 || onlyRest.length > 0) {
    throw new Error(`the two surfaces disagree about which doors take inline edges — MCP only: [${onlyMcp}], REST only: [${onlyRest}]`);
  }
  for (const d of mcp) {
    const route = routeOfTool(d.tool);
    const twin = rest.find(r => key(r) === key(d));
    if (!route || !twin || route !== `${twin.method} ${twin.path}`) {
      throw new Error(`${d.tool} is documented as answering \`${route}\` but the REST door derived for ${key(d)} is \`${twin?.method} ${twin?.path}\``);
    }
  }
  const doors = [];
  for (const d of rest) doors.push(restDoor(env, d));
  for (const d of mcp) doors.push(mcpDoor(env, d));
  if (doors.length < floor) {
    throw new Error(`only ${doors.length} doors take inline edges, below the floor of ${floor} — the derivation stopped matching, and every case over it would be about nothing`);
  }
  return doors;
}

function store(env, door) {
  const coll = KINDS[door.kind].coll;
  const marker = KINDS[door.kind].marker;
  return {
    found: async (space, text) => (await env.door.coll(space, coll).find({ [marker]: text }).toArray()).map(r => r._id),
    stored: async (space, id) => (await env.door.coll(space, coll).findOne({ _id: id })) ?? null,
    edgesIn: async (space) => (await env.door.coll(space, 'edges').find({}).toArray()).map(e => ({ from: e.from, to: e.to, label: e.label })),
  };
}

/** The body/args a door sends: bulk wraps the record in its collection, the rest send the fields as they are. */
const bulkBody = (door, fields) => ({ [door.collection]: [fields] });

function restDoor(env, d) {
  const door = {
    name: `REST ${d.method} ${d.path}${d.bulk ? ` (${d.collection})` : ''}`, channel: 'rest', ...d,
  };
  door.send = async (space, { fields, id, targetSpace, headers } = {}) => {
    const path = d.path.replace(':spaceId', space).replace(':id', id ?? '') + (targetSpace ? `?targetSpace=${encodeURIComponent(targetSpace)}` : '');
    const answer = await restCall(env, d.method, path, d.bulk ? bulkBody(door, fields) : fields, headers);
    return { ...answer, refusal: refusalOf(door, answer) };
  };
  return Object.assign(door, store(env, door));
}

function mcpDoor(env, d) {
  const door = { name: `MCP ${d.tool}${d.bulk ? ` (${d.collection})` : ''}`, channel: 'mcp', ...d };
  // MCP has no `If-Match`: a precondition header is a REST-only parameter, so `headers` is not read here.
  door.send = async (space, { fields, id, targetSpace } = {}) => {
    const target = targetSpace ? { targetSpace } : {};
    const args = d.bulk ? { space, ...target, ...bulkBody(door, fields) } : { space, ...target, ...(id !== undefined ? { id } : {}), ...fields };
    const answer = await mcpCall(env, d.tool, args);
    return { ...answer, refusal: refusalOf(door, answer) };
  };
  return Object.assign(door, store(env, door));
}

// ── The oracle ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What THIS door answers for the record's own refusal — provoked, not remembered.
 *
 * A create door (and bulk) is sent a record of a type the space does not declare; an update door is sent that type as an
 * edit of its seeded record. The space must be seeded and strict. Throws when the door ACCEPTED it, because an oracle
 * taken from an accepted write would hold nothing to anything.
 */
export async function ownRefusal(door, space) {
  const marker = `own refusal ${door.name}`;
  const kind = KINDS[door.kind];
  const fields = door.verb === 'update' ? (kind.ownEdit ?? { type: 'widget' }) : kind.ownInvalid(marker);
  const answer = await door.send(space, { fields, id: door.verb === 'update' ? KINDS[door.kind].updId : undefined });
  if (!answer.refusal) {
    throw new Error(`${door.name} accepted a record of a type the space does not declare (${answer.status}: ${answer.text.slice(0, 200)}) — no oracle can be taken from it`);
  }
  return answer;
}

/**
 * How `answer`'s refusal differs from `oracle`'s (both from `door.send`), as sentences; `[]` when it is the same refusal.
 *
 * Same refusal means: a single-record door answers the same STATUS and the same `error` code and carries every key the
 * record's own refusal carries; a bulk door answers an `errors` row of the same keys for the same collection. The words
 * are not compared — they differ by what was refused.
 */
export function refusalDifferences(door, answer, oracle) {
  const out = [];
  if (!answer.refusal) return ['it was accepted'];
  if (door.bulk) {
    const keys = (r) => Object.keys(r).sort().join(',');
    if (keys(answer.refusal.row) !== keys(oracle.refusal.row)) {
      out.push(`the errors row has keys [${keys(answer.refusal.row)}], the record's own refusal [${keys(oracle.refusal.row)}]`);
    }
    if (answer.refusal.row.type !== oracle.refusal.row.type) out.push(`the row's type is \`${answer.refusal.row.type}\`, not \`${oracle.refusal.row.type}\``);
    return out;
  }
  if (answer.status !== oracle.status) out.push(`status ${answer.status}, the record's own refusal answers ${oracle.status}`);
  if (answer.body?.error !== oracle.body?.error) out.push(`error code ${JSON.stringify(answer.body?.error)}, the record's own refusal says ${JSON.stringify(oracle.body?.error)}`);
  for (const k of Object.keys(oracle.body ?? {})) {
    if (!(k in (answer.body ?? {}))) out.push(`the body lacks \`${k}\`, which the record's own refusal carries`);
  }
  return out;
}
