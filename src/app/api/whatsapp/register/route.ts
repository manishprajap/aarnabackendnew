// src/app/api/whatsapp/register/route.ts
//
// GET  -> diagnose: shows the number's status on Meta (is it registered on Cloud API?)
// POST -> register the number on Cloud API (fixes error #133010 "Account not registered")
//
// Needs a 6-digit PIN (two-step verification PIN of the number):
//   - send it as { "pin": "123456" } in the body, or
//   - set WHATSAPP_REGISTRATION_PIN in your env.

import { NextRequest, NextResponse } from 'next/server';

import { getUserIdFromRequest, AuthError } from '@/lib/auth';
import { corsHeaders } from '@/lib/cors';
import { WhatsAppSendError, getActiveConnection } from '@/lib/whatsapp-send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GRAPH_URL = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v26.0'}`;

function json(origin: string | null, body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: corsHeaders(origin) });
}

function handleError(origin: string | null, error: unknown) {
  if (error instanceof AuthError) {
    return json(origin, { success: false, message: error.message }, 401);
  }
  if (error instanceof WhatsAppSendError) {
    return json(origin, { success: false, message: error.message }, error.status);
  }
  console.error('[WhatsApp Register]', error);
  return json(origin, { success: false, message: 'Request failed. Please try again.' }, 500);
}

async function currentUserId(req: NextRequest): Promise<number | null> {
  const id = Number(await getUserIdFromRequest(req));
  return Number.isFinite(id) && id > 0 ? id : null;
}

async function graph(path: string, accessToken: string, init: RequestInit = {}) {
  const response = await fetch(`${GRAPH_URL}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers || {}) },
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, data };
}

async function readPhoneStatus(phoneNumberId: string, accessToken: string) {
  const base = await graph(
    `${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,status,platform_type,code_verification_status,name_status,quality_rating`,
    accessToken
  );

  if (!base.ok) {
    throw new WhatsAppSendError(
      base.data?.error?.message || 'Could not read the phone number status from Meta.'
    );
  }

  // Coexistence flag (number also used in the WhatsApp Business app). Optional field.
  let isOnBizApp: boolean | null = null;
  const extra = await graph(`${encodeURIComponent(phoneNumberId)}?fields=is_on_biz_app`, accessToken);
  if (extra.ok && typeof extra.data?.is_on_biz_app === 'boolean') {
    isOnBizApp = extra.data.is_on_biz_app;
  }

  return { ...base.data, isOnBizApp };
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req.headers.get('origin')),
  });
}

/* =====================================================
   GET — diagnose
===================================================== */

export async function GET(req: NextRequest) {
  const origin = req.headers.get('origin');

  try {
    const userId = await currentUserId(req);
    if (!userId) return json(origin, { success: false, message: 'Unauthorized' }, 401);

    const connection = await getActiveConnection(userId);
    const phone = await readPhoneStatus(connection.phoneNumberId, connection.accessToken);

    return json(origin, {
      success: true,
      registered: phone.status === 'CONNECTED',
      phone,
    });
  } catch (error) {
    return handleError(origin, error);
  }
}

/* =====================================================
   POST — register number on Cloud API
===================================================== */

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');

  try {
    const userId = await currentUserId(req);
    if (!userId) return json(origin, { success: false, message: 'Unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const pin = String(body?.pin || process.env.WHATSAPP_REGISTRATION_PIN || '').trim();

    if (!/^\d{6}$/.test(pin)) {
      return json(
        origin,
        {
          success: false,
          message:
            'A 6-digit PIN is required. Set WHATSAPP_REGISTRATION_PIN on the server or send { "pin": "123456" }.',
        },
        400
      );
    }

    const connection = await getActiveConnection(userId);
    const phone = await readPhoneStatus(connection.phoneNumberId, connection.accessToken);

    if (phone.status === 'CONNECTED') {
      return json(origin, {
        success: true,
        message: 'This number is already registered and active.',
        phone,
      });
    }

    // Coexistence numbers must NOT be registered with /register.
    if (phone.isOnBizApp === true) {
      return json(
        origin,
        {
          success: false,
          message:
            'This number is linked with the WhatsApp Business app (coexistence). It cannot be registered here. Finish the onboarding in the Business app and wait for the sync, then try again.',
          phone,
        },
        400
      );
    }

    const result = await graph(
      `${encodeURIComponent(connection.phoneNumberId)}/register`,
      connection.accessToken,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
      }
    );

    if (!result.ok) {
      console.error('[WhatsApp Register] Meta error:', result.data);
      return json(
        origin,
        {
          success: false,
          message: result.data?.error?.message || 'Meta could not register this number.',
        },
        400
      );
    }

    const after = await readPhoneStatus(connection.phoneNumberId, connection.accessToken);

    return json(origin, {
      success: true,
      message: 'Number registered. You can now send messages.',
      phone: after,
    });
  } catch (error) {
    return handleError(origin, error);
  }
}