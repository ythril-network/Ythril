/**
 * Fields removed when a chrono's content window lapses.
 *
 * `embedding` and `embeddingModel` go with the text: leaving the vector behind would keep the record winning
 * semantic searches for content that is no longer there, which is the failure this exists to fix. `title`,
 * `type`, `startsAt`, `tags` and the id links stay — that is the "it happened" half.
 *
 * ## `properties` STAYS — asked and answered (canary, 2026-08-02)
 *
 * It was in this list, and taking it out is the right call. The operator asked whether the embedding can expire
 * separately from `properties`, so a chrono type can go *semantically silent while staying queryable by field*,
 * and they were holding a whole space's configuration until the answer:
 *
 * > for alert episodes `properties` (`alertname`, `fingerprint`, `notifyCount`, `reopens`, `outcome`) is the
 * > entire value and nothing else records it.
 *
 * That is the case for splitting them. What displaces knowledge in recall is the **vector** — plus the free
 * text that produced it — and `properties` is structured, small, and reachable only by explicit field query.
 * Dropping it removed everything the record was for and bought nothing this feature exists to buy.
 *
 * So the tier now means exactly what its name says: the record stops competing semantically and stays
 * *queryable*. An operator who genuinely wants the structured data gone has `days` — the record itself.
 */
export const REDACTED_CHRONO_FIELDS = [
  'description', 'matchedText', 'embedding', 'embeddingModel',
] as const;
