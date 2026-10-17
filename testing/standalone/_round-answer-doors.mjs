/**
 * The doors that open a vote round, and which driver answers for each — the one table the two halves of the projection gate read.
 *
 * ## The question it answers
 *
 * *"Which functions open a round, and for each: how does the driven half call it, or why is it not an operator door?"* The pure half
 * (`every-answer-that-carries-a-round-is-projected-in-source.test.js`) derives the doors from the source and holds the table to
 * them; the driven half (`every-answer-that-carries-a-round-is-projected.test.js`) holds each driver to a door that really answers.
 * Both read this table, so a door added to the code and to one half only is a failure in the other.
 *
 * ## Why a table at all, in a gate that derives
 *
 * The derivation finds the doors; it cannot say how to CALL one (a network, a token, a body). A door with no row fails the pure
 * half — *"a new opener answers a round no test drove"* — which is the point: the row is where somebody drives it. A row
 * whose door is gone fails too, so the table cannot keep a driver for code that no longer exists.
 *
 * `door` is `<repo path>::<outermost function>`, the name `outermostFunctionAt` gives it (a route handler written inline is named
 * for its route: `DELETE /:id`). `exempt` is the reason the answer is not an operator's round: it names who is answered instead.
 */

export const DOORS = Object.freeze([
  { door: 'server/src/networks/network-acts.ts::addNetworkSpaceAct', driver: 'add-space' },
  { door: 'server/src/spaces/meta-update.ts::applySpaceMetaUpdate', driver: 'meta-update' },
  { door: 'server/src/api/spaces.ts::DELETE /:id', driver: 'delete-space' },
  { door: 'server/src/spaces/wipe-vote.ts::openSpaceWipeRounds', driver: 'wipe' },
  { door: 'server/src/networks/member-acts.ts::addMemberAct', driver: 'member-add' },
  { door: 'server/src/networks/member-acts.ts::removeMemberAct', driver: 'member-remove' },
  { door: 'server/src/networks/member-acts.ts::admitByInviteKeyAct', driver: 'invite-key-join' },
  {
    door: 'server/src/api/invite.ts::POST /finalize',
    exempt: 'the invite handshake answers the JOINING instance, whose roundId is the key it polls with; it holds no operator to project for',
  },
]);

/** The drivers the driven half must implement: every row that is not exempt. */
export const DRIVERS = Object.freeze(DOORS.filter(d => d.driver).map(d => d.driver));

/**
 * What a round carries that is not for an operator (`NOT_FOR_AN_OPERATOR`, `networks/vote-acts.ts`): the proposal body and what it was
 * computed from, a candidate's credential record, the invite key's hash. Read from the source by the driven half, so a field added
 * to the server's list is in the check without this file being told; this constant is only the floor the derivation must clear.
 */
export const NOT_FOR_AN_OPERATOR_FLOOR = Object.freeze(['pendingMeta', 'metaBase', 'pendingMember', 'inviteKeyHash']);
