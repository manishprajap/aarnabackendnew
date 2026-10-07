import { NextRequest, NextResponse } from 'next/server';

import { verifyWhatsAppSession } from '@/lib/whatsappSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const APP_CALLBACK_URL = 'aarnamarket://whatsapp-callback';

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('session')?.trim();

  if (!sessionId) {
    return NextResponse.json(
      { success: false, message: 'WhatsApp callback session is missing' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    verifyWhatsAppSession(sessionId);

    const appUrl = new URL(APP_CALLBACK_URL);
    appUrl.searchParams.set('session', sessionId);
    appUrl.searchParams.set('status', 'pending');

    const response = NextResponse.redirect(appUrl, 302);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) {
    console.warn('[WhatsApp Callback] Rejected invalid or expired session:', error);
    return NextResponse.json(
      { success: false, message: 'WhatsApp callback session is invalid or expired' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
