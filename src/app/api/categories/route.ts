import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { categories } from '@/db/schema';
import { asc, count } from 'drizzle-orm';
import { adminUnauthorized, isAdminRequest } from '@/lib/adminApi';

/*
|--------------------------------------------------------------------------
| GET /api/categories
|--------------------------------------------------------------------------
*/

export async function GET(req: NextRequest) {
  try {
    const pageParam = req.nextUrl.searchParams.get('page');
    if (pageParam === null) {
      const allCategories = await db.select().from(categories).orderBy(asc(categories.sortOrder));
      return NextResponse.json({ success: true, categories: allCategories });
    }

    const page = Math.max(1, Number.parseInt(pageParam, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.nextUrl.searchParams.get('limit') || '20', 10) || 20));
    const [allCategories, totalRows] = await Promise.all([
      db.select().from(categories).orderBy(asc(categories.sortOrder)).limit(limit).offset((page - 1) * limit),
      db.select({ total: count() }).from(categories),
    ]);

    const total = Number(totalRows[0]?.total || 0);
    return NextResponse.json({
      success: true,
      categories: allCategories,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('LIST CATEGORIES ERROR:', error);

    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : 'Failed to fetch categories' },
      { status: 500 }
    );
  }
}

/*
|--------------------------------------------------------------------------
| POST /api/categories
|--------------------------------------------------------------------------
*/

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) return adminUnauthorized();
  try {
    const body = await req.json();

    const { name, icon, sortOrder } = body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json(
        { success: false, message: 'Category name is required' },
        { status: 400 }
      );
    }

    // id is auto-increment now — MySQL assigns it, we don't generate it.
    const [result] = await db.insert(categories).values({
      name: name.trim(),
      icon: icon || null,
      sortOrder: typeof sortOrder === 'number' ? sortOrder : 0,
      isActive: true,
    });

    const newId = result.insertId;

    return NextResponse.json({
      success: true,
      id: newId,
      category: {
        id: newId,
        name: name.trim(),
        icon: icon || null,
        sortOrder: typeof sortOrder === 'number' ? sortOrder : 0,
        isActive: true,
      },
    });
  } catch (error) {
    console.error('CREATE CATEGORY ERROR:', error);

    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : 'Failed to create category' },
      { status: 500 }
    );
  }
}