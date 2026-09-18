/**
 * NO collection read returns the embedding vector — asserted over every reader, not over a list of them.
 *
 * ## Why this gate exists and why it is shaped this way
 *
 * `NEVER_RETURNED_FIELDS` in `recall-shape.ts` already carried the right argument: *"a claim that absolute
 * should not rest on one projection being remembered at every fetch site."* It then rested on exactly that,
 * and five fetch sites had no projection at all — `listEntities`, `findEntitiesByName`, `findEntitiesByIds`,
 * `listEdges`, `listChrono`, plus three single-record getters and `findEdgeByTriplet`.
 *
 * The fleet integrator measured the consequence: **11.19 MB from `GET /entities?limit=500`** where `POST /query` answered
 * the same 100 records in 0.145 MB. It crashed their n8n with an out-of-memory failure and took their
 * database down with it for a stretch, and they found it by running out of memory rather than by reading a
 * response — because we publish, in three places, that the vector can never come back.
 *
 * ## The gate had to be over the SHAPE, not over the five names
 *
 * A test naming the five would pass the day somebody adds a sixth reader, which is the whole failure being
 * fixed: this codebase's most-produced defect is one rule with several implementations and the weaker one
 * winning. `measurement-must-not-share-the-blind-spot` says it directly — a sweep whose scope comes from the
 * same list as the code it audits cannot find what the list is missing. So this derives its own scope: it
 * finds every `.find(` / `.findOne(` on a record collection in `server/src/brain/` and requires each to carry
 * a projection.
 *
 * Run: node --test testing/standalone/reads-never-return-vectors.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';
import { REST_SEARCH, MCP_FILTER, doorSource } from '../_shared/search-doors.mjs';

const { NEVER_RETURNED_PROJECTION, LIST_WITHHELD_FIELDS } =
  await import('../../server/dist/brain/read-projection.js');

/**
 * The files to sweep, from `git ls-files` rather than a hand-kept list or `readdirSync`.
 *
 * `gitignored-files-break-local-checks`: a directory read answers with whatever is on this disk, including
 * build output and scratch files, and differs between here and CI. What the repo HOLDS is a git question.
 */
// One directory, so the floor is 20 rather than the default 100. A floor above what a scan can ever return
// fails on correct code, which is how a guard gets deleted instead of corrected.
const brainFiles = trackedSources('server/src/brain/*.ts', { floor: 20 });

/**
 * A read of a RECORD collection — the five that hold embeddable records.
 *
 * Deliberately not every `col(...)` call: tombstones, embed jobs, seq counters and sync state hold no vector,
 * and requiring a projection on them would be noise that trains the next person to add an exemption instead
 * of a projection.
 */
const RECORD_COLLECTIONS = /_(entities|edges|chrono|memories|files)`/;

/**
 * ...AND THE SAME READ SPELLED THROUGH A LOCAL VARIABLE, which is the blind spot this gate shipped with.
 *
 * The first version matched only `col<X>(\`${spaceId}_entities\`).find(...)` on one line. Nine functions
 * instead write `const collection = col<EntityDoc>(...)` and then `collection.findOne(...)` — and
 * `upsertEntity` was one of them, reading the whole document into a value the route sends back as its 201.
 * The gate reported clean while a leak sat four lines under its nose.
 *
 * That is `grep-both-spellings-dotted-and-bracket` exactly: a sweep scoped to one way of WRITING a thing
 * cannot find the other, and it passes, which is worse than failing. So the scope is now derived in two
 * passes — collect the variables assigned from a record collection, then flag reads on those too.
 */
const COLLECTION_ALIAS = /(?:const|let)\s+(\w+)\s*=\s*col<[^>]*>\(`\$\{\w+\}_(?:entities|edges|chrono|memories|files)`\)/;

describe('the vector never leaves the database', () => {
  it('sweeps a real set of files, so an empty sweep cannot pass', () => {
    // The failure this prevents is the one that makes every other assertion here vacuous: a glob that matches
    // nothing reports zero violations and looks identical to a clean codebase.
    assert.ok(brainFiles.length >= 8,
      `expected the brain module to hold at least 8 tracked files, found ${brainFiles.length} — the sweep's `
      + 'scope is wrong, and every assertion below is meaningless until it is fixed');
    assert.ok(brainFiles.some(f => f.endsWith('entities.ts')), 'entities.ts must be in scope');
    assert.ok(brainFiles.some(f => f.endsWith('read-projection.ts')), 'the rule itself must be in scope');
  });

  it('every record-collection read carries a projection', () => {
    const offenders = [];
    for (const file of brainFiles) {
      const raw = readFileSync(file, 'utf8');
      const rawLines = raw.split(/\r?\n/);
      /**
       * The line number in the ORIGINAL file, not in the stripped copy.
       *
       * `stripComments` deletes block comments outright rather than blanking them, so its line numbers drift
       * from the real file by however much prose sits above — in this module, by hundreds. The first version
       * of this gate reported those numbers and every one of them opened the wrong place, which is how a gate
       * teaches people to stop reading it.
       */
      const trueLine = (text) => {
        const needle = text.trim();
        const at = rawLines.findIndex(l => l.trim() === needle);
        return at === -1 ? '?' : at + 1;
      };
      const src = stripComments(raw);
      const lines = src.split(/\r?\n/);
      // Pass one: which local names are a record collection in this file.
      const aliases = new Set();
      for (const l of lines) {
        const m = COLLECTION_ALIAS.exec(l);
        if (m) aliases.add(m[1]);
      }
      const aliasRead = aliases.size === 0 ? null
        : new RegExp(`\\b(?:${[...aliases].join('|')})\\.(?:find|findOne)\\(`);
      // Pass two: flag every read, spelled either way.
      lines.forEach((line, i) => {
        if (!RECORD_COLLECTIONS.test(line) && !(aliasRead && aliasRead.test(line))) return;
        // The read may be chained across the following lines (`.find(...)` then `.project(...)`), so the
        // window is the statement rather than the line. Ended at the first `;` — a structural boundary, not
        // a character count, because `gate-windows-must-be-structural-not-character-counts` says a fixed
        // window spans different lines on CRLF than on CI's LF and passes by looking at less.
        const stmt = [];
        for (let j = i; j < lines.length && j < i + 30; j++) {
          stmt.push(lines[j]);
          if (lines[j].includes(';')) break;
        }
        const window = stmt.join('\n');
        if (!/\.find\(|\.findOne\(/.test(window)) return;                 // a count, an update, an aggregate
        if (/countDocuments|updateOne|updateMany|deleteOne|deleteMany|bulkWrite|insert/.test(window)) return;
        const projected = /projection:\s*NEVER_RETURNED_PROJECTION/.test(window)
          || /\.project\(NEVER_RETURNED_PROJECTION\)/.test(window)
          // An explicit narrow projection is stronger than the exclusion — it cannot include the vector by
          // accident, and several readers legitimately fetch only `_id` and `seq`.
          || /projection:\s*\{[^}]*\}/.test(window)
          || /\.project\(\{[^}]*\}\)/.test(window)
          /*
           * A DECLARED inclusion projection, e.g. `projection: FILE_LINKS.projection`.
           *
           * Accepted for the same reason the inline object is, and the type is what makes it safe rather than
           * the shape: `LinkClass.projection` is `Record<string, 1>`, so it can only ever name fields to
           * INCLUDE — a projection that cannot express an exclusion cannot leak a vector. One assertion over
           * in `one-definition-of-a-link-class` pins that those projections stay inclusion-only.
           *
           * Requiring the literal here would have forced the three link readers to spell their projections
           * out again, which is precisely the duplication `link-adjacency.ts` was extracted to remove — a gate
           * pushing back against a correct refactor is a gate that gets edited rather than believed.
           */
          || /projection:\s*[A-Z][\w$]*\.projection\b/.test(window);
        if (!projected) offenders.push(`${file}:${trueLine(lines[i])}  ${lines[i].trim().slice(0, 90)}`);
      });
    }
    assert.deepEqual(offenders, [],
      'these record reads return the whole document, vector included — the defect that sent 11.19 MB to a '
      + 'caller who had been told it could not happen:\n  ' + offenders.join('\n  '));
  });

  it('the projection is built from the field list, so the two cannot disagree', () => {
    const src = stripComments(readFileSync('server/src/brain/read-projection.ts', 'utf8'));
    assert.match(src, /NEVER_RETURNED_FIELDS\.map/,
      'the projection must be derived from NEVER_RETURNED_FIELDS — a hand-written `{ embedding: 0 }` is a '
      + 'second copy of the rule, and adding a second never-returned field would then need a sweep of every '
      + 'reader, which is the sweep that was already missed once');
    assert.deepEqual(NEVER_RETURNED_PROJECTION, { embedding: 0 });
  });

  it('an EXCLUSION projection, so a new record field is never silently absent from the API', () => {
    // An inclusion projection would have to name every field a caller might read, and the next field anybody
    // adds to a record would vanish from the list routes with nothing failing.
    for (const v of Object.values(NEVER_RETURNED_PROJECTION)) {
      assert.equal(v, 0, 'every entry must be an exclusion');
    }
  });

  it('every write that emits a stripped webhook also strips its RETURN', () => {
    /*
     * The pairing IS the assertion, and it is why this can be checked structurally.
     *
     * Fourteen places wrote `entry: { ...doc, embedding: undefined }` when emitting a webhook — so the rule
     * was known, and applied at every webhook and at zero returns. The very same object went out on the 201
     * with the vector intact. Measured: entity, memory, chrono and edge creates all leaked with
     * `waitForEmbedding: true`, and any create with `checkDuplicates` — which DEFAULTS TO TRUE.
     *
     * So: wherever a write strips for a webhook, the return in the next few lines must strip too. That
     * catches a new write function without naming any of them, which a per-function test could not.
     */
    const offenders = [];
    for (const file of brainFiles) {
      const lines = stripComments(readFileSync(file, 'utf8')).split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!/embedding: undefined/.test(line)) return;
        // The return following this webhook emit, within the same block.
        const after = lines.slice(i + 1, i + 6).join('\n');
        if (!/\breturn\b/.test(after)) return;   // a webhook that ends a function with no value
        if (/withoutVector\(/.test(after)) return;
        // A `result` assembled from an already-projected read carries no vector to strip.
        if (/return result;/.test(after)) return;
        offenders.push(`${file}: the write emitting a stripped webhook near "${line.trim().slice(0, 60)}" `
          + 'returns a document that was not stripped');
      });
    }
    assert.deepEqual(offenders, [],
      'a write knows the vector must not leave on a webhook and sends it on the response:\n  '
      + offenders.join('\n  '));
  });

  it('the list routes withhold the two record diagnostics and KEEP seq', () => {
    // `seq` is the `If-Match` value. Withholding it would remove the conditional-write path, which is why
    // this list is not a reuse of RECALL_RECORD_DIAGNOSTICS even though it looks like a subset of it.
    assert.deepEqual([...LIST_WITHHELD_FIELDS], ['matchedText', 'embeddingModel']);
    assert.ok(!LIST_WITHHELD_FIELDS.includes('seq'),
      'seq must stay — the canary operator asked for it by name, and it is the conditional-write token');
  });

  it('the one `filter` handler applies the strip, and reads the flag to decide', () => {
    /*
     * This case named four list routes until `B-9` step 3b deleted all four, and then TWO doors until 3c
     * deleted the hand-written REST twin. Listing a collection is `filter` now: one place a page of brain
     * records is built, and one implementation behind both doors.
     *
     * What it protected against was two spellings of one flag — `body['includeDiagnostics']` on the route
     * and `a['includeDiagnostics']` on the tool — where a door that dropped its own would return the
     * passage a second time to whoever picked it. There is one spelling now, which is the rule holding
     * rather than the case weakening.
     */
    /*
     * ONE door since `B-9` step 3c. The REST half was a hand-written twin with its own copy of this
     * strip; deleting it is what makes the rule unconditional rather than duplicated — the generic tool
     * door has no per-tool code, so whatever the handler withholds is what both doors withhold.
     */
    for (const [door, file] of [['the filter tool', MCP_FILTER]]) {
      const src = stripComments(doorSource(file));
      assert.match(src, /withoutListDiagnostics\(/,
        `the ${door} door returns its rows unfiltered — matchedText is the passage a second time`);
      assert.match(src, /withoutListDiagnostics\([^)]*\['includeDiagnostics'\] === true\)/,
        `the ${door} door must strip unless the caller asked, and read the flag to decide`);
    }
  });
});
