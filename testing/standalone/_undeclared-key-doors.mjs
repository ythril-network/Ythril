/**
 * The fixture every "undeclared property key" door test shares (Q-93): three spaces that differ ONLY in `validationMode`,
 * and a way to reach the app (REST over HTTP) and the MCP dispatch (`callTool`) on them.
 *
 * ## What it prevents
 *
 * The behaviour of the rule is one sentence per mode: in a strict space a write that ADDS a property key its type does not
 * declare is refused with nothing stored, in a warn space it lands and is flagged, in an off space it is ignored. It has to
 * hold on every door that stores a record, and a file per door that each built its own spaces would let one door's fixture
 * drift (a strict space whose type declares no properties at all, where the rule is correctly silent, and a test that
 * passes for it). One fixture, so every door asks the same question of the same schema.
 *
 * ## The schema, and why each type is there
 *
 * Every kind has a type that DECLARES one property (the rule applies), a type that declares NONE and carries no
 * `propertySchemas` (open, the rule is silent) and — for entities — nothing else, because with an entity allowlist a type
 * outside it is refused for its own reason. `blank` declares `propertySchemas: {}` (also open: an empty list is not a closed
 * one). Fixture values are literal on purpose: a fixture that derived its expectations from the server would assert the
 * server equals itself.
 *
 * ## What it does not do
 *
 * It decides no rule and reads no source. A door file builds its own request for its own door and asks `reading()` what came
 * back; `stored()` reads the store, so "nothing stored" is an identity check and not a count.
 */
import http from 'node:http';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { openPushDoor } from './_push-door.mjs';

/** The three modes, and the one space each lives in. */
export const MODES = Object.freeze(['strict', 'warn', 'off']);
export const spaceOf = (mode) => `undeclkeys${mode}`;

/** A key no type declares: the one every case adds. Literal on purpose. */
export const UNDECLARED = 'zzNotDeclared';
/** A key a type declares; writing it is never a violation. */
export const DECLARED = Object.freeze({ entity: 'status', edge: 'since', fact: 'severity', chrono: 'version' });
/** The type (or edge label) that declares one property, per kind, and the one that declares none (open). */
export const DECLARING = Object.freeze({ entity: 'service', edge: 'depends_on', fact: 'note', chrono: 'release' });
export const OPEN = Object.freeze({ entity: 'scratch', edge: 'relates_to', fact: 'loose', chrono: 'milestone' });
/** An entity type that declares `propertySchemas: {}` (open — an empty list is not a closed one). */
export const EMPTY_DECLARED_ENTITY = 'blank';

const meta = (validationMode) => ({
  validationMode,
  suppressEmbeddings: true,
  typeSchemas: {
    entity: {
      service: { propertySchemas: { status: { type: 'string' } } },
      scratch: {},
      blank: { propertySchemas: {} },
    },
    edge: {
      depends_on: { propertySchemas: { since: { type: 'string' } } },
      relates_to: {},
    },
    fact: {
      note: { propertySchemas: { severity: { type: 'string' } } },
      loose: {},
    },
    chrono: {
      release: { propertySchemas: { version: { type: 'string' } } },
      milestone: {},
    },
  },
});

/** The config `spaces` entries: one per mode. */
export const undeclaredKeySpaces = () => MODES.map(mode => ({
  id: spaceOf(mode), label: spaceOf(mode), folders: [], completeLinkage: true, meta: meta(mode),
}));

/**
 * Open the push door (the harness database, the config, the initialised spaces), the app on loopback, and the MCP dispatch.
 *
 * @param {object} o
 * @param {string} o.suite  harness database slug, unique per file (`a-db-harness-name-is-unique`)
 * @returns `{ door, base, adminKey, callTool, rest(method, path, body), mcp(name, args), close() }`; `rest` answers
 *   `{ status, body, text }`, `mcp` answers `{ status, isError, body, text }`
 */
export async function openUndeclaredKeyDoors({ suite, extraSpaces = [] }) {
  // A merge or an ingest would embed inline unless the space suppresses it; never let a test fetch a model.
  process.env['YTHRIL_MODELS_OFFLINE'] = '1';
  const door = await openPushDoor({ suite, spaces: [...undeclaredKeySpaces(), ...extraSpaces] });
  let server;
  try {
    const { callTool } = await import('../../server/dist/mcp/call-tool.js');
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    const ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const tokens = await import('../../server/dist/auth/tokens.js');
    const adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    const { createApp } = await import('../../server/dist/app.js');
    server = await listenOnLoopback(http.createServer(createApp()));
    const base = server.url;

    async function rest(method, path, body) {
      const r = await fetch(`${base}${path}`, {
        method, headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await r.text();
      let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
      return { status: r.status, body: parsed, text };
    }
    async function mcp(name, args) {
      const out = await callTool({
        name, args,
        caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' },
      });
      const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
      return { status: out.status, isError: out.result.isError === true, body: out.result.structuredContent ?? {}, text };
    }
    return {
      door, base, adminKey, callTool, ADMIN, rest, mcp,
      async close() { await server.close(); await door.close(); },
    };
  } catch (err) {
    await server?.close();
    await door.close();
    throw err;
  }
}

/** The collection a kind's records live in. */
export const COLLECTION = Object.freeze({ entity: 'entities', edge: 'edges', fact: 'facts', chrono: 'chrono' });

/** Empty every record collection of every mode's space, so a case starts from nothing. */
export async function wipeAll(door) {
  for (const mode of MODES) await door.wipe(spaceOf(mode));
}

/**
 * Does any stored record of `kind` in `space` carry `key` among its properties? Read from the store, so "a strict space
 * stored nothing" is not a claim about a response.
 */
export async function storedWithKey(door, space, kind, key = UNDECLARED) {
  const docs = await door.coll(space, COLLECTION[kind]).find({ [`properties.${key}`]: { $exists: true } }).toArray();
  return docs;
}

/** Every record of `kind` in `space`, for a case that asserts on identities. */
export async function storedAll(door, space, kind) {
  return door.coll(space, COLLECTION[kind]).find({}).toArray();
}

/**
 * Whether a door's answer NAMES the undeclared key as a problem: the key and the word `declared` both appear in the answer's
 * text (a refusal body, a warning row, a tool result). A weaker reading than the exact reason on purpose — the exact wording
 * is the validator's own test's to pin, and a door test that copied it would break on a reword and prove nothing more.
 */
export const namesTheKey = (text, key = UNDECLARED) => text.includes(key) && /declared/i.test(text);
