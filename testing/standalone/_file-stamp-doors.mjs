/**
 * The three doors a `file_stamp_report` is asked through, driven the way a caller reaches them — the question "what does
 * THIS door answer to THIS token and THESE arguments", answered once for every test that asks it (`Q-433`).
 *
 * ## The doors, and why there are three
 *
 * - `route` — the dedicated `POST /api/spaces/:id/file-stamp-report` (the route a UI or a script names the space in the
 *   path of);
 * - `toolRest` — `POST /api/file_stamp_report`, the REST door every tool has (the arguments are the body);
 * - `mcp` — the tool through `callTool`, the dispatch the MCP transport hands every `tools/call` to.
 *
 * The first two run in the REAL application (`createApp`, over loopback HTTP, with a real token in the configuration and
 * the real auth middleware), so a refusal is the middleware's and not a test's idea of one. The third is the same function
 * the MCP router calls, with the rights matrix of the token that was minted.
 *
 * ## One answer shape
 *
 * Every door answers `{ status, error, answer }`: the HTTP status (the door's own for MCP: what `callTool` says the REST
 * door would answer), the refusal's sentence when it refused, and the report when it did not. A test that compares doors
 * compares those three and never a door's envelope.
 *
 * ## The things a hand-written copy drops
 *
 * **A control that succeeds.** A door that does not exist answers 404, and a refusal test would read a route nobody wrote
 * as "refused". Every refusal here is only meaningful beside the same call made by an instance admin that succeeds, so
 * `asAdmin` is exported to be called FIRST.
 *
 * **Tokens that are fresh.** The heavy-call rail counts per token; a case that reused one would be judged on the
 * previous case's slots. Every `token(kind)` mints another.
 */
import http from 'node:http';
import { listenOnLoopback } from '../_shared/local-server.mjs';

// The instance's limiters answer 429 to a caller past its quota before the rail is reached; they are not what these
// tests ask about (`a-store-failure-answers-alike-on-every-door-db` sets the same three).
for (const k of ['SKIP_GLOBAL_RATE_LIMIT', 'SKIP_AUTH_RATE_LIMIT', 'SKIP_SYNC_RATE_LIMIT']) process.env[k] = 'true';
process.env['YTHRIL_RATE_LIMIT_PER_MINUTE'] ??= '1000000';

export const TOOL = 'file_stamp_report';

/**
 * @param {string} space  the one space every call names
 */
export async function openStampDoors(space) {
  const tokens = await import('../../server/dist/auth/tokens.js');
  const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
  const { callTool } = await import('../../server/dist/mcp/call-tool.js');
  const { createApp } = await import('../../server/dist/app.js');
  const server = await listenOnLoopback(http.createServer(createApp()));
  let serial = 0;

  /** Every area at `rung`, as a matrix row. */
  const areas = (rung) => Object.fromEntries(SPACE_AREAS.map(a => [a, rung]));

  /**
   * A fresh token of a kind: `admin` (instance admin), `read-only`, `write` (a plain token with write on every space),
   * `space-admin` (administers `space` and nothing else, and holds the networks area too — neither is instance admin).
   */
  async function token(kind) {
    const name = `stamp-${kind}-${++serial}`;
    const made = kind === 'admin' ? await tokens.createToken({ name, admin: true })
      : kind === 'read-only' ? await tokens.createToken({ name, readOnly: true })
        : kind === 'write' ? await tokens.createToken({ name })
          : kind === 'space-admin'
            ? await tokens.createToken({ name, rights: {
              instanceAdmin: false, createSpaces: false, floor: areas('none'), perSpace: { [space]: areas('admin') },
              spaceAdmin: { floor: false, spaces: [space] },
            } })
            : (() => { throw new Error(`no such token kind: ${kind}`); })();
    return { kind, id: made.record.id, rights: made.record.rights, plaintext: made.plaintext };
  }

  async function post(url, tok, body) {
    const r = await fetch(`${server.url}${url}`, {
      method: 'POST', headers: { Authorization: `Bearer ${tok.plaintext}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { status: r.status, parsed, text };
  }

  const doors = {
    /** The dedicated route: the space is in the path, the arguments are the body. */
    async route(tok, args = {}, spaceId = space) {
      const r = await post(`/api/spaces/${encodeURIComponent(spaceId)}/file-stamp-report`, tok, args);
      const ok = r.status === 200;
      return { status: r.status, error: ok ? undefined : (r.parsed?.error ?? r.text), answer: ok ? r.parsed : undefined };
    },
    /** `POST /api/<tool>`: the arguments are the body, the space is one of them; the answer is in `data`. */
    async toolRest(tok, args = {}, spaceId = space) {
      const r = await post(`/api/${TOOL}`, tok, { space: spaceId, ...args });
      const ok = r.status === 200;
      return { status: r.status, error: ok ? undefined : (r.parsed?.error ?? r.text), answer: ok ? (r.parsed?.data ?? r.parsed) : undefined };
    },
    /** The tool through `callTool`, with the rights of the token that was minted. */
    async mcp(tok, args = {}, spaceId = space) {
      const out = await callTool({
        name: TOOL, args: { space: spaceId, ...args },
        caller: { rights: tok.rights, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: tok.id, tokenLabel: tok.kind },
      });
      const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
      if (out.result.isError) return { status: out.status, error: text, answer: undefined };
      return { status: out.status, error: undefined, answer: out.result.structuredContent ?? JSON.parse(text) };
    },
  };

  return { doors, token, areas, base: server.url, close: () => server.close() };
}
