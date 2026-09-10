# Aanya Backend

Backend-only Next.js App Router API for the existing Aanya frontend.

## Requirements

- Node.js 20.9 or newer
- An NVIDIA API key with access to the configured chat model
- A Google API key with access to the specified Gemini TTS model

## Setup

```bash
npm install
cp .env.local.example .env.local
```

Set these server-side variables in `.env.local`:

| Variable | Purpose |
| --- | --- |
| `NVIDIA_API_KEY` | NVIDIA API credential |
| `NVIDIA_MODEL` | Optional chat model override |
| `AI_API_KEY` | Google Gemini API credential |
| `ALLOWED_ORIGIN` | Exact frontend origin, including scheme and port if applicable |

When `NVIDIA_MODEL` is blank, the backend uses:

`deepseek-ai/deepseek-v4-pro-0813`

The TTS route uses:

`gemini-3.1-flash-tts-preview`

These identifiers match the requested contract. Verify that your provider
accounts support them; provider availability is not guaranteed by this project.

For local development, set `ALLOWED_ORIGIN` to the frontend's origin,
for example `http://localhost:3000`. Do not include an API path or wildcard.

Never use `NEXT_PUBLIC_` for provider credentials.

## Local development

```bash
npm run dev
```

If the frontend already occupies port 3000:

```bash
npm run dev -- --port 3001
```

Check and build:

```bash
npm run build
npm run typecheck
```

Commit the generated `package-lock.json` for reproducible installations.
Do not commit `.env.local`.

There is no frontend or home page in this repository.

## API

### POST /api/chat

```json
{
  "messages": [
    {
      "role": "user",
      "content": "Hello, Aanya!"
    }
  ]
}
```

Successful output is SSE:

```text
data: {"delta":"Hello!"}

data: {"done":true}

```

Errors use:

```text
data: {"error":"Chat is temporarily unavailable. Please try again."}

```

Validation failures return HTTP 400 with the SSE error shape.
Oversized request bodies return 413, and rate limits return 429.

Provider failures before streaming return 502 with a generic SSE error.
After streaming begins, HTTP status cannot change; an SSE error event
indicates failure. Failed streams do not also emit `done`.

Persona configuration: `lib/persona.ts`.

### POST /api/tts

```json
{
  "text": "Hello, I am Aanya.",
  "voice": "Leda"
}
```

Returns `audio/wav`: mono PCM16 with a 44-byte WAV header.

Text must be non-empty and no longer than 2000 characters.
Only the Leda voice is accepted.

Errors return JSON:

```json
{
  "error": "Speech generation is temporarily unavailable. Please try again."
}
```

## Deploy to Vercel

1. Create a separate Git repository containing this backend.
2. Push it to GitHub.
3. Import the repository as a new Vercel project.
4. Select the Next.js framework preset if it is not detected automatically.
5. Add the server-side environment variables in Vercel project settings.
6. Set `ALLOWED_ORIGIN` to the deployed frontend's exact origin.
7. Deploy.
8. Redeploy after changing environment variables.

Both routes request a maximum duration of 60 seconds and abort provider
requests after 50 seconds. Check that your Vercel plan supports the configured
duration.

Preview deployments need an `ALLOWED_ORIGIN` appropriate to the frontend
that will call them. Each deployment allows only one configured origin.

## Connect the existing frontend

In Aanya, open:

**Settings → AI connection**

Set its backend/base URL to the deployed backend origin:

```text
https://your-aanya-backend.vercel.app
```

The existing frontend should call:

- `POST https://your-aanya-backend.vercel.app/api/chat`
- `POST https://your-aanya-backend.vercel.app/api/tts`

Use the base origin when the setting expects a backend URL, rather than
appending `/api/chat`. If the frontend instead has separate endpoint fields,
use the full route URLs above.

Do not enter provider API keys into frontend settings. They belong only
in the backend environment.

This requires the existing AI connection setting to support these backend
routes; this repository does not change frontend configuration behavior.

## Security and operational notes

- CORS permits one configured frontend origin.
- Requests with a different Origin are rejected.
- Requests without Origin are allowed for command-line and server clients.
- CORS is not authentication and does not prevent direct API calls.
- Each route has a separate 20-requests/minute per-IP limit.
- The limiter is bounded and in-memory. On Vercel, limits are per warm
  instance and reset on cold starts; they are not deployment-wide.
- Use a shared Redis-backed limiter, authentication, and provider spending
  limits if this becomes a public or high-traffic service.
- IP detection assumes a trusted deployment proxy supplies
  `X-Forwarded-For`. Revisit this before self-hosting.
- Client cancellation and timeouts abort provider requests.
- Provider error bodies, credentials, and arbitrary exceptions are never
  returned or logged by application code.
- Google authentication uses the requested query-string key. Configure any
  additional tracing or HTTP instrumentation to redact query strings and
  authorization headers; do not enable raw provider request logging.
