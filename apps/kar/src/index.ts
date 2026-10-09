interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  CF_ACCESS_ISSUER: string;
  CF_ACCESS_AUD: string;
  PUBLIC_ORIGIN: string;
  MODEL_API_URL: string;
  MODEL_API_TOKEN: string;
  MODEL_ID: string;
  INFERENCE_ACCESS_CLIENT_ID?: string;
  INFERENCE_ACCESS_CLIENT_SECRET?: string;
  INFERENCE_ACCESS_HOST?: string;
  PEPA_ACCESS_SUBJECT?: string;
  PEPA_ROAST_COOKIE_SECRET?: string;
  SPEECH_API_URL?: string;
  SPEECH_API_TOKEN?: string;
  SPEECH_MODEL_ID?: string;
  SPEECH_HOMER_VOICE_ID?: string;
  SPEECH_NORMAL_VOICE_ID?: string;
  CHAT_RATE_LIMITER: { limit(input: { key: string }): Promise<{ success: boolean }> };
}

interface AccessClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  email?: string;
  sub?: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

type PersonalityId = "KAR_STANDARD_CZ" | "KAR_UNCENSORED_CZ" | "KAR_PEPA_ROAST";

const MAX_BODY_BYTES = 48_000;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_TOTAL_CHARS = 30_000;
const MAX_COMPLETION_TOKENS = 900;
const UPSTREAM_TIMEOUT_MS = 120_000;
const MAX_SPEECH_CHARS = 4_000;
const MAX_AUDIO_BYTES = 12_000_000;
const VOICE_PROFILES = Object.freeze({ KAR_HOMER_CZ: "SPEECH_HOMER_VOICE_ID", KAR_NORMAL_CZ: "SPEECH_NORMAL_VOICE_ID" } as const);
const SYSTEM_PROMPT =
  "Jsi Kár, technický AI spolupracovník projektu Nexus. Pomáháš s návrhem, " +
  "analýzou a bezpečným vývojem. Nemáš přístup k souborům ani nástrojům, pokud " +
  "ti je aplikace výslovně neposkytne. Tvrzení o provedených změnách, testech " +
  "nebo nasazení vždy opírej o skutečný výsledek. U bezpečnostního testování " +
  "pracuj pouze v autorizovaném rozsahu.";
const PERSONALITY_PROMPTS: Record<PersonalityId, string> = {
  KAR_STANDARD_CZ: "Mluv přirozeně, věcně a srozumitelně česky.",
  KAR_UNCENSORED_CZ: "Mluv česky jako sarkastický, teatrální hospodský bručoun. Můžeš přirozeně a bez cenzury používat vulgarismy jako kurva, do prdele, píčovina, kokotina, zasraný bug, posraný testy, kunda, píča, zmrd, krypl nebo mrdka, absurdní humor a otrávené poznámky. V tomto výslovně zvoleném režimu můžeš uživatele i familiárně a komicky poslat do píči nebo si z něj utahovat, když to sedí do kontextu; drž to jako hravé škádlení, ne výhrůžku nebo útok na chráněnou identitu. Zachovej přesnost, srozumitelnost technických odpovědí, bezpečnostní pravidla a pravdivost. Styl nesmí měnit technická doporučení ani bezpečnostní hranice.",
  KAR_PEPA_ROAST: "Jsi sarkastický kamarád Pepy. Pepa je ověřen výhradně serverem podle ověřené Cloudflare Access identity a tento režim výslovně zapnul. Smíš ho spontánně, přátelsky a komicky roastovat česky, včetně přirozených vulgarismů. Dělej si legraci z jeho commitů, programování a neškodných situací; můžeš ho familiárně oslovit Pepo a občas ho poslat do píči. Nevyhrožuj, neútoč na chráněné vlastnosti a nezdržuj bezpečnostní upozornění ani technickou odpověď. Humor nikdy nesmí změnit technická fakta, bezpečnostní pravidla ani výsledek práce.",
};

const keyCache = new Map<string, { key: CryptoKey; expiresAt: number }>();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return secureAssetResponse(await env.ASSETS.fetch(request));
    }

    let claims: AccessClaims;
    try {
      claims = await requireAccess(request, env);
      if (typeof claims.sub !== "string" || claims.sub.length === 0) {
        throw new GatewayError(401, "Access token has no stable subject");
      }
    } catch (error) {
      if (error instanceof GatewayError) return apiJson({ error: error.message }, error.status);
      const requestId = crypto.randomUUID();
      console.error(JSON.stringify({ event: "kar.access_verification_failed", requestId }));
      return apiJson({ error: "Access verification unavailable", requestId }, 503);
    }

    if (url.pathname === "/api/session" && request.method === "GET") return handleSession(request, env, claims);
    if (url.pathname === "/api/settings/pepa-roast") return handlePepaRoastSetting(request, env, claims);
    if (url.pathname === "/api/health" && request.method === "GET") {
      return apiJson({ ok: true, service: "kar" }, 200);
    }

    if (url.pathname === "/api/speech") return handleSpeech(request, env, claims);
    if (url.pathname !== "/api/chat") return apiJson({ error: "Not found" }, 404);
    if (request.method !== "POST") {
      return apiJson({ error: "Method not allowed" }, 405, { Allow: "POST" });
    }

    const requestOrigin = request.headers.get("Origin");
    if (requestOrigin !== env.PUBLIC_ORIGIN) return apiJson({ error: "Forbidden" }, 403);

    try {
      const body = await readBoundedJson(request);
      const parsed = parseChatRequest(body);
      const messages = parsed.messages;
      if (parsed.personalityId === "KAR_PEPA_ROAST") {
        if (!isPepa(claims, env) || !(await hasPepaRoastConsent(request, env, claims.sub!))) {
          throw new GatewayError(403, "Pepa Roast must be enabled by the verified Pepa account");
        }
      }
      if (!env.CHAT_RATE_LIMITER) throw new GatewayError(503, "Rate limiter is not configured");
      const rate = await env.CHAT_RATE_LIMITER.limit({ key: claims.sub });
      if (!rate.success) return apiJson({ error: "Too many requests" }, 429, { "Retry-After": "60" });
      const modelUrl = validateModelUrl(env.MODEL_API_URL);
      const inferenceAccessHeaders = getInferenceAccessHeaders(env, modelUrl);
      if (!env.MODEL_API_TOKEN || !env.MODEL_ID) {
        return apiJson({ error: "Chat service is not configured" }, 503);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
      let upstream: Response;
      try {
        upstream = await fetch(modelUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.MODEL_API_TOKEN}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...inferenceAccessHeaders,
          },
          body: JSON.stringify({
            model: env.MODEL_ID,
            messages: [
              { role: "system", content: `${SYSTEM_PROMPT}\n\n${PERSONALITY_PROMPTS[parsed.personalityId]}` },
              ...messages,
            ],
            max_tokens: MAX_COMPLETION_TOKENS,
            stream: true,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeout);
        throw error;
      }

      if (!upstream.ok || !upstream.body) {
        clearTimeout(timeout);
        console.error(JSON.stringify({ event: "kar.upstream_error", status: upstream.status }));
        return apiJson({ error: "Model service unavailable" }, 502);
      }
      if (!upstream.headers.get("Content-Type")?.toLowerCase().includes("text/event-stream")) {
        clearTimeout(timeout);
        await upstream.body.cancel();
        return apiJson({ error: "Model service returned an unsupported response" }, 502);
      }

      const reader = upstream.body.getReader();
      const streamBody = new ReadableStream<Uint8Array>({
        async pull(stream) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              clearTimeout(timeout);
              stream.close();
            } else {
              stream.enqueue(chunk.value);
            }
          } catch (error) {
            clearTimeout(timeout);
            stream.error(error);
          }
        },
        async cancel(reason) {
          clearTimeout(timeout);
          await reader.cancel(reason);
        },
      });

      return new Response(streamBody, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store, no-transform",
          Connection: "keep-alive",
          "X-Content-Type-Options": "nosniff",
          "X-Accel-Buffering": "no",
        },
      });
    } catch (error) {
      if (error instanceof GatewayError) return apiJson({ error: error.message }, error.status);
      if (error instanceof Error && error.name === "AbortError") {
        return apiJson({ error: "Model service timed out" }, 504);
      }
      const requestId = crypto.randomUUID();
      console.error(JSON.stringify({ event: "kar.request_failed", requestId }));
      return apiJson({ error: "Request failed", requestId }, 500);
    }
  },
};

class GatewayError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function handleSession(request: Request, env: Env, claims: AccessClaims): Promise<Response> {
  if (request.method !== "GET") return apiJson({ error: "Method not allowed" }, 405, { Allow: "GET" });
  const eligible = isPepa(claims, env);
  const enabled = eligible && Boolean(claims.sub) && await hasPepaRoastConsent(request, env, claims.sub!);
  return apiJson({ authenticated: true, pepaRoastEligible: eligible, pepaRoastEnabled: enabled }, 200);
}

async function handlePepaRoastSetting(request: Request, env: Env, claims: AccessClaims): Promise<Response> {
  if (request.method !== "POST") return apiJson({ error: "Method not allowed" }, 405, { Allow: "POST" });
  if (request.headers.get("Origin") !== env.PUBLIC_ORIGIN) return apiJson({ error: "Forbidden" }, 403);
  if (!isPepa(claims, env) || !claims.sub) return apiJson({ error: "Pepa account required" }, 403);
  try {
    const body = await readBoundedJson(request);
    if (!body || typeof body !== "object" || typeof (body as { enabled?: unknown }).enabled !== "boolean") {
      throw new GatewayError(400, "enabled must be a boolean");
    }
    if (!(body as { enabled: boolean }).enabled) {
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "Set-Cookie": "kar_pepa_roast=; Max-Age=0; Path=/api; Secure; HttpOnly; SameSite=Strict" } });
    }
    const secret = env.PEPA_ROAST_COOKIE_SECRET;
    if (!secret || secret.length < 32) throw new GatewayError(503, "Pepa Roast consent signing is not configured");
    const subjectHash = await identityHash(claims.iss!, claims.sub);
    const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ subjectHash, exp: Math.floor(Date.now() / 1000) + 31_536_000 })));
    const key = await consentSigningKey(secret);
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
    const cookie = `kar_pepa_roast=${payload}.${base64UrlEncode(signature)}; Max-Age=31536000; Path=/api; Secure; HttpOnly; SameSite=Strict`;
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "Set-Cookie": cookie } });
  } catch (error) {
    if (error instanceof GatewayError) return apiJson({ error: error.message }, error.status);
    return apiJson({ error: "Could not update Pepa Roast setting" }, 500);
  }
}

function isPepa(claims: AccessClaims, env: Env): boolean {
  return Boolean(env.PEPA_ACCESS_SUBJECT && claims.sub && claims.sub === env.PEPA_ACCESS_SUBJECT);
}

async function hasPepaRoastConsent(request: Request, env: Env, subject: string): Promise<boolean> {
  const secret = env.PEPA_ROAST_COOKIE_SECRET;
  if (!secret || secret.length < 32) return false;
  const cookieHeader = request.headers.get("Cookie") || "";
  const value = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith("kar_pepa_roast="))?.slice("kar_pepa_roast=".length);
  if (!value) return false;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined) return false;
  try {
    const key = await consentSigningKey(secret);
    const valid = await crypto.subtle.verify("HMAC", key, decodeBase64Url(signature), new TextEncoder().encode(payload));
    if (!valid) return false;
    const parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as { subjectHash?: unknown; exp?: unknown };
    return parsed.subjectHash === await identityHash(env.CF_ACCESS_ISSUER.replace(/\/$/, ""), subject) &&
      typeof parsed.exp === "number" && parsed.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

async function identityHash(issuer: string, subject: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${issuer}|${subject}`)));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function consentSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function requireAccess(request: Request, env: Env): Promise<AccessClaims> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new GatewayError(401, "Cloudflare Access authentication required");

  const issuer = env.CF_ACCESS_ISSUER.replace(/\/$/, "");
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new GatewayError(503, "Access authentication is not configured");
  }
  if (issuerUrl.protocol !== "https:" || !env.CF_ACCESS_AUD) {
    throw new GatewayError(503, "Access authentication is not configured");
  }

  const parts = token.split(".");
  if (parts.length !== 3) throw new GatewayError(401, "Invalid Access token");
  const header = decodeJson<{ alg?: string; kid?: string }>(parts[0]!);
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new GatewayError(401, "Invalid Access token");
  }
  const claims = decodeJson<AccessClaims>(parts[1]!);
  const now = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    claims.iss !== issuer ||
    !audience.includes(env.CF_ACCESS_AUD) ||
    typeof claims.exp !== "number" || claims.exp <= now ||
    (typeof claims.nbf === "number" && claims.nbf > now + 30)
  ) {
    throw new GatewayError(401, "Invalid or expired Access token");
  }

  const key = await accessKey(issuer, header.kid);
  let signature: Uint8Array;
  try {
    signature = decodeBase64Url(parts[2]!);
  } catch {
    throw new GatewayError(401, "Invalid Access token");
  }
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new GatewayError(401, "Invalid Access token");
  return claims;
}

async function accessKey(issuer: string, kid: string): Promise<CryptoKey> {
  const cacheId = `${issuer}:${kid}`;
  const cached = keyCache.get(cacheId);
  if (cached && cached.expiresAt > Date.now()) return cached.key;

  const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new GatewayError(503, "Could not verify Access token");
  const jwks = await response.json() as { keys?: JsonWebKey[] };
  const jwk = jwks.keys?.find((candidate) => (candidate as JsonWebKey & { kid?: string }).kid === kid);
  if (!jwk) throw new GatewayError(401, "Unknown Access signing key");
  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
  );
  keyCache.set(cacheId, { key, expiresAt: Date.now() + 300_000 });
  return key;
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new GatewayError(415, "Expected application/json");
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new GatewayError(413, "Request too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new GatewayError(413, "Request too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new GatewayError(400, "Invalid JSON");
  }
}

function parseChatRequest(body: unknown): { messages: ChatMessage[]; personalityId: PersonalityId } {
  if (!body || typeof body !== "object" || !Array.isArray((body as { messages?: unknown }).messages)) {
    throw new GatewayError(400, "messages must be an array");
  }
  const input = (body as { messages: unknown[] }).messages;
  const rawPersonality = (body as { personalityId?: unknown }).personalityId;
  const personalityId: PersonalityId = rawPersonality === undefined ? "KAR_STANDARD_CZ" :
    rawPersonality === "KAR_STANDARD_CZ" || rawPersonality === "KAR_UNCENSORED_CZ" || rawPersonality === "KAR_PEPA_ROAST" ? rawPersonality :
      (() => { throw new GatewayError(400, "Unsupported personality profile"); })();
  if (input.length < 1 || input.length > MAX_MESSAGES) throw new GatewayError(400, "Invalid message count");
  let total = 0;
  const messages = input.map((item) => {
    if (!item || typeof item !== "object") throw new GatewayError(400, "Invalid message");
    const { role, content } = item as Record<string, unknown>;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim()) {
      throw new GatewayError(400, "Invalid message");
    }
    if (content.length > MAX_MESSAGE_CHARS) throw new GatewayError(413, "Message too long");
    total += content.length;
    if (total > MAX_TOTAL_CHARS) throw new GatewayError(413, "Conversation too long");
    return { role: role as ChatMessage["role"], content };
  });
  return { messages, personalityId };
}

function validateModelUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GatewayError(503, "Model service is not configured");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new GatewayError(503, "Model service URL must be a secure HTTPS endpoint");
  }
  return url.toString();
}

function getInferenceAccessHeaders(env: Env, targetUrl: string): Record<string, string> {
  const clientId = env.INFERENCE_ACCESS_CLIENT_ID;
  const clientSecret = env.INFERENCE_ACCESS_CLIENT_SECRET;
  const protectedHost = env.INFERENCE_ACCESS_HOST;
  const configured = Boolean(clientId || clientSecret || protectedHost);
  if (configured && !(clientId && clientSecret && protectedHost)) {
    throw new GatewayError(503, "Inference Access credentials are incomplete");
  }
  if (!configured || new URL(targetUrl).hostname.toLowerCase() !== protectedHost!.toLowerCase()) return {};
  return {
    "CF-Access-Client-Id": clientId!,
    "CF-Access-Client-Secret": clientSecret!,
  };
}

function decodeJson<T>(part: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(part))) as T;
  } catch {
    throw new GatewayError(401, "Invalid Access token");
  }
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function apiJson(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function secureAssetResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "microphone=(self)");
  headers.set("Cache-Control", "no-store");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(response.body, { status: response.status, headers });
}

async function handleSpeech(request: Request, env: Env, claims: AccessClaims): Promise<Response> {
  if (request.method !== "POST") return apiJson({ error: "Method not allowed" }, 405, { Allow: "POST" });
  if (request.headers.get("Origin") !== env.PUBLIC_ORIGIN) return apiJson({ error: "Forbidden" }, 403);
  const subject = claims.sub;
  if (!subject) return apiJson({ error: "Access token has no stable subject" }, 401);
  try {
    const body = await readBoundedJson(request);
    if (!body || typeof body !== "object") throw new GatewayError(400, "Invalid speech request");
    const input = body as Record<string, unknown>;
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > MAX_SPEECH_CHARS) {
      throw new GatewayError(400, "text must contain 1 to 4000 characters");
    }
    if (typeof input.profileId !== "string" || !Object.hasOwn(VOICE_PROFILES, input.profileId)) {
      throw new GatewayError(400, "Unsupported voice profile");
    }
    if (!env.CHAT_RATE_LIMITER) throw new GatewayError(503, "Rate limiter is not configured");
    const rate = await env.CHAT_RATE_LIMITER.limit({ key: subject });
    if (!rate.success) return apiJson({ error: "Too many requests" }, 429, { "Retry-After": "60" });

    const voiceSecret = VOICE_PROFILES[input.profileId as keyof typeof VOICE_PROFILES];
    const voiceId = env[voiceSecret];
    if (!env.SPEECH_API_URL || !env.SPEECH_API_TOKEN || !env.SPEECH_MODEL_ID || !voiceId) {
      return apiJson({ error: "Speech model is not configured" }, 503);
    }
    const speechUrl = validateModelUrl(env.SPEECH_API_URL);
    const inferenceAccessHeaders = getInferenceAccessHeaders(env, speechUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await fetch(speechUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.SPEECH_API_TOKEN}`, "Content-Type": "application/json", Accept: "audio/mpeg, audio/wav, audio/ogg", ...inferenceAccessHeaders },
        body: JSON.stringify({ model: env.SPEECH_MODEL_ID, voice: voiceId, input: input.text, response_format: "mp3" }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof Error && error.name === "AbortError") throw new GatewayError(504, "Speech service timed out");
      throw new GatewayError(502, "Speech service unavailable");
    }
    if (!upstream.ok || !upstream.body) {
      clearTimeout(timeout);
      await upstream.body?.cancel();
      console.error(JSON.stringify({ event: "kar.speech_upstream_error", status: upstream.status }));
      return apiJson({ error: "Speech service unavailable" }, 502);
    }
    const mime = upstream.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() || "";
    if (!new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/ogg"]).has(mime)) {
      clearTimeout(timeout);
      await upstream.body.cancel();
      return apiJson({ error: "Speech service returned an unsupported audio type" }, 502);
    }
    const declaredLength = Number(upstream.headers.get("Content-Length") || 0);
    if (declaredLength > MAX_AUDIO_BYTES) {
      clearTimeout(timeout);
      await upstream.body.cancel();
      return apiJson({ error: "Speech response is too large" }, 502);
    }
    let audio: Uint8Array;
    try {
      audio = await readBoundedAudio(upstream.body, MAX_AUDIO_BYTES);
    } finally {
      clearTimeout(timeout);
    }
    if (audio.byteLength === 0) return apiJson({ error: "Speech response is invalid" }, 502);
    return new Response(audio, { headers: { "Content-Type": mime, "Content-Length": String(audio.byteLength), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    if (error instanceof GatewayError) return apiJson({ error: error.message }, error.status);
    const requestId = crypto.randomUUID();
    console.error(JSON.stringify({ event: "kar.speech_request_failed", requestId }));
    return apiJson({ error: "Speech request failed", requestId }, 500);
  }
}

async function readBoundedAudio(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new GatewayError(502, "Speech response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
