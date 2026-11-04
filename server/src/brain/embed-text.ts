import { boundedPrefix, utf8Bytes } from '../util/bounded-text.js';
import { largestTaskPrefixBytes } from './embedding.js';
import { embedInputCeiling, noteInputCut, storedEmbeddingConfig, type CutProducer } from './embed-ceiling.js';

// The ceiling's accessor lives in `embed-ceiling.ts` (`embedding.ts` reads it too, and cannot import this file); it is re-exported
// here, beside the builders that read it, because this is where a reader of "what is embedded" looks.
export { embedInputCeiling };

/**
 * Shared helper for turning a knowledge record's `properties` into embeddable text.
 *
 * The per-type embed-text builders (fact, entity, edge, chrono, and the entity-merge
 * copy) all need to fold `properties` into the string that gets embedded. Keeping the
 * logic here means they cannot drift again — before this existed, fact/entity embedded
 * only property VALUES (dropping the keys) while edge and chrono dropped properties
 * entirely, so semantic recall couldn't match on a property name and values lost their
 * field context (`{birthplace: "Paris"}` and `{currentCity: "Paris"}` embedded identically).
 */
export function propsEmbedText(
  properties?: Record<string, string | number | boolean>,
): string {
  if (!properties) return '';
  // Include BOTH the key and the value: the key ("role") makes the field name searchable,
  // and pairing it with the value keeps each value tied to its field.
  return Object.entries(properties)
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(' ');
}

// ── Per-type embed-text builders ─────────────────────────────────────────────
// One home for every "record → embeddable string" derivation. The writers
// (remember/upsertEntity/upsertEdge/createChrono/upsertFileMeta), the entity-merge
// path, AND the reindex job all call these, so the embedding of a record is identical
// no matter which path produced it. Previously each lived privately in its domain
// module and was hand-re-implemented inline in the reindex job, which had drifted
// (values-only properties for fact/entity; properties dropped and raw entity IDs
// embedded for edges/chrono on reindex).

/**
 * Fact: tags + fact + description + properties (key value). **NOT the names of what it links to.**
 *
 * Those used to be prepended, and it cost 1.5 points of strict evidence recall on a 199-question benchmark —
 * the same turn scored 0.8528 without them and 0.8369 with them. `chronoEmbedText` never did it, so chrono was
 * the control that showed the difference was the names rather than the corpus.
 *
 * The reason is not subtle: a fact linked to five entities carried five names it does not say. A query naming
 * any of them matched a record that never mentioned them, and the record's own sentence was diluted by tokens
 * its author did not write. An EDGE is the opposite case and still embeds its endpoints — `ServiceA
 * depends_on ServiceB` is the whole of what an edge says, and without them it is a bare label.
 *
 * Links are still how you REACH this record: `traverse`, and recall's own expansion with `includeMemories`,
 * both follow them. What changed is that they no longer pretend to be its content.
 */
export function factEmbedText(
  fact: string,
  tags: string[] = [],
  description?: string,
  properties?: Record<string, string | number | boolean>,
): string {
  const parts: string[] = [];
  if (tags.length > 0) parts.push(tags.join(' '));
  parts.push(fact);
  if (description?.trim()) parts.push(description.trim());
  const propsText = propsEmbedText(properties);
  if (propsText) parts.push(propsText);
  return parts.join(' ');
}

/** Entity: name + type + tags + description + properties (key value). */
export function entityEmbedText(
  name: string,
  type: string,
  tags: string[] = [],
  description?: string,
  properties: Record<string, string | number | boolean> = {},
): string {
  const parts: string[] = [name, type];
  if (tags.length > 0) parts.push(tags.join(' '));
  if (description?.trim()) parts.push(description.trim());
  const propsText = propsEmbedText(properties);
  if (propsText) parts.push(propsText);
  return parts.join(' ');
}

/** Edge: tags + from-name + label + to-name + type + description + properties (key value).
 *  `from`/`to` are the resolved entity NAMES (resolve IDs before calling). */
export function edgeEmbedText(
  from: string,
  label: string,
  to: string,
  tags: string[] = [],
  type?: string,
  description?: string,
  properties?: Record<string, string | number | boolean>,
): string {
  const parts: string[] = [];
  if (tags.length > 0) parts.push(tags.join(' '));
  parts.push(from, label, to);
  if (type?.trim()) parts.push(type.trim());
  if (description?.trim()) parts.push(description.trim());
  const propsText = propsEmbedText(properties);
  if (propsText) parts.push(propsText);
  return parts.join(' ');
}

/** Chrono: type + status + title + tags + description + properties (key value). */
export function chronoEmbedText(
  title: string,
  type: string,
  status: string,
  description?: string,
  tags: string[] = [],
  properties?: Record<string, string | number | boolean>,
): string {
  const parts: string[] = [type, status, title];
  if (tags.length > 0) parts.push(tags.join(' '));
  if (description?.trim()) parts.push(description.trim());
  const propsText = propsEmbedText(properties);
  if (propsText) parts.push(propsText);
  return parts.join(' ');
}

/** File: path + linked-entity names + tags + description + property VALUES.
 *  NOTE: files remain the one type that embeds property values-only (no keys) — migrating
 *  them to `propsEmbedText` would change existing file embeddings and needs a reindex, so it
 *  is deliberately left as-is here; this builder just centralises the existing behavior. */
export function fileEmbedText(
  filePath: string,
  tags: string[] = [],
  description?: string,
  properties?: Record<string, string | number | boolean>,
  /**
   * A converted document's own opening prose, when it has one.
   *
   * Appended rather than replacing the description because the two answer different questions. Once
   * `description` became generated prose, a search for a phrase the reader remembers *from the document*
   * had nothing to match on the parent record — the extractive text used to be the description, and
   * generating one would have quietly removed it from the embedding. Last, so the fields that identify
   * the record still lead.
   */
  excerpt?: string,
): string {
  const parts: string[] = [filePath];
  if (tags.length > 0) parts.push(tags.join(' '));
  if (description?.trim()) parts.push(description.trim());
  if (properties) {
    const vals = Object.values(properties).map(v => String(v)).filter(v => v.trim());
    if (vals.length > 0) parts.push(vals.join(' '));
  }
  // Skipped when it merely repeats the description — which is exactly the case on an instance with no
  // model configured, where the extractive text IS the description. Embedding it twice would weight one
  // paragraph of one record against everything else in the space.
  const trimmedExcerpt = excerpt?.trim();
  if (trimmedExcerpt && trimmedExcerpt !== description?.trim()) parts.push(trimmedExcerpt);
  return parts.join(' ');
}

/**
 * A DERIVED file record's text: a passage of a converted document, or a media chunk's caption or transcript.
 *
 * The heading leads when the chunker found one, so a passage is findable by the section it sits in as well as by
 * its own words. A media chunk has no heading, and its `content` is exactly what its producer embedded — a caption,
 * a transcript, or a video's captions joined to its transcript — so the same function rebuilds every derived shape.
 *
 * It exists as a builder, not as a template written where it is used, because the conversion pipeline embeds a
 * chunk and the queue rebuilds one, and two spellings of one string are how a rebuilt vector quietly stops
 * describing the passage it belongs to. Before this, the queue had no derived branch at all and embedded a chunk
 * from its path (`docs/a.pdf#chunk0`).
 */
export function chunkEmbedText(headingText: string | null | undefined, content: string): string {
  return headingText ? `${headingText} ${content}` : content;
}


// ── What is EMBEDDED: the one builder, and the bytes it may hold ────────────────────────────────────────────────

/**
 * The most bytes of embed text one passage may be, so that what `prepareInput` then SENDS is at most `embedding.maxInputBytes`:
 * the ceiling less the largest task prefix of the configured scheme (`search_document: ` is 17 bytes, the `qwen` query instruction
 * over a hundred). A chunker that stopped at the ceiling and a sender that then added the prefix would be over by exactly the prefix.
 */
export function embedTextBudget(): number {
  const cfg = storedEmbeddingConfig();
  return Math.max(1, embedInputCeiling(cfg) - largestTaskPrefixBytes(cfg));
}

/** A heading is capped to a quarter of the budget before the body's share is counted, so a 7,000-byte heading cannot leave a passage no room. */
export function cappedHeading(headingText: string | null | undefined, budget: number = embedTextBudget()): string | null {
  return headingText ? boundedPrefix(headingText, Math.floor(budget / 4)).text : null;
}

/**
 * The text that is embedded for a heading and a body, and whether the BODY had to be cut to make it fit the budget.
 *
 * The heading is capped first, then `chunkEmbedText` builds the string, then the string is cut to the budget by the shared cut rule
 * (the last line break that fits, never inside a surrogate pair). A text that fits is `chunkEmbedText` itself.
 */
export function boundedEmbedText(
  headingText: string | null | undefined,
  content: string,
): { text: string; cut: boolean } {
  const budget = embedTextBudget();
  return boundedPrefix(chunkEmbedText(cappedHeading(headingText, budget), content), budget);
}

/**
 * THE ONE BUILDER of what a derived passage's vector is made from. The conversion's chunk store, the `embed` level, the media
 * embedders and the queue's rebuild (`derivedText` in `embed-record.ts`) all call it, and `matchedText` stores exactly its output,
 * so a rebuilt vector describes what the producer's did. `content` keeps the whole text for the lexical channel.
 */
export function embedTextFor(headingText: string | null | undefined, content: string): string {
  return boundedEmbedText(headingText, content).text;
}

/**
 * {@link embedTextFor} for a PRODUCER that embeds a text it cannot split (a whole document, a transcript): the cut is deterministic
 * and recorded, counted (`ythril_embed_input_cut_total{producer}`) and said once per window. A rebuild of the same record calls
 * {@link embedTextFor} and gets the same string, without counting again (a walk that builds a page of texts is not a producer).
 */
export function embedTextForProducer(
  headingText: string | null | undefined,
  content: string,
  producer: CutProducer,
): string {
  const { text, cut } = boundedEmbedText(headingText, content);
  if (cut) noteInputCut(producer, utf8Bytes(content), utf8Bytes(text));
  return text;
}
