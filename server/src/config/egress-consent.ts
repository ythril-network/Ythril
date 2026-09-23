/**
 * Has the operator consented to sending data to the host this URL would reach?
 *
 * Every external model slot that can carry content OFF the instance — the document assist model, the external
 * face model, the extractor's decision slot — records consent as `acknowledgedHost`: the host the operator
 * saw and accepted when they configured it. The endpoint is usable only while that host is the one
 * `baseUrl` actually points at, so changing the URL withdraws the consent until it is given again.
 *
 * **Re-checked at the point of use, never trusted from save time.** `config.json` can be hand-edited, and a
 * consent check that only runs on the admin PATCH lets an edited file egress documents or face crops with
 * nothing recorded.
 *
 * One function because it was written four times: `describe.ts`, `vlm-extract.ts` and `face-external.ts`
 * each compared the hosts inline, and the decision slot would have been the fourth. The rule is small enough
 * that every copy looked right, which is why a fifth would be written next year without anyone noticing —
 * `the-extractor-decides-by-jev-or-assist.test.js` refuses an inline comparison anywhere in `server/src`.
 *
 * Imports nothing, so config, converters and media can all reach it without an import cycle. The SAVE-time
 * half of the same rule — `refuseUnacknowledgedEgress`, below — moved here from `api/media-config.ts` for the
 * same reason: the decision slot's settings module needs it, and importing it from the route would be a cycle.
 */
export function egressConsented(slot: { baseUrl?: string; acknowledgedHost?: string } | undefined): boolean {
  const baseUrl = slot?.baseUrl?.trim();
  if (!baseUrl || !slot?.acknowledgedHost) return false;
  try {
    return slot.acknowledgedHost === new URL(baseUrl).host;
  } catch {
    return false;
  }
}

/**
 * Does THIS PATCH activate an external endpoint that has not been consented to?
 *
 * ## One rule for two endpoints, because they had two copies of it and one bug each
 *
 * Face crops (biometric) and document content (OCR text and page images) are the two things that leave the
 * instance, and each had its own inline consent gate. Both keyed the refusal on the STORED STATE:
 *
 *     face:    if (effBaseUrl)                       an endpoint is configured
 *     assist:  if (repairReachable && effBaseUrl)     ...and the rung that uses it is reachable
 *
 * So once either endpoint was stored without an acknowledgement, **every subsequent patch to this route was
 * refused, whatever it touched.** The canary operator's owner met the face one raising an image level, which has
 * nothing to do with face egress, and described the resulting flow as *"not even i understand it"* — having
 * built the service on the other end of it.
 *
 * ## Their principle, and the reason it is safe
 *
 * *"The acknowledgement should gate USE of the endpoint, not VALIDITY of the config."*
 *
 * The USE side already enforces it and always has. `detectFacesExternal` returns null unless
 * `egressConsented` matches the host it would send to, and that function's comment says why it is
 * checked there as well: *"a config edited on disk (bypassing the API) still cannot silently egress biometric
 * data."* Refusing the WRITE protected nothing that refusing the USE does not — and the collateral was an
 * optional endpoint bricking a settings page.
 *
 * ## But "gate the use" is not the whole answer, and the assist model's own comment is why
 *
 * It reads: *"the trigger is the PIPELINE RUNG, not a separate tick... consent is demanded exactly when repair
 * becomes reachable — whether that happened by configuring the endpoint or by raising the extraction mode in
 * the same or an earlier save."* The words "or an earlier save" are the defect; the rest is the right idea.
 *
 * Consent is owed at ACTIVATION, which is TWO conditions and not one. The first draft of this fix collapsed
 * them and CI caught it — a test whose name is the contract: *"configuring the endpoint BELOW the repair rung
 * is allowed (not reachable yet) and round-trips"*. Setting up an endpoint while the rung that uses it is off
 * has always been permitted, deliberately: nothing can be sent at that rung, so there is nothing to consent to
 * yet. Demanding it there asks the operator to consent to a transfer that cannot happen.
 *
 * So both halves are required:
 *
 *   REACHABLE AFTER THIS PATCH   the endpoint is set AND the rung that uses it is on. Read from the EFFECTIVE
 *                                state — patch ?? stored — because reachability is a fact about the config
 *                                that results, not about who caused it.
 *   CAUSED BY THIS PATCH         this request touched the endpoint, or raised the rung. Read from the REQUEST
 *                                only, because a rung raised in an earlier save is not this caller's act.
 *
 * The old gate had the first and not the second, so one stored endpoint refused every later write. The first
 * draft of the fix had the second and not the first, so setting up an endpoint became impossible without
 * consenting to a transfer that could not occur. Both are needed and they answer different questions.
 *
 * That is also the owner's ruling of 2026-08-20 (P-12, A + C): consent is accepted — and therefore demanded —
 * from the PIPELINE entry point as well as from the endpoint's own control, because raising an image level to
 * its recognition rung is equally an act of switching faces on.
 *
 * ## What is deliberately NOT relaxed
 *
 * A patch that activates an unacknowledged endpoint is still refused, with the host named and the reason in
 * plain language. They asked us not to weaken that and were right to: it caught a real mistake of theirs
 * within minutes, when they had written the acknowledgement as a bare host without its port.
 *
 * Exported for unit testing — this rule is the reason the function exists.
 */
export function refuseUnacknowledgedEgress(input: {
  /** Names the slot in the refusal, e.g. `external face model`. */
  what: string;
  /** What leaves the instance, in words an operator recognises. */
  sends: string;
  /** The endpoint after this patch: `patch.baseUrl ?? stored.baseUrl`. */
  effBaseUrl: string | undefined;
  /** The acknowledgement after this patch. */
  effAck: string | undefined;
  /**
   * Is the endpoint REACHABLE after this patch — set, and behind a rung that is on?
   *
   * From the EFFECTIVE state (patch ?? stored). An endpoint configured below its rung is not reachable and
   * needs no consent yet, which is a deliberate behaviour with a test named after it.
   */
  reachableAfterThisPatch: boolean;
  /**
   * Did THIS REQUEST cause it — by touching the endpoint, or by raising the rung?
   *
   * From the request only. A rung raised in an earlier save is not this caller's act, and asking them to
   * consent to it is what made one stored endpoint refuse every unrelated write.
   */
  causedByThisPatch: boolean;
}): { status: 400; body: { error: string; needsAcknowledgment: string } } | { status: 400; body: { error: string } } | null {
  const { what, sends, effBaseUrl, effAck, reachableAfterThisPatch, causedByThisPatch } = input;
  // BOTH, and the `&&` is the whole rule: reachable but not caused by this caller is somebody else's decision;
  // caused but not reachable is a transfer that cannot happen yet.
  if (!reachableAfterThisPatch || !causedByThisPatch || !effBaseUrl) return null;
  let host: string;
  try { host = new URL(effBaseUrl).host; } catch {
    return { status: 400, body: { error: `${what} baseUrl is not a valid URL` } };
  }
  // Host INCLUDING port, deliberately: `face-embed.svc` and `face-embed.svc:3120` are different destinations,
  // and accepting the bare name would let an acknowledgement cover an endpoint nobody consented to.
  if (egressConsented({ baseUrl: effBaseUrl, acknowledgedHost: effAck })) return null;
  return {
    status: 400,
    body: {
      error: `Egress to ${host} must be acknowledged before the ${what} can be used: ${sends} would be sent there.`,
      needsAcknowledgment: host,
    },
  };
}
