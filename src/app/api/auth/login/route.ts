import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { eq, or } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import { verifyPassword, signToken } from '@/lib/auth';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(req: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(req.headers.get('origin')) });
}

const loginSchema = z.object({
  identifier: z.string().trim().min(3, 'Enter your mobile number or email'),
  password: z.string().min(1, 'Enter your password'),
});

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');

  try {
    const body = await req.json();
    const parsed = loginSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    const { identifier, password } = parsed.data;

    const [user] = await db
      .select()
      .from(users)
      .where(or(eq(users.mobile, identifier), eq(users.email, identifier)))
      .limit(1);

    if (!user) {
      return NextResponse.json(
        { error: 'Invalid mobile/email or password.' },
        { status: 401, headers: corsHeaders(origin) }
      );
    }

    if (user.status !== 'ACTIVE') {
      return NextResponse.json(
        { error: 'This account is inactive. Please contact the platform administrator.' },
        { status: 403, headers: corsHeaders(origin) }
      );
    }

    // A user created via OTP signup may not have a password set yet.
    if (!user.password) {
      return NextResponse.json(
        { error: 'This account has no password set. Please log in with OTP instead.' },
        { status: 401, headers: corsHeaders(origin) }
      );
    }

    const passwordMatches = await verifyPassword(password, user.password);
    if (!passwordMatches) {
      return NextResponse.json(
        { error: 'Invalid mobile/email or password.' },
        { status: 401, headers: corsHeaders(origin) }
      );
    }

    const token = signToken({ userId: user.id });

    const response = NextResponse.json(
      {
        user: {
          id: user.id,
          name: user.name,
          mobile: user.mobile,
          email: user.email,
          plan: user.plan,
          credits: user.credits,
        },
        token,
      },
      { headers: corsHeaders(origin) }
    );

    response.cookies.set('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });

    return response;
  } catch (err) {
    console.error('Login error:', err);
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}