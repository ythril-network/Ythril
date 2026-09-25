/**
 * `completeLinkage` is a LOCAL setting on `SpaceConfig`, and nothing can put it to a vote.
 *
 * ## What the marker says, and why the answer differs per instance
 *
 * It says *"in this space, on THIS instance, every link is a link record"* — the conversion script sets it
 * when it has finished walking the arrays. `strictLinkage` is the flag one word away and it is the one this
 * was almost modelled on: that says every reference must RESOLVE, and it is a shared rule about what the
 * space MEANS, so a network votes on it and every peer ends up agreeing.
 *
 * This one is the opposite kind of fact. It is a statement about work that has been done on one disk.
 *
 * ## The trap, which is why this is a gate and not a comment
 *
 * **`SpaceMeta` crosses the wire.** A meta change in a networked space does not apply — it opens a
 * `meta_change` vote round (`spaces/meta-update.ts`, the `networkedIn.length > 0` branch), and
 * `proposedMetaFields` proposes EVERY key it is handed. So a `completeLinkage` living on `SpaceMeta` would
 * have been proposed by whichever instance ran the script first, carried by the vote, and applied on peers
 * that had converted nothing.
 *
 * What that costs is not a wrong flag. It is the refusal the flag arms in 2b: an array write refused on an
 * instance whose readers still have no records to read, so the writes stop and the reads answer empty. Every
 * peer would report a correctly-passed vote and a space that had gone quiet.
 *
 * `SpaceConfig` is where the local operational settings already live and they are labelled as such in the
 * type — `dupeRules`, `recordTtlDays`, `documentExtraction`, the four media levels. They are applied
 * immediately in `applySpaceMetaUpdate` **above** the vote branch, deliberately: a local setting sent on the
 * same request as a meta change must not be swallowed by the round the meta change opens.
 *
 * ## Why the `refine` is checked separately
 *
 * `UpdateSpaceBody` ends in a hand-written twelve-way `||` listing every field that counts as "you asked for
 * something". A field added to the schema and forgotten there is ACCEPTED by the parser and then refused by
 * the guard, with `At least one of ... must be provided` — a message naming a list the caller's field is not
 * on. That is the shape that costs an integrator an afternoon, because the body is right and the error says
 * it is empty.
 *
 * Run: node --test testing/standalone/the-conversion-marker-is-local-and-never-voted.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const MARKER = 'completeLinkage';
const code = (f) => stripComments(readFileSync(f, 'utf8'));

/** The block of a named `export interface`, brace-matched so a nested type does not end it early. */
function interfaceBody(src, name) {
  // `extends …` allowed: SpaceConfig takes its F-39.2 layering fields from `types-networks.ts`.
  const m = new RegExp(`export interface ${name}(?: extends [^{]+)? \\{`).exec(src);
  const at = m ? m.index : -1;
  assert.ok(at > 0, `${name} not found — re-anchor this gate`);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

describe('the conversion marker is local and never voted', () => {
  it('is declared on SpaceConfig', () => {
    const body = interfaceBody(code('server/src/config/types.ts'), 'SpaceConfig');
    assert.match(body, new RegExp(`\\b${MARKER}\\?:\\s*boolean`),
      `${MARKER} belongs on SpaceConfig, beside recordTtlDays and dupeRules — the settings that are local to`
      + ' one instance and never governed.');
  });

  it('is NOT on SpaceMeta, because meta is what a network votes on', () => {
    const body = interfaceBody(code('server/src/config/types-knowledge.ts'), 'SpaceMeta');
    assert.ok(!body.includes(MARKER),
      `${MARKER} is on SpaceMeta. Every meta key is handed to \`proposedMetaFields\` and carried by a`
      + '\n  `meta_change` round, so the first instance to run the conversion script would arm the marker on'
      + '\n  peers that have converted nothing — and in 2b that refuses their array writes while their readers'
      + '\n  still have no records. Move it to SpaceConfig.');
  });

  it('the meta merge does not know it either', () => {
    // `mergeSpaceMeta` handles the scalar meta fields one `if` per field. A line for this marker there would
    // mean a PATCH could route it into meta regardless of where the interface declares it.
    const src = code('server/src/spaces/meta-update.ts');
    const merge = src.slice(src.indexOf('export function mergeSpaceMeta'));
    const end = merge.indexOf('\nexport ', 1);
    assert.ok(!merge.slice(0, end > 0 ? end : merge.length).includes(MARKER),
      `mergeSpaceMeta folds ${MARKER} into the meta — it is not a meta field.`);
  });

  it('the update body accepts it AND the emptiness guard counts it', () => {
    const src = code('server/src/spaces/body-schemas.ts');
    const at = src.indexOf('export const UpdateSpaceBody');
    assert.ok(at > 0, 'UpdateSpaceBody not found — re-anchor');
    const decl = src.slice(at, src.indexOf(';', src.indexOf('.refine(', at)));

    assert.match(decl, new RegExp(`${MARKER}:\\s*z\\.boolean\\(\\)`), `UpdateSpaceBody must accept ${MARKER}`);

    /*
     * The half that gets forgotten, and it is checked against the LIST rather than against the guard text.
     *
     * `.refine` used to be a hand-written twelve-way `||` with the same twelve names repeated in the failure
     * message — one rule, two copies, and a field added to the schema and missed in either one parses fine
     * and is then refused as an empty body. They now both read `UPDATABLE`, so this asserts membership of
     * the one list; an earlier draft of this case matched `d.completeLinkage !== undefined` and would have
     * gone red on the extraction that made it unnecessary. A gate written against a spelling fails when the
     * spelling improves.
     */
    const list = src.slice(src.indexOf('const UPDATABLE'), src.indexOf('] as const', src.indexOf('const UPDATABLE')));
    assert.ok(list.includes(`'${MARKER}'`),
      `${MARKER} is missing from UPDATABLE, so a body containing only that field is refused with`
      + '\n  "At least one of ... must be provided" — a message naming a list the caller\'s field is not on.');
    const refine = decl.slice(decl.indexOf('.refine('));
    assert.ok(refine.includes('UPDATABLE'),
      'the emptiness guard has stopped deriving from UPDATABLE — it is a hand-written list again, and the'
      + '\n  message beside it is a second copy of it.');
  });

  it('is applied immediately, above the vote branch', () => {
    /*
     * Position is the assertion. `applySpaceMetaUpdate` applies the local settings first and then, if the
     * space is networked, opens a round instead of writing the meta. A local write placed after that branch
     * is skipped on exactly the instances the marker matters on.
     */
    const src = code('server/src/spaces/meta-update.ts');
    const fn = src.slice(src.indexOf('export async function applySpaceMetaUpdate'));
    const applied = fn.indexOf(MARKER);
    const vote = fn.indexOf('networkedIn.length > 0');
    assert.ok(applied > 0, `applySpaceMetaUpdate never writes ${MARKER} — the field is declared and inert.`);
    assert.ok(vote > 0, 'the vote branch moved — re-anchor this gate');
    assert.ok(applied < vote,
      `${MARKER} is written after the network-vote branch, so it is never applied in a networked space —`
      + '\n  the only kind of space where getting this wrong does damage.');
  });
});
