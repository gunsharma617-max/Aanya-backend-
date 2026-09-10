import "server-only";

const WINDOW_MS = 60_000;
const REQUEST_LIMIT = 20;
const MAX_BUCKETS = 10_000;

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly publicMessage: string,
    public readonly retryAfter?: number,
  ) {
    super(publicMessage);
    this.name = "HttpError";
  }
}

export function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function allowedOrigin(): string | null {
  const raw = process.env.ALLOWED_ORIGIN?.trim();

  if (!raw) return null;

  try {
    const url = new URL(raw);

    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

export function responseHeaders(
  initial?: HeadersInit,
): Headers {
  const headers = new Headers(initial);
  const origin = allowedOrigin();

  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
  }

  headers.set("Vary", "Origin");
  headers.set("X-Content-Type-Options", "nosniff");

  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }

  return headers;
}

function checkOrigin(request: Request): void {
  const configured = allowedOrigin();

  if (!configured) {
    throw new HttpError(503, "Service is not configured.");
  }

  const origin = request.headers.get("origin");

  // Allow clients without Origin, such as curl.
  // CORS is not authentication.
  if (origin !== null && origin !== configured) {
    throw new HttpError(403, "Origin is not allowed.");
  }
}

function checkRateLimit(
  request: Request,
  route: "chat" | "tts",
): void {
  const now = Date.now();

  if (now - lastSweep >= WINDOW_MS) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) {
        buckets.delete(key);
      }
    }

    lastSweep = now;
  }

  // Requires a trusted proxy that overwrites this header.
  // Rate limits are per process, not deployment-wide.
  const ip =
    request.headers
      .get("x-forwarded-for")
      ?.split(",")[0]
      ?.trim() || "unknown";

  const key = `${route}:${ip}`;
  let bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    if (!bucket && buckets.size >= MAX_BUCKETS) {
      throw new HttpError(
        429,
        "Too many requests. Please try again later.",
        60,
      );
    }

    bucket = {
      count: 0,
      resetAt: now + WINDOW_MS,
    };

    buckets.set(key, bucket);
  }

  if (bucket.count >= REQUEST_LIMIT) {
    throw new HttpError(
      429,
      "Too many requests. Please try again later.",
      Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    );
  }

  bucket.count += 1;
}

export function guardRequest(
  request: Request,
  route: "chat" | "tts",
): void {
  checkOrigin(request);
  checkRateLimit(request, route);
}

export function preflight(request: Request): Response {
  try {
    checkOrigin(request);

    return new Response(null, {
      status: 204,
      headers: responseHeaders({
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
      }),
    });
  } catch (error) {
    return errorResponse(
      error,
      "json",
      "Request could not be processed.",
    );
  }
}

export async function readJson(
  request: Request,
  maxBytes = 128 * 1024,
): Promise<unknown> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();

  if (contentType !== "application/json") {
    throw new HttpError(
      400,
      "Content-Type must be application/json.",
    );
  }

  if (!request.body) {
    throw new HttpError(400, "A JSON body is required.");
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", {
    fatal: true,
  });

  let size = 0;
  let text = "";

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) break;

      size += value.byteLength;

      if (size > maxBytes) {
        throw new HttpError(
          413,
          "Request body is too large.",
        );
      }

      text += decoder.decode(value, {
        stream: true,
      });
    }

    text += decoder.decode();

    return JSON.parse(text) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => undefined);

    if (error instanceof HttpError) {
      throw error;
    }

    throw new HttpError(400, "Invalid JSON body.");
  } finally {
    reader.releaseLock();
  }
}

const encoder = new TextEncoder();

export function sseEvent(
  payload:
    | { delta: string }
    | { done: true }
    | { error: string },
): Uint8Array {
  return encoder.encode(
    `data: ${JSON.stringify(payload)}\n\n`,
  );
}

export function sseHeaders(): Headers {
  return responseHeaders({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
}

export function errorResponse(
  error: unknown,
  format: "json" | "sse",
  fallback: string,
): Response {
  // Only deliberately constructed public errors are exposed.
  // Never serialize provider errors or arbitrary exceptions.
  const status =
    error instanceof HttpError ? error.status : 502;

  const message =
    error instanceof HttpError
      ? error.publicMessage
      : fallback;

  const headers =
    format === "sse"
      ? sseHeaders()
      : responseHeaders({
          "Content-Type": "application/json",
        });

  if (error instanceof HttpError && error.retryAfter) {
    headers.set(
      "Retry-After",
      String(error.retryAfter),
    );
  }

  const payload = JSON.stringify({
    error: message,
  });

  // A string avoids the Uint8Array / BodyInit type mismatch.
  const body =
    format === "sse"
      ? `data: ${payload}\n\n`
      : payload;

  return new Response(body, {
    status,
    headers,
  });
}

export function upstreamLifetime(
  clientSignal: AbortSignal,
  timeoutMs = 50_000,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();

  clientSignal.addEventListener("abort", abort, {
    once: true,
  });

  if (clientSignal.aborted) {
    abort();
  }

  const timer = setTimeout(abort, timeoutMs);
  let disposed = false;

  return {
    signal: controller.signal,

    dispose() {
      if (disposed) return;

      disposed = true;
      clearTimeout(timer);

      clientSignal.removeEventListener(
        "abort",
        abort,
      );

      controller.abort();
    },
  };
      }
