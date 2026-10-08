/**
 * `ssrfSafeFetch` re-sends the WHOLE request body on every redirect hop that preserves it (bundle-89, Q-425 part 6, plan E5 item 7).
 *
 * ## The defect
 *
 * `ssrfSafeFetch` (`util/ssrf.ts`) normalises the body ONCE, before the redirect loop, and passes the same `safeInit.body` to every
 * hop ("a body may only be read a single time, and every hop resends it"). That is correct for a string, a `Buffer` or a form
 * serialised to bytes, which can be read as often as it is asked. It is wrong for a body that is a STREAM, which is what the
 * image path becomes when it stops building the file's base64 JSON in memory: the first hop consumes it, a 307 or 308 sends the
 * next hop an empty or errored body, and the provider receives a request with a `Content-Length` of N and no bytes. A 307/308 is
 * defined to repeat the method AND the body; and the `Authorization` header goes with it, to a re-validated address, which is
 * today's behaviour and is stated here so nobody has to infer it.
 *
 * ## The rule
 *
 * **After a 307 or a 308, the next hop's body is byte-for-byte the first hop's, and so is its `Authorization` header.** Asserted
 * through the injected `fetchImpl` (the module's own test seam: transport is the injected function's, every other guard, the
 * address check and the redirect re-validation, is the real one), which reads each hop's body to its end the way a socket does.
 *
 * ## The one line to change when the factory exists
 *
 * Today a streamed body can only be handed in as a one-shot `Readable` (`oneShotBody`). The plan gives `ssrfSafeFetch` a body
 * FACTORY so a hop can ask for a fresh stream; when that API is chosen, `bodyInput` below is the single line that hands the
 * same bytes in the new form. The rule above does not change.
 *
 * ## Seen red
 *
 * On the unchanged code hop 2 reads an already-consumed stream: its body is empty (or the fetch throws), and the assertion says
 * how many bytes the second hop received. A buffered body is the control row and holds today: it is what shows the harness reads a
 * hop's body to its end rather than passing by never looking.
 *
 * Run: node --test testing/standalone/ssrf-safe-fetch-replays-its-body-on-every-redirect-hop.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import { ssrfSafeFetch } from '../../server/dist/util/ssrf.js';

const PUBLIC = async () => [{ address: '93.184.216.34', family: 4 }];
const BODY = crypto.randomBytes(300 * 1024);

/** The body, as a stream that can be read once: what a streamed upload is. */
const oneShotBody = () => Readable.from((function* () { for (let i = 0; i < BODY.length; i += 65536) yield BODY.subarray(i, i + 65536); })());
/**
 * THE line the docblock said would change when `ssrfSafeFetch` took a body factory. It has: a streaming caller hands in
 * a FUNCTION returning a fresh body, and each hop calls it. The one-shot stream is still what the function returns —
 * the point is that the second hop gets a NEW one, not the first hop's.
 */
const bodyInput = (form) => (form === 'stream' ? () => oneShotBody() : Buffer.from(BODY));

/** Read a hop's body the way a socket would: to its end, whatever form it is in. */
async function readBody(body) {
  if (body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body);
  const parts = [];
  for await (const c of body) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

async function runThroughRedirect(status, form) {
  const hops = [];
  const fetchImpl = async (url, init) => {
    const hop = { url, authorization: new Headers(init.headers).get('authorization'), body: null, error: null };
    hops.push(hop);
    try { hop.body = await readBody(init.body); } catch (err) { hop.error = String(err); }
    return hops.length === 1
      ? new Response(null, { status, headers: { location: 'http://elsewhere.example.com/v1/chat' } })
      : new Response('{}', { status: 200 });
  };
  await ssrfSafeFetch('http://provider.example.com/v1/chat', {
    method: 'POST',
    headers: { Authorization: 'Bearer sk-b89e5', 'Content-Type': 'application/json' },
    body: bodyInput(form),
    // `duplex` is what undici asks of a stream body; the injected implementation ignores it.
    ...(form === 'stream' ? { duplex: 'half' } : {}),
  }, { lookup: PUBLIC, fetchImpl });
  return hops;
}

describe('ssrfSafeFetch resends the whole body after a 307 or a 308', () => {
  for (const status of [307, 308]) {
    it(`CONTROL (a buffered body, ${status}): the second hop receives the same bytes, so the harness really reads a hop's body`, async () => {
      const hops = await runThroughRedirect(status, 'buffer');
      assert.equal(hops.length, 2);
      assert.ok(hops[0].body.equals(BODY) && hops[1].body.equals(BODY), 'the control does not read what it is given');
    });

    it(`a STREAMED body, ${status}: the second hop receives the same ${BODY.length} bytes, and the same Authorization header`, async () => {
      const hops = await runThroughRedirect(status, 'stream');
      assert.equal(hops.length, 2, 'the redirect was not followed');
      assert.ok(hops[0].body?.equals(BODY), `fixture: the FIRST hop did not read the whole body (${hops[0].body?.length} bytes, error ${hops[0].error})`);
      assert.ok(hops[1].body?.equals(BODY),
        `the second hop received ${hops[1].body?.length ?? 0} of ${BODY.length} bytes${hops[1].error ? ` (${hops[1].error})` : ''}: a stream is consumed by the first hop`);
      assert.equal(hops[1].authorization, 'Bearer sk-b89e5', 'the redirect hop dropped the Authorization header the first hop carried');
    });
  }
});
