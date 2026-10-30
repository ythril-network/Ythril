/**
 * An arriving copy that DIFFERS from the stored one at an equal seq is never a bare `skipped`, for every replicated family (Q-426, and the rule Q-324, Q-222
 * and Q-426 each made one family obey).
 *
 * ## What it holds, and why it is a gate
 *
 * `skipped` is the answer for "this instance is already current". For two copies at one version that say DIFFERENT things it is a lie that costs two
 * instances for ever: each keeps its own, nobody is told, and the space hash differs. Four tickets each found it in one family at a time (a fact, then an
 * entity, an edge and a chrono entry, then a file, then a link under another id). This gate asks it of EVERY family at once, over the real planner:
 *
 *  - a family that forks answers `forked` in BOTH hash orders (the arriving copy loses and forks; it wins, takes the parent slot and the stored copy forks),
 *    and the answer is backed by the plan: a fork row to write, and, when it wins, the swap;
 *  - file metadata answers `converged` when the arriving copy is the lower hash (a `fileSwaps` entry that replaces the stored row) and `divergenceKept` when
 *    it is the higher (nothing written, and said in the log by the door), in both orders;
 *  - a link at an equal seq whose endpoints differ is a link under an id that does not derive from them: the arriving underived copy answers `underivedId`.
 *
 * ## Derived, not listed
 *
 * The families are READ from `REPLICATED_FAMILIES` (`replicatedFixtureFamilies`, floor 6), and the kind each is asked as (forks, a file, a link) is read from
 * the planner (`FORKING_FAMILIES`) and the collection's name, so a seventh family has no case until one is added HERE: it fails, naming it, instead of being
 * passed over. What is asserted is the RULE ("never `skipped`, and the verdict is backed by the plan"), not a verdict per family.
 *
 * ## The one exemption, named
 *
 * A link ARRIVING under a derived id over a STORED row that holds the same id for other endpoints (a row an older release or a forged push left: its id does
 * not derive from what it says) is `skipped` today: the planner reads a stored link's seq and no more, so it cannot tell. It is the reverse of the case above,
 * unreachable by any writer here (a current writer always derives), and replacing such a row needs the swap machinery the forking kinds have. It is asserted
 * AS an exemption (`skipped`, and no other answer), so a planner that starts answering it differently makes this gate say so and the exemption is removed.
 *
 * ## Seen red
 *
 * On the base (993447fb6) the file cases answer `skipped`, in both orders. After the change, reverting the file tie branch by hand in the built planner makes
 * both file cases fail again.
 *
 * Run: node --test testing/standalone/an-equal-seq-divergence-is-never-a-bare-skip.test.js   (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { replicatedFixtureFamilies, deriveLinkIds } from './_seq-tie-families.mjs';
import { copyOf, copyBeating, splitByTie } from './_fork-kinds.mjs';
import { build } from './_push-door.mjs';

// The planner asks this instance's own identity (a file's convergence compares the author with it), so a config is loaded, with no database behind it.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-never-bare-skip-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = tmpDir;
fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
  instanceId: 'never-bare-skip-test', instanceLabel: 'test', tokens: [], networks: [], spaces: [{ id: 's', label: 'S', folders: [] }],
}, null, 2), { mode: 0o600 });

const SEQ = 5;
const ID = 'subject';
/** What an equal-seq divergence may be answered: it forks, it converges (one copy takes the slot), it is kept (this copy is the one the tie names) or it is refused by name. */
const NEVER_BARE = ['forked', 'converged', 'divergenceKept', 'underivedId'];

let planner, merkle, authored, FAMILIES, FORKING;

/** The planner over one stored copy and one arriving copy. */
function plan(family, stored, arriving) {
  const { collection } = family;
  const copy = { seq: stored.seq };
  if (FORKING.includes(collection)) Object.assign(copy, { bodyHash: authored.authoredContentHash(collection, stored), row: stored });
  if (collection === 'files') {
    Object.assign(copy, {
      author: stored.author, updatedAt: stored.updatedAt, row: stored,
      contentHash: merkle.fileContentHash(stored, planner.CONVERGE_BLANKED), fullContentHash: merkle.fileContentHash(stored),
    });
  }
  return planner.planArrivals([arriving], {
    kind: collection, door: 'push', stored: new Map([[stored._id, copy]]), tombstones: new Map(), deliveredBy: undefined,
  });
}

describe('an equal-seq divergence is never a bare skip', () => {
  before(async () => {
    (await import('../../server/dist/config/loader.js')).loadConfig();
    planner = await import('../../server/dist/sync/upsert-plan.js');
    merkle = await import('../../server/dist/brain/merkle.js');
    authored = await import('../../server/dist/sync/authored-content.js');
    const { linkIdFor } = await import('../../server/dist/brain/link-id.js');
    FAMILIES = await replicatedFixtureFamilies();
    deriveLinkIds(FAMILIES, linkIdFor);
    FORKING = [...planner.FORKING_FAMILIES];
  });

  it('every replicated family is asked, as the kind the planner says it is (floor: the six there are)', () => {
    assert.ok(FAMILIES.length >= 6, `only ${FAMILIES.length} replicated families`);
    assert.ok(FORKING.length >= 4, `only ${FORKING.length} forking families`);
    const unasked = FAMILIES.filter(f => !FORKING.includes(f.collection) && f.collection !== 'files' && f.collection !== 'links').map(f => f.payloadKey);
    assert.deepEqual(unasked, [], `replicated families with no equal-seq divergence case here: ${unasked} — add one, or the family can skip a divergence unseen`);
  });

  for (const order of ['wins', 'loses']) {
    it(`every family that forks: an arriving copy that ${order} the tie is forked, never skipped, and the plan holds what it says`, async () => {
      const failures = [];
      for (const family of FAMILIES.filter(f => FORKING.includes(f.collection))) {
        const c = family.collection;
        const stored0 = copyOf(c, 's', ID, SEQ, 'the stored body');
        const arriving = order === 'wins' ? await copyBeating(c, 's', ID, SEQ, stored0, 'the arriving body') : copyOf(c, 's', ID, SEQ, 'the arriving body');
        const stored = order === 'wins' ? stored0 : await copyBeating(c, 's', ID, SEQ, arriving, 'the stored body');
        const { parent } = await splitByTie(c, arriving, stored);
        if ((parent === arriving) !== (order === 'wins')) { failures.push(`${c}: fixture check: the arriving copy does not ${order === 'wins' ? 'win' : 'lose'} the tie`); continue; }
        const p = plan(family, stored, arriving);
        const verdict = p.verdicts[0];
        if (!NEVER_BARE.includes(verdict)) { failures.push(`${c}: answered ${JSON.stringify(verdict)} for two bodies at one seq`); continue; }
        if (verdict !== 'forked') failures.push(`${c}: answered ${verdict}, a forking family forks`);
        if (p.forks.length !== 1) failures.push(`${c}: said forked and plans ${p.forks.length} fork rows`);
        if (order === 'wins' && p.swaps.length !== 1) failures.push(`${c}: the arriving copy wins and plans ${p.swaps.length} parent swaps`);
        if (order === 'loses' && p.swaps.length !== 0) failures.push(`${c}: the arriving copy loses and plans a parent swap`);
      }
      assert.deepEqual(failures, [], `${failures.length} divergence(s):\n  ${failures.join('\n  ')}`);
    });
  }

  for (const order of ['wins', 'loses']) {
    it(`file metadata: an arriving copy that ${order} the tie is ${order === 'wins' ? 'swapped in' : 'kept out'}, never skipped, and the plan holds what it says`, () => {
      const family = FAMILIES.find(f => f.collection === 'files');
      assert.ok(family, 'no files family among the replicated families');
      const row = (description) => build.filemeta('s', 'notes/a.md', SEQ, { description, tags: ['t'] });
      const hash = (d) => merkle.fileContentHash(row(d));
      const [low, high] = hash('one description') < hash('the other description') ? ['one description', 'the other description'] : ['the other description', 'one description'];
      const [stored, arriving] = order === 'wins' ? [row(high), row(low)] : [row(low), row(high)];
      const p = plan(family, stored, arriving);
      const verdict = p.verdicts[0];
      assert.ok(NEVER_BARE.includes(verdict), `answered ${JSON.stringify(verdict)} for two file rows at one seq with other content`);
      if (order === 'wins') {
        assert.equal(verdict, 'converged');
        assert.equal(p.fileSwaps.length, 1, 'the arriving copy is the row and no swap is planned');
        assert.equal(p.fileSwaps[0].stored, stored, 'the swap does not name the stored row it displaces');
      } else {
        assert.equal(verdict, 'divergenceKept');
        assert.equal(p.fileSwaps.length, 0, 'a copy that loses plans a swap');
      }
      assert.equal(p.forks.length, 0, 'a file never forks');
      assert.equal(p.accepts.size, 0, 'a file tie is no ordinary accept: it is written under its own guard');
    });
  }

  it('file metadata that differs in nothing but the timestamp is not a divergence of content: it stays Q-419\'s (skipped unless its author delivers it)', () => {
    const family = FAMILIES.find(f => f.collection === 'files');
    const stored = build.filemeta('s', 'notes/a.md', SEQ, { description: 'same', updatedAt: '2026-10-01T00:00:00.000Z' });
    const arriving = build.filemeta('s', 'notes/a.md', SEQ, { description: 'same', updatedAt: '2026-10-05T00:00:00.000Z' });
    const p = plan(family, stored, arriving);
    assert.equal(p.verdicts[0], 'skipped', 'a relay chose the timestamp by choosing its hash');
    assert.equal(p.fileSwaps.length, 0);
  });

  it('links: a copy at an equal seq with other endpoints under an id that does not derive is refused by name', () => {
    const family = FAMILIES.find(f => f.collection === 'links');
    const stored = family.make('s', 'one', SEQ);
    const forged = { ...family.make('s', 'two', SEQ), _id: stored._id };
    const p = plan(family, stored, forged);
    assert.equal(p.verdicts[0], 'underivedId', 'an underived link is not refused');
  });

  it('the one exemption: a derived link arriving over a stored row that holds its id for other endpoints is skipped, and no other answer (see the docblock)', () => {
    const family = FAMILIES.find(f => f.collection === 'links');
    const arriving = family.make('s', 'one', SEQ);
    const stored = { ...family.make('s', 'two', SEQ), _id: arriving._id };
    const p = plan(family, stored, arriving);
    assert.equal(p.verdicts[0], 'skipped', 'the planner now answers this differently: remove the exemption, and assert the new answer is not skipped');
  });
});
