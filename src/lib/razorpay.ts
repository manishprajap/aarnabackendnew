// src/lib/razorpay.ts
import Razorpay from 'razorpay';

// .env files saved with Windows line endings leave a hidden "\r" on every
// value. Strip whitespace and surrounding quotes so the key is always clean.
const clean = (v: string | undefined) =>
  (v ?? '').trim().replace(/^["']|["']$/g, '').trim();

let razorpayConfig:
  | {
      razorpay: Razorpay;
      razorpayKeyId: string;
      razorpayKeySecret: string;
    }
  | undefined;

export function getRazorpayConfig() {
  if (razorpayConfig) {
    return razorpayConfig;
  }

  const keyId = clean(process.env.RAZORPAY_KEY_ID);
  const keySecret = clean(process.env.RAZORPAY_KEY_SECRET);

  if (!keyId || !keySecret) {
    throw new Error(
      'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are missing from environment variables'
    );
  }

  razorpayConfig = {
    razorpay: new Razorpay({ key_id: keyId, key_secret: keySecret }),
    razorpayKeyId: keyId,
    razorpayKeySecret: keySecret,
  };
  return razorpayConfig;
}