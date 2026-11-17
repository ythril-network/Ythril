/**
 * The OIDC sign-in settings: `Config.oidc` and the claim mapping it carries.
 *
 * Split out of `types.ts` (Q-730) when the file passed its size limit: the section had one reader, the sign-in flow (`auth/oidc.ts`,
 * `api/oidc.ts`), and no field of any other type in it, so it moved WHOLE with every field and docblock, and `types.ts` re-exports it so
 * no importer changes. It imports nothing, so it cannot become half of a module cycle.
 */

/** Maps a single IdP claim to an Ythril permission.
 *  `claim` supports dot-notation for nested objects (e.g. "realm_access.roles"). */
export interface OidcClaimRule {
  /** Dot-notated path to the claim value in the JWT payload. */
  claim: string;
  /** When present, the claim must equal this value (or be an array containing it).
   *  When absent, the claim merely needs to be truthy. */
  value?: string;
}

export interface OidcClaimMapping {
  /** When matched, the user is granted admin access. */
  admin?: OidcClaimRule;
  /** When matched, the user is restricted to read-only access. */
  readOnly?: OidcClaimRule;
  /** When matched, the claim value is treated as the list of allowed space IDs.
   *  The claim itself must be a JSON array of strings. */
  spaces?: OidcClaimRule;
  /**
   * When true, any OIDC token that does not match the `admin` or `readOnly`
   * rule is rejected with 401.  PAT tokens are unaffected.
   * Default: false (unmatched tokens are accepted with no special permissions).
   */
  requireMatch?: boolean;
}

export interface OidcConfig {
  /** Set to true to enable OIDC authentication. Default: false. */
  enabled: boolean;
  /** Base URL of the IdP realm, e.g. https://keycloak.example.com/realms/my-realm.
   *  The well-known discovery URL is derived by appending
   *  /.well-known/openid-configuration */
  issuerUrl: string;
  /** OAuth2 client ID registered at the IdP. */
  clientId: string;
  /** Expected `aud` claim value in issued JWTs.
   *  Defaults to `clientId` when omitted. */
  audience?: string;
  /** Scopes to request during the authorization code flow.
   *  Defaults to ["openid", "profile", "email"]. */
  scopes?: string[];
  /** JWS algorithms accepted when verifying ID tokens. Defaults to the
   *  asymmetric set in `DEFAULT_OIDC_ALGORITHMS` (RS/PS/ES/EdDSA). Override only
   *  to NARROW it (e.g. ["RS256"]); adding an HMAC alg would let anyone holding
   *  the shared secret mint tokens. */
  allowedAlgorithms?: string[];
  /** Maps IdP JWT claims to Ythril permission flags. */
  claimMapping?: OidcClaimMapping;
  /**
   * When true, the browser SPA rejects cached PAT (Personal Access Token)
   * sessions and forces re-authentication through the IdP.  PATs continue to
   * work for programmatic access (API / MCP via Authorization: ******;
   * only the browser localStorage session path is gated.
   * Default: false.  The API endpoint (`/api/auth/oidc-info`) normalises an
   * absent value to `false` so clients always receive a boolean.
   */
  enforceForBrowser?: boolean;
  /**
   * URI the IdP should redirect to after a successful end-session request.
   * Passed as `post_logout_redirect_uri` to the IdP's end_session_endpoint.
   * Defaults to the instance origin (i.e. the login page).
   */
  postLogoutRedirectUri?: string;
  /**
   * Allow the issuer — and the endpoints its discovery document names — to live on a
   * private/reserved address. An internal IdP is a normal deployment (Keycloak on
   * `http://keycloak.internal:8080`, Authentik on a cluster service, Dex on `10.x`), and the
   * default is public-only, so **that deployment needs this flag or nobody can sign in**.
   *
   * Enabling it does NOT drop the egress guard: discovery and JWKS still go through
   * `ssrfSafeFetch`, which DNS-resolves, pins the resolved IP for the connection and re-validates
   * every redirect — only the private-address rejection relaxes. Crown-jewel addresses (loopback,
   * link-local / cloud IMDS, unspecified) stay blocked either way, including when a hostname
   * resolves to one.
   *
   * The allowance is scoped to the issuer's own address class: a PUBLIC issuer may never hand back
   * a private `jwks_uri`, flag or no flag. Mirrors `allowPrivateModelEndpoints`.
   * Overridable via YTHRIL_OIDC_ALLOW_PRIVATE_ISSUER.
   */
  allowPrivateIssuer?: boolean;
}
