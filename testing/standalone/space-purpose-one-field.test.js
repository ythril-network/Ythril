/**
 * A space's directive has ONE store — and as of 3.0, one NAME.
 *
 * ## The defect this started as
 *
 * `SpaceConfig.description` was commented "shown to MCP clients as space-level instructions".
 * `SpaceMeta.purpose` is "short directive injected into MCP instructions at handshake". Two fields, one
 * meaning — and they were served by different tools: `space_meta` returned `purpose`, `list_spaces`
 * returned `description`. They could say anything relative to each other.
 *
 * Then the settings UI gained an editor for `purpose` and never had one for `description`, so the field
 * every MCP client read became the one no admin could change. On the deployment that reported it: three
 * spaces returning `null`, three returning mojibake from an old import, and the purposes their admins had
 * written sitting invisible beside them.
 *
 * ## What 2.x did, and what 3.0 does
 *
 * 2.x made `purpose` the store and kept `description` as a DERIVED alias, because it was published API.
 * 3.0 removes the alias — announced at `docs/integration-guide/06-spaces-api.md` since 2.3, and the only
 * deprecation in `_DEPRECATIONS.md` that named a version in the published docs.
 *
 * **The boot migration stays.** It is what makes the removal safe: a `config.json` written by an older
 * build still carries a stored `description`, and dropping the migration with the alias would silently
 * discard the operator's directive on upgrade. It goes at row 3.1, once the version floor 3.0 supports
 * upgrading from is fixed.
 *
 * Run: node --test testing/standalone/space-purpose-one-field.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let migrateSpaceDescriptionToPurpose;
let spacePurpose;
let refuseRemovedDescription;
let spacesModule;

const space = (over = {}) => ({ id: 's', label: 'S', builtIn: false, folders: [], ...over });

describe('space purpose is one field', () => {
  before(async () => {
    ({ migrateSpaceDescriptionToPurpose } = await import('../../server/dist/config/loader.js'));
    spacesModule = await import('../../server/dist/spaces/spaces.js');
    ({ spacePurpose, refuseRemovedDescription } = spacesModule);
  });

  describe('the boot migration — kept, because it is what makes the removal safe', () => {
    it('moves a legacy description into an empty purpose', () => {
      const cfg = { spaces: [space({ description: 'Papers and findings.' })] };
      assert.equal(migrateSpaceDescriptionToPurpose(cfg), true);
      assert.equal(cfg.spaces[0].meta.purpose, 'Papers and findings.');
      assert.equal('description' in cfg.spaces[0], false, 'the legacy store must be gone, not shadowed');
    });

    it('never overwrites a purpose an operator already wrote', () => {
      // The purpose is the field the UI edits, so it is the more recent, deliberate value. Clobbering it
      // with legacy text would be a worse failure than dropping the legacy text.
      const cfg = { spaces: [space({ description: 'stale import', meta: { purpose: 'what we actually do' } })] };
      assert.equal(migrateSpaceDescriptionToPurpose(cfg), true);
      assert.equal(cfg.spaces[0].meta.purpose, 'what we actually do');
      assert.equal('description' in cfg.spaces[0], false);
    });

    it('drops an empty description without inventing a purpose', () => {
      const cfg = { spaces: [space({ description: '   ' })] };
      migrateSpaceDescriptionToPurpose(cfg);
      assert.equal(cfg.spaces[0].meta?.purpose, undefined);
    });

    it('is idempotent — the second boot changes nothing', () => {
      const cfg = { spaces: [space({ description: 'x' })] };
      assert.equal(migrateSpaceDescriptionToPurpose(cfg), true);
      assert.equal(migrateSpaceDescriptionToPurpose(cfg), false,
        'returning true again would rewrite config.json on every boot, forever');
    });

    it('preserves the rest of the meta', () => {
      const cfg = { spaces: [space({ description: 'x', meta: { validationMode: 'strict', version: 7 } })] };
      migrateSpaceDescriptionToPurpose(cfg);
      assert.equal(cfg.spaces[0].meta.validationMode, 'strict');
      assert.equal(cfg.spaces[0].meta.version, 7);
    });

    it('survives a config with no spaces at all', () => {
      assert.equal(migrateSpaceDescriptionToPurpose({}), false);
    });
  });

  describe('purpose is read from one place', () => {
    it('reads purpose', () => {
      assert.equal(spacePurpose({ meta: { purpose: 'the directive' } }), 'the directive');
    });

    it('is undefined rather than empty when there is no purpose', () => {
      assert.equal(spacePurpose({}), undefined);
      assert.equal(spacePurpose({ meta: {} }), undefined);
      assert.equal(spacePurpose({ meta: { purpose: '  ' } }), undefined,
        'whitespace is not a directive; returning it would show an empty box as if it were content');
    });
  });

  describe('the alias is gone, and its removal is LOUD', () => {
    it('the derivation helpers no longer exist', () => {
      // Exported helpers are the shape a caller inside this repo would reach for. Leaving them in place
      // "harmlessly" is how a removed field comes back on the next response someone shapes.
      assert.equal(spacesModule.spaceDescriptionAlias, undefined);
      assert.equal(spacesModule.spaceResponse, undefined);
    });

    it('a create or update still sending `description` is REFUSED, not ignored', () => {
      // The half that would otherwise be silent. The top-level space bodies are NOT `.strict()` — they
      // DROP an unknown key — so without this refusal a caller who kept sending `description` would get a
      // 200 with no directive written, while MCP's `additionalProperties: false` refused the same request.
      // One rule, two implementations, the weaker one winning silently: the defect class this repo
      // produces most.
      const refusal = refuseRemovedDescription({ description: 'still sending it' });
      assert.equal(refusal?.status, 400);
      assert.match(refusal.body.error, /meta\.purpose/,
        'a refusal that does not name the replacement makes the caller go and look it up');
    });

    it('refuses nothing else', () => {
      assert.equal(refuseRemovedDescription({ label: 'fine' }), undefined);
      assert.equal(refuseRemovedDescription({ meta: { purpose: 'fine' } }), undefined);
      assert.equal(refuseRemovedDescription(undefined), undefined);
      assert.equal(refuseRemovedDescription(null), undefined);
      // An array has no keys a caller meant as fields; `'description' in []` is false anyway, but a
      // future rewrite using `Object.keys` would change that silently.
      assert.equal(refuseRemovedDescription([]), undefined);
    });

    it('and `updateSpace` no longer has a `description` arm for it to fall through to', () => {
      /*
       * The dead half, found while auditing the boot migration for 4.0. `updateSpace` took a
       * `description?: string` and folded it into `meta.purpose` — correct when it was written, and
       * unreachable since `refuseRemovedDescription` went in front of both planners: all four callers pass
       * `meta`, and any request carrying the field 400s before it gets here.
       *
       * Two implementations of one rule, and the survivor is a fold that silently ACCEPTS what the refusal
       * exists to reject. Anyone calling `updateSpace` directly from inside the repo — which is what
       * `meta-update.ts` warns about in as many words — would have bypassed the refusal and written a
       * purpose from a removed field, with no test failing.
       */
      const strip = src => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const src = strip(readFileSync('server/src/spaces/spaces.ts', 'utf8'));
      const at = src.indexOf('export function updateSpace(');
      const fn = src.slice(at, src.indexOf('\n}', at));
      assert.ok(!/description/.test(fn),
        'updateSpace still reads `description`. The field is refused at both doors, so this arm can only be '
        + 'reached by an internal caller bypassing the refusal — which is the one path that must not accept it.');
    });

    it('BOTH planners refuse it, so neither door is the weaker one', () => {
      const strip = src => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const path of ['server/src/spaces/space-create.ts', 'server/src/spaces/meta-update.ts']) {
        assert.match(strip(readFileSync(path, 'utf8')), /refuseRemovedDescription\(body\)/,
          `${path} must refuse the removed field — MCP and REST both reach the store through these`);
      }
    });
  });

  describe('no surface accepts, stores or emits it', () => {
    const strip = src => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // Assert on a boolean, not `assert.match` over a whole file: a failing match prints the entire
    // source as `actual`, which buries the one line that matters under 30 kB of unrelated code.
    const has = (path, re) => re.test(strip(readFileSync(path, 'utf8')));

    it('list_spaces serves purpose and nothing else', () => {
      assert.ok(has('server/src/mcp/tools/spaces.ts', /purpose: spacePurpose\(s\)/),
        'list_spaces is the tool that disagreed with get_space_meta');
      assert.ok(!has('server/src/mcp/tools/spaces.ts', /description: spacePurpose\(s\)/),
        'the alias was removed from the tool output in 3.0');
    });

    it('update_space no longer takes the alias on its input schema', () => {
      const src = strip(readFileSync('server/src/mcp/tools/spaces.ts', 'utf8'));
      assert.ok(!/description: \{ type: 'string', maxLength: SPACE_PURPOSE_MAX/.test(src),
        'the tool schema is what a caller reads while constructing arguments');
      assert.ok(/updates\.meta = \{ purpose: newDesc \}/.test(src),
        'the handler must speak meta.purpose — the planner no longer folds the old spelling in');
    });

    it('the request bodies do not declare it', () => {
      const src = strip(readFileSync('server/src/spaces/body-schemas.ts', 'utf8'));
      assert.ok(!/^\s*description: z\.string\(\)\.max\(SPACE_PURPOSE_MAX\)/m.test(src),
        'CreateSpaceBody and UpdateSpaceBody both carried it');
    });

    it('no space response shapes it back in', () => {
      const src = strip(readFileSync('server/src/api/spaces.ts', 'utf8'));
      assert.ok(!/spaceDescriptionAlias|spaceResponse/.test(src),
        'the shaper existed only to add the alias');
      const assigned = [...src.matchAll(/description:\s*([^,\n]{1,24})/g)].map(m => m[1].trim());
      assert.deepEqual(assigned.filter(v => !v.startsWith('z.')), [],
        'a space response must not carry a description under any derivation');
    });

    it('the settings dialog handles the 202 a governed space answers with', () => {
      // Typed as `{ space: Space }` unconditionally, the 202 body destructured to undefined and threw
      // inside `next` — which RxJS does not route to `error`. Save did nothing, said nothing, and left
      // the editor dirty, so closing it offered to discard a change that had just been submitted.
      const POPUP = 'client/src/app/pages/settings/space-settings-popup.component.ts';
      assert.ok(has(POPUP, /result\.status === 'vote_pending'/),
        'the save handler must branch on the vote-pending response');
      assert.ok(!has(POPUP, /next: \(\{ space \}\)/),
        'destructuring `space` off a 202 body is the defect');
    });
  });
});
