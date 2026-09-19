/**
 * Join an extraction delivered in several parts back into one file.
 *
 * ## Why an extraction ever arrives in parts
 *
 * Not because the conversation is too long to READ. Measured from the pinned `longmemeval_s`: a history is
 * 39–66 sessions (median 50) and 396–616 turns (median 492) — about 140k tokens, which any long-context
 * model reads in one pass. The tracker's *"a history runs to 500 sessions"* was two mistakes at once: 500
 * is the number of INSTANCES, and the 500-sessions figure belongs to `longmemeval_m`, which is not pinned.
 *
 * **The OUTPUT is the constraint.** `conv-26` is 419 turns and its committed extraction is 133 KB; a median
 * LongMemEval history is 17% longer, so roughly 45k tokens of JSON in one reply. That fits inside a couple
 * of frontier models and nothing else — and this prompt is written to be model-portable, which is a
 * property it loses entirely if the protocol needs a 64k output cap.
 *
 * ## What this module exists to make impossible
 *
 * **A missing part.** Concatenating the arrays of three files when there were four produces an extraction
 * that is structurally perfect and describes three-quarters of a conversation: every type is declared,
 * every key resolves, every date parses, the validator passes, the writer writes. The hole surfaces later
 * as a question that returns nothing, which reads as a retrieval failure rather than as a lost file.
 *
 * Nothing else in the pipeline can see it, because absence leaves no evidence anywhere else. So a part
 * declares its place and this refuses anything but a complete run — that check is the whole reason a merge
 * is a module instead of a spread.
 *
 * ## And identity across the seam
 *
 * *"Identity is the whole job."* A mention in session 3 and one in session 40 must be one node, so a part
 * after the first is given the entities already minted and reuses their keys. Reconciling by key here is
 * what makes that safe to rely on — and a key that comes back with a different TYPE is refused rather than
 * resolved, because whichever side won, the edges the other part drew now run to the wrong kind of thing.
 */

/** Fields whose values ACCUMULATE across parts rather than being replaced by the last one seen. */
const UNION_FIELDS = ['sourceTurns'];

function mergeEntity(prior, next, problems) {
  if (prior.type !== next.type) {
    problems.push(`entity '${next.key}' is a '${prior.type}' in an earlier part and a '${next.type}' in a `
      + 'later one. One of the two parts misread the subject, and resolving it either way leaves the edges '
      + 'the other part drew running to the wrong kind of thing.');
    return prior;
  }
  /*
   * LAST WINS on the scalar fields, and that is not arbitrary: an entity's description is written from the
   * whole conversation and updated as it goes, so the part that saw more of it holds the better sentence.
   */
  const out = { ...prior, ...next };
  for (const f of UNION_FIELDS) {
    const all = [...(prior[f] ?? []), ...(next[f] ?? [])];
    if (all.length > 0) out[f] = [...new Set(all)];
  }
  // `aliases` is a comma-separated string rather than an array — the shape the schema declares — so it is
  // unioned by value rather than by element, and a part that learned a new variant must not lose the old.
  const aliases = [prior.properties?.aliases, next.properties?.aliases]
    .filter(Boolean).join(', ').split(',').map(a => a.trim()).filter(Boolean);
  if (aliases.length > 0) {
    out.properties = { ...prior.properties, ...next.properties, aliases: [...new Set(aliases)].join(', ') };
  }
  return out;
}

/**
 * @param {object[]} parts  extraction files, each optionally carrying `part: {index, of}`
 * @returns {object} one extraction, with no `part` block
 * @throws when the run is incomplete, inconsistent, or two records claim one key
 */
export function mergeExtractionParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('no parts to merge — an empty run is an extraction of nothing, not an empty conversation');
  }

  /*
   * A single part declaring nothing is a WHOLE extraction, returned untouched. Every LoCoMo file is one,
   * and making the short case carry the long case's protocol would be a migration of ten committed files
   * in exchange for nothing.
   */
  if (parts.length === 1 && parts[0].part === undefined) return parts[0];

  const problems = [];
  const seen = new Map();
  let total;
  for (const p of parts) {
    const at = p.part;
    if (!at || typeof at.index !== 'number' || typeof at.of !== 'number') {
      problems.push('a part does not declare `part: {index, of}`, so a missing part could not be detected');
      continue;
    }
    if (total === undefined) total = at.of;
    else if (total !== at.of) {
      problems.push(`the parts disagree about how many there are: one says of ${total}, another of ${at.of}. `
        + 'Two runs of the same conversation spliced together is the only way that happens, and the counts '
        + 'are the only evidence of it.');
    }
    if (seen.has(at.index)) problems.push(`part ${at.index} appears twice`);
    seen.set(at.index, p);
  }
  for (let i = 1; i <= (total ?? 0); i++) {
    if (!seen.has(i)) problems.push(`part ${i} of ${total} is missing — a merge without it would be a `
      + 'structurally perfect extraction of part of a conversation, and nothing downstream can see the hole');
  }

  const ordered = [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
  const conversationId = ordered[0]?.conversationId;
  for (const p of ordered) {
    if (p.conversationId !== conversationId) {
      problems.push(`a part says conversationId '${p.conversationId}' where the first says `
        + `'${conversationId}' — these are parts of different conversations`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));

  const out = { conversationId, sessions: [], entities: [], chrono: [], edges: [], claims: [] };
  const entityAt = new Map();
  /*
   * ONE NAMESPACE, checked here as well as in the validator — and the duplication is the point rather than
   * an oversight. The validator sees the MERGED file, where a key reused across two parts has already
   * become one record or two indistinguishable ones; this sees the seam, which is exactly where a model
   * forgets what it minted forty sessions ago. The message can therefore say which part.
   */
  const keyPart = new Map();
  const claimOrChronoKey = (key, kind, index) => {
    const prior = keyPart.get(key);
    if (prior) {
      problems.push(`part ${index} defines the ${kind} key '${key}', which part ${prior.index} already `
        + `used for a ${prior.kind}. One key names one record.`);
      return;
    }
    keyPart.set(key, { index, kind });
  };

  for (const p of ordered) {
    const index = p.part?.index ?? 1;
    out.sessions.push(...(p.sessions ?? []));
    for (const c of p.chrono ?? []) { claimOrChronoKey(c.key, 'chrono', index); out.chrono.push(c); }
    for (const c of p.claims ?? []) { if (c.key !== undefined) claimOrChronoKey(c.key, 'claim', index); out.claims.push(c); }
    out.edges.push(...(p.edges ?? []));
    for (const e of p.entities ?? []) {
      const at = entityAt.get(e.key);
      if (at === undefined) { entityAt.set(e.key, out.entities.length); out.entities.push(e); continue; }
      out.entities[at] = mergeEntity(out.entities[at], e, problems);
    }
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return out;
}
