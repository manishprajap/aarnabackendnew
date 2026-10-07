///src/app/api/auth/verify-otp/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { eq, and, desc, gt } from 'drizzle-orm';
import { db } from '@/db';
import { users, otps, subscriptions } from '@/db/schema';
import { signToken } from '@/lib/auth';

export const runtime = 'nodejs';

export async function OPTIONS() {
  // CORS headers middleware.ts se globally lagte hain (matcher: /api/:path*),
  // isliye yahan corsHeaders() dobara set nahi karna — warna header duplicate ho jata hai.
  return new NextResponse(null, { status: 204 });
}

const verifySchema = z.object({
  mobile: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid mobile number'),
  otp: z.string().trim().length(4, 'Enter 4 digit OTP'),
  deviceId: z.string().trim().max(191).optional(),
  deviceType: z.string().trim().max(50).optional(),
  deviceName: z.string().trim().max(255).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = verifySchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const { mobile, otp, deviceId, deviceType, deviceName } = parsed.data;

    const [latestOtp] = await db
      .select()
      .from(otps)
      .where(and(eq(otps.mobile, mobile), eq(otps.otp, otp)))
      .orderBy(desc(otps.id))
      .limit(1);

    if (!latestOtp) {
      return NextResponse.json({ error: 'Invalid OTP' }, { status: 401 });
    }

    if (new Date(latestOtp.expiresAt) < new Date()) {
      return NextResponse.json(
        { error: 'OTP expired, please request a new one' },
        { status: 401 }
      );
    }

    const deleteResult: any = await db
      .delete(otps)
      .where(eq(otps.id, latestOtp.id));

    const affectedRows =
      deleteResult?.[0]?.affectedRows ?? deleteResult?.affectedRows ?? 0;

    if (!affectedRows) {
      return NextResponse.json(
        { error: 'This OTP was already used. Please request a new one.' },
        { status: 401 }
      );
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.mobile, mobile))
      .limit(1);

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    if (user.status !== 'ACTIVE') {
      return NextResponse.json(
        { error: 'This account is inactive. Please contact the platform administrator.' },
        { status: 403 }
      );
    }

    if (deviceId || deviceType || deviceName) {
      await db
        .update(users)
        .set({
          ...(deviceId ? { deviceId } : {}),
          ...(deviceType ? { deviceType } : {}),
          ...(deviceName ? { deviceName } : {}),
        })
        .where(eq(users.id, user.id));
    }

    // Active subscription = status 'active' AND endDate still in the future.
    const [activeSub] = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, user.id),
          eq(subscriptions.status, 'active'),
          gt(subscriptions.endDate, new Date())
        )
      )
      .orderBy(desc(subscriptions.endDate))
      .limit(1);

    const token = signToken({ userId: user.id });
    const hasBusiness = Boolean(user.business_category && user.city);
    const hasSubscription = Boolean(activeSub);

    const response = NextResponse.json({
      user: {
        id: user.id,
        name: user.name,
        mobile: user.mobile,
        email: user.email,
        plan: user.plan,
        credits: user.credits,
      },
      token,
      hasBusiness,
      hasSubscription,
    });

    response.cookies.set('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });

    return response;
  } catch (err) {
    console.error('Verify OTP error:', err);
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 }
    );
  }
}