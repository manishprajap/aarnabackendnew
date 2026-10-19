// src/app/api/whatsapp/connect/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { whatsappConnections } from '@/db/schema';
import { getUserIdFromRequest, AuthError } from '@/lib/auth';
import { corsHeaders } from '@/lib/cors';
import { ensurePhoneRegistered, subscribeWabaToApp } from '@/lib/whatsapp-register';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v25.0';
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

function reply(origin: string | null, body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: corsHeaders(origin) });
}

function jsonError(origin: string | null, message: string, status = 400) {
  return reply(origin, { success: false, message }, status);
}

async function graphGet(path: string, accessToken: string) {
  const res = await fetch(`${GRAPH_URL}/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req.headers.get('origin')),
  });
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');

  try {
    /* AUTH */
    const userId = Number(await getUserIdFromRequest(req));
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return jsonError(origin, 'Authenticated user was not found.', 401);
    }

    /* REQUEST */
    const body = await req.json().catch(() => ({}));
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const wabaId = typeof body.wabaId === 'string' ? body.wabaId.trim() : '';
    let phoneNumberId =
      typeof body.phoneNumberId === 'string' ? body.phoneNumberId.trim() : '';

    if (!code) return jsonError(origin, 'Missing Meta authorization code.');
    if (!wabaId) return jsonError(origin, 'Missing WhatsApp Business Account ID.');

    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId) return jsonError(origin, 'META_APP_ID is not configured.', 500);
    if (!appSecret) return jsonError(origin, 'META_APP_SECRET is not configured.', 500);

    /* 1. Exchange Embedded Signup code for an access token */
    const tokenUrl = new URL(`${GRAPH_URL}/oauth/access_token`);
    tokenUrl.searchParams.set('client_id', appId);
    tokenUrl.searchParams.set('client_secret', appSecret);
    tokenUrl.searchParams.set('code', code);

    const tokenResponse = await fetch(tokenUrl.toString(), {
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    });
    const tokenData = await tokenResponse.json().catch(() => ({}));

    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error('[WhatsApp] Token exchange failed:', tokenData?.error);
      return jsonError(
        origin,
        tokenData?.error?.message || 'Meta authorization code exchange failed.'
      );
    }

    const accessToken: string = tokenData.access_token;

    /* 2. WABA */
    const waba = await graphGet(`${encodeURIComponent(wabaId)}?fields=id,name`, accessToken);
    if (!waba.ok || !waba.data.id) {
      console.error('[WhatsApp] WABA lookup failed:', waba.data?.error);
      return jsonError(
        origin,
        waba.data?.error?.message || 'Unable to access WhatsApp Business Account.'
      );
    }

    /* 3. Discover phone number if the client did not send one */
    if (!phoneNumberId) {
      const list = await graphGet(
        `${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name`,
        accessToken
      );

      if (!list.ok || !Array.isArray(list.data.data) || list.data.data.length === 0) {
        return jsonError(
          origin,
          list.data?.error?.message ||
            'No WhatsApp phone number was found under this WABA.'
        );
      }

      // If several numbers exist, let the user choose one in a future version.
      phoneNumberId = String(list.data.data[0].id);
    }

    /* 4. Phone details */
    const phone = await graphGet(
      `${encodeURIComponent(phoneNumberId)}?fields=id,display_phone_number,verified_name`,
      accessToken
    );
    if (!phone.ok || !phone.data.id) {
      console.error('[WhatsApp] Phone lookup failed:', phone.data?.error);
      return jsonError(
        origin,
        phone.data?.error?.message || 'Unable to access WhatsApp phone number.'
      );
    }

    /* 5. Subscribe WABA to the app (webhooks) */
    try {
      await subscribeWabaToApp(wabaId, accessToken);
    } catch (e) {
      return jsonError(
        origin,
        e instanceof Error ? e.message : 'Unable to subscribe WhatsApp Business Account to the app.'
      );
    }

    /* 6. Save connection */
    const connectionData = {
      wabaId,
      phoneNumberId,
      businessPhoneNumber: phone.data.display_phone_number || null,
      businessName: phone.data.verified_name || waba.data.name || null,
      accessToken,
      status: 'active' as const,
    };

    const existing = await db
      .select({ id: whatsappConnections.id })
      .from(whatsappConnections)
      .where(eq(whatsappConnections.userId, userId))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(whatsappConnections)
        .set({ ...connectionData, updatedAt: new Date() })
        .where(eq(whatsappConnections.userId, userId));
    } else {
      await db.insert(whatsappConnections).values({ userId, ...connectionData });
    }

    /* 7. Auto-register for Cloud API (non-fatal).
          If the number is already CONNECTED (for example a Coexistence number)
          ensurePhoneRegistered skips /register completely. */
    let registered = false;
    let activationMessage: string | null = null;

    try {
      const result = await ensurePhoneRegistered(phoneNumberId, accessToken);
      registered = result.registered;
      if (!registered) activationMessage = 'Registration is still pending. Try again in a minute.';
    } catch (e) {
      activationMessage = e instanceof Error ? e.message : 'Activation failed';
      console.error('[WhatsApp] Auto-register failed:', activationMessage);
    }

    console.log('[WhatsApp] Connection saved:', { userId, wabaId, phoneNumberId, registered });

    return reply(origin, {
      success: true,
      message: 'WhatsApp Business connected successfully.',
      wabaId,
      phoneNumberId,
      phoneNumber: connectionData.businessPhoneNumber,
      businessName: connectionData.businessName,
      registered,
      activationMessage,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonError(origin, error.message, 401);
    }
    console.error('[WhatsApp] Connect route error:', error);
    return jsonError(
      origin,
      error instanceof Error ? error.message : 'WhatsApp connection failed.',
      500
    );
  }
}