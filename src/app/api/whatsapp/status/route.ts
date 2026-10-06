// src/app/api/whatsapp/status/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { whatsappConnections } from '@/db/schema';
import { getUserIdFromRequest, AuthError } from '@/lib/auth';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(origin: string | null, body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: corsHeaders(origin) });
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req.headers.get('origin')),
  });
}

export async function GET(req: NextRequest) {
  const origin = req.headers.get('origin');

  try {
    const userId = Number(getUserIdFromRequest(req));

    const rows = await db
      .select({
        id: whatsappConnections.id,
        wabaId: whatsappConnections.wabaId,
        phoneNumberId: whatsappConnections.phoneNumberId,
        businessPhoneNumber: whatsappConnections.businessPhoneNumber,
        businessName: whatsappConnections.businessName,
        tokenExpiresAt: whatsappConnections.tokenExpiresAt,
        status: whatsappConnections.status,
      })
      .from(whatsappConnections)
      .where(eq(whatsappConnections.userId, userId))
      .limit(1);

    if (!rows.length) {
      return json(origin, { success: true, connected: false, profile: null });
    }

    const whatsapp = rows[0];

    if (whatsapp.tokenExpiresAt && new Date(whatsapp.tokenExpiresAt).getTime() <= Date.now()) {
      return json(origin, { success: true, connected: false, expired: true, profile: null });
    }

    if (whatsapp.status !== 'active') {
      return json(origin, {
        success: true,
        connected: false,
        expired: whatsapp.status === 'expired',
        profile: null,
      });
    }

    return json(origin, {
      success: true,
      connected: true,
      profile: {
        wabaId: whatsapp.wabaId,
        phoneNumberId: whatsapp.phoneNumberId,
        phoneNumber: whatsapp.businessPhoneNumber,
        businessName: whatsapp.businessName,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return json(origin, { success: false, message: error.message }, 401);
    }

    console.error('WhatsApp status error:', error);
    return json(origin, { success: false, message: 'Failed to check WhatsApp connection' }, 500);
  }
}