/**
 * The rights matrix of a token that administers the named spaces and nothing else.
 *
 * ## Why this exists, and why not `legacyRights({ admin: true, spaces })`
 *
 * The pre-3.0 shorthand `admin: true, spaces: [...]` was what fixtures reached for to mean "the admin of one
 * space". `migrateToken` turns it into `instanceAdmin: true` with rows for those spaces, and an instance admin
 * holds every right on every space (S-11). So those fixtures were minting an INSTANCE admin and asserting it was
 * confined. They passed only while the defect S-11 fixed kept instance admins out of spaces they had no row for.
 *
 * Administering a space is its own grant since 5.0: `spaceAdmin.spaces`. It resolves to `admin` in every area of
 * those spaces except `networks`, and it is never instance-wide. That is what these fixtures always meant.
 *
 * @param {string[]} spaces  the spaces the token administers
 */
export function spaceAdminRights(spaces) {
  if (!Array.isArray(spaces) || spaces.length === 0) throw new Error('spaceAdminRights needs at least one space');
  return { instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, spaceAdmin: { floor: false, spaces: [...spaces] } };
}
