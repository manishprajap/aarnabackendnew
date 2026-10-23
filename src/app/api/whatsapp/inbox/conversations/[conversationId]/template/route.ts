import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { whatsappContacts, whatsappConversations } from '@/db/schema';
import { AuthError, getUserIdFromRequest } from '@/lib/auth';
import { corsHeaders } from '@/lib/cors';
import {
  fetchTemplate,
  getAccessToken,
} from '@/lib/whatsappCampaigns';
import {
  getActiveConnection,
  sendTemplateOutbound,
  WhatsAppSendError,
} from '@/lib/whatsapp-send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ conversationId: string }> };

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
  console.error('[WhatsApp Template POST]', error);
  return json(
    origin,
    { success: false, message: 'Request failed. Please try again.' },
    500
  );
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req.headers.get('origin')),
  });
}

export async function POST(req: NextRequest, context: RouteContext) {
  const origin = req.headers.get('origin');

  try {
    const userId = Number(await getUserIdFromRequest(req));
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return json(origin, { success: false, message: 'Unauthorized' }, 401);
    }

    const { conversationId } = await context.params;
    const id = Number(conversationId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return json(origin, { success: false, message: 'Conversation not found' }, 404);
    }

    let body: { templateId?: unknown; parameters?: unknown };
    try {
      body = await req.json();
    } catch {
      return json(origin, { success: false, message: 'Invalid JSON request body.' }, 400);
    }

    const templateId =
      typeof body?.templateId === 'string' ||
      typeof body?.templateId === 'number'
        ? String(body.templateId).trim()
        : '';
    const parameters = body?.parameters ?? [];
    if (!templateId) {
      return json(origin, { success: false, message: 'Template is required.' }, 400);
    }
    if (!Array.isArray(parameters) || parameters.some((value) => typeof value !== 'string')) {
      return json(
        origin,
        { success: false, message: 'parameters must be an array of strings.' },
        400
      );
    }

    const [conversation] = await db
      .select({
        id: whatsappConversations.id,
        phoneNumber: whatsappContacts.phoneNumber,
      })
      .from(whatsappConversations)
      .innerJoin(whatsappContacts, eq(whatsappConversations.contactId, whatsappContacts.id))
      .where(and(eq(whatsappConversations.id, id), eq(whatsappConversations.userId, userId)))
      .limit(1);

    if (!conversation) {
      return json(origin, { success: false, message: 'Conversation not found' }, 404);
    }

    const connection = await getActiveConnection(userId);
    const template = await fetchTemplate(
      templateId,
      getAccessToken(connection.accessToken)
    );
    if (!template) {
      return json(origin, { success: false, message: 'Template not found.' }, 404);
    }
    if (template.status !== 'APPROVED') {
      return json(
        origin,
        { success: false, message: 'Only approved templates can be sent.' },
        400
      );
    }

    const result = await sendTemplateOutbound({
      userId,
      conversationId: conversation.id,
      connection,
      to: String(conversation.phoneNumber),
      templateId,
      templateName: template.name,
      templateLanguage: template.language,
      parameters,
    });

    return json(origin, {
      success: true,
      message: 'WhatsApp template message accepted by Meta.',
      messageId: result.waMessageId,
    });
  } catch (error) {
    return handleError(origin, error);
  }
}
