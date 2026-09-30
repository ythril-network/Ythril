/**
 * Is this instance forbidden from fetching a model at runtime?
 *
 * ## Where the question is asked, and why it is its own module
 *
 * Two processes ask it. The inference CHILD asks at its entry (it is the one that loads the model, and it hands
 * the answer to the loader as an argument), and the HOST asks before every request, because the flag is read when
 * a child starts: a changed flag can only reach a NEW process, so the host restarts the child when the answer
 * changes. One function, so the two cannot disagree about what counts as "set". It lives in `brain/` and imports
 * nothing because the child may import nothing of the server (`local-inference-structure.test.js`).
 *
 * ## Why the ecosystem names are read first
 *
 * An operator air-gapping a stack sets `HF_HUB_OFFLINE=1`, and `docker-compose.yml` already sets exactly that on the
 * `unstructured` sidecar, so an operator has every reason to believe the convention is honoured stack-wide. It was
 * not: transformers.js does not read those variables at all (they belong to Python's `huggingface_hub`), so the
 * Node process ignored them completely. `YTHRIL_MODELS_OFFLINE` is the explicit spelling for anyone who would rather
 * not borrow another project's variable.
 *
 * These reads are literal `process.env['NAME']` on purpose: `env-var-docs-coverage` finds the settings the code
 * reads by that shape, and a list of names looked up in a loop would make all three invisible to it.
 */

/** The variable names above, for the places that need to pass them on. Kept beside the reads that use them. */
export const MODELS_OFFLINE_ENV = ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'YTHRIL_MODELS_OFFLINE'] as const;

function truthy(v: string | undefined): boolean {
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false' && v.toLowerCase() !== 'no';
}

export function modelsOffline(): boolean {
  return truthy(process.env['HF_HUB_OFFLINE'])
    || truthy(process.env['TRANSFORMERS_OFFLINE'])
    || truthy(process.env['YTHRIL_MODELS_OFFLINE']);
}
