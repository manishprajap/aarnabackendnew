// src/app/api/whatsapp/subscribe/route.ts
//
// GET  -> WABA subscription + phone number ka webhook_configuration dikhata hai
//         (yahan se pata chalta hai ki phone par purana override callback to nahi)
// POST -> WABA ko app par subscribe karta hai.
//         Body (optional): { "phoneCallbackUrl": "https://.../api/whatsapp/webhook" }
//         diya to phone-number level override bhi set karta hai (sirf tab karein jab GET me purana URL dikhe).

import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { whatsappConnections } from '@/db/schema';
import { getUserIdFromRequest, AuthError } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GRAPH_URL = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v25.0'}`;

function jsonError(message: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ success: false, message, ...extra }, { status });
}

async function getConnection(userId: number) {
  const [connection] = await db
    .select({
      wabaId: whatsappConnections.wabaId,
      phoneNumberId: whatsappConnections.phoneNumberId,
      accessToken: whatsappConnections.accessToken,
    })
    .from(whatsappConnections)
    .where(
      and(
        eq(whatsappConnections.userId, userId),
        eq(whatsappConnections.status, 'active')
      )
    )
    .orderBy(desc(whatsappConnections.id))
    .limit(1);

  if (!connection?.wabaId || !connection?.accessToken) return null;

  return {
    wabaId: String(connection.wabaId),
    phoneNumberId: connection.phoneNumberId ? String(connection.phoneNumberId) : null,
    accessToken: String(connection.accessToken),
  };
}

async function graphGet(path: string, accessToken: string) {
  const response = await fetch(`${GRAPH_URL}/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, data };
}

export async function GET(req: NextRequest) {
  try {
    const userId = Number(await getUserIdFromRequest(req));
    const connection = await getConnection(userId);
    if (!connection) {
      return jsonError('No active WhatsApp connection (WABA ID missing). Please reconnect.', 404);
    }

    const waba = await graphGet(`${connection.wabaId}/subscribed_apps`, connection.accessToken);
    if (!waba.ok) {
      return jsonError(waba.data?.error?.message || 'Could not read subscribed apps.', 400, {
        errorCode: waba.data?.error?.code,
      });
    }
    const apps = Array.isArray(waba.data?.data) ? waba.data.data : [];

    let phone: unknown = null;
    if (connection.phoneNumberId) {
      const result = await graphGet(
        `${connection.phoneNumberId}?fields=id,display_phone_number,verified_name,status,platform_type,webhook_configuration`,
        connection.accessToken
      );
      phone = result.ok
        ? result.data
        : { error: result.data?.error?.message || 'Could not read phone number.' };
    }

    return NextResponse.json({
      success: true,
      wabaId: connection.wabaId,
      phoneNumberId: connection.phoneNumberId,
      subscribed: apps.length > 0,
      apps,
      phone,
    });
  } catch (error) {
    if (error instanceof AuthError) return jsonError(error.message, 401);
    console.error('[WhatsApp Subscribe GET]', error instanceof Error ? error.message : error);
    return jsonError('Unable to check webhook subscription.', 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const userId = Number(await getUserIdFromRequest(req));
    const connection = await getConnection(userId);
    if (!connection) {
      return jsonError('No active WhatsApp connection (WABA ID missing). Please reconnect.', 404);
    }

    const body = (await req.json().catch(() => ({}))) as { phoneCallbackUrl?: unknown };
    const phoneCallbackUrl =
      typeof body?.phoneCallbackUrl === 'string' ? body.phoneCallbackUrl.trim() : '';

    // 1) WABA -> app subscription
    const response = await fetch(`${GRAPH_URL}/${connection.wabaId}/subscribed_apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${connection.accessToken}` },
      cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || data?.success === false) {
      console.error('[WhatsApp Subscribe POST] Meta error:', {
        httpStatus: response.status,
        code: data?.error?.code,
        message: data?.error?.message,
        fbtrace_id: data?.error?.fbtrace_id,
      });
      return jsonError(data?.error?.message || 'Meta rejected the subscription request.', 400, {
        errorCode: data?.error?.code,
      });
    }

    // 2) Optional: phone-number level webhook override
    let phoneOverride: 'not_requested' | 'set' = 'not_requested';
    if (phoneCallbackUrl) {
      const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN?.trim();
      if (!verifyToken) {
        return jsonError('WHATSAPP_WEBHOOK_VERIFY_TOKEN is missing on the server.', 500);
      }
      if (!connection.phoneNumberId) {
        return jsonError('Phone Number ID is missing for this connection.', 400);
      }
      if (!/^https:\/\//i.test(phoneCallbackUrl)) {
        return jsonError('phoneCallbackUrl must start with https://', 400);
      }

      const override = await fetch(`${GRAPH_URL}/${connection.phoneNumberId}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${connection.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          webhook_configuration: {
            override_callback_uri: phoneCallbackUrl,
            verify_token: verifyToken,
          },
        }),
        cache: 'no-store',
      });
      const overrideData = await override.json().catch(() => ({}));

      if (!override.ok || overrideData?.success === false) {
        console.error('[WhatsApp Subscribe POST] Phone override error:', {
          httpStatus: override.status,
          code: overrideData?.error?.code,
          message: overrideData?.error?.message,
          fbtrace_id: overrideData?.error?.fbtrace_id,
        });
        return jsonError(
          overrideData?.error?.message || 'Meta rejected the phone webhook override.',
          400,
          { errorCode: overrideData?.error?.code }
        );
      }
      phoneOverride = 'set';
    }

    return NextResponse.json({
      success: true,
      subscribed: true,
      phoneOverride,
      message: 'Webhook subscribed. Incoming messages and delivery status will now arrive.',
    });
  } catch (error) {
    if (error instanceof AuthError) return jsonError(error.message, 401);
    console.error('[WhatsApp Subscribe POST]', error instanceof Error ? error.message : error);
    return jsonError('Unable to subscribe the WhatsApp account.', 500);
  }
}