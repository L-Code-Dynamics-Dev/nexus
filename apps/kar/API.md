# Kár API contract (v1)

All `/api/*` requests, including health checks and unknown paths, are independently authenticated by the Worker using the Cloudflare Access JWT, configured issuer JWKS, exact audience, expiration and signature. Browser POST requests are also checked for an exact same-origin `Origin`; there is no permissive CORS policy. The custom-domain Worker configuration disables `workers_dev` and preview URLs, so it has no intended alternate `workers.dev` ingress. These source/config checks do not prove that the Cloudflare Access application and DNS are configured correctly in the account; verify them before deployment.

## `GET /api/health`

Returns `{ "ok": true, "service": "kar" }` after Access verification. This reports only that the Worker responded, not that model or TTS endpoints are healthy.

## `POST /api/chat`

Headers: `Content-Type: application/json`, browser-generated `Origin` exactly matching `PUBLIC_ORIGIN`, and Cloudflare Access JWT assertion.

Request:

```json
{
  "messages": [
    { "role": "user", "content": "Review this design…" },
    { "role": "assistant", "content": "…" },
    { "role": "user", "content": "What would you change?" }
  ],
  "personalityId": "KAR_STANDARD_CZ"
}
```

Only `user` and `assistant` roles are accepted. The server inserts the fixed Kár system prompt; client-supplied system/developer/tool roles are rejected. Limits: 20 messages, 8,000 characters per message, 30,000 total conversation characters, and 48,000 request bytes. Output is capped at 900 model tokens. Requests are limited to 30 per minute per verified Access subject by the Cloudflare Worker Rate Limiting binding.

Success is an `text/event-stream` response in OpenAI chat-completion SSE format. Errors return JSON and include no provider response bodies or credentials. `429` includes `Retry-After`; common responses are `400`, `401`, `403`, `413`, `415`, `429`, `502`, `503`, and `504`.

The model URL and Bearer credential are server-side Worker secrets. Only HTTPS model URLs are accepted. Conversations are not persisted. `personalityId` is one of `KAR_STANDARD_CZ`, `KAR_UNCENSORED_CZ`, or `KAR_PEPA_ROAST`; the Worker maps it to a fixed server-side prompt and rejects other values. `KAR_PEPA_ROAST` additionally requires the configured Pepa Access subject and a valid signed opt-in cookie. Personality does not relax safety or accuracy requirements.

## `GET /api/session`

Requires a verified Access JWT. Returns `pepaRoastEligible` only when the signed Access `sub` equals server secret `PEPA_ACCESS_SUBJECT`; returns `pepaRoastEnabled` only when the account-bound signed consent cookie is valid. The subject or email is not returned to the browser.

## `POST /api/settings/pepa-roast`

Requires Pepa's verified Access identity, exact same-origin `Origin`, and JSON `{ "enabled": true }` or `{ "enabled": false }`. Enabling sets a one-year Secure, HttpOnly, SameSite=Strict cookie signed with `PEPA_ROAST_COOKIE_SECRET`; disabling clears it. Chat requests using `KAR_PEPA_ROAST` are rejected unless both identity and consent validate. Consent is account-bound, and requests from another account cannot reuse it.

## `POST /api/speech`

Requires the same Cloudflare Access JWT and exact same-origin `Origin` as `/api/chat`. Request JSON is `{ "text": "…", "profileId": "KAR_HOMER_CZ" }`. Text is limited to 4,000 characters. Profile IDs are `KAR_HOMER_CZ` and `KAR_NORMAL_CZ`; voice IDs are selected only from server configuration and cannot be supplied by the browser. Per-subject rate limiting is shared with chat.

When configured, the Worker sends an OpenAI-compatible speech request to `SPEECH_API_URL`, with `{ model, voice, input, response_format: "mp3" }`, using a server-side bearer credential. Accepted responses are MP3, WAV, or OGG, capped at 12 MB, and marked private/no-store. A missing model or voice mapping returns `503`; it never claims model TTS succeeded. The UI then uses browser speech synthesis as a clearly disclosed approximate fallback. A provider-specific or local model can be connected behind this same endpoint and stable profile IDs without changing the chat UI.

The optional uncensored personality is independent of voice selection. It can use the Homer-inspired configured voice when `KAR_HOMER_CZ` is selected. `KAR_HOMER_CZ` is an original style brief, not an imitation or clone of a named Czech actor or dubber.
