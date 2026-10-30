/**
 * The embed-origin allowlist is reachable from the admin UI, and the UI cannot be looser than the file.
 *
 * ## What was asked for, and what the risk in answering it is
 *
 * `embed.allowedOrigins` worked and lived only in `config.json`, so granting a portal permission to frame a brain
 * meant shell access. The canary operator asked for it in the admin UI on 2026-08-19T1046Z; the reason it is worth
 * doing is theirs: *someone runs a brain, someone else wants to use it inside a portal, and the person who must act
 * has to be talked through editing a JSON file on a server.*
 *
 * The risk in answering it is that a NEW write path to a security-relevant list is a second chance to get the rule
 * wrong. What this list grants is framing plus runtime restyling, together, which is a clickjacking primitive and a
 * UI-spoofing primitive — so the failure mode is not "the form is awkward", it is an origin nobody vetted being
 * allowed to impersonate the admin interface.
 *
 * So this gate holds the three properties that make the new path no weaker than the old one:
 *
 *  1. **ONE validator.** The route calls `isValidEmbedOrigin`, the same function the config-file path uses. A
 *     second copy — in the route or in the client — is the defect the y-flows convention `convention-find-every-instance` names,
 *     and here the weaker copy would be deciding who may frame the admin UI.
 *  2. **A bad entry is REFUSED, not dropped.** The file path drops with a warning because nobody is waiting; a form
 *     must answer. Accepting-and-silently-dropping is the exact shape of the unscoped-token defect, where a caller
 *     was told 201 while the field they sent went nowhere.
 *  3. **The write is admin-and-MFA gated.** Their own line: *an origin allowlist that any authenticated caller
 *     could extend is not an allowlist.*
 *
 * ## Why source-level
 *
 * Driving the route needs a server, a config file and a TOTP secret, which the Docker suites have and this does
 * not. What is cheap and precise here is that the wiring cannot rot: the validator is shared, the refusal exists,
 * the middleware is the MFA one, the change is audited, and the client does not re-implement the rule.
 *
 * Run: node --test testing/standalone/embed-origins-are-editable.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { balancedFrom } from './_structural-window.mjs';

const ROUTE = 'server/src/api/embed-config.ts';
const route = stripComments(readFileSync(ROUTE, 'utf8'));
const app = stripComments(readFileSync('server/src/app.ts', 'utf8'));
const audit = stripComments(readFileSync('server/src/audit/middleware.ts', 'utf8'));
const page = stripComments(readFileSync('client/src/app/pages/settings/embedding.component.ts', 'utf8'));

describe('the rule is shared, not copied', () => {
  it('the route validates with the SAME function the config file path uses', () => {
    assert.match(route, /import \{[^}]*isValidEmbedOrigin[^}]*\} from '\.\.\/config\/embed\.js'/,
      'the route must call the shared validator — a local copy would be free to disagree with the file path, and '
      + 'the looser of the two would decide who may frame the admin UI');
  });

  it('and does not re-implement any part of it', () => {
    /*
     * The four rules `isValidEmbedOrigin` enforces. Any of them appearing HERE means a second opinion exists, which
     * is how the two paths start diverging — not on the day the copy is written, on the day one of them is fixed.
     */
    for (const [pattern, what] of [
      [/includes\('\*'\)/, 'the wildcard rejection'],
      [/protocol === 'https:'/, 'the scheme check'],
      [/hostname === 'localhost'/, 'the localhost exception'],
      [/url\.username \|\| url\.password/, 'the credentials check'],
    ]) {
      assert.doesNotMatch(route, pattern, `${what} is re-implemented in the route instead of being called`);
    }
  });

  it('the CLIENT does not validate either — it shows what the server refused', () => {
    /*
     * A form that pre-validates locally is the same defect one layer out, and it fails in a nastier way: the
     * operator is told their origin is invalid by code that may be a version behind the server's.
     *
     * Scoped to things that BRANCH on the value, not to the word `https`. The first version of this assertion
     * matched the placeholder `https://portal.example.com` and reported the page as validating — an example is not
     * a rule, and a gate that cannot tell them apart is the over-broad-selector mistake this suite has made before.
     */
    for (const pattern of [/new URL\(/, /startsWith\('http/, /includes\('\*'\)/, /\/\^https/]) {
      assert.doesNotMatch(page, pattern,
        'the page must not decide what a valid origin is — it sends the list and renders the refusal');
    }
    assert.match(page, /rejected/, 'it must be able to MARK a refused entry, which is the half it does own');
  });
});

describe('a bad entry is refused rather than absorbed', () => {
  const patch = balancedFrom(route, route.indexOf('embedConfigRouter.patch('), 'the PATCH handler');

  it('invalid entries produce a 400 that NAMES them', () => {
    assert.match(patch, /filter\(entry => !isValidEmbedOrigin\(entry\)\)/,
      'the handler must collect the invalid entries');
    assert.match(patch, /status\(400\)/, 'and refuse');
    assert.match(patch, /invalid,?\s*\}\)/,
      'and send them back — "something you typed was wrong" without saying which is barely better than silence');
  });

  it('nothing filters invalid entries out and carries on', () => {
    /*
     * The shape this must never take: `origins.filter(isValidEmbedOrigin)` followed by a save. It would answer 200
     * having stored less than was sent, and the operator would go looking at their portal for a fault that is here.
     */
    assert.doesNotMatch(patch, /filter\(\s*isValidEmbedOrigin\s*\)/,
      'a silent drop on the write path reports success for a change that did not fully happen');
  });

  it('the body is strict, so a misspelled field cannot answer 200', () => {
    // `{allowedOrigin: 'https://x'}` — singular — would otherwise be accepted, store an empty list, and read as
    // success. The same trap the token bodies had.
    assert.match(route, /\}\)\.strict\(\)/, 'the request body schema must reject unknown keys');
  });
});

describe('the write is gated like the other security-relevant config', () => {
  it('PATCH requires admin AND MFA', () => {
    assert.match(route, /embedConfigRouter\.patch\('\/', requireAdminMfa/,
      'the same bar as the media/model configuration — this list grants framing and restyling together');
  });

  it('GET requires admin', () => {
    // The RESOLVED list is public on `/api/theme` by design, because an embedder must be able to ask before trying.
    // What is admin-only is the configured list plus which entries were rejected, which is operator diagnostics.
    assert.match(route, /embedConfigRouter\.get\('\/', requireAdmin/);
  });

  it('the route is mounted under /api/admin, where the auth prefix rules apply', () => {
    assert.match(app, /app\.use\('\/api\/admin\/embed-config', embedConfigRouter\)/);
  });

  it('the change is audited', () => {
    // Nothing in the product looks different after an origin is added, so the log is the only place it leaves a
    // trace. `audit-route-coverage.test.js` would fail on a missing rule; this names the operation deliberately.
    assert.match(audit, /pattern: \/\^\\\/api\\\/admin\\\/embed-config\$\/,\s*operation: 'config\.embed\.update'/,
      'a PATCH that changes who may frame this instance must be attributable to an admin');
  });
});

describe('what the operator is told, since the UI is now the surface', () => {
  it('the page carries the framing-AND-restyling warning', () => {
    // The guide says it; the guide is not what somebody is reading while they paste an origin into a text box.
    assert.match(page, /embedding\.origins\.warning/, 'the warning must be rendered on the page');
  });

  it('every key it renders exists in all three locales', () => {
    // set-claim: the shipped UI locales, as a coverage input. The set is the i18n bundle, and a missing
    // key in a shipped locale is what this asserts -- adding a fourth locale is a product decision.
    /*
     * The failure this catches is invisible in development: a key present in `en` and missing in `de` renders its
     * raw id to a German-speaking operator, and nothing in the build objects. Checked here rather than trusted to
     * a reviewer, because adding a key to one file and not three is a single-character-of-attention mistake.
     */
    const used = [...page.matchAll(/'((?:embedding|nav|common)\.[a-zA-Z.]+)'/g)].map(m => m[1]);
    assert.ok(used.length >= 8, `expected the page's translation keys, found ${used.length}`);
    for (const locale of ['en', 'de', 'pl']) {
      const dict = JSON.parse(readFileSync(`client/public/assets/i18n/${locale}.json`, 'utf8'));
      const missing = [...new Set(used)].filter(k => !(k in dict));
      assert.deepEqual(missing, [], `${locale}.json is missing: ${missing.join(', ')}`);
    }
  });

  it('the page is reachable — a route AND a nav entry', () => {
    // A route with no nav entry is a page only somebody who reads the source can find, which would answer the ask
    // in the letter and not at all in practice.
    const routes = readFileSync('client/src/app/app.routes.ts', 'utf8');
    assert.match(routes, /path: 'embedding'/, 'the route must exist');
    const shell = readFileSync('client/src/app/pages/shell/shell.component.ts', 'utf8');
    assert.match(shell, /routerLink="\/settings\/embedding"/, 'and the sidebar must link to it');
  });
});

describe('no restart is implied anywhere, because none is needed', () => {
  it('the resolved list is read per request on both surfaces', () => {
    /*
     * The claim made to the canary operator in answer to their sub-question, pinned so it cannot quietly stop being
     * true. If either of these captured the value once at startup, an operator would save a change in the UI, see
     * nothing happen, and be told by the docs that no restart was needed.
     */
    const appSrc = stripComments(readFileSync('server/src/app.ts', 'utf8'));
    assert.match(appSrc, /frame-ancestors \$\{frameAncestorsDirective\(\)\}/,
      'the CSP header must call the directive per response, not hold a string built at boot');
    const theme = stripComments(readFileSync('server/src/api/theme.ts', 'utf8'));
    assert.match(theme, /allowedOrigins: getAllowedEmbedOrigins\(\)/,
      'the public endpoint must resolve the list per request');
  });

  it('the save updates the in-memory config, not only the file', () => {
    // `saveConfig` assigns `_config` before writing. Writing the file alone would leave the running process serving
    // the old header until the watcher noticed, which is a two-second lie rather than an eternal one — but the UI
    // says "active immediately" and that has to be true.
    /*
     * Asserted on the PATCH handler, bounded by the paren that closes it. My first version windowed
     * `bodyOf(route, 'embedConfigRouter')` — which is a top-level `const` whose body is ONE LINE, so the window
     * held the router construction and nothing else. A `|| route` fallback beside it never fired, because the
     * one-line window is truthy. Exactly the failure the structural-window work is about: a bound that returns too
     * little and an assertion that still looks like it is checking something.
     */
    assert.match(balancedFrom(route, route.indexOf('embedConfigRouter.patch('), 'the PATCH handler'),
      /saveConfig\(config\)/, 'the handler must persist through saveConfig');
  });

  it('the page says it is immediate, and does not tell anyone to restart', () => {
    const en = JSON.parse(readFileSync('client/public/assets/i18n/en.json', 'utf8'));
    assert.match(en['embedding.origins.saved'], /no restart/i,
      'the operator should be told, because the file-only shape trained everyone to expect one');
    for (const key of Object.keys(en).filter(k => k.startsWith('embedding.'))) {
      assert.doesNotMatch(en[key], /\brestart (the )?(server|instance|container)\b/i,
        `${key} tells the operator to restart, which is not required`);
    }
  });
});
