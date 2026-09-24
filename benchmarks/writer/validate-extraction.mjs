/**
 * The extraction validator lives in the server now (`server/src/extractor/validate-extraction.ts`): the
 * benchmark's writer and the product's `ingest` refuse the same files for the same reasons, because there is one
 * copy of the rules. This re-export keeps every existing import working. Requires `npm run build` in server/.
 */
export { validateExtraction, assertWritable, SUPERSEDES } from '../../server/dist/extractor/validate-extraction.js';
