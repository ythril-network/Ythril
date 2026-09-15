/**
 * No brain READ route silently drops a body key.
 *
 * ## Why a gate and not four tests
 *
 * The fleet integrator reported `skip` being accepted at 200 and silently ignored on `POST /query` — *"it cost us a fabricated
 * number"*. The reported key is not the defect. The defect is a body that accepts anything and honours some of it, and
 * `/query` was simply the route they happened to be paging. `traverse`, `recall` and `similar` had it too.
 *
 * A test per route would have been satisfied by fixing the three that exist today and would say nothing about the fifth
 * read route somebody adds next year. So this enumerates the POST routes on the search router **from source** and
 * requires each one to either refuse unknown keys or be exempt with a reason — the same shape as the audit-route
 * coverage gate, and for the same reason: the list of routes must come from the code, not from me.
 *
 * ## It also checks that the allowed set covers what the handler READS, and that is not decoration
 *
 * The first version of this fix built `RECALL_BODY_FIELDS` from recall's destructuring line and so refused
 * `includeFreshWrites` and `includeContent` — both real parameters, read 120 lines further down as
 * `(req.body as {...}).includeFreshWrites`. Making a body strict converts every key the author failed to notice into a
 * 400, so the allowed set has to be the keys the handler READS, and a handler that reads its body in two places is
 * described by whichever place you happened to look at.
 *
 * `recall-fresh-writes.test.js` caught it, which is luck: it exists because fresh-write recall was worth a test, not
 * because anybody was guarding this. So the check below derives each handler's read keys from source and demands the set
 * covers them.
 *
 * ## What it still cannot check
 *
 * The other direction — a key ALLOWED but never read. That is the original defect (accepted, ignored) surviving inside
 * the fix, and nothing here sees it: `query-paging-db.test.js` covers `skip` by asserting the pages tile the collection,
 * and the rest rely on the integration suite exercising each parameter.
 *
 * Run: node --test testing/standalone/brain-read-bodies-are-strict.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { balancedFrom } from './_structural-window.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEARCH = join(ROOT, 'server', 'src', 'api', 'brain', 'search.ts');

/**
 * Routes that take a body and deliberately do NOT enumerate its keys, each with the reason.
 *
 * A route may only be here because refusing would be wrong, never because nobody has got to it — an empty reason or a
 * vague one is what makes an exemption list rot into a to-do list.
 */
const EXEMPT = {
  '/spaces/:spaceId/reindex': 'Takes no body at all. There is nothing to be strict about, and inventing a key set for '
    + 'an empty body would be a check that can only ever pass.',
};

/**
 * Source with comments stripped, so a gate cannot pass on the comment that explains the fix.
 *
 * No `$`. The lines are split on `\n`, and on a Windows checkout each one still ends with `\r` — which `$`
 * cannot match past without the `m` flag, so this function silently stripped NOTHING locally while working
 * in CI, where the checkout is LF. Every other gate in this directory got away with `/(^|[^:])\/\/.*$/gm`,
 * where `\r` counts as a line terminator; this one split first and dropped the flag.
 *
 * `.*` stops at `\r` on its own, so leaving the anchor off is both shorter and correct on either checkout.
 */
function stripComments(src) {
  return src
    .split('\n')
    .map(l => l.replace(/(^|[^:])\/\/.*/, '$1'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

const src = stripComments(readFileSync(SEARCH, 'utf8'));

/** Every `searchRouter.post('<path>', …)` and the body of its handler, up to the next route registration. */
function postRoutes() {
  const out = [];
  const re = /searchRouter\.post\(\s*'([^']+)'/g;
  const starts = [];
  let m;
  while ((m = re.exec(src)) !== null) starts.push({ path: m[1], at: m.index });
  for (let i = 0; i < starts.length; i++) {
    const next = src.indexOf('searchRouter.', starts[i].at + 10);
    out.push({ path: starts[i].path, body: src.slice(starts[i].at, next === -1 ? src.length : next) });
  }
  return out;
}

describe('brain read routes refuse unknown body keys', () => {
  it('finds the routes (the gate itself works)', () => {
    const paths = postRoutes().map(r => r.path);
    assert.ok(paths.length >= 4, `expected at least four POST routes on the search router, found ${paths.length}`);
    // The four this was reported for, named explicitly: if one is renamed the gate must not quietly stop
    // covering it. `/recall` lost its `/spaces/:spaceId` prefix at 5.0 — the space moved into the body so a
    // caller can omit it and search everything it reads — and this list is the reason that showed up as a
    // failure rather than as silently reduced coverage, which is what it is for.
    for (const p of ['/filter', '/recall', '/spaces/:spaceId/traverse',
      '/similar']) {
      assert.ok(paths.includes(p), `${p} is no longer registered under that path — re-point this gate`);
    }
  });

  it('every POST route validates its body keys or is exempt with a reason', () => {
    const offenders = [];
    for (const { path, body } of postRoutes()) {
      if (path in EXEMPT) continue;
      // By shape: the shared helper called against a named field set. The argument text is NOT constrained -- the first
      // version of this gate required a comma-free first argument and so flagged two routes that pass
      // `(req.body ?? {}) as Record<string, unknown>`, whose type parameter contains a comma. A gate that reports
      // correct code is worse than no gate: it gets relaxed under pressure, and the relaxation is what ships.
      // A WINDOW, converted: the subject is the call's ARGUMENT LIST, bounded by its own paren. The comment
      // above explains why the argument text must not be constrained — and a 200-character cap is a
      // constraint on it, just expressed as a length. `balancedFrom` reads the whole list however long, and
      // however many commas or type parameters it contains.
      const callAt = body.indexOf('unknownBodyFields(');
      const refuses = callAt > -1
        && /[A-Z_]+_BODY_FIELDS/.test(balancedFrom(body, body.indexOf('(', callAt), 'the unknownBodyFields call'));
      if (!refuses) offenders.push(path);
    }
    assert.deepEqual(offenders, [],
      'these POST routes read a body without refusing unknown keys, so a mistyped parameter is dropped and the '
      + 'request still answers 200 — the defect the fleet integrator reported on /query, which cost them a fabricated number');
  });

  it('a refusing route actually returns 400 with the offending keys, not just a computed value', () => {
    // The near-miss version of this fix: compute the unknown keys and forget to return. That is the proxy-lens defect
    // (a narrowed list computed and discarded) and it would satisfy the check above on its own.
    for (const { path, body } of postRoutes()) {
      if (path in EXEMPT) continue;
      // The name is READ from the assignment rather than listed here, so a fifth route may call its variable anything
      // and still be covered. Hard-coding the four current names would make this gate stop working silently.
      const assigned = body.match(/const\s+(\w+)\s*=\s*unknownBodyFields\(/);
      assert.ok(assigned, `${path}: expected the refusal's result to be assigned to a const`);
      // An exact substring rather than a constructed RegExp: building one from an identifier means escaping the dots
      // and parens of `res.status(400).json(x)`, and the first version of this line got that wrong in a way that made
      // the pattern match more loosely than intended. A gate whose own pattern is subtle is a gate nobody trusts.
      assert.ok(body.includes(`res.status(400).json(${assigned[1]})`),
        `${path} computes its unknown keys into \`${assigned[1]}\` and never returns it — the value is discarded, `
        + 'which is exactly what the proxy lens did with its narrowed space list on three shipped routes');
    }
  });

  it('every key a handler READS is in its allowed set', () => {
    // The check that would have caught `includeFreshWrites`. Three access shapes appear in these handlers:
    //   const { a, b } = req.body ?? {}          — the destructure
    //   body['a'] / (req.body as X)['a']         — bracket access
    //   (req.body as { a?: unknown }).a          — cast-then-dot, which is how the two missed keys were read
    // `stripComments` here too, not only on the route file. The sets carry long comments explaining why each key is
    // listed, and the member extraction below pairs single quotes — so one apostrophe in prose (`the MCP tool's
    // schema`) pairs with the next real quote and swallows every key after it. That is exactly how this gate reported
    // `traverse` and `includeContent` as missing from a set that listed them.
    const QUERY_SRC = stripComments(readFileSync(join(ROOT, 'server', 'src', 'brain', 'query.ts'), 'utf8'));
    const missing = [];

    for (const { path, body } of postRoutes()) {
      if (path in EXEMPT) continue;
      // Same conversion, and the same reason: the field-set name is an ARGUMENT, so the argument list is
      // the bound.
      const nameAt = body.indexOf('unknownBodyFields(');
      const setName = nameAt > -1
        ? /([A-Z_]+_BODY_FIELDS)/.exec(balancedFrom(body, body.indexOf('(', nameAt), 'the unknownBodyFields call'))?.[1]
        : undefined;
      assert.ok(setName, `${path}: no named field set`);

      // The set's members, read from query.ts rather than imported: this gate reads source everywhere else, and
      // importing would make it depend on a build.
      const block = QUERY_SRC.slice(QUERY_SRC.indexOf(`export const ${setName}`));
      const declared = new Set([...block.slice(0, block.indexOf(']')).matchAll(/'([^']+)'/g)].map(m => m[1]));

      const read = new Set();
      for (const m of body.matchAll(/const\s*\{([^}]+)\}\s*=\s*req\.body/g)) {
        for (const nm of m[1].split(',')) {
          const clean = nm.trim().split(':')[0].trim();
          if (clean) read.add(clean);
        }
      }
      for (const m of body.matchAll(/(?:req\.body[^)]*\)|\bbody)\s*\[\s*'([^']+)'\s*\]/g)) read.add(m[1]);
      for (const m of body.matchAll(/\(\s*req\.body\s+as\s*\{[^}]*\}\s*\)\s*\.\s*(\w+)/g)) read.add(m[1]);

      for (const key of read) {
        if (!declared.has(key)) missing.push(`${path} reads '${key}' but ${setName} does not allow it`);
      }
    }

    assert.deepEqual(missing, [],
      'a strict body turns every unlisted key into a 400, so a key the handler reads and the set omits breaks a '
      + 'documented parameter — which is what happened to recall\'s includeFreshWrites in the first version of this fix');
  });

  it('the read-key extraction actually finds keys (the check is not vacuous)', () => {
    // Without this, a regex that matches nothing makes the assertion above pass for every route for ever — the shape of
    // a green gate that measures nothing.
    const recall = postRoutes().find(r => r.path === '/recall');
    const found = [...recall.body.matchAll(/\(\s*req\.body\s+as\s*\{[^}]*\}\s*\)\s*\.\s*(\w+)/g)].map(m => m[1]);
    assert.ok(found.includes('includeFreshWrites'),
      'the cast-then-dot pattern must be detected — it is the one that was missed, and if this stops matching the '
      + 'coverage check silently stops covering it');
  });

  it('every exemption carries a real reason', () => {
    for (const [path, reason] of Object.entries(EXEMPT)) {
      assert.ok(reason && reason.length > 40, `${path}: an exemption needs a reason, not a placeholder`);
      assert.ok(!/todo|later|for now|not yet/i.test(reason),
        `${path}: "${reason}" is a deferral, not a reason — an exemption list that accepts those becomes a to-do list`);
    }
  });

  it('no exemption names a route that no longer exists', () => {
    const paths = new Set(postRoutes().map(r => r.path));
    const stale = Object.keys(EXEMPT).filter(p => !paths.has(p));
    assert.deepEqual(stale, [], 'a stale exemption silently covers nothing, and hides the next route that needs it');
  });
});
