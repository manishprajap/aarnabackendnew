import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createSessionToken, SESSION_COOKIE_NAME } from '@/lib/adminAuth';

/*
|--------------------------------------------------------------------------
| POST /api/admin/login
|--------------------------------------------------------------------------
*/

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = z.object({
      email: z.string().trim().email().max(191),
      password: z.string().min(1).max(1024),
    }).safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: 'Enter a valid admin email and password.' },
        { status: 400 },
      );
    }

    const email = parsed.data.email.toLowerCase();
    const password = parsed.data.password;
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminEmail || !adminPassword) {
      return NextResponse.json(
        { success: false, message: 'Admin credentials are not configured' },
        { status: 500 }
      );
    }

    const digest = (value: string) => crypto.createHash('sha256').update(value).digest();
    const emailMatches = crypto.timingSafeEqual(
      digest(email),
      digest(adminEmail.trim().toLowerCase())
    );
    const passwordMatches = crypto.timingSafeEqual(
      digest(password),
      digest(adminPassword)
    );
    if (!emailMatches || !passwordMatches) {
      return NextResponse.json(
        { success: false, message: 'Invalid email or password' },
        { status: 401 }
      );
    }

    const token = await createSessionToken(email);

    const response = NextResponse.json({ success: true });

    response.cookies.set(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60,
    });

    return response;
  } catch (error: any) {
    console.error('[Admin Login] Login request failed:', error);

    return NextResponse.json(
      { success: false, message: 'Admin login failed. Please try again.' },
      { status: 500 }
    );
  }
}