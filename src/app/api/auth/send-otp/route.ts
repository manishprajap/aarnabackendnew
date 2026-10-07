import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users, otps } from '@/db/schema';

export const runtime = 'nodejs';

export async function OPTIONS() {
  // CORS headers middleware.ts se globally lagte hain (matcher: /api/:path*),
  // isliye yahan corsHeaders() dobara set nahi karna — warna header duplicate ho jata hai.
  return new NextResponse(null, { status: 204 });
}

const sendOtpSchema = z.object({
  mobile: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid mobile number'),
});

// TEMP: SMS gateway abhi live nahi hai, isliye fixed test OTP use ho raha hai.
// Jab SMS gateway (MSG91 / Fast2SMS / Twilio) integrate ho jaye, is function ko
// wapas random generateOtp() se replace kar dena aur sendSms() call karna.
function generateOtp() {
  return '1234';
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = sendOtpSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const { mobile } = parsed.data;

    const [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.mobile, mobile))
      .limit(1);

    if (existingUser && existingUser.status !== 'ACTIVE') {
      return NextResponse.json(
        { error: 'This account is inactive. Please contact the platform administrator.' },
        { status: 403 }
      );
    }

    let userId: number;
    const isNewUser = !existingUser;

    if (!existingUser) {
      // Naya user - sirf mobile ke saath insert, baaki columns NULL/default
      const [inserted] = await db.insert(users).values({
        mobile,
      });
      userId = (inserted as any).insertId;
    } else {
      userId = existingUser.id;
    }

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min validity

    // Fixed OTP bhi normal flow ki tarah table mein save hota hai,
    // taaki verify-otp route bina kisi change ke kaam kare.
    await db.insert(otps).values({ mobile, otp, expiresAt });

    // TODO: real SMS gateway yahan call karein (MSG91 / Fast2SMS / Twilio)
    // await sendSms(mobile, otp);

    const isDev = process.env.NODE_ENV !== 'production';

    return NextResponse.json({
      message: 'OTP sent successfully',
      userId,
      isNewUser,
      ...(isDev ? { devOtp: otp } : {}),
    });
  } catch (err) {
    console.error('Send OTP error:', err);
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 }
    );
  }
}