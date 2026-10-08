import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { subcategories } from '@/db/schema';
import { asc, count, eq } from 'drizzle-orm';
import { adminUnauthorized, isAdminRequest } from '@/lib/adminApi';

/*
|--------------------------------------------------------------------------
| GET /api/subcategories?categoryId=xxx
|--------------------------------------------------------------------------
*/

export async function GET(req: NextRequest) {
  try {
    const categoryIdParam = req.nextUrl.searchParams.get('categoryId');
    const categoryId = categoryIdParam ? parseInt(categoryIdParam, 10) : null;
    const pageParam = req.nextUrl.searchParams.get('page');

    const query = db.select().from(subcategories).orderBy(asc(subcategories.sortOrder));

    if (pageParam === null) {
      const rows = categoryId !== null ? await query.where(eq(subcategories.categoryId, categoryId)) : await query;
      return NextResponse.json({ success: true, subcategories: rows });
    }

    const page = Math.max(1, Number.parseInt(pageParam, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.nextUrl.searchParams.get('limit') || '20', 10) || 20));
    const where = categoryId !== null ? eq(subcategories.categoryId, categoryId) : undefined;
    const [rows, totalRows] = await Promise.all([
      db.select().from(subcategories).where(where).orderBy(asc(subcategories.sortOrder)).limit(limit).offset((page - 1) * limit),
      db.select({ total: count() }).from(subcategories).where(where),
    ]);

    const total = Number(totalRows[0]?.total || 0);
    return NextResponse.json({ success: true, subcategories: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error('LIST SUBCATEGORIES ERROR:', error);

    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : 'Failed to fetch subcategories' },
      { status: 500 }
    );
  }
}

/*
|--------------------------------------------------------------------------
| POST /api/subcategories
|--------------------------------------------------------------------------
*/

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) return adminUnauthorized();
  try {
    const body = await req.json();

    const { categoryId, name, sortOrder } = body;

    if (!categoryId) {
      return NextResponse.json(
        { success: false, message: 'categoryId is required' },
        { status: 400 }
      );
    }

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json(
        { success: false, message: 'Subcategory name is required' },
        { status: 400 }
      );
    }

    const resolvedCategoryId = typeof categoryId === 'number' ? categoryId : parseInt(categoryId, 10);

    if (Number.isNaN(resolvedCategoryId)) {
      return NextResponse.json(
        { success: false, message: 'categoryId must be a valid number' },
        { status: 400 }
      );
    }

    // id is auto-increment now — MySQL assigns it, we don't generate it.
    const [result] = await db.insert(subcategories).values({
      categoryId: resolvedCategoryId,
      name: name.trim(),
      sortOrder: typeof sortOrder === 'number' ? sortOrder : 0,
    });

    const newId = result.insertId;

    return NextResponse.json({
      success: true,
      id: newId,
      subcategory: {
        id: newId,
        categoryId: resolvedCategoryId,
        name: name.trim(),
        sortOrder: typeof sortOrder === 'number' ? sortOrder : 0,
      },
    });
  } catch (error) {
    console.error('CREATE SUBCATEGORY ERROR:', error);

    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : 'Failed to create subcategory' },
      { status: 500 }
    );
  }
}