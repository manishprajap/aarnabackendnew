// src/app/api/whatsapp/session/route.ts
import { NextRequest, NextResponse } from 'next/server';

import { getUserIdFromRequest, AuthError } from '@/lib/auth';
import { createWhatsAppSession } from '@/lib/whatsappSession';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const APP_CALLBACK_URL = 'aarnamarket://whatsapp-callback';

function json(origin: string | null, body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: corsHeaders(origin) });
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
    if (!process.env.WHATSAPP_SESSION_SECRET) {
      console.error('WHATSAPP_SESSION_SECRET is missing');
      return json(
        origin,
        { success: false, message: 'WhatsApp session configuration is missing' },
        500
      );
    }

    const userId = getUserIdFromRequest(req);

    const body = await req.json().catch(() => ({}));
    const callbackScheme = String(body?.callbackUrl || '');

    if (callbackScheme !== APP_CALLBACK_URL) {
      return json(origin, { success: false, message: 'Invalid WhatsApp callback URL' }, 400);
    }

    // Signed, 10-minute session containing userId
    const sessionId = createWhatsAppSession(userId);

    // Preserve any deployment prefix (for example /aarnexai-backend) from
    // the incoming API URL when constructing the HTTPS callback URL.
    const callbackHttpsUrl = new URL(req.url);
    const callbackPath = callbackHttpsUrl.pathname.replace(/\/session\/?$/, '/callback');
    if (callbackPath === callbackHttpsUrl.pathname) {
      throw new Error('Unable to construct WhatsApp callback URL from request path');
    }
    callbackHttpsUrl.pathname = callbackPath;
    callbackHttpsUrl.search = '';
    callbackHttpsUrl.searchParams.set('session', sessionId);

    return json(origin, {
      success: true,
      sessionId,
      callbackHttpsUrl: callbackHttpsUrl.toString(),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return json(origin, { success: false, message: error.message }, 401);
    }

    console.error('WhatsApp session error:', error);
    return json(origin, { success: false, message: 'Could not create WhatsApp session' }, 500);
  }
}