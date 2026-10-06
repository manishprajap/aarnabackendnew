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
    const callbackUrl = String(body?.callbackUrl || '');

    if (callbackUrl !== APP_CALLBACK_URL) {
      return json(origin, { success: false, message: 'Invalid WhatsApp callback URL' }, 400);
    }

    // Signed, 10-minute session containing userId
    const sessionId = createWhatsAppSession(userId);

    // NEXT_PUBLIC_APP_URL optional hai — sirf tab callbackHttpsUrl banao jab set ho,
    // warna missing env poora connect flow block kar deta tha.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '');
    const callbackHttpsUrl = appUrl
      ? `${appUrl}/api/whatsapp/callback?session=${encodeURIComponent(sessionId)}`
      : undefined;

    return json(origin, { success: true, sessionId, callbackHttpsUrl });
  } catch (error) {
    if (error instanceof AuthError) {
      return json(origin, { success: false, message: error.message }, 401);
    }

    console.error('WhatsApp session error:', error);
    return json(origin, { success: false, message: 'Could not create WhatsApp session' }, 500);
  }
}