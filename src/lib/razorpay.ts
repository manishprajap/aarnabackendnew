// src/lib/razorpay.ts
import Razorpay from 'razorpay';

// .env files saved with Windows line endings leave a hidden "\r" on every
// value. Strip whitespace and surrounding quotes so the key is always clean.
const clean = (v: string | undefined) =>
  (v ?? '').trim().replace(/^["']|["']$/g, '').trim();

export const razorpayKeyId = clean(process.env.RAZORPAY_KEY_ID);
export const razorpayKeySecret = clean(process.env.RAZORPAY_KEY_SECRET);

if (!razorpayKeyId || !razorpayKeySecret) {
  throw new Error(
    'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are missing from environment variables'
  );
}

export const razorpay = new Razorpay({
  key_id: razorpayKeyId,
  key_secret: razorpayKeySecret,
});