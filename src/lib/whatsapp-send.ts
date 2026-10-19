// src/lib/whatsapp-send.ts
//
// Shared helpers for sending WhatsApp messages from the app:
// - finds the user's active connection
// - finds/creates the contact + conversation
// - sends text or media through Meta Cloud API
// - stores the outbound message (status: sent / failed)
//
// Delivery updates (delivered / read / failed) are applied later by the
// existing webhook route using waMessageId.

import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import {
  whatsappConnections,
  whatsappContacts,
  whatsappConversations,
  whatsappMessages,
} from '@/db/schema';

const GRAPH_URL = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v26.0'}`;

export class WhatsAppSendError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'WhatsAppSendError';
    this.status = status;
  }
}

export type ActiveConnection = {
  phoneNumberId: string;
  accessToken: string;
};

export type ContactSummary = {
  id: number;
  waId: string | null;
  phoneNumber: string;
  name: string | null;
  profileName: string | null;
  avatarUrl: string | null;
};

export type ConversationSummary = {
  id: number;
  status: string | null;
  lastMessageText: string | null;
  lastMessageAt: Date | null;
  unreadCount: number | null;
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Digits only, country code included. 10-digit numbers default to India (91). */
export function normalizePhone(input: unknown): string | null {
  let digits = String(input ?? '').replace(/\D/g, '');
  if (digits.length === 10) digits = `91${digits}`;
  return digits.length >= 11 && digits.length <= 15 ? digits : null;
}

function friendlyMetaError(error: any): string {
  switch (Number(error?.code)) {
    case 131047:
      return 'More than 24 hours have passed since this customer last messaged you. Send an approved template message instead.';
    case 133010:
      return 'This number is not registered for messaging yet. Open the Connection tab and tap "Activate messaging".';
    case 131030:
      return 'This number is not in the allowed recipient list of your WhatsApp test account.';
    case 131026:
      return 'Message could not be delivered. The number may not be on WhatsApp.';
    case 190:
      return 'WhatsApp connection expired. Please reconnect your number.';
    default:
      return error?.error_user_msg || error?.message || 'WhatsApp could not send this message.';
  }
}

async function metaFetch(path: string, accessToken: string, init: RequestInit) {
  const response = await fetch(`${GRAPH_URL}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.headers || {}),
    },
    cache: 'no-store',
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('[WhatsApp Send] Meta error:', path, data);
    throw new WhatsAppSendError(friendlyMetaError(data?.error), 400);
  }

  return data;
}

/* -------------------------------------------------------------------------- */
/* Connection                                                                 */
/* -------------------------------------------------------------------------- */

export async function getActiveConnection(userId: number): Promise<ActiveConnection> {
  const [connection] = await db
    .select({
      phoneNumberId: whatsappConnections.phoneNumberId,
      accessToken: whatsappConnections.accessToken,
      tokenExpiresAt: whatsappConnections.tokenExpiresAt,
      status: whatsappConnections.status,
    })
    .from(whatsappConnections)
    .where(eq(whatsappConnections.userId, userId))
    .limit(1);

  if (
    !connection ||
    connection.status !== 'active' ||
    !connection.phoneNumberId ||
    !connection.accessToken
  ) {
    throw new WhatsAppSendError('WhatsApp is not connected. Please connect your number first.');
  }

  if (connection.tokenExpiresAt && new Date(connection.tokenExpiresAt).getTime() <= Date.now()) {
    throw new WhatsAppSendError('WhatsApp connection expired. Please reconnect your number.');
  }

  return {
    phoneNumberId: String(connection.phoneNumberId),
    accessToken: String(connection.accessToken),
  };
}

/* -------------------------------------------------------------------------- */
/* Contact + conversation                                                     */
/* -------------------------------------------------------------------------- */

export async function findOrCreateConversation(
  userId: number,
  phoneNumberId: string,
  phone: string
): Promise<{ contact: ContactSummary; conversation: ConversationSummary }> {
  const [existingContact] = await db
    .select({
      id: whatsappContacts.id,
      waId: whatsappContacts.waId,
      phoneNumber: whatsappContacts.phoneNumber,
      name: whatsappContacts.name,
      profileName: whatsappContacts.profileName,
      avatarUrl: whatsappContacts.avatarUrl,
    })
    .from(whatsappContacts)
    .where(and(eq(whatsappContacts.userId, userId), eq(whatsappContacts.phoneNumber, phone)))
    .limit(1);

  let contact = existingContact as ContactSummary | undefined;

  if (!contact) {
    const [created] = await db
      .insert(whatsappContacts)
      .values({
        userId,
        waId: phone,
        phoneNumber: phone,
        isActive: true,
        lastSeenAt: new Date(),
        metadata: { source: 'app_outbound' },
      })
      .$returningId();

    contact = {
      id: created.id,
      waId: phone,
      phoneNumber: phone,
      name: null,
      profileName: null,
      avatarUrl: null,
    };
  }

  const [existingConversation] = await db
    .select({
      id: whatsappConversations.id,
      status: whatsappConversations.status,
      lastMessageText: whatsappConversations.lastMessageText,
      lastMessageAt: whatsappConversations.lastMessageAt,
      unreadCount: whatsappConversations.unreadCount,
    })
    .from(whatsappConversations)
    .where(
      and(eq(whatsappConversations.userId, userId), eq(whatsappConversations.contactId, contact.id))
    )
    .limit(1);

  if (existingConversation) {
    return { contact, conversation: existingConversation as ConversationSummary };
  }

  const now = new Date();
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

  return {
    contact,
    conversation: {
      id: createdConversation.id,
      status: 'open',
      lastMessageText: '',
      lastMessageAt: now,
      unreadCount: 0,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Store outbound                                                             */
/* -------------------------------------------------------------------------- */

async function storeOutbound(params: {
  userId: number;
  conversationId: number;
  type: string;
  text: string;
  waMessageId: string;
  status: 'sent' | 'failed';
  errorMessage?: string;
  metadata: Record<string, unknown>;
}) {
  const now = new Date();

  await db.insert(whatsappMessages).values({
    conversationId: params.conversationId,
    userId: params.userId,
    waMessageId: params.waMessageId,
    direction: 'outbound',
    type: params.type,
    text: params.text || null,
    status: params.status,
    createdAt: now,
    ...(params.status === 'sent' ? { sentAt: now } : {}),
    ...(params.errorMessage ? { errorMessage: params.errorMessage } : {}),
    metadata: params.metadata,
  });

  await db
    .update(whatsappConversations)
    .set({
      lastMessageText: params.text || `[${params.type}]`,
      lastMessageAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(whatsappConversations.id, params.conversationId),
        eq(whatsappConversations.userId, params.userId)
      )
    );
}

/* -------------------------------------------------------------------------- */
/* Send                                                                       */
/* -------------------------------------------------------------------------- */

export async function sendOutbound(input: {
  userId: number;
  conversationId: number;
  connection: ActiveConnection;
  to: string;
  text?: string;
  file?: File | null;
}): Promise<{ waMessageId: string }> {
  const { userId, conversationId, connection, to } = input;
  const text = (input.text || '').trim();
  const file = input.file && input.file.size > 0 ? input.file : null;

  let type = 'text';
  let metadata: Record<string, unknown> = {};
  let waMessageId = '';

  try {
    let payload: Record<string, unknown>;

    if (file) {
      type = file.type.startsWith('image/')
        ? 'image'
        : file.type.startsWith('video/')
          ? 'video'
          : 'document';

      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', file.type || 'application/octet-stream');
      form.append('file', file, file.name);

      const upload = await metaFetch(`${connection.phoneNumberId}/media`, connection.accessToken, {
        method: 'POST',
        body: form,
      });

      const mediaId = String(upload?.id || '');
      if (!mediaId) throw new WhatsAppSendError('Media upload to WhatsApp failed.');

      metadata = { mediaId, fileName: file.name, mimeType: file.type };
      payload = {
        type,
        [type]: {
          id: mediaId,
          ...(text && type !== 'document' ? { caption: text } : {}),
          ...(type === 'document' ? { filename: file.name, ...(text ? { caption: text } : {}) } : {}),
        },
      };
    } else {
      payload = { type: 'text', text: { body: text, preview_url: false } };
    }

    const sent = await metaFetch(`${connection.phoneNumberId}/messages`, connection.accessToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        ...payload,
      }),
    });

    waMessageId = String(sent?.messages?.[0]?.id || '');
    if (!waMessageId) throw new WhatsAppSendError('WhatsApp did not return a message ID.');
  } catch (error) {
    const sendError =
      error instanceof WhatsAppSendError
        ? error
        : new WhatsAppSendError('WhatsApp could not send this message.', 500);

    // Keep the failed attempt visible in the chat (with a unique placeholder ID).
    await storeOutbound({
      userId,
      conversationId,
      type,
      text,
      waMessageId: `failed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'failed',
      errorMessage: sendError.message,
      metadata,
    }).catch((storeError) => console.error('[WhatsApp Send] Could not store failed message:', storeError));

    throw sendError;
  }

  await storeOutbound({
    userId,
    conversationId,
    type,
    text,
    waMessageId,
    status: 'sent',
    metadata,
  });

  return { waMessageId };
}