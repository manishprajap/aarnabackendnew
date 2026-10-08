import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { childCategories } from '@/db/schema';
import { asc, eq } from 'drizzle-orm';
import { adminUnauthorized, isAdminRequest } from '@/lib/adminApi';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ subcategoryId: string }> }
) {
  try {
    const { subcategoryId: subcategoryIdParam } = await params;
    const subcategoryId = parseInt(subcategoryIdParam, 10);

    if (Number.isNaN(subcategoryId)) {
      return NextResponse.json(
        { success: false, message: 'Invalid subcategoryId' },
        { status: 400 }
      );
    }

    const rows = await db
      .select()
      .from(childCategories)
      .where(eq(childCategories.subcategoryId, subcategoryId))
      .orderBy(asc(childCategories.sortOrder));

    return NextResponse.json({ success: true, childCategories: rows });
  } catch (error: any) {
    console.error('LIST CHILD CATEGORIES ERROR:', error);
    return NextResponse.json(
      { success: false, message: error?.message || 'Failed to fetch child categories' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) return adminUnauthorized();
  try {
    const body = await req.json();
    const { subcategoryId, name, sortOrder } = body;

    if (!subcategoryId) {
      return NextResponse.json(
        { success: false, message: 'subcategoryId is required' },
        { status: 400 }
      );
    }

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json(
        { success: false, message: 'Child category name is required' },
        { status: 400 }
      );
    }

    const resolvedSubcategoryId =
      typeof subcategoryId === 'number' ? subcategoryId : parseInt(subcategoryId, 10);

    if (Number.isNaN(resolvedSubcategoryId)) {
      return NextResponse.json(
        { success: false, message: 'subcategoryId must be a valid number' },
        { status: 400 }
      );
    }

    const [result] = await db.insert(childCategories).values({
      subcategoryId: resolvedSubcategoryId,
      name: name.trim(),
      sortOrder: typeof sortOrder === 'number' ? sortOrder : 0,
    });

    const newId = result.insertId;

    return NextResponse.json({
      success: true,
      id: newId,
      childCategory: {
        id: newId,
        subcategoryId: resolvedSubcategoryId,
        name: name.trim(),
        sortOrder: typeof sortOrder === 'number' ? sortOrder : 0,
      },
    });
  } catch (error: any) {
    console.error('CREATE CHILD CATEGORY ERROR:', error);
    return NextResponse.json(
      { success: false, message: error?.message || 'Failed to create child category' },
      { status: 500 }
    );
  }
}