/**
 * The phases a `Server-Timing` header names, read the way a client reads them (bundle-378, Q-976, S1): the one parser the phase specs and the
 * door-floor script share, so a spec and the measurement read one header alike.
 *
 * ## What it prevents
 *
 * A spec that matched a phase name anywhere in the header text would pass on `members` inside another entry's description; this splits the
 * header into its entries (RFC 8941-style list, `name;dur=<ms>;desc="<text>"`) and answers each entry by name. A header that is absent answers
 * `null`, never an empty map, so a spec cannot read "no phases" as "no header".
 */

/**
 * The entries of a `Server-Timing` header value, by name: `{ dur, count }`, `count` read from `desc="n=<count>"` (1 when the entry has none).
 * @param {string | string[] | undefined} value the header as `node:http` hands it (a string, or a list when sent twice)
 * @returns {Map<string, { dur: number, count: number }> | null} `null` when there is no header
 */
export function serverTimingOf(value) {
  if (value === undefined || value === null) return null;
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  const out = new Map();
  for (const raw of text.split(',')) {
    const parts = raw.trim().split(';').map(p => p.trim());
    const name = parts[0];
    if (!name) continue;
    let dur = NaN;
    let count = 1;
    for (const p of parts.slice(1)) {
      const eq = p.indexOf('=');
      if (eq < 0) continue;
      const key = p.slice(0, eq).trim();
      const v = p.slice(eq + 1).trim().replace(/^"|"$/g, '');
      if (key === 'dur') dur = Number(v);
      if (key === 'desc') {
        const m = /^n=(\d+)$/.exec(v);
        if (m) count = Number(m[1]);
      }
    }
    out.set(name, { dur, count });
  }
  return out;
}

/** The phases an MCP tool result carries in its `_meta` (`ythril/server-timing`), as {@link serverTimingOf} answers a header; `null` when absent. */
export function mcpTimingOf(result) {
  const held = result?._meta?.['ythril/server-timing'];
  if (!held || typeof held !== 'object') return null;
  return new Map(Object.entries(held).map(([name, v]) => [name, { dur: Number(v?.dur), count: Number(v?.count ?? 1) }]));
}

/** One tool call on `POST /mcp` answered as its whole JSON-RPC result (its `_meta` included). */
export async function mcpCallResult(url, key, tool, args) {
  const r = await fetch(`${url}/mcp`, {
    method: 'POST', signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const raw = await r.text();
  const data = /^(?:event|data):/m.test(raw) ? raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)) : [raw];
  for (const d of data) {
    let msg = null; try { msg = JSON.parse(d); } catch { /* not JSON */ }
    if (msg?.id === 1) return msg.result ?? { error: msg.error };
  }
  return null;
}
