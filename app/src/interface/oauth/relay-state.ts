/**
 * State relayed through Cognito during the authorize round-trip: the client's
 * own state plus its redirect URI. Not signed — the callback re-validates the
 * redirect URI against the allowlist, which is what actually prevents abuse
 * (an attacker cannot bounce a code to a URI outside the allowlist).
 */
export interface RelayState {
  readonly redirectUri: string;
  readonly clientState?: string;
}

export function encodeRelayState(state: RelayState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

export function decodeRelayState(encoded: string): RelayState | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as { redirectUri?: unknown }).redirectUri === 'string'
    ) {
      const clientState = (parsed as { clientState?: unknown }).clientState;
      if (clientState === undefined || typeof clientState === 'string') {
        return parsed as RelayState;
      }
    }
  } catch {
    // fall through
  }
  return undefined;
}
