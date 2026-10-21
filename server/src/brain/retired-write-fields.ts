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

/**
 * One retirement: the name that replaced it, and the whole sentence a caller sees.
 *
 * The replacement is a FIELD of its own rather than something a gate reads back out of the sentence
 * (`Q-41`). It used to be inferred — the gate asserted the message named exactly one of the three link
 * input names — which was true of every member while every member was a link array, and silently became
 * the wrong rule the moment a retirement replaced something else. Declared, the gate can check that the
 * sentence names its own replacement whatever kind of thing that is.
 */
export interface RetiredWriteField {
  /** The name to send instead. Must be a name some door actually accepts. */
  replacement: string;
  /** What the caller is told. Names both the retired field and the replacement, and says why. */
  message: string;
}

/** Retired input field → what to send instead. */
export const RETIRED_WRITE_FIELDS: Readonly<Record<string, RetiredWriteField>> = Object.freeze({
  entityIds: {
    replacement: 'linkEntities',
    message: '`entityIds` was removed in 5.0: send `linkEntities` with the same ids. A record\'s connections '
      + 'are link records now, so the field is an instruction to make them rather than a value to store.',
  },
  memoryIds: {
    replacement: 'linkFacts',
    message: '`memoryIds` was removed in 5.0: send `linkFacts` with the same ids. A record\'s connections '
      + 'are link records now, so the field is an instruction to make them rather than a value to store.',
  },
  chronoIds: {
    replacement: 'linkChronos',
    message: '`chronoIds` was removed in 5.0: send `linkChronos` with the same ids. A record\'s connections '
      + 'are link records now, so the field is an instruction to make them rather than a value to store.',
  },
  /*
   * The batch body's own key, added by `Q-41` — reported by the fleet integrator, who sent it and was
   * answered `207` with nothing written and an empty `errors` array.
   *
   * It belongs in this table rather than in a check of its own for the reason the docblock above gives:
   * the next retirement will want it too, and a second mechanism would be a second sentence to keep in
   * step with this one. It is the first entry replacing a COLLECTION KEY rather than a link array, which
   * is what made the declared `replacement` above necessary.
   */
  memories: {
    replacement: 'facts',
    message: '`memories` was removed in 5.0: send `facts` with the same items. The knowledge type was '
      + 'renamed, so the array is the same shape under a different key.',
  },
});

/**
 * Addressing fields a record write used to take and no longer does (6.0, Q-531): refused BY NAME, on every door and in both REST spellings
 * (query and body), with the one sentence. A SECOND table beside {@link RETIRED_WRITE_FIELDS} rather than rows in it: that table's
 * replacements are fields a body carries (a gate holds each to a name a write door accepts), and these replacements are the `space`
 * every door already takes.
 *
 * `targetSpace` named the member a write to a proxy space landed in. A proxy is a personal view now and a view never writes, so a write
 * names the member space itself.
 */
export const RETIRED_ADDRESSING_FIELDS: Readonly<Record<string, RetiredWriteField>> = Object.freeze({
  targetSpace: {
    replacement: 'space',
    message: '`targetSpace` was removed in 6.0: a proxy space is now a personal view, which never writes. Write to the member space itself: '
      + 'send `space` (REST: the space in the path) holding the id of that member space.',
  },
});

/**
 * Space fields a space create used to take and no longer does (6.0, Q-531): `proxyFor` made the new space a proxy, and a proxy is a
 * personal view now - made with `POST /api/views` (MCP `view_create`), by the token that will read through it.
 */
export const RETIRED_SPACE_FIELDS: Readonly<Record<string, RetiredWriteField>> = Object.freeze({
  proxyFor: {
    replacement: 'members',
    message: '`proxyFor` was removed in 6.0: a proxy space is now a personal view, owned by the token that makes it. Create one with '
      + '`POST /api/views` (MCP `view_create`) with the same ids as `members`; nothing is created as a space.',
  },
});

const ALL_RETIRED: readonly Readonly<Record<string, RetiredWriteField>>[] = [RETIRED_WRITE_FIELDS, RETIRED_ADDRESSING_FIELDS, RETIRED_SPACE_FIELDS];

/** Why a SPACE create body cannot be honoured because of a retired field, or `null` (`proxyFor`). */
export function retiredSpaceFieldError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  for (const name of Object.keys(RETIRED_SPACE_FIELDS)) if (Object.hasOwn(body, name)) return RETIRED_SPACE_FIELDS[name]!.message;
  return null;
}

/** Why a request's QUERY string cannot be honoured because of a retired addressing field, or `null` (`?targetSpace=`). */
export function retiredAddressingQueryError(query: unknown): string | null {
  if (!query || typeof query !== 'object') return null;
  for (const name of Object.keys(RETIRED_ADDRESSING_FIELDS)) if (Object.hasOwn(query, name)) return RETIRED_ADDRESSING_FIELDS[name]!.message;
  return null;
}

/** Why this body cannot be honoured because of a retired field name, or `null`. */
export function retiredWriteFieldError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const bag = body as Record<string, unknown>;
  // OWN keys, both ways (R6-11): a caller's name is looked up in the table, and the table's names are looked up in the body, by
  // `hasOwn` — `in` and a bare index would also answer for what `Object.prototype` carries (`constructor`, `__proto__`, `toString`).
  for (const name of Object.keys(RETIRED_WRITE_FIELDS)) {
    if (Object.hasOwn(bag, name)) return RETIRED_WRITE_FIELDS[name]!.message;
  }
  for (const name of Object.keys(RETIRED_ADDRESSING_FIELDS)) {
    if (Object.hasOwn(bag, name)) return RETIRED_ADDRESSING_FIELDS[name]!.message;
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
  for (const table of ALL_RETIRED) if (Object.hasOwn(table, name)) return table[name]!.message;
  return null;
}
