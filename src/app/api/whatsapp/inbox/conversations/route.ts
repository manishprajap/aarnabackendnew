// src/app/api/whatsapp/inbox/conversations/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { whatsappContacts, whatsappConversations } from '@/db/schema';
import { getUserIdFromRequest, AuthError } from '@/lib/auth';
import { corsHeaders } from '@/lib/cors';
import { findOrCreateConversation, getActiveConnection, normalizePhone, sendOutbound, WhatsAppSendError } from '@/lib/whatsapp-send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(origin: string | null, body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: corsHeaders(origin) });
}

function handleError(origin: string | null, error: unknown, label: string) {
  if (error instanceof AuthError) {
    return json(origin, { success: false, message: error.message }, 401);
  }
  if (error instanceof WhatsAppSendError) {
    return json(origin, { success: false, message: error.message }, error.status);
  }
  console.error(label, error);
  return json(origin, { success: false, message: 'Request failed. Please try again.' }, 500);
}

async function currentUserId(req: NextRequest): Promise<number | null> {
  const id = Number(await getUserIdFromRequest(req));
  return Number.isFinite(id) && id > 0 ? id : null;
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req.headers.get('origin')),
  });
}

/* =====================================================
   GET — list conversations
===================================================== */

export async function GET(req: NextRequest) {
  const origin = req.headers.get('origin');

  try {
    const userId = await currentUserId(req);
    if (!userId) return json(origin, { success: false, message: 'Unauthorized' }, 401);

    const conversations = await db
      .select({
        id: whatsappConversations.id,
        status: whatsappConversations.status,
        lastMessageText: whatsappConversations.lastMessageText,
        lastMessageAt: whatsappConversations.lastMessageAt,
        unreadCount: whatsappConversations.unreadCount,
        contact: {
          id: whatsappContacts.id,
          waId: whatsappContacts.waId,
          phoneNumber: whatsappContacts.phoneNumber,
          name: whatsappContacts.name,
          profileName: whatsappContacts.profileName,
          avatarUrl: whatsappContacts.avatarUrl,
        },
      })
      .from(whatsappConversations)
      .innerJoin(whatsappContacts, eq(whatsappConversations.contactId, whatsappContacts.id))
      .where(eq(whatsappConversations.userId, userId))
      .orderBy(desc(whatsappConversations.lastMessageAt));

    return json(origin, { success: true, conversations });
  } catch (error) {
    return handleError(origin, error, '[WhatsApp Inbox GET]');
  }
}

/* =====================================================
   POST — start a new conversation + send first message
   body: { phoneNumber, text }
===================================================== */

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');

  try {
    const userId = await currentUserId(req);
    if (!userId) return json(origin, { success: false, message: 'Unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const phone = normalizePhone(body?.phoneNumber);
    const text = typeof body?.text === 'string' ? body.text.trim() : '';

    if (!phone) {
      return json(
        origin,
        { success: false, message: 'Enter a valid phone number with country code.' },
        400
      );
    }
    if (!text) {
      return json(origin, { success: false, message: 'Message text is required.' }, 400);
    }

    const connection = await getActiveConnection(userId);
    const { contact, conversation } = await findOrCreateConversation(
      userId,
      connection.phoneNumberId,
      phone
    );

    // Throws WhatsAppSendError (after saving a "failed" bubble) if Meta rejects it.
    await sendOutbound({
      userId,
      conversationId: conversation.id,
      connection,
      to: phone,
      text,
    });

    return json(origin, {
      success: true,
      conversation: {
        id: conversation.id,
        status: conversation.status ?? 'open',
        lastMessageText: text,
        lastMessageAt: new Date().toISOString(),
        unreadCount: conversation.unreadCount ?? 0,
        contact,
      },
    });
  } catch (error) {
    return handleError(origin, error, '[WhatsApp Inbox POST]');
  }
}