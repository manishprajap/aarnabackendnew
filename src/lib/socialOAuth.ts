////src/lib/socialOAuth.ts
import { createHmac, timingSafeEqual } from 'node:crypto';

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

type SocialOAuthState = {
  userId: number;
  provider: 'youtube' | 'linkedin' | 'google_analytics';
  createdAt: number;
};

function getStateSecret() {
  const secret = process.env.SOCIAL_OAUTH_STATE_SECRET || process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('SOCIAL_OAUTH_STATE_SECRET or JWT_SECRET is not configured');
  }

  return secret;
}

function sign(value: string) {
  return createHmac('sha256', getStateSecret()).update(value).digest('base64url');
}

export function createSocialOAuthState(userId: number, provider: SocialOAuthState['provider']) {
  const payload = Buffer.from(
    JSON.stringify({ userId, provider, createdAt: Date.now() } satisfies SocialOAuthState),
    'utf8'
  ).toString('base64url');

  return `${payload}.${sign(payload)}`;
}

export function verifySocialOAuthState(state: string, provider: SocialOAuthState['provider']) {
  const [payload, signature] = state.split('.');

  if (!payload || !signature) {
    return null;
  }

  const expected = sign(payload);
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SocialOAuthState;

    if (
      parsed.provider !== provider ||
      !Number.isInteger(parsed.userId) ||
      parsed.userId <= 0 ||
      !Number.isFinite(parsed.createdAt) ||
      Date.now() - parsed.createdAt > STATE_MAX_AGE_MS ||
      parsed.createdAt > Date.now() + 30_000
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function getSocialOAuthFrontendUrl() {
  return (
    process.env.FRONTEND_URL ||
    process.env.NEXT_PUBLIC_FRONTEND_URL ||
    'http://localhost:8100'
  ).replace(/\/+$/, '');
}
