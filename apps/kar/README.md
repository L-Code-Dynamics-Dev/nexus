# Kár web chat

Cloudflare Worker + static frontend for `kar.l-code-dynamics.com`. This is an initial private chat surface. It verifies Cloudflare Access JWT signatures on every `/api/*` path, rate-limits by Access subject, keeps model tokens server-side, limits request size/history, and proxies streamed OpenAI-compatible chat completions.

## Current boundary

- The UI has text input, browser dictation (`SpeechRecognition`) and speech output behind the `KarSpeechOutput` adapter contract. Voice profiles are `KAR_HOMER_CZ` and `KAR_NORMAL_CZ`; default is `KAR_HOMER_CZ`. Personality profiles are independently selectable: `KAR_STANDARD_CZ` and `KAR_UNCENSORED_CZ`. The latter permits uncensored Czech comic profanity while keeping technical clarity and safety constraints. Dictation is controlled by the browser and may use its speech service; the UI discloses this. No raw audio is uploaded to the Worker.
- Worker `POST /api/speech` supports any HTTPS OpenAI-compatible audio speech endpoint, selected voice IDs remain server-side, and output is capped and non-cacheable. If no TTS model is configured, the UI falls back to browser speech with an explicit approximate-profile notice. Browser pitch/rate controls cannot guarantee a deep, raspy expressive voice. The profile is original and does not clone a named actor or dubber. Replacing the backend speech provider does not require frontend changes.
- Chat data is held in page memory and disappears on refresh. The app does not store conversations or provide Nexus source-code context yet.
- The Worker does not execute shell commands, tools, repository writes, deployments, or security scans. It is a chat proxy only.
- The model endpoint must implement `POST /v1/chat/completions`, Bearer token auth, and OpenAI-compatible SSE chunks. The environment points at the complete endpoint URL.
- The Runpod pod, `kar_chat.py`, DNS, Cloudflare Access application, and model endpoint could not be reached from the build environment. Do not infer that they are running or compatible. Preserve `kar_chat.py`; inspect it and add a narrow adapter only after its actual interface is available.

## Required Cloudflare setup

1. In Cloudflare Zero Trust, create an Access application for `kar.l-code-dynamics.com/*`. Restrict it to the named project operators using the selected identity provider and MFA. Apply the Access policy before publishing the app. Configure an aud tag for this app.
2. Choose a unique positive integer `namespace_id` for the Worker rate-limit binding in `wrangler.jsonc`; `2026100901` is a proposed value and must be checked against this account's other Worker bindings before deploy. The limit is 30 chat requests per minute per Access subject and is applied at Cloudflare locations.
3. Configure secrets (values are intentionally not in git):

   ```sh
   npx wrangler secret put MODEL_API_URL --config apps/kar/wrangler.jsonc
   npx wrangler secret put MODEL_API_TOKEN --config apps/kar/wrangler.jsonc
   npx wrangler secret put MODEL_ID --config apps/kar/wrangler.jsonc
   npx wrangler secret put INFERENCE_ACCESS_CLIENT_ID --config apps/kar/wrangler.jsonc
   npx wrangler secret put INFERENCE_ACCESS_CLIENT_SECRET --config apps/kar/wrangler.jsonc
   npx wrangler secret put INFERENCE_ACCESS_HOST --config apps/kar/wrangler.jsonc
   npx wrangler secret put SPEECH_API_URL --config apps/kar/wrangler.jsonc
   npx wrangler secret put SPEECH_API_TOKEN --config apps/kar/wrangler.jsonc
   npx wrangler secret put SPEECH_MODEL_ID --config apps/kar/wrangler.jsonc
   npx wrangler secret put SPEECH_HOMER_VOICE_ID --config apps/kar/wrangler.jsonc
   npx wrangler secret put SPEECH_NORMAL_VOICE_ID --config apps/kar/wrangler.jsonc
   npx wrangler secret put PEPA_ACCESS_SUBJECT --config apps/kar/wrangler.jsonc
   npx wrangler secret put PEPA_ROAST_COOKIE_SECRET --config apps/kar/wrangler.jsonc
   ```

   `CF_ACCESS_ISSUER` and `PUBLIC_ORIGIN` are non-secret Worker vars already set in `wrangler.jsonc` to `https://hlancaric.cloudflareaccess.com` and `https://kar.l-code-dynamics.com`. Before the first deploy, add `CF_ACCESS_AUD` to that same `vars` object using the audience tag copied from the existing Access app. Do not guess the tag. `MODEL_API_URL` is the full HTTPS OpenAI-compatible endpoint, `MODEL_API_TOKEN` a dedicated model-serving token (never the Runpod control-plane API key), and `MODEL_ID` the model identifier accepted by that server.

   Speech settings are optional until a compatible TTS service and original Czech voice profiles are available. `SPEECH_API_URL` is the full HTTPS OpenAI-compatible `/v1/audio/speech` endpoint; the model token and model ID are provider-specific. Configure the two voice IDs to distinct server-authorized profiles. Validate Czech pronunciation and intelligibility before treating either profile as verified. Do not paste actor or dubber recordings without rights.

   For a Runpod inference origin protected behind Cloudflare Access, create a separate Access service token and a self-hosted Access application for the exact inference hostname. Give that app a **Service Auth** policy containing only the service token. Set `INFERENCE_ACCESS_HOST` to that exact hostname and the two service-token values above. The Worker attaches those headers only to matching inference requests; it never forwards them to a different TTS provider. Store the Runpod bearer token separately as `MODEL_API_TOKEN` (and `SPEECH_API_TOKEN` if the same inference service exposes speech).

4. Before any deployment, verify the access policy, account rate namespace uniqueness, custom-domain ownership, and model endpoint. Then run `npm run kar:deploy:dry-run`. Only deploy with `npm run kar:deploy` after those values and the upstream have been validated. `workers_dev` and preview URLs are disabled to prevent an alternate public route.

## Runpod model contract

The Worker must not connect to a terminal-only chat program or guess its protocol. On the H200 pod, keep Qwen and all model files in the existing `/workspace/guardian` volume. Inspect `kar_chat.py` and the process that currently launches it, then expose a restricted HTTPS or Runpod proxy endpoint that:

- listens on the expected path and accepts the OpenAI-compatible JSON/SSE contract above;
- requires a dedicated, high-entropy model-serving token and does not expose it in logs;
- binds only as required for the pod/proxy and does not expose an unauthenticated port;
- streams tokens, applies a model context/output limit, and has a health route;
- does not run arbitrary tools from model output.

### Private Runpod-to-Cloudflare route

Recommended ingress is outbound-only from Runpod: run the model API bound to `127.0.0.1:8000` in the pod and run `cloudflared` in that pod as a service. Publish a distinct hostname such as `inference.l-code-dynamics.com` through a Cloudflare Tunnel route to `http://localhost:8000`; do not expose a Runpod public HTTP port. Protect that hostname with a separate Cloudflare Access self-hosted application and a Service Auth policy that allows only the Worker service token. Cloudflare Tunnel connects the private origin through outbound connections, and Access service-token requests use `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers. [Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/), [service-token headers](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), [Service Auth policy](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/).

At a high level, on a secured admin machine create a named tunnel (`cloudflared tunnel create kar-inference`), add the published application route for the inference hostname to `http://localhost:8000`, install the tunnel credentials only on Runpod, then start `cloudflared tunnel run kar-inference`. In Zero Trust, create the service token and Service Auth policy before exposing the route. Do not paste tunnel credentials or service-token values into the repository, chat, shell history, or logs. Runpod network and process setup are still pending access to the pod; validate the model API and bearer-token enforcement before setting the Worker endpoint.

### Pepa Roast identity and consent

`PEPA_ACCESS_SUBJECT` must be the UUID `sub` claim from Pepa's verified Cloudflare Access app token, not a name or value read from a message. `PEPA_ROAST_COOKIE_SECRET` must be a randomly generated secret of at least 32 characters. The UI learns eligibility through authenticated `GET /api/session`; only the matching Access subject sees the opt-in. `POST /api/settings/pepa-roast` issues or clears a Secure, HttpOnly, SameSite=Strict signed cookie bound to the verified Access subject. The Worker requires that consent cookie before accepting `KAR_PEPA_ROAST` on chat. A 25% opening roast is displayed only after an authenticated session confirms opt-in. No roast is sent outside a page session.

Use `kar_chat.py` as the known-good behavior reference. `kar_nexus.py` is explicitly untrusted until fully inspected. A Pod proxy URL may be public; the bearer check must be enforced by the serving process, not assumed from obscurity of the URL. Never put `RUNPOD_API_KEY` in browser code or pass it as the model token.

## Local checks

```sh
npm ci
npx vitest run tests/unit/karGateway.test.ts
npm run build
npm run kar:deploy:dry-run
```

Local dev must also be placed behind a real test Cloudflare Access setup to exercise JWT validation end-to-end. Do not add a production auth bypass for local development.
