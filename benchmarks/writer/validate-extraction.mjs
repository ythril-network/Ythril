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

/**
 * The share of a conversation's claims that may come from ONE turn.
 *
 * The inverse of the rule above, and it catches the opposite mistake. That one stops a record claiming most
 * of the transcript as its provenance; this one stops most of the claims coming out of a single turn.
 *
 * **It exists because people paste.** An article, a contract, a log — dropped into one turn and followed by
 * a question. Mining it yields dozens of claims about a subject nobody in the conversation is, all sharing
 * one `sourceTurns` entry, and the graph stops being about the people in it. The prompt says a pasted
 * document is material rather than assertion; this is the part that does not depend on the model having
 * read that.
 *
 * A legitimate turn is named by a handful of claims — the fact it states, plus the arc claims it takes
 * part in. A mined document is named by a quarter of the file. The gap between those is wide enough that
 * the exact share does not have to be argued about, which is why it is a share rather than a count: a
 * threshold in records would be wrong for a short conversation and meaningless for a long one.
 */
const MAX_CLAIMS_FROM_ONE_TURN_SHARE = 0.15;

/** `YYYY-MM-DD`, and nothing looser. A partial date cannot be compared and a relative one cannot be resolved. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A speaker who is an AI assistant rather than a person.
 *
 * Matched on the whole value rather than as a substring, because a person may be called Ai, and a corpus
 * whose participants are named is exactly where a loose pattern would start marking their claims as a
 * model's. LongMemEval writes the role as `assistant`; the others are what a transcript of a product
 * conversation tends to use for the same participant.
 */
const ASSISTANT_SPEAKER = /^\s*(assistant|ai|bot|chatbot|agent|model|system)\s*$/i;

/**
 * @param {object} extraction  the parsed extraction file
 * @param {Array<object>} schemaEntries  the parsed `space/schema.json`
 * @returns {string[]} every problem found, empty when the file is writable
 */
/**
 * The edge label that says one claim replaced another.
 *
 * A second copy of `SERVER_WRITTEN_EDGE_LABELS` in `server/src/spaces/schema-validation.ts`, and it is a
 * copy on purpose: this module runs in the benchmark harness, which must not depend on a server build
 * having happened. `an-extraction-is-checked-before-anything-is-written.test.js` reads both and compares
 * them, so the copy cannot drift without a gate failing — which is the only thing that makes a second copy
 * survivable.
 */
export const SUPERSEDES = 'supersedes';

export function validateExtraction(extraction, schemaEntries) {
  const problems = [];
  const say = m => problems.push(m);

  if (!extraction || typeof extraction !== 'object') return ['the extraction is not an object'];

  const typesOf = kind => new Set(schemaEntries.filter(e => e.knowledgeType === kind).map(e => e.typeName));
  const entityTypes = typesOf('entity');
  const chronoTypes = typesOf('chrono');
  const claimTypes = typesOf('fact');
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

  /*
   * ONE NAMESPACE FOR EVERY LOCAL KEY, and one place that says so.
   *
   * An edge names its ends by bare key and says nothing about which collection the key is in — so the key
   * has to decide that by itself. Entities and chrono entries each policed their own keys, which meant an
   * entity and a chrono entry could share one: harmless while nothing crossed the two, and an edge end
   * resolving to whichever the writer looked up first as soon as something did.
   *
   * Claims joined the namespace when supersession arrived. Nothing had ever pointed at a claim before.
   */
  const keyKind = new Map();
  const defineKey = (key, kind, at) => {
    const prior = keyKind.get(key);
    if (prior) {
      say(`${at} uses the key '${key}', which ${prior.at} already defines. One key names one record: an `
        + 'edge end is a bare key, so two records sharing one make the edge point at whichever was '
        + 'resolved last.');
      return;
    }
    keyKind.set(key, { kind, at });
  };

  const entityType = new Map();
  for (const [i, e] of entities.entries()) {
    const at = `entities[${i}]`;
    if (!e.key) { say(`${at} has no key`); continue; }
    defineKey(e.key, 'entity', at);
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
    defineKey(c.key, 'chrono', at);
    chronoKeys.add(c.key);
    if (!chronoTypes.has(c.type)) say(`${at} ('${c.key}') has type '${c.type}', which the schema does not declare`);
    if (!c.title) say(`${at} ('${c.key}') has no title`);
    if (!ISO_DATE.test(String(c.date ?? ''))) say(`${at} ('${c.key}') has date '${c.date}', which is not YYYY-MM-DD`);
    for (const k of c.entities ?? []) {
      if (!entityType.has(k)) say(`${at} ('${c.key}') links to the entity key '${k}', which nothing defines`);
    }
  }

  /*
   * Claim keys, registered before the edges are read rather than in the claims block below.
   *
   * A claim's `key` is OPTIONAL and almost always absent — nothing points at a claim except a supersedes
   * edge, and most claims retire nothing. The registration is hoisted here only because the edge loop
   * resolves ends by key, and a claim key that arrived after it would read as a reference to nothing: a
   * confidently wrong message about the one construct this was added for.
   */
  const supersededClaims = new Set();
  for (const [i, c] of claims.entries()) {
    if (c.key === undefined) continue;
    defineKey(c.key, 'claim', `claims[${i}]`);
    if (c.superseded === true) supersededClaims.add(c.key);
  }

  /*
   * What a `supersedes` edge must look like, and the ONE implication worth gating.
   *
   * It runs claim → claim. Between two ENTITIES it would be a merge written as a link, leaving two nodes
   * where the whole value of the graph is that a mention in session 3 and one in session 18 are one node;
   * `aliases` is where that belongs.
   *
   * The rule is NOT "every retirement has a successor". "She left Acme" with no new employer is a real
   * retirement, so `superseded: true` stands alone — required an edge, the model would invent a successor
   * to satisfy the validator. The implication runs the other way: if X supersedes Y then Y is no longer
   * true, and an edge drawn without the mark leaves both claims ranking as current. That is the whole
   * defect supersession exists to fix, and it would be invisible, because the edge looks like the fix.
   */
  const checkSupersedes = (e, at) => {
    for (const [end, key] of [['from', e.from], ['to', e.to]]) {
      const kind = keyKind.get(key)?.kind;
      if (kind !== 'claim') {
        say(`${at} ('${SUPERSEDES}') ${end} is '${key}', which is ${kind ? `a ${kind}` : 'nothing'}. `
          + 'A supersedes edge runs between two claims: one fact replacing another. Two entities that turn '
          + 'out to be the same thing are a merge — put the variants in aliases instead.');
      }
    }
    if (keyKind.get(e.to)?.kind === 'claim' && !supersededClaims.has(e.to)) {
      say(`${at} ('${SUPERSEDES}') says '${e.to}' was replaced, but that claim is not marked `
        + '`superseded: true`. Both then come back from a search looking equally current, which is the '
        + 'thing this edge was drawn to prevent.');
    }
  };

  /* ── edges: the ends must be the kinds the label allows ────────────────────────────────────────────── */

  for (const [i, e] of edges.entries()) {
    const at = `edges[${i}]`;
    /*
     * `supersedes` is not declared in the space schema and must not be: the INSTANCE writes it too — it is
     * in `SERVER_WRITTEN_EDGE_LABELS`, drawn whenever a reviewer resolves a contradiction — so a space that
     * declared an edge allowlist without it would forbid an edge its own server creates. Checked as the
     * shape it is rather than as a schema entry.
     */
    if (e.label === SUPERSEDES) { checkSupersedes(e, at); continue; }
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

    /*
     * A CLAIM THE ASSISTANT ORIGINATED SAYS SO, AND NOTHING ELSE DOES.
     *
     * `attributed: true` means the graph records that this was said, not that it is so — an assistant's
     * world knowledge may be right, stale or invented, and nothing in a conversation settles which. The
     * mark is what lets a caller ask for only what a person asserted.
     *
     * Checked BOTH WAYS on purpose. A missing mark puts a model's output in the graph as fact, which is
     * the failure; a mark on a person's claim is the quieter one, because it retires a real fact from
     * whatever the reader filters on and nothing ever contradicts it. A mark that is optional in practice
     * cannot be filtered on at all, so neither direction is a warning.
     */
    const bySpeaker = ASSISTANT_SPEAKER.test(String(c.speaker ?? ''));
    if (bySpeaker && c.attributed !== true) {
      say(`${at} is spoken by the assistant and is not marked \`attributed: true\`. A model's output stored `
        + 'as a plain fact is indistinguishable at retrieval from something the user said. If the assistant '
        + 'was handing back the USER\'s own fact, the claim is the user\'s — set `speaker` to them instead.');
    }
    if (!bySpeaker && c.attributed === true) {
      say(`${at} is marked \`attributed: true\` but its speaker is '${c.speaker}', who is a person. The mark `
        + 'is for a claim an AI assistant originated; on a person\'s claim it hides a real fact from every '
        + 'reader that filters on it.');
    }
    // Refused rather than coerced: "false" is truthy, and a mark whose entire job is to be believed must
    // never be read as the opposite of what was written.
    if (c.superseded !== undefined && typeof c.superseded !== 'boolean') {
      say(`${at} has superseded '${c.superseded}', which must be a boolean`);
    }
    if (!ISO_DATE.test(String(c.statedOn ?? ''))) say(`${at} has statedOn '${c.statedOn}', which is not YYYY-MM-DD`);
    if ((c.sourceTurns ?? []).length === 0) say(`${at} names no sourceTurns, so nothing can trace it to the transcript`);
    for (const k of c.entities ?? []) {
      if (!entityType.has(k)) say(`${at} links to the entity key '${k}', which nothing defines`);
    }
    for (const k of c.chrono ?? []) {
      if (!chronoKeys.has(k)) say(`${at} links to the chrono key '${k}', which nothing defines`);
    }
  }

  /*
   * ONE TURN, TOO MANY CLAIMS — a pasted document being mined. See `MAX_CLAIMS_FROM_ONE_TURN_SHARE`.
   *
   * The floor keeps a short file out of it: with six claims, four from one turn is a conversation about one
   * thing rather than a document being taken apart.
   */
  if (claims.length >= 20) {
    const ceiling = Math.ceil(claims.length * MAX_CLAIMS_FROM_ONE_TURN_SHARE);
    const from = new Map();
    for (const c of claims) {
      for (const t of new Set(c.sourceTurns ?? [])) from.set(t, (from.get(t) ?? 0) + 1);
    }
    for (const [turn, n] of from) {
      if (n > ceiling) {
        say(`${n} of ${claims.length} claims name turn '${turn}' as a source, over the ${ceiling} a single `
          + 'turn may account for. That is the shape of a pasted document being mined: an article or a log '
          + 'yields dozens of statements about a subject nobody in the conversation is. Record that it was '
          + 'brought and what was wanted from it, and leave the contents in the transcript.');
      }
    }
  }

  /* ── sessions ──────────────────────────────────────────────────────────────────────────────────────── */

  /*
   * WHAT IDENTIFIES A SESSION, and why the date is not enough.
   *
   * The writer files claims by session and names each transcript after one. It keyed both on the date,
   * which is correct for a corpus with one session a day and silently destructive for one without:
   * measured, LoCoMo has 0 of 272 sessions sharing a date and LongMemEval has 18,565 of 25,112, across
   * every one of its 500 histories. Six sessions on one day become one transcript, keeping the last, and
   * all six sessions' claims are filed under it.
   *
   * Reported here so a caller sees it with everything else rather than on the write. The writer refuses it
   * too — the same rule twice, deliberately, because that one is the guard that cannot be skipped by a
   * caller assembling an extraction by hand.
   */
  const sessionAt = new Map();
  for (const [i, s] of sessions.entries()) {
    const key = s.key ?? s.date;
    const prior = sessionAt.get(key);
    if (prior !== undefined) {
      say(`sessions[${i}] and sessions[${prior}] both identify as '${key}', so one transcript would `
        + 'overwrite the other and both would claim the same records. Give each session its own `key`; the '
        + 'date alone is not an identity when a day holds more than one session.');
    } else sessionAt.set(key, i);
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
