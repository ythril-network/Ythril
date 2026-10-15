/**
 * A megabyte key sent to a strict space body is refused in bounded text, the same text on REST and MCP, and logged as ONE
 * bounded line (`Q-362`, R5-4, R6-11; canary 5.6.4 step 5 — a megabyte fact answered one log line ending `…(+N chars)`).
 *
 * ## The finding
 *
 * `PATCH /api/spaces/:id` and the MCP `schema_update` both run the body through the one strict zod parse
 * (`planSpaceMetaUpdate`) and answer `parsed.error.message` — which is the issue array as JSON, with an unknown key quoted
 * whole. A caller who sends a one-megabyte key got a refusal of two megabytes back (probed 2026-10-14: 2,000,130 characters),
 * and nothing was logged that said a body had been refused or how large the key was. The MCP dispatcher bounds a
 * top-level unknown argument at ~400 characters before the parse is reached, so the question is asked where the key reaches
 * the zod parse on BOTH doors: nested in `meta.typeSchemas.<kind>.<type>`.
 *
 * ## What is held, per door
 *
 *  - **Bounded answer.** The refusal text is far shorter than the key (a fixed ceiling, not a multiple of the input), names the
 *    key's first characters (the caller must be able to find it), and says how much was cut: `…(+N chars)`.
 *  - **One text.** The MCP text is `Error (400): ` + the REST body's `error` — the same words from the same function, so
 *    the answer does not depend on which client the caller picked (`CLAUDE.md`, "check both when you change either").
 *  - **No whole key anywhere.** Neither the answer nor any log line carries the key whole.
 *  - **One log line, ending `…(+N chars)`.** The refusal is logged once per call, in a line that carries the key's front and
 *    ends with the count of what was cut — the shape the canary checks.
 *  - **Nothing is stored.** The refused body changes nothing (meta version unchanged).
 *
 * ## Seen red
 *
 * On 85c4c564 both doors answer the whole key back (a refusal of over a megabyte) and no line is logged.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-megabyte-key-to-a-strict-space-body-is-refused-bounded-on-both-doors-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';

const skip = await mongoSkipReason();

const SPACE = 'bigkeyspace';
const FRONT = 'MEGAKEY';
const KEY = FRONT + 'x'.repeat(1_000_000);
/** The most characters any answer or log line about the key may carry: the quoted window, its count and the sentence round it. */
const CEILING = 4_000;
const CUT_MARK = /…\(\+\d+ chars\)/;

const BODY = { meta: { typeSchemas: { entity: { person: { [KEY]: 1 } } } } };

let door;
let spacesRouter;
let subscribeLogLines;

/** Every log line written while `fn` runs, whatever its level. */
async function lines(fn) {
  const seen = [];
  const off = subscribeLogLines((l) => seen.push(l));
  try { await fn(); } finally { off(); }
  return seen;
}

describe('a megabyte key to a strict space body', { skip }, () => {
  before(async () => {
    door = await openToolDoor({ suite: 'bigkeybody', spaces: [{ id: SPACE, label: SPACE, folders: [], meta: { validationMode: 'strict' } }] });
    ({ spacesRouter } = await import('../../server/dist/api/spaces.js'));
    ({ subscribeLogLines } = await import('../../server/dist/util/log.js'));
  });
  after(async () => { await door?.close(); });

  /** The two doors, each answering the refusal as `{ status, text }` — REST's `error` and MCP's text. */
  const DOORS = {
    'PATCH /api/spaces/:id': async () => {
      const h = door.routeHandler(spacesRouter, 'patch', '/:id');
      const out = await door.request(h, { params: { id: SPACE }, body: BODY });
      return { status: out.status, text: String(out.body?.error ?? ''), body: out.body };
    },
    'schema_update (MCP)': async () => {
      const out = await door.call('schema_update', { space: SPACE, typeSchemas: BODY.meta.typeSchemas });
      return { status: out.status, text: out.text, body: out.structured };
    },
  };

  const answers = {};
  const logged = {};

  for (const [name, send] of Object.entries(DOORS)) {
    describe(name, () => {
      before(async () => {
        logged[name] = await lines(async () => { answers[name] = await send(); });
      });

      it('refuses the body, and the refusal is far shorter than the key', () => {
        const a = answers[name];
        assert.ok(a.status >= 400 && a.status < 500, `answered ${a.status}`);
        assert.ok(a.text.length < CEILING, `the refusal is ${a.text.length} characters for a ${KEY.length}-character key — the key came back whole`);
      });

      it('names the front of the key and says how much was cut', () => {
        const a = answers[name];
        assert.ok(a.text.includes(FRONT), `the refusal does not name the key (its front): ${a.text.slice(0, 200)}`);
        assert.match(a.text, CUT_MARK, 'the refusal does not say how many characters were cut');
        assert.ok(!a.text.includes(KEY), 'the whole key is in the refusal');
      });

      it('logs the refusal as ONE line that carries the key bounded and ends `…(+N chars)`', () => {
        const about = logged[name].filter(l => l.includes(FRONT));
        assert.equal(about.length, 1, `${about.length} log line(s) carry the key (want exactly one): ${logged[name].map(l => l.slice(0, 120)).join(' | ')}`);
        const [line] = about;
        assert.ok(line.length < CEILING, `the log line is ${line.length} characters`);
        assert.match(line.trimEnd(), /…\(\+\d+ chars\)$/, `the log line does not end with the count of what was cut: …${line.slice(-120)}`);
        assert.ok(!line.includes(KEY));
      });
    });
  }

  it('the two doors say the same words', () => {
    const rest = answers['PATCH /api/spaces/:id'];
    const mcp = answers['schema_update (MCP)'];
    assert.equal(mcp.text, `Error (${rest.status}): ${rest.text}`,
      'REST and MCP answered the same refusal in different words — one door builds its own text');
  });

  it('a refused body stores nothing', async () => {
    const { getConfig } = await import('../../server/dist/config/loader.js');
    const space = getConfig().spaces.find(s => s.id === SPACE);
    assert.deepEqual(space?.meta?.typeSchemas ?? {}, {}, 'a refused body changed the space');
  });
});
