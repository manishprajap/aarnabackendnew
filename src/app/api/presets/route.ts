import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { adPresets } from '@/db/schema';
import { and, asc, count, eq, isNull, or } from 'drizzle-orm';
import { adminUnauthorized, isAdminRequest } from '@/lib/adminApi';

/*
|--------------------------------------------------------------------------
| GET /api/presets?group=style&categoryId=xxx
|--------------------------------------------------------------------------
*/

export async function GET(req: NextRequest) {
  try {
    const group = req.nextUrl.searchParams.get('group');
    const categoryIdParam = req.nextUrl.searchParams.get('categoryId');
    const categoryId = categoryIdParam ? parseInt(categoryIdParam, 10) : null;

    const pageParam = req.nextUrl.searchParams.get('page');
    const filters = [];
    if (group) filters.push(eq(adPresets.group, group));
    if (categoryId !== null) filters.push(or(eq(adPresets.categoryId, categoryId), isNull(adPresets.categoryId))!);
    const where = filters.length ? and(...filters) : undefined;

    if (pageParam === null) {
      const rows = await db.select().from(adPresets).where(where).orderBy(asc(adPresets.sortOrder));
      return NextResponse.json({ success: true, presets: rows });
    }

    const page = Math.max(1, Number.parseInt(pageParam, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.nextUrl.searchParams.get('limit') || '20', 10) || 20));
    const [rows, totals] = await Promise.all([
      db.select().from(adPresets).where(where).orderBy(asc(adPresets.sortOrder)).limit(limit).offset((page - 1) * limit),
      db.select({ total: count() }).from(adPresets).where(where),
    ]);
    const total = Number(totals[0]?.total || 0);
    return NextResponse.json({ success: true, presets: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error('LIST PRESETS ERROR:', error);

    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : 'Failed to fetch presets' },
      { status: 500 }
    );
  }
}

/*
|--------------------------------------------------------------------------
| POST /api/presets
|--------------------------------------------------------------------------
*/

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) return adminUnauthorized();
  try {
    const body = await req.json();

    const {
      presetKey,
      name,
      group,
      categoryId,
      aspectRatio,
      promptModifier,
      requiresOffer,
      icon,
      sortOrder,
    } = body;

    if (!presetKey || !name || !group || !promptModifier) {
      return NextResponse.json(
        {
          success: false,
          message: 'presetKey, name, group and promptModifier are required',
        },
        { status: 400 }
      );
    }

    if (!['style', 'creative_type'].includes(group)) {
      return NextResponse.json(
        { success: false, message: "group must be 'style' or 'creative_type'" },
        { status: 400 }
      );
    }

    // categoryId comes in as a number (or is omitted/undefined for universal presets).
    const resolvedCategoryId =
      typeof categoryId === 'number'
        ? categoryId
        : categoryId
        ? parseInt(categoryId, 10)
        : null;

    // id is auto-increment now — MySQL assigns it, we don't generate it.
    const [result] = await db.insert(adPresets).values({
      presetKey,
      name,
      group,
      categoryId: resolvedCategoryId,
      aspectRatio: aspectRatio || '1:1',
      promptModifier,
      requiresOffer: !!requiresOffer,
      icon: icon || null,
      sortOrder: typeof sortOrder === 'number' ? sortOrder : 0,
      isActive: true,
    });

    const newId = result.insertId;

    return NextResponse.json({ success: true, id: newId });
  } catch (error) {
    console.error('CREATE PRESET ERROR:', error);

    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : 'Failed to create preset' },
      { status: 500 }
    );
  }
}