// src/app/api/whatsapp/inbox/conversations/[conversationId]/messages/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { and, asc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { whatsappContacts, whatsappConversations, whatsappMessages } from '@/db/schema';
import { getUserIdFromRequest, AuthError } from '@/lib/auth';
import { corsHeaders } from '@/lib/cors';
import { getActiveConnection, sendOutbound, WhatsAppSendError } from '@/lib/whatsapp-send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ conversationId: string }> };

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
   GET — messages of a conversation (also clears unread)
===================================================== */

export async function GET(req: NextRequest, context: RouteContext) {
  const origin = req.headers.get('origin');

  try {
    const userId = await currentUserId(req);
    if (!userId) return json(origin, { success: false, message: 'Unauthorized' }, 401);

    const { conversationId } = await context.params;
    const id = Number(conversationId);

    const [conversation] = await db
      .select({ id: whatsappConversations.id })
      .from(whatsappConversations)
      .where(and(eq(whatsappConversations.id, id), eq(whatsappConversations.userId, userId)))
      .limit(1);

    if (!conversation) {
      return json(origin, { success: false, message: 'Conversation not found' }, 404);
    }

    const messages = await db
      .select()
      .from(whatsappMessages)
      .where(and(eq(whatsappMessages.conversationId, id), eq(whatsappMessages.userId, userId)))
      .orderBy(asc(whatsappMessages.createdAt));

    // Opening the chat marks it as read.
    await db
      .update(whatsappConversations)
      .set({ unreadCount: 0 })
      .where(and(eq(whatsappConversations.id, id), eq(whatsappConversations.userId, userId)));

    return json(origin, { success: true, messages });
  } catch (error) {
    return handleError(origin, error, '[WhatsApp Messages GET]');
  }
}

/* =====================================================
   POST — send a message in an existing conversation
   multipart/form-data: text?, file?, productId?
===================================================== */

export async function POST(req: NextRequest, context: RouteContext) {
  const origin = req.headers.get('origin');

  try {
    const userId = await currentUserId(req);
    if (!userId) return json(origin, { success: false, message: 'Unauthorized' }, 401);

    const { conversationId } = await context.params;
    const id = Number(conversationId);

    const form = await req.formData();
    const text = String(form.get('text') || '').trim();
    const fileEntry = form.get('file');
    const file = fileEntry instanceof File && fileEntry.size > 0 ? fileEntry : null;

    if (form.get('productId')) {
      return json(
        origin,
        { success: false, message: 'Sharing catalog products in chat is not available yet.' },
        400
      );
    }
    if (!text && !file) {
      return json(origin, { success: false, message: 'Write a message or attach a file.' }, 400);
    }

    const [row] = await db
      .select({
        id: whatsappConversations.id,
        phoneNumber: whatsappContacts.phoneNumber,
      })
      .from(whatsappConversations)
      .innerJoin(whatsappContacts, eq(whatsappConversations.contactId, whatsappContacts.id))
      .where(and(eq(whatsappConversations.id, id), eq(whatsappConversations.userId, userId)))
      .limit(1);

    if (!row) {
      return json(origin, { success: false, message: 'Conversation not found' }, 404);
    }

    const connection = await getActiveConnection(userId);

    await sendOutbound({
      userId,
      conversationId: row.id,
      connection,
      to: String(row.phoneNumber).replace(/\D/g, ''),
      text,
      file,
    });

    return json(origin, { success: true });
    
  } catch (error) {
    return handleError(origin, error, '[WhatsApp Messages POST]');
  }
}