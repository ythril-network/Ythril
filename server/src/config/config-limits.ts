/**
 * The numeric limit blocks of the config, as one type and one validator the loader asks at load and at reload (bundle-271, Q-756): the
 * request-body limits (`body-limits.ts`) and the SPARQL bounds (`sparql-limits.ts`).
 *
 * ## What it prevents
 *
 * A limit block added to the config and validated at load but not at reload: both loader paths call {@link validateConfigLimits} once, so a
 * block joins both by being added here.
 */
import { validateImportLimits, type BodyLimitsConfig } from './body-limits.js';
import { validateSparqlLimits, type SparqlLimitsConfig } from './sparql-limits.js';

/** Every limit block of the config. */
export type ConfigLimits = BodyLimitsConfig & SparqlLimitsConfig;

/** Refuse a config any of whose limit blocks holds a value outside its rule, naming the key. */
export function validateConfigLimits(cfg: ConfigLimits): void {
  validateImportLimits(cfg);
  validateSparqlLimits(cfg);
}
