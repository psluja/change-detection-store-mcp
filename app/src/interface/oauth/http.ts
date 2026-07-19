/** Transport-agnostic HTTP response; structurally compatible with Lambda results. */
export interface HttpResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export function jsonResponse(
  statusCode: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): HttpResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload),
  };
}

export function redirectResponse(location: string): HttpResponse {
  return { statusCode: 302, headers: { location }, body: '' };
}

/** RFC 6749 error shape for OAuth endpoints. */
export function oauthErrorResponse(
  statusCode: number,
  error: string,
  description: string,
): HttpResponse {
  return jsonResponse(statusCode, { error, error_description: description });
}
