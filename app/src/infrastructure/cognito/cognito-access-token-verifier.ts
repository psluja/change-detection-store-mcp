import { CognitoJwtVerifier } from 'aws-jwt-verify';

import type { AccessTokenVerdict, AccessTokenVerifier } from '../../interface/oauth/ports.js';

export interface CognitoVerifierConfig {
  readonly userPoolId: string;
  readonly clientId: string;
  readonly requiredGroup: string;
}

/** Separate factory so the verifier's exact (inferred) type can be reused below. */
function createPoolVerifier(config: CognitoVerifierConfig) {
  return CognitoJwtVerifier.create({
    userPoolId: config.userPoolId,
    clientId: config.clientId,
    tokenUse: 'access',
  });
}

type PoolVerifier = ReturnType<typeof createPoolVerifier>;

/**
 * Validates Cognito access tokens: signature against the pool's JWKS (cached
 * by aws-jwt-verify), issuer, client_id, token_use and expiry. Group
 * membership is checked separately so the caller can distinguish 401
 * (invalid token) from 403 (valid user without the required group).
 */
export class CognitoAccessTokenVerifier implements AccessTokenVerifier {
  private readonly verifier: PoolVerifier;

  constructor(private readonly config: CognitoVerifierConfig) {
    this.verifier = createPoolVerifier(config);
  }

  /** Test hook: preload the JWKS so verification never touches the network. */
  cacheJwks(jwks: Parameters<PoolVerifier['cacheJwks']>[0]): void {
    this.verifier.cacheJwks(jwks);
  }

  async verify(token: string): Promise<AccessTokenVerdict> {
    let payload;
    try {
      payload = await this.verifier.verify(token);
    } catch {
      return { status: 'unauthorized' };
    }
    const groups = payload['cognito:groups'];
    const isMember = Array.isArray(groups) && groups.includes(this.config.requiredGroup);
    return isMember ? { status: 'ok', subject: payload.sub } : { status: 'forbidden' };
  }
}
