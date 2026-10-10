// app/api/admin/home-content/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { AuthError } from '@/lib/auth';
import { isAdminRequest } from '@/lib/adminApi';

export const dynamic = 'force-dynamic';

type ContentType = 'banner' | 'news';

/**
 * Must match the DB column exactly:
 * home_content.media_type = enum('image','video','text') DEFAULT 'text'
 * 'none' is NEVER stored. It is accepted from the client and mapped to 'text'.
 */
type DbMediaType = 'image' | 'video' | 'text';

type ParsedContent = {
  contentType: ContentType;
  title: string;
  description: string | null;
  mediaUrl: string | null;
  mediaType: DbMediaType;
  buttonText: string | null;
  buttonUrl: string | null;
  newsUrl: string | null;
  startDate: string | null;
  endDate: string | null;
  displayOrder: number;
  isActive: 0 | 1;
};

const ACCEPTED_MEDIA_TYPES = ['image', 'video', 'text', 'none'];

function jsonError(message: string, status: number) {
  return NextResponse.json({ success: false, message }, { status });
}

const isHttpUrl = (value: string) => /^https?:\/\//i.test(value.trim());
const isUploadedMediaPath = (value: string) =>
  /^\/upload\/home-content\/[a-zA-Z0-9-]+\.(?:jpg|png|webp|gif|mp4|webm|mov)$/i.test(value.trim()) ||
  /^\/uploads\/home-content\/[a-zA-Z0-9-]+\.(?:jpg|png|webp|gif|mp4|webm|mov)$/i.test(value.trim());

/** Maps any client value ('none', 'text', undefined, ...) to a value the DB enum accepts. */
function toDbMediaType(value: unknown, hasMediaUrl: boolean): DbMediaType {
  if (value === 'image' || value === 'video') return value;
  if (value === 'text' || value === 'none') return 'text';
  // Not provided: infer from whether a media URL exists
  return hasMediaUrl ? 'image' : 'text';
}

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

/**
 * Throws AuthError if the request is not an admin request.
 * Returns the admin user id when one is available, otherwise null
 * (created_by is nullable in the table).
 */
function requireAdmin(req: NextRequest): number | null {
  if (!isAdminRequest(req)) {
    throw new AuthError('Admin session expired. Please sign in again.');
  }

  return null;
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

function isValidDateOnly(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

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
    'start_date',
    'end_date',
  ]) {
    if (!optionalString(body[key])) {
      return { error: `${key} must be a string` };
    }
  }

  if (
    body.media_type !== undefined &&
    body.media_type !== null &&
    !ACCEPTED_MEDIA_TYPES.includes(body.media_type as string)
  ) {
    return { error: 'media_type must be image, video, text or none' };
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
  const startDate = clean(body.start_date);
  const endDate = clean(body.end_date);
  if (startDate && !isValidDateOnly(startDate)) {
    return { error: 'start_date must be a valid YYYY-MM-DD date' };
  }
  if (endDate && !isValidDateOnly(endDate)) {
    return { error: 'end_date must be a valid YYYY-MM-DD date' };
  }
  if (startDate && endDate && endDate < startDate) {
    return { error: 'end_date must be on or after start_date' };
  }

  const toDatabaseDate = (value: string | null) =>
    value ? `${value} 00:00:00` : null;
  const databaseStartDate = toDatabaseDate(startDate);
  const databaseEndDate = toDatabaseDate(endDate);
  const isActive: 0 | 1 =
    body.is_active === false || body.is_active === 0 ? 0 : 1;

  if (contentType === 'banner') {
    const rawMediaUrl = clean(body.media_url);
    // 'none' / 'text' / missing -> 'text' (valid DB enum value)
    const mediaType = toDbMediaType(body.media_type, Boolean(rawMediaUrl));
    const hasMedia = mediaType === 'image' || mediaType === 'video';
    const mediaUrl = hasMedia ? rawMediaUrl : null;
    const buttonUrl = clean(body.button_url);
    const buttonText = clean(body.button_text);

    if (hasMedia && !mediaUrl) {
      return { error: 'Media URL is required for an image/video banner' };
    }
    if (hasMedia && mediaUrl && !isHttpUrl(mediaUrl) && !isUploadedMediaPath(mediaUrl)) {
      return { error: 'Banner media must be uploaded or use a valid http:// or https:// URL' };
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
        mediaUrl,
        mediaType,
        buttonText,
        buttonUrl,
        newsUrl: null,
        startDate: databaseStartDate,
        endDate: databaseEndDate,
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
      mediaType: 'text', // news is always text-only
      buttonText: null,
      buttonUrl: null,
      newsUrl,
      startDate: databaseStartDate,
      endDate: databaseEndDate,
      displayOrder,
      isActive,
    },
  };
}

function handleError(error: unknown) {
  if (error instanceof AuthError) {
    return jsonError(error.message, 401);
  }

  console.error('Admin home-content API error:', error);
  return jsonError('Internal server error', 500);
}

// Admins receive all records; public clients receive only active homepage content.
export async function GET(req: NextRequest) {
  try {
    const isAdmin = isAdminRequest(req);

    const result = isAdmin
      ? await db.execute(sql`
          SELECT
            id, content_type, title, description, media_url, media_type,
            button_text, button_url, news_url, display_order, is_active,
            DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date,
            created_by, created_at, updated_at
          FROM home_content
          ORDER BY content_type ASC, display_order ASC, id DESC
        `)
      : await db.execute(sql`
          SELECT
            id, content_type, title, description, media_url, media_type,
            button_text, button_url, news_url, display_order, is_active,
            DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date
          FROM home_content
          WHERE is_active = 1
            AND (start_date IS NULL OR DATE(start_date) <= CURRENT_DATE())
            AND (end_date IS NULL OR DATE(end_date) >= CURRENT_DATE())
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
    const userId = requireAdmin(req);

    const body = await readJson<Record<string, unknown>>(req);
    if (!body) return jsonError('Invalid JSON body', 400);

    const parsed = parseContent(body);
    if ('error' in parsed) return jsonError(parsed.error, 400);
    const c = parsed.data;

    const result = await db.execute(sql`
      INSERT INTO home_content (
        content_type, title, description, media_url, media_type,
        button_text, button_url, news_url, display_order, is_active,
        start_date, end_date, created_by
      ) VALUES (
        ${c.contentType}, ${c.title}, ${c.description}, ${c.mediaUrl}, ${c.mediaType},
        ${c.buttonText}, ${c.buttonUrl}, ${c.newsUrl}, ${c.displayOrder}, ${c.isActive},
        ${c.startDate}, ${c.endDate}, ${userId}
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
    requireAdmin(req);

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
        start_date = ${c.startDate},
        end_date = ${c.endDate},
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
    requireAdmin(req);

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
    requireAdmin(req);

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