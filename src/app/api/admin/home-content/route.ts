// app/api/admin/home-content/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { AuthError, getUserIdFromRequest } from '@/lib/auth';
import { isAdminRequest } from '@/lib/adminApi';

export const dynamic = 'force-dynamic';

type ContentType = 'banner' | 'news';
type MediaType = 'image' | 'video' | 'none';

type ParsedContent = {
  contentType: ContentType;
  title: string;
  description: string | null;
  mediaUrl: string | null;
  mediaType: MediaType;
  buttonText: string | null;
  buttonUrl: string | null;
  newsUrl: string | null;
  displayOrder: number;
  isActive: 0 | 1;
};

/** Thrown when the user is logged in but is not an admin (403, not 401). */
class ForbiddenError extends Error {
  constructor(message = 'Admin access required') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ success: false, message }, { status });
}

const isHttpUrl = (value: string) => /^https?:\/\//i.test(value.trim());

/**
 * Drizzle raw-query results differ by driver.
 * Normalize SELECT results to an array of rows.
 */
function normalizeRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    // mysql2: [rows, fields]
    if (
      result.length === 2 &&
      Array.isArray(result[0]) &&
      (Array.isArray(result[1]) || result[1] == null)
    ) {
      return result[0] as T[];
    }
    return result as T[];
  }

  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }

  return [];
}

/**
 * mysql2 returns [ResultSetHeader, fields] for INSERT.
 * Other drivers may return the header directly.
 */
function getInsertId(result: unknown): number | null {
  const header = Array.isArray(result) ? result[0] : result;
  const insertId = (header as { insertId?: number | bigint } | null)?.insertId;
  return insertId ? Number(insertId) : null;
}

async function requireAdmin(req: NextRequest): Promise<number | null> {
  if (isAdminRequest(req)) {
    return null;
  }

  // Throws AuthError (-> 401) when the user is not logged in.
  const userId = await getUserIdFromRequest(req);

  const result = await db.execute(sql`
    SELECT role
    FROM users
    WHERE id = ${userId}
    LIMIT 1
  `);

  const rows = normalizeRows<{ role: string | null }>(result);
  const role = rows[0]?.role?.toLowerCase();

  if (role !== 'admin') {
    throw new ForbiddenError();
  }

  return userId;
}

async function readJson<T>(req: NextRequest): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

async function recordExists(id: number): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT id FROM home_content WHERE id = ${id} LIMIT 1
  `);
  return normalizeRows(result).length > 0;
}

const optionalString = (v: unknown) =>
  v === undefined || v === null || typeof v === 'string';

const clean = (v: unknown): string | null =>
  typeof v === 'string' ? v.trim() || null : null;

/** Validates and normalizes a request body. Shared by POST and PUT. */
function parseContent(
  body: Record<string, unknown> | null,
): { error: string } | { data: ParsedContent } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Invalid request body' };
  }

  const contentType = body.content_type;
  if (contentType !== 'banner' && contentType !== 'news') {
    return { error: 'content_type must be banner or news' };
  }

  if (typeof body.title !== 'string' || !body.title.trim()) {
    return { error: 'Title is required' };
  }
  const title = body.title.trim();
  if (title.length > 255) {
    return { error: 'Title must be 255 characters or fewer' };
  }

  for (const key of [
    'description',
    'media_url',
    'button_text',
    'button_url',
    'news_url',
  ]) {
    if (!optionalString(body[key])) {
      return { error: `${key} must be a string` };
    }
  }

  if (
    body.media_type !== undefined &&
    !['image', 'video', 'none'].includes(body.media_type as string)
  ) {
    return { error: 'media_type must be image, video or none' };
  }

  if (
    body.is_active !== undefined &&
    typeof body.is_active !== 'boolean' &&
    body.is_active !== 0 &&
    body.is_active !== 1
  ) {
    return { error: 'is_active must be a boolean' };
  }

  const displayOrder = Number(body.display_order ?? 0);
  if (!Number.isInteger(displayOrder) || displayOrder < 0) {
    return { error: 'display_order must be a non-negative integer' };
  }

  const description = clean(body.description);
  const isActive: 0 | 1 =
    body.is_active === false || body.is_active === 0 ? 0 : 1;

  if (contentType === 'banner') {
    const mediaUrl = clean(body.media_url);
    const mediaType: MediaType =
      (body.media_type as MediaType | undefined) ??
      (mediaUrl ? 'image' : 'none');
    const buttonUrl = clean(body.button_url);
    const buttonText = clean(body.button_text);

    if (mediaType !== 'none' && !mediaUrl) {
      return { error: 'Media URL is required for an image/video banner' };
    }
    if (mediaType !== 'none' && mediaUrl && !isHttpUrl(mediaUrl)) {
      return { error: 'Media URL must start with http:// or https://' };
    }
    if (buttonUrl && !isHttpUrl(buttonUrl)) {
      return { error: 'Button URL must start with http:// or https://' };
    }
    if (buttonText && !buttonUrl) {
      return { error: 'Button URL is required when button text is set' };
    }

    return {
      data: {
        contentType,
        title,
        description,
        mediaUrl: mediaType === 'none' ? null : mediaUrl,
        mediaType,
        buttonText,
        buttonUrl,
        newsUrl: null,
        displayOrder,
        isActive,
      },
    };
  }

  // news
  const newsUrl = clean(body.news_url);
  if (!description) {
    return { error: 'News text is required' };
  }
  if (newsUrl && !isHttpUrl(newsUrl)) {
    return { error: 'News URL must start with http:// or https://' };
  }

  return {
    data: {
      contentType,
      title,
      description,
      mediaUrl: null,
      mediaType: 'none',
      buttonText: null,
      buttonUrl: null,
      newsUrl,
      displayOrder,
      isActive,
    },
  };
}

function handleError(error: unknown) {
  if (error instanceof ForbiddenError) {
    return jsonError(error.message, 403);
  }
  if (error instanceof AuthError) {
    return jsonError(error.message, 401);
  }

  console.error('Admin home-content API error:', error);
  return jsonError('Internal server error', 500);
}

// GET: List all banners and news for the admin page.
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);

    const result = await db.execute(sql`
      SELECT
        id, content_type, title, description, media_url, media_type,
        button_text, button_url, news_url, display_order, is_active,
        created_by, created_at, updated_at
      FROM home_content
      ORDER BY content_type ASC, display_order ASC, id DESC
    `);

    return NextResponse.json({
      success: true,
      data: normalizeRows(result),
    });
  } catch (error) {
    return handleError(error);
  }
}

// POST: Add a banner or a news item.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireAdmin(req);

    const body = await readJson<Record<string, unknown>>(req);
    if (!body) return jsonError('Invalid JSON body', 400);

    const parsed = parseContent(body);
    if ('error' in parsed) return jsonError(parsed.error, 400);
    const c = parsed.data;

    const result = await db.execute(sql`
      INSERT INTO home_content (
        content_type, title, description, media_url, media_type,
        button_text, button_url, news_url, display_order, is_active, created_by
      ) VALUES (
        ${c.contentType}, ${c.title}, ${c.description}, ${c.mediaUrl}, ${c.mediaType},
        ${c.buttonText}, ${c.buttonUrl}, ${c.newsUrl}, ${c.displayOrder}, ${c.isActive}, ${userId}
      )
    `);

    return NextResponse.json(
      {
        success: true,
        message: 'Content added successfully',
        id: getInsertId(result),
      },
      { status: 201 },
    );
  } catch (error) {
    return handleError(error);
  }
}

// PUT: Update an existing record. Send id in the JSON body.
export async function PUT(req: NextRequest) {
  try {
    await requireAdmin(req);

    const body = await readJson<Record<string, unknown>>(req);
    if (!body) return jsonError('Invalid JSON body', 400);

    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) {
      return jsonError('A valid id is required', 400);
    }

    const parsed = parseContent(body);
    if ('error' in parsed) return jsonError(parsed.error, 400);
    const c = parsed.data;

    if (!(await recordExists(id))) {
      return jsonError('Content not found', 404);
    }

    await db.execute(sql`
      UPDATE home_content
      SET
        content_type = ${c.contentType},
        title = ${c.title},
        description = ${c.description},
        media_url = ${c.mediaUrl},
        media_type = ${c.mediaType},
        button_text = ${c.buttonText},
        button_url = ${c.buttonUrl},
        news_url = ${c.newsUrl},
        display_order = ${c.displayOrder},
        is_active = ${c.isActive},
        updated_at = NOW()
      WHERE id = ${id}
    `);

    return NextResponse.json({
      success: true,
      message: 'Content updated successfully',
    });
  } catch (error) {
    return handleError(error);
  }
}

// PATCH: Toggle active/inactive status with { id, is_active }.
export async function PATCH(req: NextRequest) {
  try {
    await requireAdmin(req);

    const body = await readJson<{ id?: number; is_active?: boolean }>(req);
    if (!body) return jsonError('Invalid JSON body', 400);

    const id = Number(body.id);
    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      typeof body.is_active !== 'boolean'
    ) {
      return jsonError('Valid id and boolean is_active are required', 400);
    }

    if (!(await recordExists(id))) {
      return jsonError('Content not found', 404);
    }

    await db.execute(sql`
      UPDATE home_content
      SET is_active = ${body.is_active ? 1 : 0},
          updated_at = NOW()
      WHERE id = ${id}
    `);

    return NextResponse.json({
      success: true,
      message: 'Status updated successfully',
    });
  } catch (error) {
    return handleError(error);
  }
}

// DELETE: Delete using /api/admin/home-content?id=123
export async function DELETE(req: NextRequest) {
  try {
    await requireAdmin(req);

    const id = Number(req.nextUrl.searchParams.get('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return jsonError('A valid id is required in the query string', 400);
    }

    if (!(await recordExists(id))) {
      return jsonError('Content not found', 404);
    }

    await db.execute(sql`
      DELETE FROM home_content
      WHERE id = ${id}
    `);

    return NextResponse.json({
      success: true,
      message: 'Content deleted successfully',
    });
  } catch (error) {
    return handleError(error);
  }
}