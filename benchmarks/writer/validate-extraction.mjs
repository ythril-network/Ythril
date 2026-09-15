/**
 * Check an extraction file against the schema before anything is written.
 *
 * ## Why this runs first, and all at once
 *
 * The writer makes hundreds of requests per conversation. A type the schema does not declare, or an edge
 * drawn between the wrong kinds of thing, is a 400 from the instance — but it arrives on request 340, after
 * 339 records are already stored. What is left is a space holding most of a conversation, which is worse than
 * an empty one: it is interpretable, it is wrong, and nothing about it says so.
 *
 * So every problem in the file is found before the first write, and they are ALL reported rather than the
 * first one. A validator that stops at the first error turns one bad extraction into a dozen round trips
 * through a model.
 *
 * ## What it checks that the instance cannot
 *
 * Keys. An extraction refers to its own records by a local `key`, because it is written before anything has
 * an id. A claim naming a key nothing defines is a link that will simply be absent — the instance sees a
 * valid record with one fewer link and stores it happily. That is the quiet half of this file's job, and it
 * is the half that would otherwise be found by a benchmark score being mysteriously low.
 */

/**
 * Does this text open with `<the speaker's name>:` — the shape of a transcript line?
 *
 * Compared against the claim's OWN speaker rather than pattern-matched. A pattern for "a short capitalised
 * word then a colon" also flags *"Ada named three reasons: pay, people and place"*, which is a perfectly
 * good fact — and a validator that refuses good input is one people learn to work around.
 */
function startsWithSpeakerName(text, speaker) {
  const name = String(speaker ?? '').trim();
  if (!name) return false;
  return String(text ?? '').trimStart().toLowerCase().startsWith(`${name.toLowerCase()}:`);
}

/**
 * The share of a conversation one synthesised record may name as its provenance.
 *
 * A few sentences about a subject cannot have been derived from most of a transcript. Beyond this the
 * record is a summary of the conversation rather than of a subject, which is the padding cheat with a
 * graph drawn round it.
 */
const MAX_SYNTHESISED_PROVENANCE_SHARE = 0.12;

/** `YYYY-MM-DD`, and nothing looser. A partial date cannot be compared and a relative one cannot be resolved. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {object} extraction  the parsed extraction file
 * @param {Array<object>} schemaEntries  the parsed `space/schema.json`
 * @returns {string[]} every problem found, empty when the file is writable
 */
export function validateExtraction(extraction, schemaEntries) {
  const problems = [];
  const say = m => problems.push(m);

  if (!extraction || typeof extraction !== 'object') return ['the extraction is not an object'];

  const typesOf = kind => new Set(schemaEntries.filter(e => e.knowledgeType === kind).map(e => e.typeName));
  const entityTypes = typesOf('entity');
  const chronoTypes = typesOf('chrono');
  const claimTypes = typesOf('memory');
  const edgeDefs = new Map(schemaEntries.filter(e => e.knowledgeType === 'edge')
    .map(e => [e.typeName, e.schema.endpoints]));

  // The floor. A schema that loaded as nothing would make every check below vacuous and the file would
  // "validate" into a space that declares nothing and therefore validates nothing itself.
  if (entityTypes.size === 0 || edgeDefs.size === 0 || claimTypes.size === 0) {
    return ['the schema loaded with no entity types, no edge labels or no claim type — check space/schema.json'];
  }

  const entities = extraction.entities ?? [];
  const edges = extraction.edges ?? [];
  const chrono = extraction.chrono ?? [];
  const claims = extraction.claims ?? [];
  const sessions = extraction.sessions ?? [];

  if (claims.length === 0) say('no claims: an extraction with nothing said stores nothing a question can match');
  if (sessions.length === 0) say('no sessions: there is no date to anchor anything to');

  /* ── keys, and what type each one names ────────────────────────────────────────────────────────────── */

  const entityType = new Map();
  for (const [i, e] of entities.entries()) {
    const at = `entities[${i}]`;
    if (!e.key) { say(`${at} has no key`); continue; }
    if (entityType.has(e.key)) say(`${at} redefines the key '${e.key}'`);
    if (!e.name) say(`${at} ('${e.key}') has no name`);
    if (!entityTypes.has(e.type)) say(`${at} ('${e.key}') has type '${e.type}', which the schema does not declare`);
    // An entity is where facts about a subject accumulate, and it is the natural hub for a question about
    // that subject — but only if there is something in it. `Luna, animal, cat` embeds as three words and
    // loses every search it takes part in, which is what makes a bare-name entity worse than no entity: it
    // occupies a ranked slot and answers nothing.
    if (!String(e.description ?? '').trim()) {
      say(`${at} ('${e.key}') has no description. A bare name is a tag, not something a question can match.`);
    }
    entityType.set(e.key, e.type);
  }

  const chronoKeys = new Set();
  for (const [i, c] of chrono.entries()) {
    const at = `chrono[${i}]`;
    if (!c.key) { say(`${at} has no key`); continue; }
    if (chronoKeys.has(c.key)) say(`${at} redefines the key '${c.key}'`);
    chronoKeys.add(c.key);
    if (!chronoTypes.has(c.type)) say(`${at} ('${c.key}') has type '${c.type}', which the schema does not declare`);
    if (!c.title) say(`${at} ('${c.key}') has no title`);
    if (!ISO_DATE.test(String(c.date ?? ''))) say(`${at} ('${c.key}') has date '${c.date}', which is not YYYY-MM-DD`);
    for (const k of c.entities ?? []) {
      if (!entityType.has(k)) say(`${at} ('${c.key}') links to the entity key '${k}', which nothing defines`);
    }
  }

  /* ── edges: the ends must be the kinds the label allows ────────────────────────────────────────────── */

  for (const [i, e] of edges.entries()) {
    const at = `edges[${i}]`;
    const def = edgeDefs.get(e.label);
    if (!def) { say(`${at} has label '${e.label}', which the schema does not declare`); continue; }
    for (const [end, key] of [['from', e.from], ['to', e.to]]) {
      if (!entityType.has(key)) { say(`${at} ('${e.label}') ${end} is '${key}', which no entity defines`); continue; }
      const allowed = def[end] ?? [];
      const actual = entityType.get(key);
      // An entity whose own type is undeclared has already been reported. Saying it a second time here, in
      // the words of a different rule, makes one mistake look like two and buries the root cause among its
      // consequences — a hub entity with a typo would produce a page of them.
      if (!entityTypes.has(actual)) continue;
      if (!allowed.includes(actual)) {
        // The instance would refuse this too, but only when it reached it. Said here so the whole file can
        // be fixed in one pass.
        say(`${at} ('${e.label}') ${end} is a '${actual}' and the label allows ${allowed.join(', ')}`);
      }
    }
    for (const [k, v] of Object.entries(e.properties ?? {})) {
      if ((k === 'since' || k === 'until') && !ISO_DATE.test(String(v))) {
        say(`${at} ('${e.label}') has ${k} '${v}', which is not YYYY-MM-DD`);
      }
    }
  }

  /* ── claims ────────────────────────────────────────────────────────────────────────────────────────── */

  for (const [i, c] of claims.entries()) {
    const at = `claims[${i}]`;
    if (!c.text) say(`${at} has no text`);
    /*
     * A claim is a resolved fact, not a line of the transcript.
     *
     * `Caroline: I went to a support group yesterday` names nobody a search can find and dates nothing — an
     * embedding sees those words and no context. The fact is `Caroline attended an LGBTQ support group on 7
     * May 2023`. Storing the line instead produces a graph that retrieves exactly as well as the raw
     * transcript, which is what this whole layer exists to beat.
     *
     * The leading `Speaker: ` is the tell, and it is the one part of this that a machine can see. Whether the
     * rest of the sentence stands on its own is the writer's job.
     */
    if (startsWithSpeakerName(c.text, c.speaker)) {
      say(`${at} starts with a speaker prefix, so it is a transcript line rather than a resolved fact. `
        + 'The verbatim words belong in the session transcript; a claim says what is true.');
    }
    if (!c.speaker) say(`${at} has no speaker — a claim nobody can attribute is not auditable`);
    if (!ISO_DATE.test(String(c.statedOn ?? ''))) say(`${at} has statedOn '${c.statedOn}', which is not YYYY-MM-DD`);
    if ((c.sourceTurns ?? []).length === 0) say(`${at} names no sourceTurns, so nothing can trace it to the transcript`);
    for (const k of c.entities ?? []) {
      if (!entityType.has(k)) say(`${at} links to the entity key '${k}', which nothing defines`);
    }
    for (const k of c.chrono ?? []) {
      if (!chronoKeys.has(k)) say(`${at} links to the chrono key '${k}', which nothing defines`);
    }
  }

  /* ── sessions ──────────────────────────────────────────────────────────────────────────────────────── */

  for (const [i, s] of sessions.entries()) {
    if (!ISO_DATE.test(String(s.date ?? ''))) say(`sessions[${i}] has date '${s.date}', which is not YYYY-MM-DD`);
  }

  /*
   * THE CLAIM LAYER IS COMPLETE, and this is the check that makes that a rule rather than advice.
   *
   * Measured, not assumed: an extraction that kept only the turns that seemed to say something covered 34.6%
   * of a conversation and scored WORSE on every measure than storing the raw turns and nothing else. Two
   * thirds of what was said was gone, so no question about it could be answered from any structure built on
   * top — and nothing in the graph looked wrong. It had entities, edges, dates and links; it was simply
   * missing most of the conversation.
   *
   * Only checkable when the sessions carry their turn ids. A file without them is not refused — the writer
   * has no transcript to compare against and inventing a failure there would block a legitimate caller who
   * is not running a benchmark.
   */
  /*
   * A SYNTHESISED RECORD MAY NOT CLAIM MOST OF THE CONVERSATION.
   *
   * An entity's description says what the conversation established about a subject, and it carries the turns
   * that established it so the statement can be checked. That provenance is also what a benchmark credits —
   * which makes it the obvious place for the oldest cheat in retrieval to reappear: give one record the turns
   * of the whole transcript, match it once, and score everything.
   *
   * The line is what the description actually SAYS. Three sentences about a person cannot have been derived
   * from four hundred turns; they were derived from the handful that state those three sentences. A record
   * claiming more than this share is either over-claiming its provenance or is a summary of the conversation
   * wearing a subject's name, and both are refused.
   */
  const declaredTurns = sessions.flatMap(s => s.turns ?? []);
  if (declaredTurns.length > 0) {
    const ceiling = Math.max(4, Math.ceil(declaredTurns.length * MAX_SYNTHESISED_PROVENANCE_SHARE));
    for (const [kind, list] of [['entities', entities], ['chrono', chrono]]) {
      for (const [i, r] of list.entries()) {
        const n = (r.sourceTurns ?? []).length;
        if (n > ceiling) {
          say(`${kind}[${i}] ('${r.key}') claims ${n} source turns of ${declaredTurns.length}, over the `
            + `${ceiling} a synthesised record may claim. Either its provenance names turns its description `
            + 'does not use, or the description is a summary of the conversation rather than of a subject.');
        }
      }
    }
  }

  const declared = declaredTurns;
  if (declared.length > 0) {
    const covered = new Set(claims.flatMap(c => c.sourceTurns ?? []));
    const missing = declared.filter(t => !covered.has(t));
    if (missing.length > 0) {
      const shown = missing.slice(0, 8).join(', ');
      say(`${missing.length} of ${declared.length} turns are in no claim (${shown}${missing.length > 8 ? ', …' : ''}). `
        + 'The claim layer is complete or the conversation is partly missing, and a partly missing conversation '
        + 'looks exactly like a working graph.');
    }
  }

  return problems;
}

/**
 * The same check, as a throw.
 *
 * Every problem in the message, not the first — see the note at the top of this file.
 */
export function assertWritable(extraction, schemaEntries) {
  const problems = validateExtraction(extraction, schemaEntries);
  if (problems.length > 0) {
    throw new Error(`the extraction for '${extraction?.conversationId ?? '(unnamed)'}' cannot be written, `
      + `${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  }
}
