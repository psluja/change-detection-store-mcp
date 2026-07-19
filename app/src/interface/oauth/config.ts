/** OAuth wiring; all values are non-secret identifiers (the client secret has its own port). */
export interface OAuthConfig {
  readonly userPoolId: string;
  readonly clientId: string;
  /** Cognito hosted UI base URL, e.g. https://cds-auth-x.auth.eu-central-1.amazoncognito.com */
  readonly cognitoDomain: string;
  /** Membership in this Cognito group authorizes MCP access (claim cognito:groups). */
  readonly requiredGroup: string;
  /** Exact-match allowlist for client redirect URIs (Claude callback URLs). */
  readonly allowedRedirectUris: readonly string[];
}
