/**
 * The prose limits of a space schema — the numbers a body refuses above, and the numbers an app's editor shows a counter for.
 * `server/src/spaces/_shared.ts` re-exports them.
 */

/**
 * Maximum length of a space's directive (`meta.purpose`, and its deprecated `description` alias).
 *
 * One constant because there were six literals for one field, and two of them disagreed: REST accepted
 * **4000** while the MCP `update_space` tool refused anything over **2000**. So a purpose written through
 * one transport could not be edited through the other — and the migration that moved legacy `description`
 * text into `meta.purpose` used the 4000 bound, meaning an MCP client could be handed a purpose it was
 * forbidden to change.
 *
 * Unified UP rather than down: 4000 is what the writer actually stores (`updateSpace` truncates there), so
 * lowering it would have made the API advertise a limit smaller than the data it already holds.
 */
export const SPACE_PURPOSE_MAX = 4000;

/**
 * How long a SCHEMA ENTRY's prose may be — a type's `description` and a property's (`F-24`).
 *
 * Its own constant rather than `SPACE_PURPOSE_MAX`, which it briefly borrowed. Two bounds that happen
 * to be equal are not one bound: the space directive and a type note answer different questions and
 * would move for different reasons. Sharing the name also collided with the gate that keeps the retired
 * space-level `description` alias from returning — it matches on `description: z.string().max(
 * SPACE_PURPOSE_MAX)`, and a borrowed constant made an unrelated field look like that alias coming back.
 *
 * A property gets the smaller half: it describes one value, not a whole record type.
 */
export const SCHEMA_DESCRIPTION_MAX = 4000;
export const PROPERTY_DESCRIPTION_MAX = 2000;
