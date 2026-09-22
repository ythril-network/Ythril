/**
 * Input fields a write door used to accept and no longer does — refused BY NAME, never silently dropped.
 *
 * ## Why a retired name needs its own refusal
 *
 * 5.0 removed the six link arrays. Without this, each door does what it does with any name it does not
 * know: REST folds it into `warnings` and stores the rest, MCP's dispatcher answers *"unexpected property
 * 'entityIds'"*. Both are 200-shaped from an upgrading caller's point of view — the record is written and
 * the connections it asked for are not, which surfaces weeks later as a traversal that comes back empty.
 *
 * The same call was made for the pre-3.1.0 suppression spelling (`D-6`): *"both left at once, which is why
 * a caller sending it now gets a refusal rather than a silent drop"*. This is that decision, in a module,
 * because the next retirement will want it too.
 *
 * ## One sentence, both doors
 *
 * `connectionInputError` calls this, and every write door already calls that — so REST refuses with a
 * `400`. The MCP dispatcher refuses the same field a step earlier, from `additionalProperties: false`, and
 * reads the SAME sentence out of here for the hint. Two mechanisms, one text: a caller who moves between
 * doors is told to do the same thing.
 *
 * ## What the message has to contain, and it is not an apology
 *
 * The NEW spelling, and that nothing about the ids changed. A refusal naming only what is gone leaves the
 * reader to search the guide for what replaced it — and the guide is the thing they were reading when they
 * wrote the old name.
 */

/** Retired input field → what to send instead. The value is the whole sentence a caller sees. */
export const RETIRED_WRITE_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  entityIds: '`entityIds` was removed in 5.0: send `linkEntities` with the same ids. A record\'s connections '
    + 'are link records now, so the field is an instruction to make them rather than a value to store.',
  memoryIds: '`memoryIds` was removed in 5.0: send `linkFacts` with the same ids. A record\'s connections '
    + 'are link records now, so the field is an instruction to make them rather than a value to store.',
  chronoIds: '`chronoIds` was removed in 5.0: send `linkChronos` with the same ids. A record\'s connections '
    + 'are link records now, so the field is an instruction to make them rather than a value to store.',
});

/** Why this body cannot be honoured because of a retired field name, or `null`. */
export function retiredWriteFieldError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const bag = body as Record<string, unknown>;
  for (const name of Object.keys(RETIRED_WRITE_FIELDS)) {
    if (name in bag) return RETIRED_WRITE_FIELDS[name] as string;
  }
  return null;
}

/**
 * The sentence for ONE rejected property name, or `null` when it is simply unknown.
 *
 * For a door that has already decided to refuse and only needs to say why usefully — the MCP dispatcher,
 * which refuses from the schema before any handler runs.
 */
export function retiredWriteFieldHint(name: string): string | null {
  return RETIRED_WRITE_FIELDS[name] ?? null;
}
