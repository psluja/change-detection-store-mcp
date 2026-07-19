/**
 * Verdict split matters: 'unauthorized' (401) means the token is not valid,
 * 'forbidden' (403) means a valid user lacks the required group.
 */
export type AccessTokenVerdict =
  | { readonly status: 'ok'; readonly subject: string }
  | { readonly status: 'unauthorized' }
  | { readonly status: 'forbidden' };

/** Validates a bearer access token (signature, issuer, client, expiry, group). */
export interface AccessTokenVerifier {
  verify(token: string): Promise<AccessTokenVerdict>;
}

/** Supplies the Cognito app client secret (from Secrets Manager in production). */
export interface ClientSecretProvider {
  getClientSecret(): Promise<string>;
}
