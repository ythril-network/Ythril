/**
 * The import's operations spool hands its operations back kind by kind, in the order the caller names, each kind in the order it arrived
 * (bundle-270 S5, amendment A1).
 *
 * ## The rule
 *
 * Committing in the order subjects come would land an edge or a link before the record it points at, and a strict-linkage space refuses that
 * after earlier windows have landed. So the import writes its operations into one spool per kind as it translates, and its commit pass reads
 * them in the store's order of kinds over the whole import. What it holds: operations appended in mixed order come back grouped by kind in the
 * order asked and, within a kind, in arrival order; a second session over the same folder (a resumed import) appends after the first; an order
 * that leaves out a kind the spool holds, or names one twice, is refused rather than dropping operations; a kind name that is no plain word is
 * refused; an operation with any string comes back equal; and a read sees every operation appended, closed or not.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spoolModule, tempFolder, cleanupFolders, refusalOf } from './_rdf-import-spool-doors.mjs';

after(cleanupFolders);

const ORDER = ['entity', 'chrono', 'fact', 'file', 'edge', 'link'];

async function spoolIn(label) {
  const { openImportFolder, openOperationSpool } = await spoolModule();
  assert.equal(typeof openOperationSpool, 'function', 'import-spool.ts exports no openOperationSpool');
  const folder = await openImportFolder(tempFolder(label));
  return { folder, ops: await openOperationSpool(folder), openOperationSpool };
}

async function readAll(ops, order) {
  const out = [];
  for await (const item of ops.read(order)) out.push(item);
  return out;
}

describe('the import operations come back by kind', () => {
  it('operations appended in mixed order come back grouped by kind in the order asked, each kind in arrival order', async () => {
    const { ops } = await spoolIn('mixed');
    const appended = [];
    const kinds = ['edge', 'entity', 'link', 'fact', 'entity', 'edge', 'chrono', 'entity', 'link', 'fact'];
    for (let i = 0; i < 300; i += 1) {
      const kind = kinds[(i * 7) % kinds.length];
      const op = { n: i, kind, text: `operation ${i}` };
      appended.push({ kind, op });
      await ops.append(kind, op);
    }
    await ops.close();
    const back = await readAll(ops, ORDER);
    const expected = ORDER.flatMap(k => appended.filter(a => a.kind === k));
    assert.deepEqual(back, expected);
    const reversed = [...ORDER].reverse();
    assert.deepEqual(await readAll(ops, reversed), reversed.flatMap(k => appended.filter(a => a.kind === k)), 'a second read in another order did not follow it');
  });

  it('a second session over the same folder appends after the first', async () => {
    const { folder, ops, openOperationSpool } = await spoolIn('resume');
    await ops.append('entity', { n: 1 });
    await ops.append('edge', { n: 2 });
    await ops.close();
    const again = await openOperationSpool(folder);
    await again.append('entity', { n: 3 });
    await again.append('edge', { n: 4 });
    await again.close();
    assert.deepEqual((await readAll(again, ['entity', 'edge'])).map(x => x.op.n), [1, 3, 2, 4]);
  });

  it('an order that leaves out a kind the spool holds, or names one twice, is refused; a kind with nothing yields nothing', async () => {
    const { ops } = await spoolIn('order');
    await ops.append('entity', { n: 1 });
    await ops.append('edge', { n: 2 });
    await ops.close();
    const left = await refusalOf(readAll(ops, ['entity']), 'an order without edge');
    assert.match(String(left?.message), /edge/, 'the refusal does not name the kind left out');
    await refusalOf(readAll(ops, ['entity', 'edge', 'entity']), 'an order naming entity twice');
    assert.deepEqual((await readAll(ops, ['fact', 'entity', 'edge'])).map(x => x.op.n), [1, 2]);
  });

  it('a kind name that is no plain word is refused', async () => {
    const { ops } = await spoolIn('names');
    for (const bad of ['../entity', 'Entity', 'en tity', '', 'a/b', 'x'.repeat(65)]) {
      await refusalOf(ops.append(bad, {}), `the kind name ${JSON.stringify(bad)}`);
    }
    await refusalOf(readAll(ops, ['../x']), 'an order naming a kind that is no plain word');
  });

  it('an operation with any string comes back equal, and a read sees what was appended before any close', async () => {
    const { ops } = await spoolIn('values');
    const op = { text: 'two\nlines\tand "quotes" \\ \u0000   \uD800', nested: [{ a: 1.5, b: null, c: true }], empty: '' };
    await ops.append('fact', op);
    await ops.append('fact', { n: 2 });
    assert.deepEqual(await readAll(ops, ['fact']), [{ kind: 'fact', op }, { kind: 'fact', op: { n: 2 } }]);
    await ops.append('fact', { n: 3 });
    assert.deepEqual((await readAll(ops, ['fact'])).length, 3, 'an operation appended after a read was lost');
  });
});
