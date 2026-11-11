/**
 * Nothing is mounted at `/setup`, so the SPA's own first-run page is reachable.
 *
 * ## Deprecation 1.5, and why it waited three releases
 *
 * `setupRouter` was mounted twice: at `/api/setup`, which is what the SPA polls for `configExists()`, and
 * again at `/setup`, which served a server-rendered HTML form and `404`ed once configured. Express matches a
 * mount before the SPA's index fallback, so the second line made the Angular `/setup` route **unreachable**.
 * The legacy form was the live first-run path and the SPA's own page had never served one.
 *
 * It was kept "for non-SPA access" from before the SPA existed. Removing it is one line, and the risk is why
 * it waited: this is the unauthenticated boot path, and getting it wrong means an instance nobody can set up.
 *
 * ## The two pages were NOT the same flow, which is what the proof found
 *
 * The legacy form asked for a label and nothing else. The SPA page asks for a label, a settings password and
 * a confirmation, and keeps its submit disabled until all three are filled. So "the SPA route exists" was
 * never evidence that removing the mount was safe — it collects different information and posts a different
 * body.
 *
 * ## What was proven, end to end, against a genuine first run
 *
 * Config deleted and the database dropped, then through a browser at `/setup`:
 *
 *     GET /setup                  ->  200, and the response is the SPA shell, not the form
 *     app-root present            ->  true
 *     password fields             ->  2   (the legacy form had 0)
 *     setup completes             ->  a token appears after ~15s
 *     GET /api/setup/status       ->  configured: false  ->  true
 *     the issued token            ->  200 on /api/tokens/me and /api/spaces
 *
 * The 15 seconds matter and are the reason this is not a five-second check: the first boot creates the
 * default space and starts an index build, so the page sits on "Setting up…" for a while. A shorter wait
 * reports NO TOKEN and looks exactly like the failure this test exists to catch.
 *
 * ## And again when the FORM was deleted, 2026-09-02
 *
 * Unmounting `/setup` left the form, its `POST` handler and the HTML error page in the file. Removing those
 * was re-proven against a genuine first run on an isolated instance, because it is still the boot path:
 *
 *     GET /api/setup/status       ->  configured: false
 *     GET /setup                  ->  200, and ZERO forms in the body
 *     GET /api/setup              ->  404   (the form endpoint is gone)
 *     POST /api/setup  (form)     ->  404   (its handler is gone)
 *     POST /api/setup/json  101c  ->  400, naming the 100-character limit
 *     POST /api/setup/json  100c  ->  201 with the one-time token
 *     GET /api/setup/status       ->  configured: true
 *     the issued token            ->  200 on /api/tokens/me
 *     POST /api/setup/json again  ->  404
 *
 * The 101-character case is there because deleting the form surfaced that `SETUP_LABEL_MAX` had only ever
 * been enforced by the form's handler — so the path the SPA uses had been unbounded since the mount went.
 *
 * ## What this file can assert, and what it cannot
 *
 * A browser first-run cannot run here — that is the `verify` skill's scratch instance, and the recipe is in
 * `scratchpad/verify/firstrun.mjs`. What is gated here is the thing that regresses silently: the mount coming
 * back. A re-added `app.use('/setup', …)` would restore the shadow with no test failing anywhere else,
 * because every other suite reaches setup through `/api/setup`.
 *
 * Run: node --test testing/standalone/setup-does-not-shadow-the-spa.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = 'server/src/app.ts';
/** Line comments first, then block — a block-open inside a line comment otherwise swallows real code. */
const strip = (src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('the SPA owns /setup', () => {
  const src = strip(readFileSync(APP, 'utf8'));

  it('mounts the setup router on the API path only', () => {
    const mounts = [...src.matchAll(/app\.use\(\s*'([^']*setup[^']*)'/g)].map(m => m[1]);
    assert.deepEqual(mounts, ['/api/setup'],
      `only /api/setup may be mounted; found ${JSON.stringify(mounts)} — a '/setup' mount shadows the SPA route`);
  });

  it('still serves the JSON API the SPA depends on', () => {
    // The other direction: removing the shadow must not remove the endpoint the setup page polls. Without
    // `/api/setup/status` the SPA cannot tell a first run from a configured instance at all.
    assert.match(src, /app\.use\(\s*'\/api\/setup'\s*,\s*setupRouter\s*\)/);
    const routes = strip(readFileSync('server/src/setup/routes.ts', 'utf8'));
    assert.match(routes, /setupRouter\.get\('\/status'/, 'the SPA polls /api/setup/status');
  });

  it('the router still refuses a second setup once configured', () => {
    // The guard that makes an unauthenticated route safe at all. It is unchanged by this removal, and it is
    // the one thing that must not be lost while moving the entry point.
    const routes = strip(readFileSync('server/src/setup/routes.ts', 'utf8'));
    // `isFirstRun()` is the boot's answer to "no config.json yet" (a file that is there and unusable stopped the boot, Q-350 a): the guard on both doors.
    assert.match(routes, /isFirstRun\(\)/, 'setup must still be first-run only');
  });

  it('and the server-rendered FORM is gone, not merely unmounted', () => {
    /*
     * The second half of deprecation 1.5, and the half that was left behind. Unmounting `/setup` made the
     * SPA reachable; it did not remove the form. `setup/routes.ts` still rendered an HTML page whose
     * `<form action="/setup">` posted to a path that no longer exists, alongside a `POST /` handler that
     * answered in HTML and an error page linking back to `/setup`.
     *
     * Dead code, and the poisonous kind: it is the unauthenticated boot path, it LOOKS like the live entry
     * point to anyone reading the file, and it kept `11-setup-api.md` documenting two endpoints that had
     * already stopped existing. An integrator following that page got a 404 from a guide that was correct
     * when it was written.
     */
    const routes = strip(readFileSync('server/src/setup/routes.ts', 'utf8'));
    assert.doesNotMatch(routes, /<form/i, 'the setup router must not render a form');
    assert.doesNotMatch(routes, /action="\/setup"/, 'nothing may post to the removed mount');
    assert.doesNotMatch(routes, /setupRouter\.get\('\/'/, 'GET /api/setup served the form and has no caller');
    assert.doesNotMatch(routes, /setupRouter\.post\('\/'\s*,/, 'POST /api/setup was the form handler');
  });

  it('but the JSON completion the SPA posts to is untouched', () => {
    // The inverse. Every assertion above is satisfied by deleting the router, which would leave an instance
    // nobody can set up — the exact risk this deprecation waited three releases for.
    const routes = strip(readFileSync('server/src/setup/routes.ts', 'utf8'));
    assert.match(routes, /setupRouter\.post\('\/json'/, 'the SPA completes setup through POST /api/setup/json');
    assert.match(routes, /createToken/, 'and that path must still issue the one-time admin token');
  });

  it('and the label bound applies to the path that actually runs', () => {
    /*
     * Found by deleting the form: `SETUP_LABEL_MAX` was enforced by the FORM handler and not by
     * `POST /json`. One rule, two implementations, the weaker one surviving — and it had been the ONLY path
     * since the `/setup` mount was removed, so an unbounded `instanceLabel` was reachable on the
     * unauthenticated boot path for a release.
     */
    const routes = strip(readFileSync('server/src/setup/routes.ts', 'utf8'));
    const at = routes.indexOf("setupRouter.post('/json'");
    assert.notEqual(at, -1, 'the JSON completion is gone');
    const handler = routes.slice(at, routes.indexOf('\n});', at));
    assert.match(handler, /SETUP_LABEL_MAX/,
      'POST /api/setup/json must bound the instance label — it is the only first-run path now');
  });

  it('the guide no longer documents the removed pair', () => {
    // A doc that promises a route which 404s is worse than no doc: the reader concludes the product is
    // broken rather than that the page is old.
    const doc = readFileSync('docs/integration-guide/11-setup-api.md', 'utf8');
    const offenders = doc.split(/\r?\n/)
      .map((text, i) => ({ line: i + 1, text }))
      .filter(({ text }) => /^\s*(GET|POST)\s+\/setup\s*$/.test(text) || /^\s*(GET|POST)\s+\/api\/setup\s*$/.test(text))
      .map(({ line, text }) => `11-setup-api.md:${line}: ${text.trim()}`);
    assert.deepEqual(offenders, [],
      `these document endpoints that no longer exist:\n  ${offenders.join('\n  ')}`);
  });
});
