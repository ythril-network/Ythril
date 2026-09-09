/**
 * Rung S0+ — everything the source already states, as structure. Still no model call.
 *
 * ## The rung nobody thinks to run
 *
 * Between "store the text" and "have a model read it" there is a step that costs nothing: **use what the source
 * already tells you.** A transcript format normally carries more than prose — who the participants are, when
 * each session happened, which turn is which. All of that is structure, and turning it into records needs no
 * language understanding at all.
 *
 * Here that is the two speakers, and a real timestamp per session. So this rung writes:
 *
 *   - one `person` entity per participant;
 *   - one `session` entity per session, because the session is the natural JOIN POINT — a turn belongs to one,
 *     a session has a date, and evidence in this corpus is cited by turn. Traversal can then walk
 *     fact → session → date → other facts in that session, which is a hop that exists in the data rather than
 *     one a model inferred;
 *   - one `chrono` per session carrying its real `startsAt`, so time is a first-class record and not a string
 *     inside prose;
 *   - edges joining them.
 *
 * ## Why this rung is worth its own row in the results
 *
 * If a measurable part of the temporal or multi-hop gain is available for **zero tokens**, that is a stronger
 * claim than any comparison against a competitor: it says the structure earns its keep before the extraction
 * does. And the negative result is equally useful — if S0+ does not move temporal at all, then chrono records
 * are not reaching retrieval, and the S3 → S4 comparison further up the ladder needs re-reading before anyone
 * concludes the graph is worthless.
 *
 * ## General justification, which is the test every element here has to pass
 *
 * Would this still be right for a user whose data looks nothing like this dataset? Yes, and that is why it is
 * here rather than in a LoCoMo adapter: **every conversational corpus has participants and timestamps.** A chat
 * export, a meeting transcript, a support thread. This rung is the part of ingestion that never needs a model
 * for any of them.
 *
 * ## The question-blindness rule
 *
 * Conversation in, records out. No import can reach the question set, and a gate enforces it.
 */

import { TURN_PROPERTIES, STRUCTURE_ENTITIES, SESSION_CHRONO } from './_schemas.mjs';

import * as s0 from './s0-raw-turns.mjs';

/**
 * What this corpus may contain, declared so the instance enforces it.
 *
 * A space defaults to `validationMode: 'strict'` and a declared collection's keys are an ALLOWLIST, so an
 * undeclared type is a 400 and a missing `required` property is a 400. Without a declaration strict mode
 * validates NOTHING: there is no rule for an undeclared type, so nothing can be violated.
 *
 * A benchmark needs that more than an application does. An application with a broken corpus throws; a
 * benchmark reports a NUMBER, and a corpus missing a field scores low and reads as a finding about retrieval.
 */
export const typeSchemas = {
  memory: {
    /* Its turns are written through S0's ingest, so they carry S0's properties exactly. */
    utterance: { propertySchemas: TURN_PROPERTIES },
  },
  entity: STRUCTURE_ENTITIES,
  chrono: SESSION_CHRONO,
  edge: {
    /* A speaker took part in a session. A hop, so it is never embedded. */
    spoke_in: { endpoints: { from: ['person'], to: ['session'] }, suppressEmbeddings: true },
  },
};

export const rung = 's0+';

/** Its turns are memories, exactly as S0's are — see `recallTypes` in `s0-raw-turns.mjs`. */
export const recallTypes = ['memory'];
export const needsModel = false;

/*
 * IDENTITY IS THE INGESTER'S JOB, and it is not optional — measured the hard way.
 *
 * The first version of this rung derived readable ids (`space:person:ada`) and passed them on write, expecting
 * the second write of the same name to be an update by construction. **Ythril does not adopt a caller-supplied
 * id.** Identity is server-generated; `id` addresses an EXISTING record and an id that names nothing is ignored
 * rather than adopted, exactly as `upsert_entity`'s own schema says. The write succeeded with a fresh UUID, and
 * the edge that followed was refused — `from` references an entity ID that does not exist — which is the right
 * refusal and the only reason this was caught before a forty-minute run.
 *
 * So the ingester holds a REGISTRY: name+type to the id the server actually returned. The specification called
 * identity "the hard part and not the model's job" and it is right for a reason stronger than it argued: there
 * is no shortcut available. Every re-mention must pass the id that came back from the first write.
 */

/**
 * @param {object} args
 * @param {object} args.conversation  no question data on it
 * @param {object} args.ythril
 * @param {string} args.space
 * @returns {Promise<{records: number, modelCalls: number}>}
 */
export async function ingest({ conversation, ythril, space }) {
  /*
   * S0+ IS S0 PLUS STRUCTURE, and for one run it was only the structure.
   *
   * This rung wrote the participants, the sessions, the chrono records and the edges — and never wrote the
   * turns. Its spaces held 78 records where S0's held 419, so there was no transcript to retrieve and every
   * evidence-recall score for the rung would have been near zero. Not because structure fails to help: because
   * nothing was there to help find.
   *
   * It would have been reported as a measurement. The comparison the whole rung exists for is S0 versus S0 with
   * structure on top, which is only a comparison if the S0 half is present in both. Caught by a record count
   * that did not add up — 78 against 419 — and not by any assertion, which is why `run-tier0r.mjs` now prints
   * the count for every space as it goes.
   */
  let records = 0;

  // ── The participants ──────────────────────────────────────────────────────
  //
  // Ids are DERIVED rather than server-minted, because `upsertEntity` mints a fresh UUID unless one is passed
  // and only WARNS when a same name+type already exists. Two `Caroline` documents would fragment every path
  // through her and raise no error — the silent-duplicate defect the specification calls the hard part of
  // identity. A derived id makes the second write an update by construction.
  const speakerIds = new Map();
  for (const name of conversation.speakers) {
    const created = await ythril.writeEntity(space, {
      name,
      type: 'person',
      description: `A participant in this conversation.`,
      properties: { role: 'participant' },
    });
    // The id the SERVER chose. Nothing later may reconstruct it — see the note above.
    speakerIds.set(name, created.id ?? created._id);
    records++;
  }

  // ── The sessions ──────────────────────────────────────────────────────────
  // Keyed by the session's own index, because that is what a turn carries and what the linker below looks up.
  const sessionIds = new Map();
  for (const session of conversation.sessions) {
    const day = session.startsAt.slice(0, 10);

    /*
     * The session as an ENTITY, and separately as a CHRONO.
     *
     * Not one record doing both, because they answer different questions and a store that conflates them makes
     * one of them worse. The entity is a place in the graph to stand — edges attach to it and a traversal can
     * pass through it. The chrono is a point in time — it carries a real `startsAt` that a time-range query can
     * compare, which a property on an entity cannot do as well.
     *
     * The entity is written WITHOUT an embedding. It is a navigational node, and an embedded "Session 7" would
     * compete for a result slot with the sentences that actually answer things — the specification's one
     * invariant is one claim, one embedded record, and a session heading is not a claim.
     */
    const sessionEntity = await ythril.writeEntity(space, {
      name: `Session ${session.index}`,
      type: 'session',
      properties: {
        session: session.index,
        startsOn: day,
        turns: session.turns.length,
      },
      suppressEmbeddings: true,
    });
    const sid = sessionEntity.id ?? sessionEntity._id;
    sessionIds.set(session.index, sid);
    records++;

    await ythril.writeChrono(space, {
      title: `Conversation session ${session.index}`,
      startsAt: session.startsAt,
      // `event` because chrono types are a CLOSED SET — event, deadline, plan, prediction, milestone — and a
      // session is something that happened at a known time. Found by the smoke test rather than by reading:
      // an invented type is a 400, which is the right refusal and the reason to exercise a client before a
      // forty-minute run depends on it.
      type: 'event',
      entityIds: [sid, ...speakerIds.values()],
      properties: {
        session: session.index,
        // Mirrored as a plain property for the same reason S0 mirrors `statedOn`: `recall`'s filter reaches
        // `properties.*`, not a chrono's native `startsAt`, so without this a caller cannot bound a recall in
        // time on either door without a second `query` call.
        startsOn: day,
      },
    });
    records++;

    // Each participant spoke in this session. Directed from the person, because "who spoke where" is the
    // question this edge answers and a traversal outbound from a person should reach their sessions.
    const spoke = new Set(session.turns.map(t => t.speaker));
    for (const name of spoke) {
      const from = speakerIds.get(name);
      if (!from) continue;   // a speaker not in the header — recorded by absence rather than invented
      await ythril.writeEdge(space, {
        from,
        to: sid,
        label: 'spoke_in',
        // Suppressed: this edge is a hop, not a sentence. Fourteen of them per conversation competing for
        // `topK` would evict the memories carrying the actual content, and the specification's invariant is
        // exactly about not paying a ranked slot for structure.
        suppressEmbeddings: true,
      });
      records++;
    }
  }

  /*
   * The turns go in LAST, and joined to the structure above them.
   *
   * Last because a memory's `entityIds` must RESOLVE — the session and speaker entities have to exist before a
   * turn can name them — and joined because an unjoined turn makes the whole graph unreachable from search.
   * Recall matches a turn; traversal expands from what recall matched; so if the matched record names no
   * entity, expansion has nowhere to go and the session, the date and the sibling turns are all invisible.
   *
   * That is what "the mixture of graph and semantic recall" actually requires: the semantic hit must be a node
   * in the graph, not a document beside it.
   */
  /*
   * The turns go in as MEMORIES, with no `entityIds`, and therefore with EXACTLY the embedding S0 gives them.
   *
   * That is deliberate and it is what makes this rung a control. Two things were tried here and both are
   * recorded because each was wrong in an instructive way:
   *
   * 1. **`entityIds` linking each turn to its session and speaker.** It measured -1.5 points of strict
   *    evidence recall and bought nothing back, because graph traversal did not read `entityIds`.
   *
   *    **BOTH halves of that have since stopped being true, and this row is kept as the record of it.** The
   *    reason given was that `memoryEmbedText` prepends the linked entities' NAMES to the fact; it no longer
   *    does — the names were removed FROM THE PRODUCT precisely because of the 1.5 points measured here, so
   *    the cost was paid off rather than avoided. And a traverse now starts a walk from a non-entity seed,
   *    so `entityIds` IS read. `s0l-linked-memories.mjs` is the rung that re-tests it.
   *
   *    Worth stating plainly beside it, because two rungs were built on getting this wrong: a property IS
   *    embedded. `memoryEmbedText` appends every one of them as `key value`.
   * 2. **An edge from each turn to its session.** Refused by the store, and correctly:
   *    `assertRefsResolve` validates an edge's `from`/`to` against the `_entities` collection, so **a memory
   *    cannot be an edge endpoint at all.** Edges are entity-to-entity.
   *
   * Together those two facts are why recall's `traverse` cannot expand from a matched memory: the seeds are the
   * matched records' own ids, and a memory id is the endpoint of no edge. That is a property of the product,
   * not of this benchmark, and testing it is what rung `s0g` is for — it models the turns AS entities so they
   * can be edge endpoints, which is the only shape in which the graph and the ranked search meet.
   *
   * So this rung answers one question cleanly: **does adding structure alongside the turns cost anything?** It
   * should score identically to S0 at every traverse depth, and if it does not, the structure is interfering.
   */
  const base = await s0.ingest({ conversation, ythril, space });
  records += base.records;

  // Summed rather than written as 0: this rung adds no model call, and the claim it makes is "whatever the
  // base rung cost, plus nothing" — which stays true if the base rung ever stops being free.
  return { records, modelCalls: base.modelCalls };
}
