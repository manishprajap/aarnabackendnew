import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { db } from '@/db';
import { otps, users } from '@/db/schema';

export const runtime = 'nodejs';

const schema = z.object({
  name: z.string().trim().min(2).max(191),
  mobile: z.string().trim().regex(/^[6-9]\d{9}$/),
  email: z.string().trim().email().max(191),
});

export async function POST(request: NextRequest) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, message: parsed.error.issues[0]?.message || 'Enter valid account details.' },
      { status: 400 },
    );
  }

  const name = parsed.data.name;
  const mobile = parsed.data.mobile;
  const email = parsed.data.email.toLowerCase();

  try {
    const [existing] = await db.select({ id: users.id })
      .from(users)
      .where(eq(users.mobile, mobile))
      .limit(1);
    if (existing) {
      return NextResponse.json(
        { success: false, message: 'This mobile number already has an account. Sign in with mobile OTP.' },
        { status: 409 },
      );
    }

    const [emailOwner] = await db.select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (emailOwner) {
      return NextResponse.json(
        { success: false, message: 'This email is already registered. Sign in or use another email.' },
        { status: 409 },
      );
    }

    const resendApiKey = process.env.RESEND_API_KEY?.trim();
    const emailFrom = process.env.EMAIL_FROM?.trim();
    if (process.env.NODE_ENV === 'production' && (!resendApiKey || !emailFrom)) {
      console.error('[Registration OTP] RESEND_API_KEY and EMAIL_FROM must be configured.');
      return NextResponse.json(
        { success: false, message: 'Email verification is temporarily unavailable. Please contact support.' },
        { status: 503 },
      );
    }

    const otp = String(randomInt(100000, 1000000));
    const [inserted] = await db.insert(otps).values({
      mobile,
      email,
      otp,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    const otpId = inserted.insertId;

    if (!resendApiKey || !emailFrom) {
      return NextResponse.json({
        success: true,
        message: 'Verification code created for development.',
        ...(process.env.NODE_ENV !== 'production' ? { devOtp: otp } : {}),
      });
    }

    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: emailFrom,
        to: [email],
        subject: 'Your Aarna verification code',
        text: `Hello ${name},\n\nYour Aarna verification code is ${otp}. It expires in 5 minutes. If you did not request this code, you can ignore this email.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#0f2a4a"><h2>Verify your Aarna account</h2><p>Hello ${name.replace(/[<>&"']/g, '')},</p><p>Use this one-time code to verify your email:</p><div style="font-size:32px;font-weight:700;letter-spacing:8px;padding:18px;background:#f0f7ff;border-radius:12px;text-align:center">${otp}</div><p>This code expires in 5 minutes. If you did not request it, ignore this email.</p></div>`,
      }),
      cache: 'no-store',
    });

    if (!emailResponse.ok) {
      const details = await emailResponse.text().catch(() => '');
      console.error('[Registration OTP] Email provider rejected send request:', {
        status: emailResponse.status,
        details: details.slice(0, 500),
      });
      await db.delete(otps).where(eq(otps.id, otpId));
      return NextResponse.json(
        { success: false, message: 'Could not send the verification email. Check the address and try again.' },
        { status: 502 },
      );
    }

    return NextResponse.json({ success: true, message: 'Verification code sent to your email.' });
  } catch (error) {
    console.error('[Registration OTP] Could not send verification code:', error);
    return NextResponse.json(
      { success: false, message: 'Could not send the verification code. Please try again.' },
      { status: 500 },
    );
  }
}
