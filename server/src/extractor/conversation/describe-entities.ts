/**
 * Phase 4.10 of the conversation extractor — an entity's description, written from its own claims (`F-31`,
 * DECOMPOSITION.md 4.10).
 *
 * Written ONCE per entity at the end, from the claims that name it (`linkClaims`), so it reads as one account
 * rather than a pile of amendments made turn by turn. The writer is handed those claims and nothing else — every
 * fact in a description then has a claim behind it.
 *
 * Checked like a claim for conversation structure (turn and session references, `lintClaim`) and for a named
 * subject; one rewrite with the failure named, then the entity's first claim is used as-is. The format requires
 * every entity to be described, and a plain description quoted from a claim is better than an invented one.
 * An entity no claim names — a speaker who only said *"hi"* — is described by its name and type, without asking.
 */
import { lintClaim } from './claims.js';

const SYSTEM = [
  'Describe the entity in one to three sentences, using ONLY the claims given.',
  '- Start with its name. Say what it is, then what is known about it.',
  '- Keep the dates exactly as written; add nothing the claims do not say.',
  '- Never mention the conversation itself: no turns, messages or sessions.',
  'Reply with the description only.',
].join('\n');

export async function describeEntities(
  entities: { id: string; name: string; type: string }[],
  claims: { text: string; entityIds: string[] }[],
  write: (prompt: { system: string; user: string }) => Promise<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const e of entities) {
    const own = claims.filter(c => c.entityIds.includes(e.id)).map(c => c.text);
    if (!own.length) { out.set(e.id, `${e.name} (${e.type}).`); continue; }
    const brief = [`Entity: ${e.name} (${e.type}).`, 'Claims:', ...own.map(t => `- ${t}`)].join('\n');
    let failure = '';
    let text = '';
    for (let attempt = 1; attempt <= 2 && !text; attempt++) {
      const got = (await write({ system: SYSTEM, user: failure ? `${brief}\n\nYour previous attempt was refused: ${failure}\nWrite it again.` : brief })).trim();
      const problems = lintClaim(got, {});
      if (!got) failure = 'it was empty';
      else if (problems.length) failure = `"${got}" — ${problems.join('; ')}`;
      else text = got;
    }
    out.set(e.id, text || own[0]!);
  }
  return out;
}
