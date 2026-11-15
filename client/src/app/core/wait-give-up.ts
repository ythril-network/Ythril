/**
 * How long a request may run before the client gives up on it and says so, rather than spinning for ever.
 *
 * One number for every read that ends in a "no answer" state: the graph's two loads, the space-create call and a type's history
 * reads. It was written in the graph watch and once more by hand in the create dialog; a third copy would let two screens give up
 * at different times for the same wait.
 */
export const WAIT_GIVE_UP_MS = 30_000;
