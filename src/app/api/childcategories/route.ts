import { NextRequest, NextResponse } from 'next/server';
import { asc, count, eq } from 'drizzle-orm';

import { db } from '@/db';
import { childCategories } from '@/db/schema';
import { adminUnauthorized, isAdminRequest } from '@/lib/adminApi';

export async function GET(request: NextRequest) {
  try {
    const subcategoryParam = request.nextUrl.searchParams.get('subcategoryId');
    const subcategoryId = subcategoryParam ? Number(subcategoryParam) : null;
    const pageParam = request.nextUrl.searchParams.get('page');
    const where = subcategoryId !== null ? eq(childCategories.subcategoryId, subcategoryId) : undefined;

    if (pageParam === null) {
      const rows = await db.select().from(childCategories).where(where).orderBy(asc(childCategories.sortOrder));
      return NextResponse.json({ success: true, childCategories: rows });
    }

    const page = Math.max(1, Number.parseInt(pageParam, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(request.nextUrl.searchParams.get('limit') || '20', 10) || 20));
    const [rows, totals] = await Promise.all([
      db.select().from(childCategories).where(where).orderBy(asc(childCategories.sortOrder)).limit(limit).offset((page - 1) * limit),
      db.select({ total: count() }).from(childCategories).where(where),
    ]);
    const total = Number(totals[0]?.total || 0);
    return NextResponse.json({
      success: true,
      childCategories: rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('[Child Categories] Could not load child categories:', error);
    return NextResponse.json({ success: false, message: 'Could not load child categories.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!isAdminRequest(request)) return adminUnauthorized();
  try {
    const body = await request.json().catch(() => null);
    const subcategoryId = Number(body?.subcategoryId);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!Number.isInteger(subcategoryId) || subcategoryId <= 0 || !name || name.length > 100) {
      return NextResponse.json(
        { success: false, message: 'A valid subcategory and child category name are required.' },
        { status: 400 }
      );
    }
    const [result] = await db.insert(childCategories).values({
      subcategoryId,
      name,
      sortOrder: Number.isInteger(body?.sortOrder) ? body.sortOrder : 0,
    });
    return NextResponse.json({ success: true, id: result.insertId }, { status: 201 });
  } catch (error) {
    console.error('[Child Categories] Could not create child category:', error);
    return NextResponse.json({ success: false, message: 'Could not create child category.' }, { status: 500 });
  }
}
