// src/app/api/whatsapp/callback/route.ts
// Meta redirects here after "Get started".
// Verifies the signed session, links + subscribes + registers the number
// automatically, then sends the user back to the app.

import { NextRequest, NextResponse } from 'next/server';

import { verifyWhatsAppSession } from '@/lib/whatsappSession';
import { claimWhatsAppForUser } from '@/lib/whatsapp-claim';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Mobile deep link, used only when AARNA_APP_URL is not set.
const APP_DEEP_LINK = 'aarnamarket://whatsapp-callback';

type CallbackStatus = 'linked' | 'pending' | 'error';

function buildAppRedirect(
  sessionId: string,
  status: CallbackStatus,
  registered: boolean
): URL {
  const baseUrl = (process.env.AARNA_APP_URL || '').trim().replace(/\/+$/, '');

  let target: URL;
  if (baseUrl) {
    target = new URL(`${baseUrl}/whatsapp`);
    target.searchParams.set('view', 'connection');
  } else {
    target = new URL(APP_DEEP_LINK);
  }

  target.searchParams.set('status', status);
  target.searchParams.set('registered', registered ? '1' : '0');
  // The app only needs the session while it still has to poll /claim.
  if (status === 'pending') target.searchParams.set('session', sessionId);
  return target;
}

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('session')?.trim();

  if (!sessionId) {
    return NextResponse.json(
      { success: false, message: 'WhatsApp callback session is missing' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  let userId: number;
  try {
    const session = verifyWhatsAppSession(sessionId);
    userId = Number(session.userId);
  } catch (error) {
    console.warn('[WhatsApp Callback] Rejected invalid or expired session:', error);
    return NextResponse.json(
      { success: false, message: 'WhatsApp callback session is invalid or expired' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  let status: CallbackStatus = 'pending';
  let registered = false;

  try {
    // Link + subscribe + register. If Meta has not shared the WABA yet this
    // returns "waiting" and the app falls back to polling /claim.
    const result = await claimWhatsAppForUser(userId);

    if (result.state === 'linked') {
      status = 'linked';
      registered = result.data.registered;
    } else if (result.state === 'error') {
      status = 'error';
    }
  } catch (error) {
    console.error('[WhatsApp Callback] Auto-claim failed:', error);
    status = 'pending'; // let the app retry through /claim
  }

  const response = NextResponse.redirect(
    buildAppRedirect(sessionId, status, registered),
    302
  );
  response.headers.set('Cache-Control', 'no-store');
  return response;
}