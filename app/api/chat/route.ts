import {
  errorResponse,
  guardRequest,
  HttpError,
  isRecord,
  preflight,
  readJson,
  sseEvent,
  sseHeaders,
  upstreamLifetime,
} from "@/lib/http";
import { AANYA_SYSTEM_PROMPT } from "@/lib/persona";
import { parseSse } from "@/lib/sse";

export const runtime = "nodejs";
export const maxDuration = 60;

const NVIDIA_URL =
  "https://integrate.api.nvidia.com/v1/chat/completions";

const DEFAULT_MODEL = "deepseek-ai/deepseek-v4-pro-0813";
const GENERIC_ERROR = "Chat is temporarily unavailable. Please try again.";

type Message = {
  role: "user" | "assistant" | "system";
  content: string;
};

function validateMessages(body: unknown): Message[] {
  if (
    !isRecord(body) ||
    !Array.isArray(body.messages) ||
    body.messages.length === 0 ||
    body.messages.length > 100
  ) {
    throw new HttpError(400, "Provide between 1 and 100 messages.");
  }

  let totalCharacters = 0;

  return body.messages.map((message: unknown): Message => {
    if (
      !isRecord(message) ||
      !["user", "assistant", "system"].includes(String(message.role)) ||
      typeof message.content !== "string" ||
      message.content.trim().length === 0 ||
      message.content.length > 16_000
    ) {
      throw new HttpError(400, "Each message must have a valid role and content.");
    }

    totalCharacters += message.content.length;

    if (totalCharacters > 60_000) {
      throw new HttpError(400, "Conversation is too long.");
    }

    return {
      role: message.role as Message["role"],
      content: message.content,
    };
  });
}

async function* chatEvents(
  body: ReadableStream<Uint8Array>,
  lifetime: ReturnType<typeof upstreamLifetime>,
): AsyncGenerator<Uint8Array, void, unknown> {
  try {
    for await (const data of parseSse(body)) {
      if (data.trim() === "[DONE]") {
        yield sseEvent({ done: true });
        return;
      }

      const event: unknown = JSON.parse(data);

      if (
        !isRecord(event) ||
        "error" in event ||
        !Array.isArray(event.choices)
      ) {
        throw new Error("Invalid provider event");
      }

      // Empty choices can occur in usage-only events.
      const choice: unknown = event.choices[0];

      if (choice === undefined) continue;

      if (!isRecord(choice)) {
        throw new Error("Invalid provider event");
      }

      if (choice.delta === undefined || choice.delta === null) continue;

      if (!isRecord(choice.delta)) {
        throw new Error("Invalid provider event");
      }

      const content = choice.delta.content;

      if (content !== undefined && content !== null) {
        if (typeof content !== "string") {
          throw new Error("Invalid provider event");
        }

        if (content.length > 0) {
          yield sseEvent({ delta: content });
        }
      }

      // Do not forward provider metadata, reasoning fields, or tool calls.
    }

    // A disconnected stream must not be mistaken for successful completion.
    throw new Error("Provider stream ended before completion");
  } finally {
    lifetime.dispose();
  }
}

export function OPTIONS(request: Request): Response {
  return preflight(request);
}

export async function POST(request: Request): Promise<Response> {
  let lifetime: ReturnType<typeof upstreamLifetime> | undefined;

  try {
    guardRequest(request, "chat");

    const messages = validateMessages(await readJson(request));
    const apiKey = process.env.NVIDIA_API_KEY?.trim();

    if (!apiKey) {
      throw new HttpError(503, "Chat service is not configured.");
    }

    lifetime = upstreamLifetime(request.signal);

    const upstream = await fetch(NVIDIA_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: process.env.NVIDIA_MODEL?.trim() || DEFAULT_MODEL,
        messages: [
          { role: "system", content: AANYA_SYSTEM_PROMPT },
          ...messages,
        ],
        stream: true,
      }),
      signal: lifetime.signal,
      cache: "no-store",
      redirect: "error",
    });

    if (
      !upstream.ok ||
      !upstream.body ||
      !upstream.headers.get("content-type")?.includes("text/event-stream")
    ) {
      await upstream.body?.cancel().catch(() => undefined);
      throw new HttpError(502, GENERIC_ERROR);
    }

    const streamLifetime = lifetime;
    const iterator = chatEvents(upstream.body, streamLifetime);
    let cancelled = false;

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await iterator.next();

          if (cancelled) return;

          if (result.done) {
            controller.close();
          } else {
            controller.enqueue(result.value);
          }
        } catch {
          streamLifetime.dispose();

          if (!cancelled) {
            controller.enqueue(sseEvent({ error: GENERIC_ERROR }));
            controller.close();
          }
        }
      },

      async cancel() {
        cancelled = true;
        streamLifetime.dispose();
        await iterator.return(undefined).catch(() => undefined);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: sseHeaders(),
    });
  } catch (error) {
    lifetime?.dispose();

    return errorResponse(error, "sse", GENERIC_ERROR);
  }
}
