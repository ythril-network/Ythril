/**
 * The refusal an upload door answers for its sender's pace: the status and the sentence of a stalled upload, a trickling one and a caller
 * cooled down for either (bundle-270, Q-953, lens finding D1).
 *
 * ## What it prevents
 *
 * The RDF doors (`rdf/rdf-document.ts`) and the admin import (`api/admin-space-transfer.ts`) each held the statuses (408 for a body that did not
 * arrive in time, RFC 9110 section 15.5.9; 429 for a caller refused for it) and the three sentences, so a sentence or a status changed in one
 * place left the other door saying the old one. The words are written here and nowhere else (a gate reads every server source for them).
 *
 * ## What it does not decide
 *
 * The code of a refusal and the test of which codes are pace refusals are each door's own (the RDF doors' codes are `rdf_import_upload_*`, the
 * admin import's `space_import_upload_*`), and so are the header and the body the answer travels in. The door speaks through its voice: what it
 * did not do (`what`), what the sender sends again (`sent`: "file", "body") and how the sentence ends (`ending`).
 */

/** The statuses of an upload's pace: the body did not arrive in time, and a cooled-down caller. */
const PACE_STATUS = { REQUEST_TIMEOUT: 408, TOO_MANY_REQUESTS: 429 } as const;
const MS_PER_SECOND = 1_000;

/** What the reader found of an upload's pace, or what a cooled-down caller must wait. */
export type UploadPaceOutcome =
  | { kind: 'stalled'; idleMs: number }
  | { kind: 'too-slow'; minBytesPerSecond: number; windowMs: number }
  | { kind: 'cooldown'; retryAfter: number };

/** How a door words its refusal. */
export interface UploadPaceVoice {
  /** What the sender sends again: "file" or "body". */
  sent: string;
  /** What closes the sentence: "" or ".". */
  ending: string;
  /** What the door did not do because of the refusal ("nothing was imported"); a stall and a trickle always say it, a cooldown when the door does. */
  what?: string;
}

/** The answer: its status and sentence, and the seconds a cooled-down caller must wait (the door's `Retry-After`). */
export interface UploadPaceRefusal { status: number; error: string; retryAfter?: number }

/** Answer `outcome` in the door's `voice`. A stall or a trickle without `what` throws: a refusal never says nothing of what was not done. */
export function uploadPaceRefusal(outcome: UploadPaceOutcome, voice: UploadPaceVoice): UploadPaceRefusal {
  const { sent, ending, what } = voice;
  if (outcome.kind === 'cooldown') {
    const consequence = what === undefined ? '' : `; ${what}`;
    return {
      status: PACE_STATUS.TOO_MANY_REQUESTS,
      error: `Your last upload here was too slow or stalled${consequence}: send the ${sent} again in ${outcome.retryAfter} seconds, without pauses${ending}`,
      retryAfter: outcome.retryAfter,
    };
  }
  if (what === undefined) throw new Error('a pace refusal says what the door did not do');
  if (outcome.kind === 'stalled') {
    return {
      status: PACE_STATUS.REQUEST_TIMEOUT,
      error: `The upload sent nothing for ${Math.round(outcome.idleMs / MS_PER_SECOND)} seconds and was cut off; ${what}: send the ${sent} again, without pauses${ending}`,
    };
  }
  return {
    status: PACE_STATUS.REQUEST_TIMEOUT,
    error: `The upload sent less than ${outcome.minBytesPerSecond} bytes a second over ${Math.round(outcome.windowMs / MS_PER_SECOND)} seconds and was cut off; ${what}: send the ${sent} again over a faster link${ending}`,
  };
}
