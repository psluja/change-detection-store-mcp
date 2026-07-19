export type JsonPrimitive = string | number | boolean | null;

/** Any JSON value, as produced by JSON.parse / the MCP JSON-RPC layer. */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
