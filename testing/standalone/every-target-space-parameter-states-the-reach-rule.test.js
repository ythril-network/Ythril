/**
 * Every MCP `targetSpace` parameter carries the one description that states the reach rule (Q-440).
 *
 * ## What went wrong
 *
 * Twenty-four tool schemas each spelled "Required for proxy spaces: the member space to write to." by hand. Once the REST
 * docs promised that a proxy write lands only in a member the token can write, and that a member it cannot reach is
 * answered as a missing one, the MCP schemas - the text a caller reads while building arguments - still said nothing of it.
 * A description is the authoritative reference, and 24 copies is 24 places for it to be stale.
 *
 * ## The rule
 *
 * A tool that takes `targetSpace` takes its description from `TARGET_SPACE_DESCRIPTION` (mcp/tools/shared.ts), a tool
 * DESCRIPTION that mentions `targetSpace` carries that same text (the PARAMETERS bullet is `TARGET_SPACE_BULLET`, built from
 * it), and no tool source spells the old sentence again. The tools are DERIVED from the registry, never listed, and a FLOOR is asserted:
 * an empty derivation passes every loop written over it.
 *
 * Run: npm run build -w server && node --test testing/standalone/every-target-space-parameter-states-the-reach-rule.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { toolValidators } from './_validator-schemas.mjs';

const { TARGET_SPACE_DESCRIPTION } = await import('../../server/dist/mcp/tools/shared.js');

/**
 * The one tool whose `targetSpace` is not a write target: `ingest_status` READS a run and names the member that run wrote
 * into, so "the member this token can write" would be a false sentence there. A new exemption is a new reason in this map.
 */
const NOT_A_WRITE_TARGET = new Map([['ingest_status', 'it names the member an earlier ingest run wrote into, for a read']]);

const withTarget = toolValidators().filter(t => t.schema?.properties?.targetSpace);
const writeTargets = withTarget.filter(t => !NOT_A_WRITE_TARGET.has(t.tool.name));

describe('every MCP targetSpace parameter states the reach rule', () => {
  it('the registry derivation found the tools that take targetSpace', () => {
    assert.ok(writeTargets.length >= 20, `only ${writeTargets.length} tool(s) take a write targetSpace - the derivation reads nothing`);
    for (const name of NOT_A_WRITE_TARGET.keys()) {
      assert.ok(withTarget.some(t => t.tool.name === name), `${name} is exempt but no longer takes targetSpace - drop the exemption`);
    }
  });

  it('the shared sentence states the guarantee a caller relies on', () => {
    assert.match(TARGET_SPACE_DESCRIPTION, /proxy/);
    assert.match(TARGET_SPACE_DESCRIPTION, /can write/);
    assert.match(TARGET_SPACE_DESCRIPTION, /does not exist/);
  });

  it('every tool advertises exactly the shared description', () => {
    const own = writeTargets
      .filter(t => t.schema.properties.targetSpace.description !== TARGET_SPACE_DESCRIPTION)
      .map(t => `${t.door}: "${t.schema.properties.targetSpace.description}"`);
    assert.deepEqual(own, [], 'these tools describe targetSpace in their own words instead of TARGET_SPACE_DESCRIPTION');
  });

  it('every tool description that mentions targetSpace carries the shared text', () => {
    const mentioning = writeTargets.filter(t => t.tool.description.includes('targetSpace'));
    assert.ok(mentioning.length >= 10, `only ${mentioning.length} tool description(s) mention targetSpace - the derivation reads nothing`);
    const own = mentioning.filter(t => !t.tool.description.includes(TARGET_SPACE_DESCRIPTION)).map(t => t.door);
    assert.deepEqual(own, [], 'these tool descriptions say what targetSpace is in their own words instead of carrying TARGET_SPACE_DESCRIPTION');
  });

  it('no tool source spells the old per-tool sentence again', () => {
    const files = trackedSources(['server/src/mcp'], { floor: 20 });
    const spelled = files.filter(f => /Required for proxy spaces/.test(stripComments(readFileSync(`${REPO_ROOT}/${f}`, 'utf8'))));
    assert.deepEqual(spelled, [], 'these sources spell a hand-written targetSpace description');
  });
});
