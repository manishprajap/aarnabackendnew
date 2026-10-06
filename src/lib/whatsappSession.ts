import crypto from 'crypto';

export interface SessionPayload {
  userId: string;
  bannerId?: number;
  exp: number;
}

function getSecret(): string {
  const secret = process.env.WHATSAPP_SESSION_SECRET;
  if (!secret) throw new Error('WHATSAPP_SESSION_SECRET is missing');
  return secret;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function createSignature(payload: string): string {
  return crypto
    .createHmac('sha256', getSecret())
    .update(payload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function createWhatsAppSession(
  userId: number | string,
  extra: { bannerId?: number } = {}
): string {
  const payload: SessionPayload = {
    userId: String(userId),
    ...extra,
    exp: Date.now() + 10 * 60 * 1000,
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${createSignature(encoded)}`;
}

export function verifyWhatsAppSession(sessionId: string): SessionPayload {
  const parts = sessionId.split('.');
  if (parts.length !== 2) throw new Error('Invalid WhatsApp session');

  const [encodedPayload, providedSignature] = parts;
  const expected = Buffer.from(createSignature(encodedPayload));
  const provided = Buffer.from(providedSignature);

  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new Error('Invalid WhatsApp session signature');
  }

  const payload = JSON.parse(base64UrlDecode(encodedPayload)) as SessionPayload;

  if (!payload.userId || !payload.exp) {
    throw new Error('Invalid WhatsApp session payload');
  }
  if (Date.now() > payload.exp) {
    throw new Error('WhatsApp connection session expired');
  }
  return payload;
}