/**
 * Domain telemetry emitted by the interface layer. Backed by CloudWatch EMF
 * in production (structured log lines, zero API calls) and a no-op locally.
 */
export interface Telemetry {
  /** A tool invocation started (counted for every call, success or not). */
  toolCalled(tool: string): void;
  /** A tool returned a typed domain error (client-fixable; fine in small numbers). */
  toolErrored(tool: string, code: string): void;
  /** A tool hit an unexpected error (a bug — alarmed, expected to be zero). */
  internalError(tool: string): void;
  /** Change-detection outcome of a patch: new versions written vs no-op polls. */
  changeOutcomes(changed: number, unchanged: number): void;
  /** The OAuth gate rejected a request: invalid token (401) vs missing group (403). */
  authRejected(outcome: 'unauthorized' | 'forbidden'): void;
}

export const NOOP_TELEMETRY: Telemetry = {
  toolCalled: () => undefined,
  toolErrored: () => undefined,
  internalError: () => undefined,
  changeOutcomes: () => undefined,
  authRejected: () => undefined,
};
