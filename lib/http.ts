export function errorResponse(
  error: unknown,
  format: "json" | "sse",
  fallback: string,
): Response {
  const status = error instanceof HttpError ? error.status : 502;

  const message =
    error instanceof HttpError ? error.publicMessage : fallback;

  const headers =
    format === "sse"
      ? sseHeaders()
      : responseHeaders({
          "Content-Type": "application/json",
        });

  if (error instanceof HttpError && error.retryAfter) {
    headers.set("Retry-After", String(error.retryAfter));
  }

  const payload = JSON.stringify({ error: message });

  const body =
    format === "sse"
      ? `data: ${payload}\n\n`
      : payload;

  return new Response(body, {
    status,
    headers,
  });
}
