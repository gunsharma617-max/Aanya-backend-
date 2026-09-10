import {
  errorResponse,
  guardRequest,
  HttpError,
  isRecord,
  preflight,
  readJson,
  responseHeaders,
  upstreamLifetime,
} from "@/lib/http";
import { pcm16ToWav } from "@/lib/wav";

export const runtime = "nodejs";
export const maxDuration = 60;

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/" +
  "gemini-3.1-flash-tts-preview:generateContent";

const GENERIC_ERROR =
  "Speech generation is temporarily unavailable. Please try again.";

const MAX_TEXT_LENGTH = 2000;
const MAX_AUDIO_BASE64_LENGTH = 32 * 1024 * 1024;

function validateInput(body: unknown): string {
  if (
    !isRecord(body) ||
    typeof body.text !== "string" ||
    body.text.trim().length === 0
  ) {
    throw new HttpError(400, "Provide non-empty text.");
  }

  if (body.text.length > MAX_TEXT_LENGTH) {
    throw new HttpError(
      400,
      `Text must not exceed ${MAX_TEXT_LENGTH} characters.`,
    );
  }

  if (body.voice !== "Leda") {
    throw new HttpError(400, 'Voice must be "Leda".');
  }

  return body.text;
}

function extractAudio(payload: unknown): {
  pcm: Uint8Array;
  sampleRate: number;
} {
  if (!isRecord(payload) || !Array.isArray(payload.candidates)) {
    throw new Error("Invalid audio response");
  }

  const candidate: unknown = payload.candidates[0];

  if (!isRecord(candidate) || !isRecord(candidate.content)) {
    throw new Error("Invalid audio response");
  }

  const parts = candidate.content.parts;

  if (!Array.isArray(parts)) {
    throw new Error("Invalid audio response");
  }

  // Usually parts[0]; scanning also tolerates accompanying non-audio parts.
  for (const part of parts as unknown[]) {
    if (!isRecord(part) || !isRecord(part.inlineData)) continue;

    const { data, mimeType } = part.inlineData;

    if (
      typeof data !== "string" ||
      data.length === 0 ||
      data.length > MAX_AUDIO_BASE64_LENGTH ||
      data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
    ) {
      throw new Error("Invalid audio response");
    }

    if (
      mimeType !== undefined &&
      (typeof mimeType !== "string" ||
        !/^audio\/(?:L16|pcm)(?:\s*;|$)/i.test(mimeType))
    ) {
      throw new Error("Invalid audio response");
    }

    let sampleRate = 24000;

    if (typeof mimeType === "string") {
      const rateParameter = mimeType
        .split(";")
        .slice(1)
        .find((parameter) => /^\s*rate\s*=/i.test(parameter));

      if (rateParameter !== undefined) {
        const match = /^\s*rate\s*=\s*"?(\d+)"?\s*$/i.exec(rateParameter);

        if (!match) {
          throw new Error("Invalid audio response");
        }

        sampleRate = Number(match[1]);
      }
    }

    return {
      pcm: Buffer.from(data, "base64"),
      sampleRate,
    };
  }

  throw new Error("No audio returned");
}

export function OPTIONS(request: Request): Response {
  return preflight(request);
}

export async function POST(request: Request): Promise<Response> {
  let lifetime: ReturnType<typeof upstreamLifetime> | undefined;

  try {
    guardRequest(request, "tts");

    const text = validateInput(await readJson(request, 32 * 1024));
    const apiKey = process.env.AI_API_KEY?.trim();

    if (!apiKey) {
      throw new HttpError(503, "Speech service is not configured.");
    }

    lifetime = upstreamLifetime(request.signal);

    // Never log this URL: the provider's required query contains a secret.
    const url = new URL(GEMINI_URL);
    url.searchParams.set("key", apiKey);

    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text }],
          },
        ],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Leda",
              },
            },
          },
        },
      }),
      signal: lifetime.signal,
      cache: "no-store",
      redirect: "error",
    });

    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => undefined);
      throw new HttpError(502, GENERIC_ERROR);
    }

    const payload: unknown = await upstream.json();
    const { pcm, sampleRate } = extractAudio(payload);
    const wav = pcm16ToWav(pcm, sampleRate);

    return new Response(new Uint8Array(wav), {
      status: 200,
      headers: responseHeaders({
        "Content-Type": "audio/wav",
        "Content-Length": String(wav.byteLength),
      }),
    });
  } catch (error) {
    return errorResponse(error, "json", GENERIC_ERROR);
  } finally {
    lifetime?.dispose();
  }
}
