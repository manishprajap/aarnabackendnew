import { NextRequest, NextResponse } from 'next/server';
import { and, eq, ne, or } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/db';
import { users } from '@/db/schema';
import { verifyToken } from '@/lib/auth';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

const profileSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(191).optional(),
  mobile: z
    .string()
    .trim()
    .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number')
    .optional(),
  email: z
    .string()
    .trim()
    .email('Enter a valid email')
    .max(191)
    .optional()
    .or(z.literal('')),
  business_category: z.string().trim().max(100).optional(),
  businessCategoryId: z.number().int().positive().nullable().optional(),
  city: z.string().trim().max(100).optional(),
  website: z.string().trim().max(255).optional(),
  logo: z.string().trim().max(255).optional(),
  language: z.string().trim().max(50).optional(),
});

function getAuthenticatedUserId(request: NextRequest) {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const token = bearer || request.cookies.get('token')?.value;

  if (!token) return null;
  return verifyToken(token)?.userId || null;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function PUT(request: NextRequest) {
  const userId = getAuthenticatedUserId(request);

  if (!userId) {
    return NextResponse.json(
      { success: false, error: 'Not authenticated' },
      { status: 401, headers: corsHeaders() }
    );
  }

  try {
    const parsed = profileSchema.safeParse(await request.json());

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Invalid profile data' },
        { status: 400, headers: corsHeaders() }
      );
    }

    const data = parsed.data;
    const email = data.email === '' ? null : data.email;
    const duplicateValues = [
      email ? eq(users.email, email) : undefined,
      data.mobile ? eq(users.mobile, data.mobile) : undefined,
    ].filter((condition): condition is ReturnType<typeof eq> => Boolean(condition));

    if (duplicateValues.length > 0) {
      const duplicate = await db
        .select({ id: users.id })
        .from(users)
        .where(and(ne(users.id, userId), or(...duplicateValues)))
        .limit(1);

      if (duplicate.length > 0) {
        return NextResponse.json(
          { success: false, error: 'Email or mobile number is already in use' },
          { status: 409, headers: corsHeaders() }
        );
      }
    }

    const updates: Partial<typeof users.$inferInsert> = {};

    if (data.name !== undefined) updates.name = data.name;
    if (data.mobile !== undefined) updates.mobile = data.mobile;
    if (data.email !== undefined) updates.email = email;
    if (data.business_category !== undefined) updates.business_category = data.business_category;
    if (data.businessCategoryId !== undefined) updates.businessCategoryId = data.businessCategoryId;
    if (data.city !== undefined) updates.city = data.city;
    if (data.website !== undefined) updates.website = data.website;
    if (data.logo !== undefined) updates.logo = data.logo;
    if (data.language !== undefined) updates.language = data.language;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { success: false, error: 'At least one profile field is required' },
        { status: 400, headers: corsHeaders() }
      );
    }

    await db.update(users).set(updates).where(eq(users.id, userId));

    const [user] = await db
      .select({
        id: users.id,
        name: users.name,
        mobile: users.mobile,
        email: users.email,
        business_category: users.business_category,
        businessCategoryId: users.businessCategoryId,
        city: users.city,
        website: users.website,
        logo: users.logo,
        language: users.language,
        plan: users.plan,
        credits: users.credits,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return NextResponse.json(
      { success: true, user },
      { headers: corsHeaders() }
    );
  } catch (error) {
    console.error('[Profile Update] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update profile' },
      { status: 500, headers: corsHeaders() }
    );
  }
}

export async function PATCH(request: NextRequest) {
  return PUT(request);
}