import { desc, eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { db } from '@/db';
import { otps, users } from '@/db/schema';
import { signToken } from '@/lib/auth';

export const runtime = 'nodejs';

const schema = z.object({
  name: z.string().trim().min(2).max(191),
  mobile: z.string().trim().regex(/^[6-9]\d{9}$/),
  email: z.string().trim().email().max(191),
  otp: z.string().trim().regex(/^\d{6}$/),
});

export async function POST(request: NextRequest) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, message: parsed.error.issues[0]?.message || 'Enter valid verification details.' },
      { status: 400 },
    );
  }

  const { name, mobile, otp } = parsed.data;
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

    const [latestOtp] = await db.select()
      .from(otps)
      .where(eq(otps.mobile, mobile))
      .orderBy(desc(otps.id))
      .limit(1);

    if (!latestOtp || latestOtp.email?.toLowerCase() !== email || latestOtp.otp !== otp) {
      return NextResponse.json(
        { success: false, message: 'That verification code is incorrect. Check your email and try again.' },
        { status: 401 },
      );
    }
    if (latestOtp.expiresAt.getTime() <= Date.now()) {
      return NextResponse.json(
        { success: false, message: 'Your verification code has expired. Request a new code.' },
        { status: 401 },
      );
    }

    await db.delete(otps).where(eq(otps.id, latestOtp.id));
    const [inserted] = await db.insert(users).values({ name, mobile, email });
    const userId = inserted.insertId;
    const token = signToken({ userId });
    const user = { id: userId, name, mobile, email };
    const response = NextResponse.json({ success: true, user, token, hasBusiness: false, hasSubscription: false });
    response.cookies.set('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ER_DUP_ENTRY' || error.code === '23505')
    ) {
      return NextResponse.json(
        { success: false, message: 'This email or mobile number is already registered. Please sign in.' },
        { status: 409 },
      );
    }
    console.error('[Registration OTP] Verification failed:', error);
    return NextResponse.json(
      { success: false, message: 'Could not complete account verification. Please try again.' },
      { status: 500 },
    );
  }
}
