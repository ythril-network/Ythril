/**
 * Per-column filters — the server side.
 *
 * The Description column had no control, and the box that DID exist (in the first column) searched
 * `description` as well as `name`/`fact`/`title` via `?search=`. So the column looked unfiltered while
 * something else quietly filtered it. A column control has to narrow its own column, or it reports
 * something it does not do.
 *
 * `?search=` keeps its documented multi-field behaviour — integrations use it — so this is a NEW
 * per-field parameter alongside it, not a change to it.
 *
 * Run: node --test testing/standalone/column-filters.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import { trackedSources } from './_sources.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** Every tracked server source, read out of git rather than named — see the derived cases below. */
function serverSources() {
  return trackedSources('server/src');
}
const read = (f) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');


let textContains, tagContains;

before(async () => {
  ({ textContains, tagContains } = await import('../../server/dist/brain/tag-filter.js'));
});

describe('textContains', () => {
  it('matches a substring, case-insensitively', () => {
    const m = textContains('quarterly');
    assert.match('The QUARTERLY review notes', new RegExp(m.$regex, m.$options));
  });

  it('is unanchored — a whole-field match was the bug being fixed', () => {
    const m = textContains('review');
    assert.ok(!m.$regex.startsWith('^') && !m.$regex.endsWith('$'));
  });

  it('escapes the input, so a crafted value cannot act as a pattern', () => {
    const m = textContains('(a+)+$');
    const re = new RegExp(m.$regex, m.$options);
    assert.match('literal (a+)+$ here', re);
    assert.doesNotMatch('aaaaaaaa', re);
  });

  it('is the same matcher tag search uses', () => {
    // One implementation, so the two cannot drift into different answers — which is exactly what had
    // happened across the five record types before they were unified.
    assert.equal(tagContains, textContains);
  });
});

describe('every record type filters its own description column', () => {
  const SITES = [
    ['server/src/api/brain/_shared.ts', 'facts'],
    ['server/src/api/brain/entities.ts', 'entities'],
    ['server/src/brain/edges.ts', 'edges'],
    ['server/src/brain/chrono.ts', 'chrono'],
  ];

  for (const [file, label] of SITES) {
    it(`${label} applies a substring filter to \`description\``, () => {
      const src = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      assert.match(src, /description'?\]?\s*=\s*textContains\(/,
        `${file} must narrow description with the shared substring matcher`);
    });
  }

  it('leaves `search` spanning its documented field set', () => {
    // Narrowing `search` to one field would silently break every integration using it.
    const src = readFileSync(new URL('../../server/src/brain/text-search.js'.replace('.js', '.ts'), import.meta.url), 'utf8');
    assert.ok(src.includes("facts: ['fact', 'description']"), 'search must still span both');
    assert.ok(src.includes("entities: ['name', 'description']"), 'search must still span both');
  });
});

describe('propertiesValueContains — filters on VALUE, not key', () => {
  let propertiesValueContains, PROPERTIES_SCAN_MAX_MS;

  before(async () => {
    ({ propertiesValueContains, PROPERTIES_SCAN_MAX_MS } = await import('../../server/dist/brain/tag-filter.js'));
  });

  it('walks the bag rather than naming a field', () => {
    // Keys are operator-chosen, so there is no field to query — the values have to be walked.
    const f = propertiesValueContains('engineer');
    const json = JSON.stringify(f);
    assert.match(json, /\$objectToArray/);
    assert.match(json, /\$regexMatch/);
    assert.match(json, /\$anyElementTrue/);
  });

  it('matches the VALUE side of each pair, never the key', () => {
    // `$$this.v`, not `$$this.k`. Verified live: filtering "role" against {role:'engineer'} returns 0.
    const json = JSON.stringify(propertiesValueContains('x'));
    assert.ok(json.includes('$$this.v'), 'must read the value');
    assert.ok(!json.includes('$$this.k'), 'must NOT read the key');
  });

  it('stringifies before matching, so a numeric value is still findable', () => {
    // Values are string | number | boolean. Without $toString, filtering "12" would miss a numeric 12 —
    // which reads as a broken filter rather than as a type subtlety.
    assert.match(JSON.stringify(propertiesValueContains('12')), /\$toString/);
  });

  it('escapes the needle', () => {
    const f = propertiesValueContains('(a+)+$');
    const regex = f.$expr.$anyElementTrue.$map.in.$regexMatch.regex;
    assert.ok(regex.includes('\('), 'metacharacters must be escaped');
    assert.doesNotMatch('aaaaaaaa', new RegExp(regex));
  });

  it('is case-insensitive', () => {
    assert.equal(propertiesValueContains('x').$expr.$anyElementTrue.$map.in.$regexMatch.options, 'i');
  });

  it('tolerates a missing properties bag instead of erroring', () => {
    assert.match(JSON.stringify(propertiesValueContains('x')), /\$ifNull/);
  });

  it('exports a scan deadline, because this query cannot use an index', () => {
    assert.ok(typeof PROPERTIES_SCAN_MAX_MS === 'number' && PROPERTIES_SCAN_MAX_MS > 0);
  });

  it('every list function APPLIES the deadline, not merely imports it', () => {
    /*
     * An unbounded collection scan on a large space is the failure mode here — not a wrong result.
     * Checking for the identifier alone is not enough: deleting the guard leaves the import behind, so that
     * version of this test passed with the bound gone.
     *
     * **DERIVED from who imports the deadline, because "every list function" is the claim.** It named four
     * files, which are the four that import it today — correct, and a list all the same. A fifth list
     * function written next year is outside everything this gate reads while the title goes on covering it
     * (`Q-6`, 2026-09-07).
     */
    const importers = serverSources()
      .filter(f => f !== 'server/src/brain/tag-filter.ts')   // where the constant is DECLARED
      .filter(f => /PROPERTIES_SCAN_MAX_MS/.test(read(f)));
    assert.ok(importers.length >= 4,
      `only ${importers.length} module(s) reference the deadline; the four known list functions are the `
      + 'minimum, so the scan is wrong rather than the code');

    for (const f of importers) {
      assert.match(read(f), /maxTimeMS\([^)]*PROPERTIES_SCAN_MAX_MS/,
        `${f} imports the deadline and never passes it to maxTimeMS — the import is not the bound`);
    }
  });
});

describe('entity-NAME column filters (From / To / Entities)', () => {
  it('an unmatched name filters to NOTHING, never to everything', () => {
    /*
     * The dangerous shape: resolve a name to zero ids, then skip the filter because the list is empty. The
     * column would show every row while claiming to be filtered.
     *
     * **Two halves, and the second is now derived.** The `$in` on the edge query stays asserted literally —
     * those two lines ARE the rule for that door. The other half used to name two API files; it now asks
     * every CALLER of the resolver, because a caller is what a new door becomes.
     *
     * The rule asserted per call is that the resolved list is never LENGTH-TESTED. That is the whole defect:
     * `if (ids.length)` is how an empty result turns into no filter at all. Bounded by the statement's own
     * semicolon rather than by a character count — a count spans different lines on CRLF than on LF.
     */
    const edges = read('server/src/brain/edges.ts');
    assert.match(edges, /if \(filter\.fromIds\) q\['from'\] = \{ \$in: filter\.fromIds \}/);
    assert.match(edges, /if \(filter\.toIds\) q\['to'\] = \{ \$in: filter\.toIds \}/);

    const CALL = 'resolveEntityIdsByName(';
    const callers = serverSources()
      .filter(f => f !== 'server/src/brain/entities.ts')     // where the resolver is DECLARED
      .filter(f => read(f).includes(CALL));
    assert.ok(callers.length >= 3,
      `only ${callers.length} caller(s) of the resolver found; the three known doors are the minimum`);

    for (const f of callers) {
      const src = read(f);
      let at = src.indexOf(CALL);
      while (at > 0) {
        const prefix = src.slice(src.lastIndexOf('\n', at) + 1, at);
        assert.doesNotMatch(prefix, /\b(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?$/,
          `${f} binds a resolved name list to a local: ${prefix.trim()}${CALL}…)\n\n`
          + 'An unmatched name must filter to NOTHING. A local is what an `if (ids.length)` can stand in '
          + 'front of, and skipping the filter on an empty list shows every row while the column claims to '
          + 'be filtered — the one wrong answer nobody reports. Assign it onto the query directly.');
        at = src.indexOf(CALL, at + 1);
      }
    }
  });

  it('resolves per MEMBER, not once for the whole proxy space', () => {
    // Ids belong to the member that owns them; resolving against another member's entities would match
    // nothing while looking like it worked.
    for (const f of ['edges.ts', 'facts.ts', 'chrono.ts']) {
      const src = readFileSync(new URL(`../../server/src/api/brain/${f}`, import.meta.url), 'utf8');
      // The PROPERTY, not the shape that used to express it. This line required
      // `collectAcrossMembers(spaceId, async mid =>` until the list routes moved onto the shared pager, at which point the
      // resolution moved into a `filterFor(mid)` helper — still per member, and the gate failed on correct code.
      //
      // Asserting the ARGUMENT is stronger than asserting the enclosing loop: the old pattern would have passed a
      // `resolveEntityIdsByName(spaceId, …)` written inside the loop, which is the actual mistake being guarded against.
      assert.match(src, /resolveEntityIdsByName\(mid,/, `${f} must resolve against the MEMBER id`);
      assert.ok(!/resolveEntityIdsByName\(spaceId,/.test(src),
        `${f} resolves an entity name against the PROXY space id — ids belong to the member that owns them, so this `
        + 'matches nothing while looking like it worked');
    }
  });

  it('caps how many ids one name can expand to', () => {
    const src = readFileSync(new URL('../../server/src/brain/entities.ts', import.meta.url), 'utf8');
    assert.ok(src.includes('NAME_FILTER_ID_CAP'), 'an unbounded $in is a denial-of-service shape');
    assert.match(src, /\.limit\(NAME_FILTER_ID_CAP\)/, 'the cap must be applied to the query');
  });

  it('matches names by escaped substring, like every other text filter', () => {
    const src = readFileSync(new URL('../../server/src/brain/entities.ts', import.meta.url), 'utf8');
    assert.match(src, /name: textContains\(trimmed\)/);
  });
});
