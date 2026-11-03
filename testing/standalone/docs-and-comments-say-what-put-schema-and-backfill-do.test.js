/**
 * What the docs and the code comments say about `PUT /api/spaces/:id/schema` and about the way back from suppression
 * is what the code does (Q-509, Q-368).
 *
 * ## Q-509 — `PUT /schema` on a networked space is a vote
 *
 * Since Q-52 a networked space's schema is the network's to decide, whichever door the write comes through: `PUT
 * /schema`, the single-type upsert and delete and the schema library's apply open a `meta_change` round exactly as `PATCH
 * /api/spaces/:id` does (`api/spaces.ts` calls `voteOnSchemaEditIfNetworked` before it touches the space). Three
 * sentences written before Q-52 still say the opposite — that the route "applies directly" and "does not open a vote
 * round", that it "bypasses the network vote", that routing the UI there would be "a silent consensus bypass" — and a
 * reader who believes them picks the PATCH form to be safe, or the PUT form to skip a vote that is not skippable.
 * They are in the integration guide (06), the schema type editor's docblock and `body-schemas.ts`.
 *
 * The backup the route writes is the same kind of sentence: it is written only where the replacement is applied at once,
 * on a space in no network; on a networked space nothing is written until the round passes, so "the previous schema is
 * backed up first" is true of one case only and the page must say which.
 *
 * ## Q-368 — the way back from suppression is Backfill, not Reindex
 *
 * The guide says: turning suppression off does not embed what was written while it was on; use **Backfill missing
 * embeddings** on the space's Danger tab (`POST /reembed`). Two docblocks quote that sentence as "Use the space's Reindex
 * control" — a control that rebuilds EVERY vector in the space, which is the other repair
 * (`04d-brain-ops-api.md`: "Not the same as the backfill, and this is the pair people pick wrong").
 *
 * ## The set is the repository's, not a list
 *
 * Every tracked `.md` under `docs/` and every tracked `.ts` / `.js` under the source trees is read, one paragraph (or
 * comment block) at a time, so the next copy of the sentence is caught wherever it is written.
 *
 * Run: node --test testing/standalone/docs-and-comments-say-what-put-schema-and-backfill-do.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';

const THIS_FILE = 'testing/standalone/docs-and-comments-say-what-put-schema-and-backfill-do.test.js';

/** Paragraphs of a file, with comment markers removed so a docblock reads as prose; each with its first line. */
export function paragraphs(text) {
  const out = [];
  let cur = []; let start = 1;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/^\s*(?:\/\*\*?|\*\/|\*|\/\/+)\s?/, '').replace(/\*\/\s*$/, '').trimEnd();
    if (line.trim() === '') {
      if (cur.length) out.push({ line: start, text: cur.join(' ') });
      cur = []; start = i + 2;
    } else {
      if (!cur.length) start = i + 1;
      cur.push(line.trim());
    }
  });
  if (cur.length) out.push({ line: start, text: cur.join(' ') });
  return out;
}

/** `PUT /schema`, `PUT :id/schema`, `PUT /:id/schema`, `PUT /api/spaces/:id/schema`, as prose or code. */
const PUT_SCHEMA = /PUT\s*`?\s*(?:\/api\/spaces\/)?\/?(?::id\/|\{id\}\/)?\/?schema\b/;
/** Sentences that say a schema write skips the network's vote. */
const SKIPS_THE_VOTE = /applies\s+\*{0,2}directly\*{0,2}|bypass(?:es)?\s+the\s+(?:network\s+)?vote|consensus\s+bypass|does\s+not\s+open\s+a\s+vote|not\s+open\s+a\s+vote\s+round|without\s+(?:a|the)\s+(?:network\s+)?vote\b/i;

/** Where `paras` of `file` say `PUT /schema` skips the vote. */
export function staleVoteClaims(file, paras) {
  return paras.filter(p => PUT_SCHEMA.test(p.text) && SKIPS_THE_VOTE.test(p.text))
    .map(p => `${file}:${p.line} says PUT /schema skips the network vote`);
}

/** Where `paras` of `file` say the schema is backed up first, without saying that is the non-networked case. */
export function unqualifiedBackupClaims(file, paras) {
  return paras
    .filter(p => /_schema-backup|backed\s+up|writes\s+a\s+(?:timestamped\s+)?backup/i.test(p.text) && /type\s?schemas?|schema/i.test(p.text))
    .filter(p => /PUT|_schema-backup|previous\s+`?typeSchemas/.test(p.text))
    .filter(p => !/network/i.test(p.text))
    .map(p => `${file}:${p.line} says the previous schema is backed up first, and not that a networked space writes nothing until its round passes`);
}

// Case-sensitive on purpose: "the reindex controls" of a spec comment names the buttons of the Reindex feature, not this sentence.
const REINDEX_AS_THE_WAY_BACK = new RegExp(`${['Reindex', 'control'].join(' ')}\\b`);

/** Where `text` of `file` names the Reindex control as the repair for suppression turned off. */
export function reindexAsWayBack(file, text) {
  return text.split(/\r?\n/)
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => REINDEX_AS_THE_WAY_BACK.test(l))
    .map(({ n }) => `${file}:${n} names a "Reindex control" — the way back from suppression is Backfill missing embeddings; Reindex rebuilds every vector`);
}

// ── the repository ────────────────────────────────────────────────────────────────────────────────────────────────
const DOCS = trackedSources('docs', { ext: ['.md'], floor: 20 });
const SOURCES = trackedSources(['server/src', 'client/src', 'schema/src'], { ext: ['.ts'], floor: 300 });
const TESTS = trackedSources('testing', { ext: ['.js', '.mjs'], floor: 100 }).filter(f => f !== THIS_FILE);
const text = (f) => readFileSync(join(REPO_ROOT, f), 'utf8');

describe('a networked space\'s schema write is a vote, and the docs and comments say so (Q-509)', () => {
  it('the scan reads the integration guide, the type editor and body-schemas', () => {
    for (const f of ['docs/integration-guide/06-spaces-api.md', 'client/src/app/pages/settings/schema-type-editor.component.ts', 'server/src/spaces/body-schemas.ts']) {
      assert.ok([...DOCS, ...SOURCES].includes(f), `${f} is not in the scan`);
    }
  });

  it('nothing says PUT /schema applies directly, skips the vote or bypasses consensus', () => {
    const found = [...DOCS, ...SOURCES].flatMap(f => staleVoteClaims(f, paragraphs(text(f))));
    assert.deepEqual(found, [],
      `${found.join('\n')}\n\nSince Q-52 the route calls voteOnSchemaEditIfNetworked before it writes: on a networked space it answers 202 vote_pending `
      + '(or 200 where this instance\'s own yes carries it) and applies the replacement when the round passes.');
  });

  it('the backup the route writes is described as the non-networked case', () => {
    const found = DOCS.flatMap(f => unqualifiedBackupClaims(f, paragraphs(text(f))));
    assert.deepEqual(found, [], found.join('\n'));
  });
});

describe('the way back from suppression is named by its label (Q-368)', () => {
  it('no doc, comment or test calls it the "Reindex control"', () => {
    const found = [...DOCS, ...SOURCES, ...TESTS].flatMap(f => reindexAsWayBack(f, text(f)));
    assert.deepEqual(found, [], found.join('\n'));
  });
});

describe('the gates themselves', () => {
  const para = (s) => paragraphs(s);

  it('the stale sentences of the three files are flagged, and the corrected ones are not', () => {
    assert.equal(staleVoteClaims('a.md', para('- `PUT /api/spaces/:id/schema` to replace the whole map. Note it applies **directly**, so on a networked space it does not open a vote round')).length, 1);
    assert.equal(staleVoteClaims('b.ts', para('/**\n * `PUT :id/schema` already replaces wholesale, but it calls `updateSpace()` directly and so bypasses the network vote\n */')).length, 1);
    assert.equal(staleVoteClaims('c.ts', para('// through `PATCH /api/spaces/:id` rather than `PUT /:id/schema`, which applies directly and would be a\n// silent consensus bypass on a networked space')).length, 1);
    assert.deepEqual(staleVoteClaims('d.md', para('`PUT /schema`, the single-type upsert and delete open a `meta_change` round exactly as `PATCH` does and answer 202. A space in no network is written at once.')), []);
    assert.deepEqual(staleVoteClaims('e.md', para('The record applies directly to the store.')), [], 'a paragraph that does not name the route is not about it');
  });

  it('a backup sentence needs the network case beside it', () => {
    const bare = 'Before the new schema is written, the previous `typeSchemas` is automatically backed up to `_schema-backup-<ts>.json`.';
    assert.equal(unqualifiedBackupClaims('a.md', para(bare)).length, 1);
    assert.deepEqual(unqualifiedBackupClaims('a.md', para(`${bare} On a networked space nothing is written, backup included, until the round passes.`)), []);
  });

  it('the Reindex control wording is found on any line', () => {
    assert.equal(reindexAsWayBack('a.ts', ' * what was written while it was on. Use the space\'s Reindex control"* — so only').length, 1);
    assert.deepEqual(reindexAsWayBack('a.ts', ' * Use Backfill missing embeddings on the space\'s Danger tab'), []);
  });
});
