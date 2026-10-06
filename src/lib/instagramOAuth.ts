// src/lib/instagramOAuth.ts
import crypto from "crypto";

export const DEFAULT_REDIRECT_URI =
  "https://aarnexai.com/aarnexai-backend/api/meta/callback";

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Read an env var and strip whitespace / stray \r (CRLF .env files).
 * Returns undefined if missing or empty.
 */
export function getEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const cleaned = value.trim().replace(/^["']|["']$/g, "").trim();
  return cleaned || undefined;
}

export function getMetaConfig() {
  return {
    clientId: getEnv("META_APP_ID"),
    clientSecret: getEnv("META_APP_SECRET"),
    redirectUri: getEnv("META_REDIRECT_URI") || DEFAULT_REDIRECT_URI,
  };
}

/**
 * Secret used to sign the OAuth state.
 * Uses OAUTH_STATE_SECRET if set, otherwise falls back to META_APP_SECRET.
 */
function getStateSecret(): string | undefined {
  return getEnv("OAUTH_STATE_SECRET") || getEnv("META_APP_SECRET");
}

export type OAuthStatePayload = {
  userId: number;
  bannerId: number | null;
  timestamp: number;
};

function sign(data: string, secret: string) {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

export function createSignedState(payload: OAuthStatePayload): string {
  const secret = getStateSecret();
  if (!secret) {
    throw new Error("OAUTH_STATE_SECRET (or META_APP_SECRET) is not configured");
  }
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  return `${body}.${sign(body, secret)}`;
}

export function verifySignedState(state: string): OAuthStatePayload | null {
  try {
    const secret = getStateSecret();
    if (!secret) return null;

    const [body, signature] = state.split(".");
    if (!body || !signature) return null;

    const expected = sign(body, secret);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8")
    ) as OAuthStatePayload;

    if (
      !payload.timestamp ||
      Date.now() - payload.timestamp > STATE_MAX_AGE_MS ||
      payload.timestamp > Date.now() + 60_000
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}