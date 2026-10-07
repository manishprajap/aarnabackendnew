import { and, count, desc, eq, like, or } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { db } from '@/db';
import { users } from '@/db/schema';
import { hasValidAdminSession, SESSION_COOKIE_NAME } from '@/lib/adminAuth';

const createVendorSchema = z.object({
  name: z.string().trim().min(2).max(191),
  mobile: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'),
  email: z.union([z.string().trim().email().max(191), z.literal('')]).optional(),
  businessName: z.string().trim().max(190).optional(),
});

function authorize(request: NextRequest) {
  return hasValidAdminSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
}

function unauthorized() {
  return NextResponse.json(
    { success: false, message: 'Admin session expired. Please sign in again.' },
    { status: 401 }
  );
}

export async function GET(request: NextRequest) {
  if (!authorize(request)) return unauthorized();

  try {
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get('q')?.trim().slice(0, 100) || '';
    const status = searchParams.get('status') || 'all';
    const page = Math.max(1, Number.parseInt(searchParams.get('page') || '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(searchParams.get('limit') || '20', 10) || 20));
    const filters = [];

    if (status === 'ACTIVE' || status === 'INACTIVE' || status === 'SUSPENDED') {
      filters.push(eq(users.status, status));
    }
    if (query) {
      const searchFilter = or(
        like(users.name, `%${query}%`),
        like(users.mobile, `%${query}%`),
        like(users.email, `%${query}%`),
        like(users.businessName, `%${query}%`)
      );
      if (searchFilter) filters.push(searchFilter);
    }

    const where = filters.length ? and(...filters) : undefined;
    const [rows, totals] = await Promise.all([
      db
        .select({
          id: users.id,
          name: users.name,
          mobile: users.mobile,
          email: users.email,
          businessName: users.businessName,
          plan: users.plan,
          credits: users.credits,
          status: users.status,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(where)
        .orderBy(desc(users.createdAt), desc(users.id))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ total: count() }).from(users).where(where),
    ]);

    return NextResponse.json({
      success: true,
      vendors: rows,
      pagination: {
        page,
        limit,
        total: Number(totals[0]?.total || 0),
        pages: Math.ceil(Number(totals[0]?.total || 0) / limit),
      },
    });
  } catch (error) {
    console.error('[Admin Vendors] Could not list vendor accounts:', error);
    return NextResponse.json(
      { success: false, message: 'Could not load vendor accounts.' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  if (!authorize(request)) return unauthorized();

  try {
    const body = await request.json().catch(() => null);
    const parsed = createVendorSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: parsed.error.issues[0]?.message || 'Invalid vendor details.' },
        { status: 400 }
      );
    }

    const { name, mobile, businessName } = parsed.data;
    const email = parsed.data.email || null;
    const duplicate = email
      ? or(eq(users.mobile, mobile), eq(users.email, email))
      : eq(users.mobile, mobile);
    const existing = await db.select({ id: users.id }).from(users).where(duplicate).limit(1);

    if (existing.length) {
      return NextResponse.json(
        { success: false, message: 'A vendor with this mobile number or email already exists.' },
        { status: 409 }
      );
    }

    const [insertResult] = await db.insert(users).values({
        name,
        mobile,
        email,
        businessName: businessName || null,
        plan: 'free',
        credits: 2,
        status: 'ACTIVE',
    });
    const vendorId = Number((insertResult as { insertId: number }).insertId);

    return NextResponse.json(
      {
        success: true,
        vendor: {
          id: vendorId,
          name,
          mobile,
          email,
          businessName: businessName || null,
          plan: 'free',
          credits: 2,
          status: 'ACTIVE',
        },
        message: 'Vendor created. They can sign in with their mobile number and OTP.',
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('[Admin Vendors] Could not create vendor account:', error);
    return NextResponse.json(
      { success: false, message: 'Could not create vendor account.' },
      { status: 500 }
    );
  }
}
