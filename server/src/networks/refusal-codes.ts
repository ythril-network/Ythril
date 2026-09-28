/**
 * The machine names a network refusal carries in `code` (`Q-133`) — the one list of them.
 *
 * A client translates a refusal by its code (`networks.refusal.<code>` in the i18n files), and the MCP text gate
 * must tell a code named in a description from a tool name. Both read this list, so a new code cannot arrive
 * untranslated or be mistaken for a tool that does not exist. Every code here is a sentence the server also sends
 * in `error`, so a client without words for it still shows something true.
 */
export const NETWORK_REFUSAL_CODES = [
  /** Two of the network's spaces would land on one local space, or a `spaceMap` key could mean two. */
  'join_mapping_collision',
  /** A network id already reaches a different local space on a network this instance carries. */
  'network_id_aliased',
  /** The inviter's answer named a space by an id no space can have. */
  'invalid_answer',
  /** Another space already syncs under this id in one of this instance's networks. */
  'space_name_in_use',
] as const;

export type NetworkRefusalCode = typeof NETWORK_REFUSAL_CODES[number];
