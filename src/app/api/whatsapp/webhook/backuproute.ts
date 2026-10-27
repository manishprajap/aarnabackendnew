
/**
 * File: src/app/api/whatsapp/webhook/route.ts
 *
 * Handles:
 * 1. Meta webhook verification (GET)
 * 2. Meta signature validation (POST)
 * 3. Outgoing message delivery statuses
 * 4. Incoming WhatsApp messages
 *
 * Important:
 * - Status updates use wa_message_id, not the connection's userId.
 * - If a phone_number_id belongs to multiple active users, incoming messages
 *   are not assigned arbitrarily to one of those users.
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import {
  whatsappConnections,
  whatsappContacts,
  whatsappConversations,
  whatsappMessages,
} from '@/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type MetaStatus = 'sent' | 'delivered' | 'read' | 'failed';

type MetaWebhookStatus = {
  id: string;
  status: MetaStatus;
  timestamp?: string;
  recipient_id?: string;
  errors?: Array<{
    code?: number;
    title?: string;
    message?: string;
    error_data?: {
      details?: string;
    };
  }>;
};

type MetaIncomingMessage = {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: {
    body?: string;
  };
  image?: {
    id?: string;
    mime_type?: string;
    caption?: string;
  };
  video?: {
    id?: string;
    mime_type?: string;
    caption?: string;
  };
  document?: {
    id?: string;
    mime_type?: string;
    filename?: string;
    caption?: string;
  };
  audio?: {
    id?: string;
    mime_type?: string;
  };
  sticker?: {
    id?: string;
    mime_type?: string;
  };
  button?: {
    text?: string;
    payload?: string;
  };
  interactive?: {
    type?: string;
    button_reply?: {
      id?: string;
      title?: string;
    };
    list_reply?: {
      id?: string;
      title?: string;
      description?: string;
    };
  };
  context?: {
    id?: string;
    from?: string;
  };
};

type MetaWebhookValue = {
  messaging_product?: string;
  metadata?: {
    phone_number_id?: string;
    display_phone_number?: string;
  };
  contacts?: Array<{
    wa_id?: string;
    profile?: {
      name?: string;
    };
  }>;
  messages?: MetaIncomingMessage[];
  statuses?: MetaWebhookStatus[];
};

type MetaWebhookBody = {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: MetaWebhookValue;
    }>;
  }>;
};

const STATUS_RANK: Record<string, number> = {
  failed: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function jsonError(message: string, status: number) {
  return NextResponse.json(
    { success: false, message },
    { status },
  );
}

function unixTimestampToDate(value?: string): Date {
  const timestamp = Number(value);

  if (Number.isFinite(timestamp) && timestamp > 0) {
    return new Date(timestamp * 1000);
  }

  return new Date();
}

function normalizePhone(value?: string | null): string {
  return String(value ?? '').replace(/\D/g, '');
}

function getMessageText(message: MetaIncomingMessage): string {
  switch (message.type) {
    case 'text':
      return message.text?.body ?? '';

    case 'image':
      return message.image?.caption ?? '';

    case 'video':
      return message.video?.caption ?? '';

    case 'document':
      return message.document?.caption ?? '';

    case 'button':
      return message.button?.text ?? message.button?.payload ?? '';

    case 'interactive':
      return (
        message.interactive?.button_reply?.title ??
        message.interactive?.list_reply?.title ??
        ''
      );

    default:
      return '';
  }
}

function getMessageMetadata(
  message: MetaIncomingMessage,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    source: 'meta_webhook',
    messageType: message.type ?? 'unknown',
  };

  if (message.image) metadata.media = message.image;
  if (message.video) metadata.media = message.video;
  if (message.document) metadata.media = message.document;
  if (message.audio) metadata.media = message.audio;
  if (message.sticker) metadata.media = message.sticker;
  if (message.button) metadata.button = message.button;
  if (message.interactive) metadata.interactive = message.interactive;
  if (message.context) metadata.context = message.context;

  return metadata;
}

/**
 * Validates X-Hub-Signature-256 using the raw request body.
 * Configure META_FACEBOOK_APP_SECRET with the Meta application's App Secret.
 */
function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  const appSecret = process.env.META_FACEBOOK_APP_SECRET;

  if (!appSecret || !signatureHeader) {
    return false;
  }

  const suppliedSignature = signatureHeader.trim();

  if (!/^sha256=[a-f0-9]{64}$/i.test(suppliedSignature)) {
    return false;
  }

  const expectedSignature =
    'sha256=' +
    crypto
      .createHmac('sha256', appSecret)
      .update(rawBody, 'utf8')
      .digest('hex');

  const suppliedBuffer = Buffer.from(
    suppliedSignature.toLowerCase(),
    'utf8',
  );
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

  return (
    suppliedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
}

/* -------------------------------------------------------------------------- */
/* Update outbound message status                                             */
/* -------------------------------------------------------------------------- */

async function applyStatusUpdate(
  status: MetaWebhookStatus,
): Promise<void> {
  const waMessageId = String(status?.id ?? '').trim();
  const statusName = String(status?.status ?? '').toLowerCase();

  if (!waMessageId || !Object.hasOwn(STATUS_RANK, statusName)) {
    console.warn('[WhatsApp Webhook] Invalid status callback', {
      hasMessageId: Boolean(waMessageId),
      statusName,
    });
    return;
  }

  const eventDate = unixTimestampToDate(status.timestamp);

  for (let attempt = 1; attempt <= 3; attempt++) {
    // Meta message IDs should identify one stored outgoing message.
    // Limit to 2 so duplicates can be detected instead of updating an
    // arbitrary customer's message.
    const matches = await db
      .select({
        id: whatsappMessages.id,
        userId: whatsappMessages.userId,
        direction: whatsappMessages.direction,
        status: whatsappMessages.status,
      })
      .from(whatsappMessages)
      .where(eq(whatsappMessages.waMessageId, waMessageId))
      .limit(2);

    if (matches.length === 0) {
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }

      console.warn(
        '[WhatsApp Webhook] Status received for an unknown message:',
        { waMessageId, statusName },
      );
      return;
    }

    if (matches.length > 1) {
      console.error(
        '[WhatsApp Webhook] Duplicate wa_message_id; refusing update:',
        { waMessageId, statusName },
      );
      return;
    }

    const message = matches[0];

    // Do not change an inbound message from an outgoing delivery callback.
    if (message.direction !== 'outbound') {
      console.warn('[WhatsApp Webhook] Status belongs to a non-outbound row:', {
        messageRowId: message.id,
        direction: message.direction,
        waMessageId,
      });
      return;
    }

    const currentStatus = String(message.status ?? '').toLowerCase();

    // Do not regress delivered/read messages when an older callback arrives.
    if (
      statusName !== 'failed' &&
      Object.hasOwn(STATUS_RANK, currentStatus) &&
      STATUS_RANK[currentStatus] > STATUS_RANK[statusName]
    ) {
      console.info('[WhatsApp Webhook] Ignoring older status callback:', {
        messageRowId: message.id,
        currentStatus,
        incomingStatus: statusName,
      });
      return;
    }

    const updateData: Record<string, unknown> = {
      status: statusName,
    };

    if (statusName === 'sent') {
      updateData.sentAt = eventDate;
    } else if (statusName === 'delivered') {
      updateData.deliveredAt = eventDate;
    } else if (statusName === 'read') {
      updateData.readAt = eventDate;
    } else if (statusName === 'failed') {
      const errors = Array.isArray(status.errors) ? status.errors : [];

      updateData.errorMessage = errors.length
        ? errors
            .map((error) =>
              [
                error.code != null ? `Code ${error.code}` : '',
                error.title ?? error.message ?? '',
                error.error_data?.details ?? '',
              ]
                .filter(Boolean)
                .join(': '),
            )
            .filter(Boolean)
            .join('; ')
        : 'WhatsApp message delivery failed';
    }

    await db
      .update(whatsappMessages)
      .set(updateData)
      .where(eq(whatsappMessages.id, message.id));

    console.info('[WhatsApp Webhook] Message status updated:', {
      messageRowId: message.id,
      userId: message.userId,
      waMessageId,
      statusName,
    });

    return;
  }
}

/* -------------------------------------------------------------------------- */
/* Save incoming WhatsApp message                                             */
/* -------------------------------------------------------------------------- */

async function saveIncomingMessage(params: {
  userId: number;
  phoneNumberId: string;
  message: MetaIncomingMessage;
  profileName?: string;
}): Promise<void> {
  const { userId, phoneNumberId, message, profileName } = params;

  const waMessageId = String(message.id ?? '').trim();
  const sender = normalizePhone(message.from);

  if (!waMessageId || !sender) {
    console.warn('[WhatsApp Webhook] Incoming message missing ID or sender');
    return;
  }

  // Meta can retry webhook events. Avoid inserting the same incoming message
  // more than once for this user.
  const [existingMessage] = await db
    .select({ id: whatsappMessages.id })
    .from(whatsappMessages)
    .where(
      and(
        eq(whatsappMessages.userId, userId),
        eq(whatsappMessages.waMessageId, waMessageId),
      ),
    )
    .limit(1);

  if (existingMessage) {
    console.info('[WhatsApp Webhook] Duplicate incoming event ignored:', {
      waMessageId,
      userId,
    });
    return;
  }

  let [contact] = await db
    .select({
      id: whatsappContacts.id,
      name: whatsappContacts.name,
      profileName: whatsappContacts.profileName,
    })
    .from(whatsappContacts)
    .where(
      and(
        eq(whatsappContacts.userId, userId),
        eq(whatsappContacts.waId, sender),
      ),
    )
    .limit(1);

  const now = unixTimestampToDate(message.timestamp);

  if (!contact) {
    const [createdContact] = await db
      .insert(whatsappContacts)
      .values({
        userId,
        waId: sender,
        phoneNumber: sender,
        ...(profileName ? { profileName } : {}),
        isActive: true,
        lastSeenAt: now,
        metadata: { source: 'meta_webhook' },
      })
      .$returningId();

    if (!createdContact?.id) {
      throw new Error('Could not create WhatsApp contact');
    }

    contact = {
      id: createdContact.id,
      name: null,
      profileName: profileName ?? null,
    };
  } else {
    await db
      .update(whatsappContacts)
      .set({
        isActive: true,
        lastSeenAt: now,
        ...(profileName ? { profileName } : {}),
      })
      .where(
        and(
          eq(whatsappContacts.id, contact.id),
          eq(whatsappContacts.userId, userId),
        ),
      );
  }

  let [conversation] = await db
    .select({
      id: whatsappConversations.id,
    })
    .from(whatsappConversations)
    .where(
      and(
        eq(whatsappConversations.userId, userId),
        eq(whatsappConversations.contactId, contact.id),
      ),
    )
    .limit(1);

  if (!conversation) {
    const [createdConversation] = await db
      .insert(whatsappConversations)
      .values({
        userId,
        contactId: contact.id,
        phoneNumberId,
        status: 'open',
        lastMessageText: '',
        lastMessageAt: now,
        unreadCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .$returningId();

    if (!createdConversation?.id) {
      throw new Error('Could not create WhatsApp conversation');
    }

    conversation = { id: createdConversation.id };
  }

  const messageType = String(message.type ?? 'unknown');
  const text = getMessageText(message);

  await db.insert(whatsappMessages).values({
    userId,
    conversationId: conversation.id,
    waMessageId,
    direction: 'inbound',
    type: messageType,
    text: text || null,
    status: 'received',
    createdAt: now,
    metadata: getMessageMetadata(message),
  });

  await db
    .update(whatsappConversations)
    .set({
      lastMessageText: text || `[${messageType}]`,
      lastMessageAt: now,
      updatedAt: now,
      unreadCount: sql`${whatsappConversations.unreadCount} + 1`,
    })
    .where(
      and(
        eq(whatsappConversations.id, conversation.id),
        eq(whatsappConversations.userId, userId),
      ),
    );

  console.info('[WhatsApp Webhook] Incoming message saved:', {
    userId,
    conversationId: conversation.id,
    waMessageId,
    messageType,
  });
}

/* -------------------------------------------------------------------------- */
/* GET: Meta webhook verification                                             */
/* -------------------------------------------------------------------------- */

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const mode = searchParams.get('hub.mode');
  const verifyToken = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  const expectedToken =
    process.env.WHATSAPP_VERIFY_TOKEN ??
    process.env.META_WEBHOOK_VERIFY_TOKEN;

  if (!expectedToken) {
    console.error(
      '[WhatsApp Webhook] WHATSAPP_VERIFY_TOKEN is not configured',
    );
    return new NextResponse('Webhook verification is not configured', {
      status: 500,
    });
  }

  if (
    mode === 'subscribe' &&
    verifyToken === expectedToken &&
    challenge !== null
  ) {
    console.info('[WhatsApp Webhook] Verification successful');
    return new NextResponse(challenge, { status: 200 });
  }

  console.warn('[WhatsApp Webhook] Verification failed');
  return new NextResponse('Forbidden', { status: 403 });
}

/* -------------------------------------------------------------------------- */
/* POST: Receive Meta webhook events                                          */
/* -------------------------------------------------------------------------- */

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();

    // Validate the signature before trusting the request body.
    const signature = request.headers.get('x-hub-signature-256');

    if (!verifyMetaSignature(rawBody, signature)) {
      console.error(
        '[WhatsApp Webhook] Invalid signature or META_FACEBOOK_APP_SECRET missing',
      );
      return jsonError('Invalid webhook signature', 401);
    }

    let body: MetaWebhookBody;

    try {
      body = JSON.parse(rawBody) as MetaWebhookBody;
    } catch {
      return jsonError('Invalid JSON body', 400);
    }

    if (body.object !== 'whatsapp_business_account') {
      // Acknowledge unrelated webhook objects without processing them.
      return NextResponse.json({ success: true, ignored: true });
    }

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') {
          continue;
        }

        const value = change.value;
        if (!value) continue;

        const phoneNumberId = String(
          value.metadata?.phone_number_id ?? '',
        ).trim();

        const displayPhoneNumber = value.metadata?.display_phone_number;

        console.info('[WhatsApp Webhook] Messages event received:', {
          phoneNumberId: phoneNumberId || null,
          displayPhoneNumber: displayPhoneNumber || null,
          incomingCount: value.messages?.length ?? 0,
          statusCount: value.statuses?.length ?? 0,
        });

        /*
         * IMPORTANT:
         * Status callbacks are processed independently of connection lookup.
         * The database message ID, not a connection's userId, identifies
         * the message being updated.
         */
        for (const status of value.statuses ?? []) {
          try {
            await applyStatusUpdate(status);
          } catch (error) {
            console.error(
              '[WhatsApp Webhook] Failed to update message status:',
              {
                waMessageId: status?.id,
                status: status?.status,
                error:
                  error instanceof Error ? error.message : String(error),
              },
            );
          }
        }

        const incomingMessages = value.messages ?? [];

        // Status-only callbacks do not need a connection lookup.
        if (incomingMessages.length === 0) {
          continue;
        }

        if (!phoneNumberId) {
          console.error(
            '[WhatsApp Webhook] Incoming messages missing phone_number_id',
          );
          continue;
        }

        /*
         * A phone_number_id must map to one active customer for safe
         * incoming-message routing. Do not use .limit(1) on this lookup:
         * it could silently assign messages to the wrong customer.
         */
        const matchingConnections = await db
          .select({
            id: whatsappConnections.id,
            userId: whatsappConnections.userId,
            wabaId: whatsappConnections.wabaId,
            phoneNumberId: whatsappConnections.phoneNumberId,
            status: whatsappConnections.status,
          })
          .from(whatsappConnections)
          .where(
            and(
              eq(whatsappConnections.phoneNumberId, phoneNumberId),
              eq(whatsappConnections.status, 'active'),
            ),
          )
          .limit(2);

        if (matchingConnections.length === 0) {
          console.error(
            '[WhatsApp Webhook] No active connection for incoming messages:',
            { phoneNumberId },
          );
          continue;
        }

        if (matchingConnections.length > 1) {
          console.error(
            '[WhatsApp Webhook] Multiple active connections for the same phone number; incoming messages skipped:',
            {
              phoneNumberId,
              connectionIds: matchingConnections.map((row) => row.id),
              userIds: matchingConnections.map((row) => row.userId),
            },
          );
          continue;
        }

        const connection = matchingConnections[0];
        const userId = Number(connection.userId);

        const contactsByWaId = new Map<string, string>();

        for (const contact of value.contacts ?? []) {
          const waId = normalizePhone(contact.wa_id);
          const profileName = String(contact.profile?.name ?? '').trim();

          if (waId) {
            contactsByWaId.set(waId, profileName);
          }
        }

        for (const message of incomingMessages) {
          try {
            const sender = normalizePhone(message.from);
            const profileName = contactsByWaId.get(sender);

            await saveIncomingMessage({
              userId,
              phoneNumberId,
              message,
              profileName,
            });
          } catch (error) {
            console.error(
              '[WhatsApp Webhook] Failed to save incoming message:',
              {
                waMessageId: message?.id,
                userId,
                error:
                  error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
      }
    }

    // Meta expects a successful response to acknowledge delivery.
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('[WhatsApp Webhook] Unexpected processing error:', error);

    return jsonError('Webhook processing failed', 500);
  }
}
