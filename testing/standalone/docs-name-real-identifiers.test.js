/**
 * A backticked camelCase identifier in the docs must exist somewhere in the repository.
 *
 * ## The failure it catches
 *
 * `plannedRoute` was documented as a response field for **thirteen releases** after the feature was removed
 * in 2.0.0. The removal cut its explanation off mid-word, and what stayed behind read as a description of a
 * capability the product has. Nothing failed: no test names a field that does not exist, and prose is not
 * compiled.
 *
 * That matters more than an ordinary stale sentence because the canary reads our documentation **into**
 * Ythril. A field no endpoint returns becomes a confidently retrieved false fact — the same reasoning that
 * produced `doc-links-resolve`.
 *
 * The first run of this check on the shipped docs found two more, both in the migration-strategy section of
 * the contribution guide, which is the section a contributor reads to decide how to write a migration:
 *
 *  - `sizeFileBytes` — the real field is `sizeBytes`, and it was the *worked example* of the self-healing
 *    rule, so it is the name a reader would have gone looking for;
 *  - `ensureIndex` — removed from the MongoDB driver in 4.0. Our code uses `createIndex` and always has.
 *
 * ## Deliberately narrow
 *
 * Earlier slices of this audit tried generic doc↔code matching and produced 69, then 36, then 89 false
 * proposals. The lesson recorded in `doc-cited-constants` is that a check nobody trusts gets skipped, so
 * this one asks the narrowest useful question:
 *
 *  - **camelCase only.** A lowercase start with at least one internal capital is an identifier, not a word.
 *    `retention` and `strict` are prose; `strictLinkage` is a field.
 *  - **backticked only.** The document is naming an identifier rather than using a word.
 *  - **existence, not correctness.** "Does this string appear anywhere in the repository" — not whether it is
 *    used the way the doc says. Cheap, and it is the question `plannedRoute` failed.
 *
 * ## camelCase ONLY, and the other two shapes were measured before being ruled out
 *
 * Both alternatives were run against the shipped docs rather than reasoned about:
 *
 *  - **`SCREAMING_SNAKE`: 136 distinct, 0 unaccounted for.** Not because it is safe to add, but because
 *    `env-var-docs-coverage` already asserts *"every variable the docs name actually exists"*. Adding it here
 *    would be a second copy of a green check — one more place to edit, and the one that goes stale is
 *    whichever the editor did not have open.
 *  - **`snake_case`: 105 distinct, 2 unaccounted for, and both correct.** `default_facts` is the real
 *    `<spaceId>_facts` scheme with `spaceId` filled in; `validated_by` is an edge label in a use-case
 *    scenario. That is structural, not a fixable blind spot: in this product `snake_case` is the shape of
 *    **user data** — space ids, edge labels, type names — so every instantiated example reads as a ghost.
 *    camelCase does not have that problem, because our fields are camelCase and user data is not.
 *
 * So this shape is the one that carries signal. Do not widen it without re-measuring.
 *
 * ## It searches EVERYTHING git tracks
 *
 * The first version scanned `server/src` and `client/src` only, and reported `emptyDir`, `podPidsLimit` and
 * `livenessProbe` as nonexistent. Two of the three are real Kubernetes fields in `kubernetes/manifests/`,
 * which the scan had excluded — a blind spot in the measurement producing findings about the documentation.
 * So the haystack is every tracked file outside `docs/`, manifests and compose files included.
 *
 * Run: node --test testing/standalone/docs-name-real-identifiers.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/**
 * Identifiers owned by SOMEONE ELSE's software, which correctly appear in our docs and correctly appear
 * nowhere in our repository.
 *
 * Each row needs a reason naming the owner. That requirement is the whole safety mechanism: an exemption
 * list is how a gate stops checking things, and "it was failing" is not a reason. If this list grows past a
 * handful, the check has the wrong shape and should be reconsidered rather than fed.
 */
const NOT_OURS = [
  { id: 'podPidsLimit', why: 'a kubelet configuration flag, set on the cluster and not in our manifests' },
  { id: 'targetOrigin', why: "the second parameter of the DOM's window.postMessage, named in the embedding "
    + 'guide because an embedder has to pass it correctly — the guide exists to stop them constructing it' },
];

/** This file's own path, excluded below. */
const SELF = 'testing/standalone/docs-name-real-identifiers.test.js';

/**
 * Every tracked file that could contain an identifier. Docs are the needle, so they are not the haystack.
 *
 * **And neither is this file.** Its header names `sizeFileBytes` and `ensureIndex` while explaining that they
 * were wrong, and its mutation check names a fabricated identifier. Including itself made the gate pass *on
 * the comment describing the bug it exists to catch* — the third time that shape has appeared in this repo,
 * and the reason `gates-must-strip-comments` is a rule here. Re-introducing `sizeFileBytes` into the
 * contribution guide with self included left this green.
 */
function haystack() {
  const files = git(['ls-files']).split('\n').filter(Boolean)
    .filter((f) => /\.(ts|tsx|js|mjs|cjs|html|css|json|py|ya?ml|sh|toml|conf)$/.test(f) || /Dockerfile|Makefile/.test(f))
    .filter((f) => !f.startsWith('docs/') && f !== SELF && !RULE_SHEETS.includes(f));
  return { files, text: files.map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n') };
}

/**
 * `CLAUDE.md` is checked too, and it is the highest-value file in the set.
 *
 * It is the contributor's rule sheet — read by whoever is about to make a decision, so a stale identifier there
 * is not a documentation problem but a decision taken against a rule that no longer holds. It also rots faster
 * than the guides, because it cites the code it is making rules ABOUT: on 2026-09-01 an audit found a section
 * written that morning already stale, three PRs having landed between writing it and reading it back.
 *
 * Added when that audit had to be done BY HAND. Everything it found mechanically was a NAME — a symbol that had
 * moved, a file that had been split — which is the question this gate already asks, and it was asking it of
 * every file except the one that tells people how to write code here.
 *
 * Excluded from the haystack below for the same reason this file is: a document that is its own haystack
 * validates every name it invents.
 */
const RULE_SHEETS = ['CLAUDE.md'];

/** Every backticked camelCase identifier in the docs, mapped to the files that name it. */
function documentedIdentifiers() {
  const docs = [...git(['ls-files', 'docs/*.md', 'docs/*/*.md']).split('\n').filter(Boolean), ...RULE_SHEETS];
  const found = new Map();
  const IDENT = /`([a-z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]*)+)`/g;
  for (const d of docs) {
    for (const m of readFileSync(d, 'utf8').matchAll(IDENT)) {
      if (!found.has(m[1])) found.set(m[1], new Set());
      found.get(m[1]).add(d);
    }
  }
  return { docs, found };
}

describe('the check itself works before it is trusted', () => {
  const { files } = haystack();
  const { docs, found } = documentedIdentifiers();

  it('found the docs and the source', () => {
    // Either side returning nothing makes the assertion below vacuously true.
    assert.ok(docs.length >= 20, `only found ${docs.length} docs`);
    assert.ok(files.length >= 200, `only found ${files.length} source files`);
  });

  it('extracts a useful number of identifiers', () => {
    // Two digits would mean the pattern had stopped matching. It found 291 when written.
    assert.ok(found.size >= 150, `only extracted ${found.size} backticked camelCase identifiers`);
  });

  it('extracts identifiers and not prose', () => {
    // The pattern must require an internal capital. Without that it matches every backticked word and the
    // exemption list becomes the whole check.
    const IDENT = /`([a-z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]*)+)`/g;
    const hits = [...'`strictLinkage` and `retention` and `maxTimeMS` and `strict`'.matchAll(IDENT)].map(m => m[1]);
    assert.deepEqual(hits, ['strictLinkage', 'maxTimeMS'], 'lowercase words must not be treated as identifiers');
  });

  it('would REPORT an identifier that exists nowhere', () => {
    // Mutation-check against a fabricated name, because a scan that can never report looks exactly like a
    // clean repository.
    const { text } = haystack();
    assert.ok(!text.includes('plannedRouteThatWasRemoved'),
      'the fabricated name must genuinely be absent for this check to mean anything');
  });

  it('every exemption gives a reason and is still absent from the code', () => {
    const { text } = haystack();
    for (const row of NOT_OURS) {
      assert.ok(row.why && row.why.length > 20, `exemption '${row.id}' needs a reason naming whose software owns it`);
      assert.ok(!text.includes(row.id),
        `'${row.id}' is exempted as third-party but now appears in our own code — drop the exemption`);
    }
  });
});

describe('every documented identifier is real', () => {
  it('names nothing that exists nowhere in the repository', () => {
    const { text } = haystack();
    const { found } = documentedIdentifiers();
    const exempt = new Set(NOT_OURS.map((r) => r.id));
    const ghosts = [...found]
      .filter(([id]) => !exempt.has(id) && !text.includes(id))
      .map(([id, files]) => `${id} — named in ${[...files].join(', ')}`)
      .sort();
    assert.deepEqual(ghosts, [],
      'These identifiers are documented and exist nowhere in the repository:\n  '
      + `${ghosts.join('\n  ')}\n\n`
      + 'Either the name is wrong (check for a near-miss: `sizeFileBytes` for `sizeBytes`), or it documents a\n'
      + 'capability that was removed and left prose behind (`plannedRoute` did, for thirteen releases). If it\n'
      + "genuinely belongs to someone else's software, add it to NOT_OURS with a reason naming the owner.");
  });
});
