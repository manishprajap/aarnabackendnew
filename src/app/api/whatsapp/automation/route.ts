import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { whatsappConnections } from '@/db/schema';
import { AuthError, getUserIdFromRequest } from '@/lib/auth';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(origin: string | null, body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: corsHeaders(origin) });
}

async function getUserId(req: NextRequest): Promise<number | null> {
  const userId = Number(await getUserIdFromRequest(req));
  return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req.headers.get('origin')),
  });
}

export async function GET(req: NextRequest) {
  const origin = req.headers.get('origin');

  try {
    const userId = await getUserId(req);
    if (!userId) return json(origin, { success: false, message: 'Unauthorized' }, 401);

    const [connection] = await db
      .select({
        status: whatsappConnections.status,
        enabled: whatsappConnections.aiAutoReplyEnabled,
        instructions: whatsappConnections.aiInstructions,
      })
      .from(whatsappConnections)
      .where(eq(whatsappConnections.userId, userId))
      .limit(1);

    return json(origin, {
      success: true,
      connected: Boolean(connection && connection.status === 'active'),
      enabled: Boolean(connection?.enabled),
      instructions: connection?.instructions ?? '',
      geminiConfigured: Boolean((process.env.GEMINI_API_KEY ?? '').trim()),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return json(origin, { success: false, message: error.message }, 401);
    }

    console.error('[WhatsApp automation GET] Failed to load settings:', error);
    return json(origin, { success: false, message: 'Could not load AI reply settings.' }, 500);
  }
}

export async function PATCH(req: NextRequest) {
  const origin = req.headers.get('origin');

  try {
    const userId = await getUserId(req);
    if (!userId) return json(origin, { success: false, message: 'Unauthorized' }, 401);

    let body: { enabled?: unknown; instructions?: unknown };
    try {
      body = await req.json();
    } catch {
      return json(origin, { success: false, message: 'Invalid JSON request body.' }, 400);
    }

    if (typeof body.enabled !== 'boolean') {
      return json(origin, { success: false, message: 'enabled must be a boolean.' }, 400);
    }

    if (
      body.instructions !== undefined &&
      (typeof body.instructions !== 'string' || body.instructions.length > 2000)
    ) {
      return json(
        origin,
        { success: false, message: 'Instructions must be text no longer than 2,000 characters.' },
        400,
      );
    }

    const [connection] = await db
      .select({ id: whatsappConnections.id, status: whatsappConnections.status })
      .from(whatsappConnections)
      .where(eq(whatsappConnections.userId, userId))
      .limit(1);

    if (!connection || connection.status !== 'active') {
      return json(origin, { success: false, message: 'Connect an active WhatsApp number first.' }, 409);
    }

    if (body.enabled && !(process.env.GEMINI_API_KEY ?? '').trim()) {
      return json(
        origin,
        { success: false, message: 'The server is missing GEMINI_API_KEY. Ask your administrator to configure it.' },
        503,
      );
    }

    const updates: {
      aiAutoReplyEnabled: boolean;
      aiInstructions?: string;
    } = { aiAutoReplyEnabled: body.enabled };

    if (typeof body.instructions === 'string') {
      updates.aiInstructions = body.instructions.trim();
    }

    await db
      .update(whatsappConnections)
      .set(updates)
      .where(eq(whatsappConnections.id, connection.id));

    return json(origin, {
      success: true,
      enabled: body.enabled,
      instructions: updates.aiInstructions ?? undefined,
      geminiConfigured: true,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return json(origin, { success: false, message: error.message }, 401);
    }

    console.error('[WhatsApp automation PATCH] Failed to save settings:', error);
    return json(origin, { success: false, message: 'Could not save AI reply settings.' }, 500);
  }
}
