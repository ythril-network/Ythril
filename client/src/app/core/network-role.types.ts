/** What THIS instance is in a network, as the server reports it on `myRole` (F-38.1). */
export type NetworkRoleName = 'publisher' | 'subscriber' | 'organiser' | 'member' | 'root' | 'node' | 'leaf';

/** The role, and the members it acts on — each list holds instance ids into the network's `members`. */
export interface NetworkRole {
  role: NetworkRoleName;
  members: string[];
  publisher?: string;
  pathToRoot?: string[];
  subtree?: string[];
}
