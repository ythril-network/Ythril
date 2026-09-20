/**
 * A chrono entry is reachable by `traverse`.
 *
 * ## The reported cost, which is why this is not cosmetic
 *
 * `chrono.entityIds` was the only thing linking a chrono to the graph, and it was legible to `query()` and
 * invisible to `traverse` — the retrieval path an agent reaches for first. An integrator measured what that
 * costs: reconstructing a **33-day hardware-RMA timeline took four `query()` calls plus two repo greps**, and
 * the first pass still missed the actual carrier ticket, which had to be found by a name regex rather than by
 * traversal from the incident.
 *
 * Their framing is the right one: the natural reading of "knowledge graph" is that a chrono is a node.
 *
 * ## What is pinned here
 *
 * The traversal itself needs MongoDB, so the behaviour is proven in the Docker suite. What this file pins is
 * the part that is pure and the part that is a promise to callers:
 *
 *  - the synthetic link has a REAL label, so `edgeLabels` can include or exclude it like any other;
 *  - an explicit `edgeLabels` filter that does not name it EXCLUDES chrono — a filter that cannot exclude
 *    something is not a filter, and asking for `depends_on` must not quietly return timeline entries;
 *  - chrono nodes are marked `kind`, and entity nodes are not — so a response is byte-identical for every
 *    caller that was already using this, and a caller following `_id` knows which collection to look in;
 *  - the chrono node does NOT join the next frontier, or a depth-2 walk would bounce back through every
 *    entity the chrono mentions;
 *  - **both surfaces take the same flag with the same default.** A rule that reaches one door and not the
 *    other is the defect four brain-API fixes were about.
 *
 * ## Re-pointed in 3.6, and the reason is the thing this file is about
 *
 * Every rule below used to be read out of `traverseGraph`, where the chrono scan sat inline beside a
 * near-identical memory scan and a near-identical file scan. `recall`'s expansion then needed the same three,
 * which would have made SIX copies of one rule in one file — the defect `CLAUDE.md` names as the one this
 * repo produces most. The scan moved into `link-frontier.ts` and both traversals call it.
 *
 * So these assertions read from two files now, and they are stronger for it: the rule is enforced once for
 * all three link classes rather than three times for three, and a check that passes proves it for the memory
 * and file walks too. What is no longer assertable is any claim about chrono holding a rule the other two
 * lack — there is nowhere left for that to be true.
 *
 * Run: node --test testing/standalone/traverse-reaches-chrono.test.js
 * (requires a prior `npm run build` in server/ so server/dist exists)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bodyOf, blockAfter } from './_structural-window.mjs';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let CHRONO_LINK_LABEL;

describe('the chrono link is a first-class edge label', () => {
  before(async () => {
    ({ CHRONO_LINK_LABEL } = await import('../../server/dist/brain/edges.js'));
  });

  it('is exported and non-empty, so callers can name it', () => {
    assert.equal(typeof CHRONO_LINK_LABEL, 'string');
    assert.ok(CHRONO_LINK_LABEL.length > 0);
    // Named for the field it derives from: a reader of a traverse result can tell a modelled relationship
    // from a derived one without consulting the docs.
    assert.match(CHRONO_LINK_LABEL, /chrono/);
  });
});

describe('traverse follows chrono.entityIds', () => {
  // Comments explain the mechanism by name, so they must not satisfy the checks that guard it.
  const strip = (t) =>
    t.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  // Both traversals: the standalone one stayed in `edges.ts`, the recall walk moved to its own module in A-4,
  // and the break condition this pins has to be right in both. `edge-id.ts` is here because `edges.ts` is
  // frozen at its size and `syntheticEdgeId` went there in `Q-24` — the id format is a fact about edges
  // rather than about either walk, which is what its own docblock had been saying while it sat in the
  // walk's file. A gate reading only the two walks would have reported the id rule clean about nothing.
  const code = strip(read('server/src/brain/edges.ts') + read('server/src/brain/recall-seed-traversal.ts')
    + read('server/src/brain/edge-id.ts'));
/*
 * The node RENDERING moved out of the walk in 5.0 and this gate has to follow it.
 *
 * Both walks now resolve a neighbour through `neighbourNodes`, because an edge may name a fact, chrono
 * entry or file at either end and the walks used to look every neighbour up among entities. `edges.ts` is
 * frozen at its size, so the new behaviour went beside it. A gate that kept pinning the old inline push
 * would have gone green on a file that no longer contains the rule.
 */
const nodes = strip(read('server/src/brain/edge-endpoint-names.ts'));
  const scan = strip(read('server/src/brain/link-frontier.ts'));

  it('queries the chrono collection for entries pointing at the frontier', () => {
    // The class supplies the collection name, so the literal is gone from the query. Requiring it back would
    // force a copy of exactly what `link-adjacency.ts` holds once, and `one-definition-of-a-link-class` is
    // what pins the contents of that class.
    assert.match(scan, /linksToAny\(mid, cls, frontier\)/,
      'the link is the class read against the frontier — that is the inbound edge this ask is about');
    assert.match(scan, /\$\{mid\}_\$\{cls\.collection\}/,
      'the collection name must come from the class, or this scan knows a name the class does not');
  });

  it('an explicit edgeLabels filter excludes a link unless it names the label', () => {
    // Without this, asking for one label would quietly return chrono entries as well — and a filter that
    // cannot exclude something is not a filter.
    const body = bodyOf(scan, 'labelWanted');
    assert.match(body, /edgeLabels\.includes\(cls\.label\)/,
      'an explicit filter must be able to exclude a link by name');
    assert.match(body, /length === 0/, 'an empty filter must still mean every label, as it always did');
  });

  it('marks the linked node and leaves entity nodes untouched', () => {
    assert.match(code, /kind: rec\.kind/, 'a caller following `_id` must know which collection to look in');
    /*
     * The ENTITY node must carry no `kind` — its absence is the contract, and it is what keeps every
     * response this product has ever given byte-identical.
     *
     * Read from `neighbourNodes`, where both walks now build it. The window is the loop that writes an
     * entity into the map, bounded structurally rather than by a character count — a `+ N` slice spans
     * different lines on CRLF than on LF.
     */
    const at = nodes.indexOf('for (const e of entities)');
    assert.ok(at > -1, 'the entity loop is not where this gate expects it — re-anchor before trusting it');
    const entityWrite = blockAfter(nodes, at);
    assert.ok(entityWrite, 'could not find where an entity becomes a node — this gate is pinned to nothing');
    assert.match(entityWrite, /_id: String\(e\['_id'\]\)/, 'and it must be the entity write, not some other loop');
    assert.doesNotMatch(entityWrite, /kind:/,
      'an entity node must stay exactly as it was, so no existing response changes shape');
  });

  it('collects the links BEFORE the early break, and the break counts them', () => {
    /*
     * The defect this gate did not catch on its own: the BFS breaks out when a frontier yields no entity
     * neighbours, and the chrono lookup originally sat after that break — so an entity whose only link is a
     * timeline traversed to nothing, which is the reported scenario rather than an edge case. Behaviour
     * proved it; this pins the ordering that fixed it.
     *
     * Three collections until 3.6, one call now — which is also why the break condition can no longer be
     * right for chrono and wrong for files.
     */
    const breakLine = code.split('\n').find(l => l.includes('break;') && l.includes('newNeighborIds.length === 0'));
    assert.ok(breakLine, 'could not find the early break');
    // `records: linkedHere` since the scans began reporting whether they stopped reading — matched on the
    // BINDING rather than on `const linkedHere`, so destructuring more out of the same call does not read as
    // the scan having moved.
    const declaredAt = code.search(/\blinkedHere\b/);
    assert.ok(declaredAt > 0, 'could not find the link scan');
    assert.ok(code.indexOf(breakLine) > declaredAt, 'the links must be collected before the early break');
    assert.ok(breakLine.includes('linkedHere.length === 0'),
      'the break must count the links, or an entity whose only link is a timeline looks like a dead end');
  });

  /*
   * The emit loop, bounded by its own braces rather than by a character count. A fixed window spans different
   * LINES on CRLF than on CI's LF, and a window that can fall short of its subject is a gate that passes by
   * looking at less than it means to — which is what `gates-bound-their-subject-structurally` exists to refuse.
   */
  const emitLoop = () => {
    const at = code.indexOf('for (const rec of linkedHere)');
    assert.notEqual(at, -1, 'the link emit loop is gone — re-point this gate');
    return blockAfter(code, at, 'the linked-record emit loop');
  };

  it('does not expand FROM a linked node', () => {
    // A chrono links to entities, not to other chrono entries, so expanding one would only walk back to
    // entities already visited — spending depth to return nothing.
    assert.doesNotMatch(emitLoop(), /nextFrontier\.push/, 'a linked node must not join the next frontier');
  });

  it('honours the node limit like any other node', () => {
    assert.match(emitLoop(), /resultNodes\.length >= limit/,
      'linked nodes must count toward `limit`, or a timeline-heavy space blows past it');
  });

  it('gives every synthetic edge an id of its own, never the target node id', () => {
    // set-claim: the two traversal entry points by name, as anchors -- each is read for its own emit loop,
    // which is a per-function assertion.
    /*
     * REVERSED once already, because the rule it held was wrong in both halves.
     *
     * It asserted `_id: doc._id` on the rationale that "an invented edge id would 404 for anyone who looked
     * it up — the chrono's own id resolves". It does not: `getEdgeById` reads the edges collection and
     * nothing else, so the chrono's id 404s on every edge-lookup path the product has. The affordance was
     * never delivered.
     *
     * What WAS delivered was a collision. A graph library keeps one id namespace for nodes and edges, so the
     * synthetic edge and the node it points at were the same element — cytoscape drops the repeat silently,
     * and the links vanished from the graph view with nothing in the console.
     *
     * Checked in BOTH traversals. The old version anchored per link class, because the three emit loops could
     * be fixed one at a time; the classes are one loop now, and what can be fixed one at a time is the
     * standalone walk versus recall's expansion.
     */
    for (const name of ['traverseGraph', 'traverseFromSeeds']) {
      const body = bodyOf(code, name);
      assert.match(body, /syntheticEdgeId\(/,
        `the ${name} link hop must carry its own edge id — sharing the target node id makes a graph library `
        + 'drop the edge, and it resolves to nothing anyway');
      assert.doesNotMatch(body, /_id: (?:doc|rec\.doc)\._id, from:/,
        `${name} is reusing the target document id for the synthetic edge again`);
    }
  });

  it('the synthetic id cannot be mistaken for a stored one', () => {
    // Shaped `<label>:<from>:<to>` rather than a UUID, deliberately: there is no stored edge behind it, and
    // an id that looked real would invite the lookup that cannot work.
    // `bodyOf`, not a slice to the first `}` — the first one belongs to the label placeholder inside the
    // template literal, so a hand-cut window ends three characters into the thing it is checking.
    assert.match(bodyOf(code, 'syntheticEdgeId'), /\$\{label\}:\$\{from\}:\$\{to\}/,
      'the id must name its label and both endpoints, so two seeds linking to one target differ');
  });
});

describe('both surfaces take the same flag with the same default', () => {
  const rest = read('server/src/api/brain/search.ts');
  const mcp = read('server/src/mcp/tools/edge.ts');

  it('REST accepts includeChrono, defaults it ON, and validates its type', () => {
    // The three inclusion flags are now validated by one loop over an object of defaults, so the rejection
    // message is templated rather than spelled out per flag. What matters is unchanged: the flag is known,
    // its default is on, and a non-boolean is refused — coercing a string would make a "false" mean true.
    assert.match(rest, /includeChrono:\s*true/, 'includeChrono must still default to ON');
    assert.match(rest, /must be a boolean/, 'a non-boolean must be rejected, not coerced');
    assert.match(rest, /typeof raw !== 'boolean'|typeof includeChronoRaw !== 'boolean'/,
      'the type check must be a real typeof test');
  });

  it('MCP advertises it in the tool schema, so an agent can discover it', () => {
    assert.match(mcp, /includeChrono: \{ type: 'boolean', default: true/);
  });

  it('both default to ON — the defect was discoverability, not the absence of a flag', () => {
    for (const [name, src] of [['REST', rest], ['MCP', mcp]]) {
      assert.match(src, /includeChrono[^\n]*!== false|!== false/, `${name} must treat only an explicit false as opt-out`);
    }
  });
});
