import { and, eq, ne } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { db } from '@/db';
import { users } from '@/db/schema';
import { hasValidAdminSession, SESSION_COOKIE_NAME } from '@/lib/adminAuth';

const updateVendorSchema = z.object({
  name: z.string().trim().min(2).max(191).optional(),
  email: z.union([z.string().trim().email().max(191), z.literal(''), z.null()]).optional(),
  businessName: z.union([z.string().trim().max(190), z.literal(''), z.null()]).optional(),
  credits: z.number().int().min(0).max(1_000_000).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
});

type RouteContext = { params: Promise<{ vendorId: string }> };

export async function PATCH(request: NextRequest, context: RouteContext) {
  if (!hasValidAdminSession(request.cookies.get(SESSION_COOKIE_NAME)?.value)) {
    return NextResponse.json(
      { success: false, message: 'Admin session expired. Please sign in again.' },
      { status: 401 }
    );
  }

  try {
    const { vendorId: rawId } = await context.params;
    const vendorId = Number.parseInt(rawId, 10);
    if (!Number.isSafeInteger(vendorId) || vendorId <= 0) {
      return NextResponse.json({ success: false, message: 'Invalid vendor ID.' }, { status: 400 });
    }

    const body = await request.json().catch(() => null);
    const parsed = updateVendorSchema.safeParse(body);
    if (!parsed.success || !Object.keys(parsed.data || {}).length) {
      return NextResponse.json(
        { success: false, message: parsed.success ? 'No vendor changes provided.' : parsed.error.issues[0]?.message },
        { status: 400 }
      );
    }

    const changes = parsed.data;
    const email = typeof changes.email === 'string' ? changes.email.trim() || null : changes.email;
    if (email) {
      const duplicate = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, email), ne(users.id, vendorId)))
        .limit(1);
      if (duplicate.length) {
        return NextResponse.json(
          { success: false, message: 'That email address is already used by another account.' },
          { status: 409 }
        );
      }
    }

    const [updated] = await db
      .update(users)
      .set({
        ...(changes.name !== undefined ? { name: changes.name } : {}),
        ...(changes.email !== undefined ? { email: email ?? null } : {}),
        ...(changes.businessName !== undefined
          ? { businessName: typeof changes.businessName === 'string' ? changes.businessName || null : null }
          : {}),
        ...(changes.credits !== undefined ? { credits: changes.credits } : {}),
        ...(changes.status !== undefined ? { status: changes.status } : {}),
      })
      .where(eq(users.id, vendorId));

    const affectedRows =
      (updated as { affectedRows?: number })?.affectedRows ?? 0;
    if (!affectedRows) {
      const [existingVendor] = await db.select({ id: users.id }).from(users).where(eq(users.id, vendorId)).limit(1);
      if (!existingVendor) {
        return NextResponse.json({ success: false, message: 'Vendor not found.' }, { status: 404 });
      }
    }

    const [vendor] = await db
      .select({
        id: users.id,
        name: users.name,
        mobile: users.mobile,
        email: users.email,
        businessName: users.businessName,
        plan: users.plan,
        credits: users.credits,
        status: users.status,
      })
      .from(users)
      .where(eq(users.id, vendorId))
      .limit(1);

    return NextResponse.json({ success: true, vendor });
  } catch (error) {
    console.error('[Admin Vendors] Could not update vendor account:', error);
    return NextResponse.json(
      { success: false, message: 'Could not update vendor account.' },
      { status: 500 }
    );
  }
}
