/**
 * The rights matrix shows the areas the server enforces — no more, no fewer, in one order.
 *
 * The client keeps `RIGHT_AREAS` (`rights-glyph.component.ts`) because its glyph and grid render before the
 * catalogue arrives. It is a second copy of `SPACE_AREAS`, and the copy that drifts is the one people read: when
 * `networks` joined the server's areas (`F-34`), a client still showing four would have offered no way to grant
 * the fifth, and a token saved from that editor would have round-tripped without it.
 *
 * Run: node --test testing/standalone/a-client-area-list-matches-the-server.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let SPACE_AREAS;
before(async () => { ({ SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js')); });

describe('the client shows the server\'s areas', () => {
  it('RIGHT_AREAS equals SPACE_AREAS, in order', () => {
    const src = readFileSync('client/src/app/pages/settings/rights-glyph.component.ts', 'utf8');
    const m = /export const RIGHT_AREAS = \[([^\]]+)\]/.exec(src);
    assert.ok(m, 'RIGHT_AREAS is gone from rights-glyph.component.ts — re-point this gate');
    const client = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
    assert.ok(client.length > 0, 'parsed no areas — the gate would pass on nothing');
    assert.deepEqual(client, [...SPACE_AREAS]);
  });
});
