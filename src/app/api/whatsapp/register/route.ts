// src/app/api/whatsapp/register/route.ts

import { NextRequest, NextResponse } from 'next/server';

import { getUserIdFromRequest, AuthError } from '@/lib/auth';
import { corsHeaders } from '@/lib/cors';
import {
  WhatsAppSendError,
  getActiveConnection,
} from '@/lib/whatsapp-send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GRAPH_URL = `https://graph.facebook.com/${
  process.env.META_GRAPH_VERSION || 'v25.0'
}`;

function json(
  origin: string | null,
  body: unknown,
  status = 200
) {
  return NextResponse.json(body, {
    status,
    headers: corsHeaders(origin),
  });
}

function handleError(origin: string | null, error: unknown) {
  if (error instanceof AuthError) {
    return json(
      origin,
      { success: false, message: error.message },
      401
    );
  }

  if (error instanceof WhatsAppSendError) {
    return json(
      origin,
      { success: false, message: error.message },
      error.status
    );
  }

  console.error('[WhatsApp Register]', error);

  return json(
    origin,
    {
      success: false,
      message: 'Request failed. Check the backend logs.',
    },
    500
  );
}

async function currentUserId(
  req: NextRequest
): Promise<number | null> {
  const id = Number(await getUserIdFromRequest(req));

  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function graph(
  path: string,
  accessToken: string
) {
  const response = await fetch(`${GRAPH_URL}/${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = data?.error;

    console.error('[WhatsApp Register] Meta status error:', {
      status: response.status,
      code: error?.code,
      subcode: error?.error_subcode,
      message: error?.message,
    });

    let message =
      error?.message ||
      'Could not retrieve WhatsApp phone number status from Meta.';

    if (Number(error?.code) === 190) {
      message =
        'WhatsApp access token is invalid or expired. Reconnect the WhatsApp account.';
    }

    throw new WhatsAppSendError(
      message,
      response.status === 401 ? 401 : 400
    );
  }

  return data;
}

async function readPhoneStatus(
  phoneNumberId: string,
  accessToken: string
) {
  if (!/^\d+$/.test(phoneNumberId)) {
    throw new WhatsAppSendError(
      'Invalid WhatsApp Phone Number ID.'
    );
  }

  const phone = await graph(
    `${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,status,platform_type,code_verification_status,name_status,quality_rating`,
    accessToken
  );

  let isOnBizApp: boolean | null = null;

  // This field is optional and may not be available for every account.
  try {
    const extra = await graph(
      `${encodeURIComponent(phoneNumberId)}?fields=is_on_biz_app`,
      accessToken
    );

    if (typeof extra?.is_on_biz_app === 'boolean') {
      isOnBizApp = extra.is_on_biz_app;
    }
  } catch {
    // An unavailable optional field must not invalidate the main status.
  }

  return {
    ...phone,
    isOnBizApp,
  };
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req.headers.get('origin')),
  });
}

/**
 * GET /api/whatsapp/register
 *
 * Diagnose the active WhatsApp phone number.
 * Does not modify the Meta registration.
 */
export async function GET(req: NextRequest) {
  const origin = req.headers.get('origin');

  try {
    const userId = await currentUserId(req);

    if (!userId) {
      return json(
        origin,
        { success: false, message: 'Unauthorized' },
        401
      );
    }

    const connection = await getActiveConnection(userId);

    const phone = await readPhoneStatus(
      connection.phoneNumberId,
      connection.accessToken
    );

    const registered = phone.status === 'CONNECTED';

    return json(origin, {
      success: true,
      registered,
      message: registered
        ? 'Meta reports that the phone number is connected.'
        : 'The phone number is not currently reported as CONNECTED by Meta.',
      phone,
    });
  } catch (error) {
    return handleError(origin, error);
  }
}

/**
 * POST /api/whatsapp/register
 *
 * PIN-free version:
 * Does not attempt registration because Meta's standard
 * Cloud API registration flow requires a six-digit PIN.
 */
export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');

  try {
    const userId = await currentUserId(req);

    if (!userId) {
      return json(
        origin,
        { success: false, message: 'Unauthorized' },
        401
      );
    }

    const connection = await getActiveConnection(userId);

    const phone = await readPhoneStatus(
      connection.phoneNumberId,
      connection.accessToken
    );

    if (phone.status === 'CONNECTED') {
      return json(origin, {
        success: true,
        registered: true,
        message: 'The WhatsApp phone number is already connected.',
        phone,
      });
    }

    if (phone.isOnBizApp === true) {
      return json(
        origin,
        {
          success: false,
          registered: false,
          message:
            'This number appears to be linked to the WhatsApp Business app. Complete the supported coexistence onboarding flow instead of registering it through this endpoint.',
          phone,
        },
        400
      );
    }

    return json(
      origin,
      {
        success: false,
        registered: false,
        code: 'WHATSAPP_REGISTRATION_REQUIRED',
        message:
          'Meta does not report this number as CONNECTED. This endpoint does not register numbers without a PIN. Open Meta WhatsApp Manager and check the phone number registration and onboarding status. If Meta requires Cloud API registration, its supported registration flow requires the six-digit two-step verification PIN.',
        phone,
      },
      400
    );
  } catch (error) {
    return handleError(origin, error);
  }
}