// Called by the app after Meta onboarding, and as a fallback poller.
//
// Response contract:
//   { success: true,  state: 'linked',  data }                -> saved (data.registered tells if messaging is active)
//   { success: false, state: 'waiting', message }             -> nothing shared yet, keep polling
//   { success: false, state: 'error',   step, message, code? } -> real error, STOP polling

import { NextRequest, NextResponse } from 'next/server';

import { getUserIdFromRequest, AuthError } from '@/lib/auth';
import { corsHeaders } from '@/lib/cors';
import { verifyWhatsAppSession } from '@/lib/whatsappSession';
import { claimWhatsAppForUser } from '@/lib/whatsapp-claim';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function reply(origin: string | null, body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: corsHeaders(origin) });
}

function authError(origin: string | null, step: string, message: string, status: number) {
  return reply(origin, { success: false, state: 'error', step, message }, status);
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
    const userId = Number(await getUserIdFromRequest(req));
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return authError(origin, 'auth', 'Invalid user', 401);
    }

    const body = await req.json().catch(() => ({}));
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId) {
      return authError(origin, 'session', 'WhatsApp connection session is required', 400);
    }

    let session: ReturnType<typeof verifyWhatsAppSession>;
    try {
      session = verifyWhatsAppSession(sessionId);
    } catch (error) {
      return authError(
        origin,
        'session',
        error instanceof Error ? error.message : 'Invalid WhatsApp connection session',
        401
      );
    }

    if (Number(session.userId) !== userId) {
      return authError(origin, 'session', 'WhatsApp session does not belong to this user', 403);
    }

    const result = await claimWhatsAppForUser(userId);

    if (result.state === 'linked') {
      return reply(origin, {
        success: true,
        state: 'linked',
        message: result.message,
        data: result.data,
      });
    }

    if (result.state === 'waiting') {
      return reply(origin, { success: false, state: 'waiting', message: result.message });
    }

    return reply(
      origin,
      {
        success: false,
        state: 'error',
        step: result.step,
        code: result.code,
        message: result.message,
        detail: result.detail,
      },
      result.httpStatus
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return authError(origin, 'auth', error.message, 401);
    }
    console.error('[WhatsApp Claim] Error:', error);
    return authError(origin, 'unknown', 'Failed to link WhatsApp account', 500);
  }
}