/**
 * OAuth discovery documents. Cowork connects custom MCP servers only through
 * OAuth 2.0: on a 401 it fetches the protected-resource metadata (RFC 9728),
 * follows it to the authorization-server metadata (RFC 8414) and drives the
 * authorization-code + PKCE flow against our proxy endpoints.
 */

export function protectedResourceMetadata(baseUrl: string): Record<string, unknown> {
  return {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: ['openid', 'email', 'profile'],
  };
}

export function authorizationServerMetadata(baseUrl: string): Record<string, unknown> {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/auth/authorize`,
    token_endpoint: `${baseUrl}/auth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    // The client authenticates with PKCE only; this proxy injects the Cognito
    // client secret upstream. No dynamic client registration — the Client ID
    // is entered manually in the connector's advanced settings.
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['openid', 'email', 'profile'],
  };
}
