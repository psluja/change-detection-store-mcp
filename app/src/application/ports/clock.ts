/** Time source; injected so handlers are deterministic under test. */
export interface Clock {
  now(): Date;
}
