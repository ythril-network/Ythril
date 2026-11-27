/**
 * `GET /api/about` names the instance's public address however the operator set it (Q-942, bundle-358 fix round).
 *
 * ## Why
 *
 * The RDF card on a space's Settings shows the base a first enable would store, built from the `publicUrl` of this answer. The server builds
 * that base from the instance's public address, which `PUBLIC_BASE_URL` (the environment) sets as well as `config.publicUrl` and which the
 * environment wins (`config/public-url.ts`). An answer that named only the config's address left the card without a default base on an
 * instance set up through the environment, where the server stores one.
 *
 * ## What it holds
 *
 * - With nothing set, the answer carries no `publicUrl` (the loopback fallback is no address to show).
 * - With `PUBLIC_BASE_URL` alone, the answer names it (without a closing slash).
 * - The default base the card builds from that answer is the base the server stores at the first enable of RDF on a space with none.
 *
 * Run: node --test testing/standalone/the-about-answer-names-the-public-address-however-it-is-set-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'aboutbase';
const ENV_ADDRESS = 'https://env.example.org';

/** The base the card shows: the address without its closing slash, `/ld/`, the space's id, a closing slash (`defaultBaseOf` in the client). */
const cardBase = (publicUrl, space) => `${publicUrl.replace(/\/+$/, '')}/ld/${encodeURIComponent(space)}/`;

describe('the about answer names the public address', { skip }, () => {
  let d, admin;
  const saved = process.env['PUBLIC_BASE_URL'];
  before(async () => {
    delete process.env['PUBLIC_BASE_URL'];
    d = await openRdfExportDoors({ suite: 'about_public_address', spaces: [{ id: SPACE, meta: { suppressEmbeddings: true, validationMode: 'warn' } }] });
    admin = await d.mint('admin', {}, { admin: true });
  });
  after(async () => {
    if (saved === undefined) delete process.env['PUBLIC_BASE_URL']; else process.env['PUBLIC_BASE_URL'] = saved;
    await d?.close();
  });

  it('names no address when none is set', async () => {
    const r = await d.rest(admin.key, 'GET', '/api/about');
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(r.body.publicUrl, undefined, JSON.stringify(r.body));
  });

  it('names the address PUBLIC_BASE_URL sets, and the card\'s default base is the base the server stores', async () => {
    process.env['PUBLIC_BASE_URL'] = `${ENV_ADDRESS}/`;
    const about = await d.rest(admin.key, 'GET', '/api/about');
    assert.equal(about.status, 200, about.text.slice(0, 300));
    assert.equal(about.body.publicUrl, ENV_ADDRESS, JSON.stringify(about.body));
    const enabled = await d.rest(admin.key, 'PATCH', `/api/spaces/${SPACE}`, { meta: { rdf: { enabled: true } } });
    assert.ok(enabled.status < 300, `${enabled.status} ${enabled.text.slice(0, 300)}`);
    const space = await d.rest(admin.key, 'GET', `/api/spaces/${SPACE}`);
    const stored = space.body?.meta?.rdf?.base ?? (await d.rest(admin.key, 'GET', '/api/spaces')).body?.spaces?.find?.(s => s.id === SPACE)?.meta?.rdf?.base;
    assert.equal(stored, cardBase(about.body.publicUrl, SPACE), `stored ${stored}`);
  });
});
