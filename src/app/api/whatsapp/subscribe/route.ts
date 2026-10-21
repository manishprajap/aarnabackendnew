// src/app/api/whatsapp/subscribe/route.ts
//
// GET  -> check karta hai ki aapka app is WABA par subscribed hai ya nahi
// POST -> WABA ko app par subscribe karta hai (webhook events aana shuru)
//
// Bina subscribed_apps ke Meta "messages" webhook (incoming + delivered/read) bhejta hi nahi.

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

async function getWabaConnection(userId: number) {
  const [connection] = await db
    .select({
      wabaId: whatsappConnections.wabaId,
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

  if (!connection?.wabaId || !connection?.accessToken) {
    return null;
  }
  return {
    wabaId: String(connection.wabaId),
    accessToken: String(connection.accessToken),
  };
}

export async function GET(req: NextRequest) {
  try {
    const userId = Number(await getUserIdFromRequest(req));
    const connection = await getWabaConnection(userId);
    if (!connection) {
      return jsonError('No active WhatsApp connection (WABA ID missing). Please reconnect.', 404);
    }

    const response = await fetch(`${GRAPH_URL}/${connection.wabaId}/subscribed_apps`, {
      headers: { Authorization: `Bearer ${connection.accessToken}` },
      cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return jsonError(data?.error?.message || 'Could not read subscribed apps.', 400, {
        errorCode: data?.error?.code,
      });
    }

    const apps = Array.isArray(data?.data) ? data.data : [];
    return NextResponse.json({
      success: true,
      subscribed: apps.length > 0,
      apps,
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
    const connection = await getWabaConnection(userId);
    if (!connection) {
      return jsonError('No active WhatsApp connection (WABA ID missing). Please reconnect.', 404);
    }

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

    return NextResponse.json({
      success: true,
      subscribed: true,
      message: 'Webhook subscribed. Incoming messages and delivery status will now arrive.',
    });
  } catch (error) {
    if (error instanceof AuthError) return jsonError(error.message, 401);
    console.error('[WhatsApp Subscribe POST]', error instanceof Error ? error.message : error);
    return jsonError('Unable to subscribe the WhatsApp account.', 500);
  }
}