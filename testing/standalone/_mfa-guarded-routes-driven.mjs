/**
 * The routes the held-space tests drive behind the second-factor guard (`requireSpaceAuthMfaScoped`), one of each family, as the route
 * table spells them (`:id` the space).
 *
 * Shared by the -db test that drives them on a held space and the pure test that holds them to the route table, so the two cannot name
 * different routes; the route-table case lives in a pure file because the local preflight never runs a -db file.
 */
export const MFA_GUARDED_ROUTES_DRIVEN = [
  { method: 'POST', path: '/api/brain/spaces/:spaceId/reindex', body: {} },
  { method: 'POST', path: '/api/spaces/:id/reembed', body: {} },
  { method: 'POST', path: '/api/spaces/:id/validate-schema', body: {} },
];
