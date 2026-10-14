/**
 * Every key of `SpaceMeta` is either accepted by the body that writes it or owned by the server, with a reason (`Q-217`).
 *
 * ## What was found
 *
 * `brain/stamp-skew.ts` reads `meta.stampSkew`, the `SpaceMeta` interface declares it, `docs/integration-guide/04f-write-semantics.md`
 * says it is writable — and `SpaceMetaBody`, which is `.strict()`, did not list it. So no caller could set it by any door except a
 * hand-edited `config.json`, and a peer layer carrying it was refused WHOLE by `mergeReplicatedMeta`. Nothing said so: the field was
 * declared on the type, read by the server and documented, and each of those is somebody's authoritative source.
 *
 * ## The rule this holds
 *
 * Every key of the `SpaceMeta` interface is, in the body that writes a meta, EITHER a key the body accepts (so every door can set it) OR
 * server-owned (`SERVER_OWNED_META_FIELDS`: written by the server, stripped from an incoming meta) — and a server-owned key says why.
 * The sets are derived: the interface from the source, the body from `SpaceMetaBody.shape`, the owned list from its export. A key
 * added to the interface is then decided by whoever adds it, in this file, on the commit that adds it.
 *
 * ## And the places a settable key is told about
 *
 * `stampSkew` is the instance; the rule it stands for is general, so the doors are asserted for EVERY body key rather than for it:
 * `schema_update` declares each (it forwards exactly what its schema declares), `save_space`'s `meta` description names each, and the
 * field-rights table prices each. `stampSkew` additionally appears in the audit change list, which is a hand allowlist on purpose.
 *
 * Run: node --test testing/standalone/every-space-meta-field-is-accepted-or-server-owned.test.js
 * (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { parseSource, ts } from '../_shared/syntax-tree.mjs';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';

const dir = tempInstanceDir('ythril-meta-fields-');

/** Why each server-owned key is not settable by a caller. A server-owned key with no row fails; so does a row for a key that is no longer owned. */
const OWNED_BECAUSE = {
  version: 'a counter the server increments on every meta write; a caller-set value would break the If-Match precondition',
  updatedAt: 'the time of the last meta write, stamped by the server',
  previousVersions: 'the capped history of earlier metas, kept by updateSpace; a caller cannot rewrite history',
};

/** The members of an interface declared in `file`, read from the source. */
function interfaceKeys(file, name) {
  const sf = parseSource(file, stripComments(readFileSync(join(REPO_ROOT, file), 'utf8')));
  let keys = null;
  sf.forEachChild(function visit(node) {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      keys = node.members.filter(m => m.name).map(m => m.name.getText(sf).replace(/^['"]|['"]$/g, ''));
      return;
    }
    ts.forEachChild(node, visit);
  });
  assert.ok(keys, `${file} no longer declares interface ${name} — re-anchor this gate`);
  return keys;
}

describe('every SpaceMeta key is accepted by the body or owned by the server', () => {
  let SpaceMetaBody, SERVER_OWNED, bodyKeys, interfaceMetaKeys, inst;
  before(async () => {
    ({ SpaceMetaBody, SERVER_OWNED_META_FIELDS: SERVER_OWNED } = await import('../../server/dist/spaces/body-schemas.js'));
    bodyKeys = Object.keys(SpaceMetaBody.shape);
    interfaceMetaKeys = interfaceKeys('server/src/config/types-knowledge.ts', 'SpaceMeta');
    inst = await bootSchemaInstance(dir, { spaces: [{ id: 'sch', label: 'Schema', folders: [], meta: { validationMode: 'strict' } }] });
  });
  after(() => inst?.close());

  it('the scan found the interface and the body (a scan of nothing would pass)', () => {
    assert.ok(interfaceMetaKeys.length >= 8, `only ${interfaceMetaKeys.length} keys read from interface SpaceMeta`);
    assert.ok(bodyKeys.length >= 6, `only ${bodyKeys.length} keys read from SpaceMetaBody`);
  });

  it('every key of the interface is accepted by SpaceMetaBody or is server-owned', () => {
    const neither = interfaceMetaKeys.filter(k => !bodyKeys.includes(k) && !SERVER_OWNED.includes(k));
    assert.deepEqual(neither, [],
      `SpaceMeta declares ${neither.join(', ')}, which SpaceMetaBody (strict) does not accept and the server does not own. The server reads it, `
      + 'the type declares it and the docs may call it writable, yet no door can set it and a peer layer carrying it is refused whole.');
  });

  it('every server-owned key the interface declares says why a caller may not set it, and no reason outlives its key', () => {
    const owned = interfaceMetaKeys.filter(k => SERVER_OWNED.includes(k));
    assert.ok(owned.length >= 3, `only ${owned.length} owned keys found on the interface`);
    assert.deepEqual(owned.filter(k => !(k in OWNED_BECAUSE)), [], 'a server-owned key has no reason here: say why a caller may not set it');
    assert.deepEqual(Object.keys(OWNED_BECAUSE).filter(k => !owned.includes(k)), [], 'a reason names a key that is no longer on the interface or no longer owned');
  });

  it('every meta key the server READS is one of those (the scan reads the source, not the interface)', () => {
    const reads = new Map();
    for (const file of trackedSources('server/src', { floor: 300 })) {
      const src = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
      for (const m of src.matchAll(/\bmeta\??\.([A-Za-z_]\w*)/g)) {
        if (!interfaceMetaKeys.includes(m[1])) continue;
        (reads.get(m[1]) ?? reads.set(m[1], []).get(m[1])).push(file);
      }
    }
    assert.ok(reads.size >= 5, `only ${reads.size} distinct meta keys read in server/src — the pattern has lost its subjects`);
    assert.ok(reads.has('stampSkew'), 'the read of meta.stampSkew (brain/stamp-skew.ts) was not found: the scan is looking in the wrong place');
    const unreachable = [...reads.keys()].filter(k => !bodyKeys.includes(k) && !SERVER_OWNED.includes(k));
    assert.deepEqual(unreachable, [],
      `the server reads ${unreachable.join(', ')} from a space's meta, and no door can set it (SpaceMetaBody refuses it; it is not server-owned)`);
  });

  describe('every settable key is told about wherever a meta is written', () => {
    /**
     * Keys a caller is meant to set on a meta: the interface's, from the source (a key the body has not heard of yet is still one the
     * doors owe), less the server's own and `purpose`, which MCP writes through `update_space` and not `schema_update`.
     */
    const settable = () => interfaceMetaKeys.filter(k => !SERVER_OWNED.includes(k) && k !== 'purpose');

    it('schema_update declares every settable key (it forwards exactly what its schema declares)', async () => {
      const { schema_updateTool } = await import('../../server/dist/mcp/tools/spaces.js');
      const declared = Object.keys(schema_updateTool.inputSchema({ requiredSpace: { type: 'string' } }).properties);
      assert.deepEqual(settable().filter(k => !declared.includes(k)), [], 'schema_update does not declare these meta keys, so an agent cannot set them');
    });

    it('save_space names every settable key in its meta description', async () => {
      const { save_spaceTool } = await import('../../server/dist/mcp/tools/spaces.js');
      const text = save_spaceTool.inputSchema({ requiredSpace: { type: 'string' } }).properties.meta.description;
      assert.deepEqual(settable().filter(k => !new RegExp(`\\b${k}\\b`).test(text)), [],
        `save_space's meta description (${text.slice(0, 160)}…) omits keys the body accepts: the description is what a caller reads while building arguments`);
    });

    it('the field-rights table prices every settable meta key', async () => {
      const { SPACE_FIELD_RIGHTS } = await import('../../server/dist/auth/space-field-rights.js');
      const priced = [...settable(), 'purpose'];
      assert.deepEqual(priced.filter(k => !(`meta.${k}` in SPACE_FIELD_RIGHTS)), [], 'a settable meta key has no row in SPACE_FIELD_RIGHTS: the route would allow it ungoverned');
    });

    it('stampSkew is a schema-area write, and its changes are audited', async () => {
      const { SPACE_FIELD_RIGHTS } = await import('../../server/dist/auth/space-field-rights.js');
      const right = SPACE_FIELD_RIGHTS['meta.stampSkew'];
      assert.ok(right && right.area === 'schema', `meta.stampSkew is priced ${JSON.stringify(right)}: it changes what a space's records are checked against, which is the schema area's`);
      const { AUDIT_CHANGE_FIELDS } = await import('../../server/dist/audit/audit-changes.js');
      assert.ok(AUDIT_CHANGE_FIELDS['space.update'].some(f => /^stampSkew/.test(f)),
        'space.update records no change to stampSkew: an operator who switched the check off (warnMinutes 0) leaves no trace');
    });

    it('the PATCH planner accepts stampSkew and keeps it in the merged meta', async () => {
      const { planSpaceMetaUpdate } = await import('../../server/dist/spaces/meta-update.js');
      const space = inst.loader.getConfig().spaces.find(s => s.id === 'sch');
      const stampSkew = { warnMinutes: 5, properties: ['stampedAt'] };
      const decision = planSpaceMetaUpdate({ spaceId: 'sch', space, body: { meta: { stampSkew } }, ifMatch: undefined });
      assert.equal(decision.ok, true, `PATCH refused meta.stampSkew: ${String(JSON.stringify(decision.refusal?.body)).slice(0, 300)}`);
      assert.deepEqual(decision.plan.mergedMeta.stampSkew, stampSkew, 'the merged meta dropped stampSkew');
    });
  });
});
