
import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/db';
import {
  whatsappConnections,
  whatsappContacts,
  whatsappConversations,
  whatsappMessages,
} from '@/db/schema';

const GRAPH_URL = `https://graph.facebook.com/${
  process.env.META_GRAPH_VERSION || 'v25.0'
}`;

export class WhatsAppSendError extends Error {
  status: number;
  metaCode?: number;
  metaSubcode?: number;

  constructor(
    message: string,
    status = 400,
    metaCode?: number,
    metaSubcode?: number
  ) {
    super(message);
    this.name = 'WhatsAppSendError';
    this.status = status;
    this.metaCode = metaCode;
    this.metaSubcode = metaSubcode;
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
/* Phone and Meta error helpers                                               */
/* -------------------------------------------------------------------------- */

export function normalizePhone(input: unknown): string | null {
  let digits = String(input ?? '').replace(/\D/g, '');

  // India: automatically add country code for a 10-digit number.
  if (digits.length === 10) {
    digits = `91${digits}`;
  }

  return digits.length >= 11 && digits.length <= 15
    ? digits
    : null;
}

function friendlyMetaError(error: any): string {
  switch (Number(error?.code)) {
    case 131042:
      return 'Meta rejected this message because the WhatsApp Business Account billing currency is not configured. In Meta Business Suite, open Billing & payments and complete the currency setup for the WhatsApp Business Account, then retry. The catalog product currency setting does not affect message sending.';

    case 131047:
      return 'The 24-hour customer service window has expired. Send an approved WhatsApp template message instead.';

    case 133010:
      return 'Meta reports that the sender WhatsApp phone number is not registered for Cloud API messaging. Verify the saved Phone Number ID and complete registration in Meta WhatsApp Manager.';

    case 131030:
      return 'This recipient is not on the allowed recipient list for your WhatsApp test account.';

    case 131026:
      return 'Meta could not deliver the message. Verify that the recipient can receive WhatsApp messages.';

    case 190:
      return 'The WhatsApp access token is invalid or expired. Reconnect the WhatsApp account.';

    default:
      return (
        error?.error_user_msg ||
        error?.message ||
        'WhatsApp could not send this message.'
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Meta API helper                                                            */
/* -------------------------------------------------------------------------- */

async function metaFetch(
  path: string,
  accessToken: string,
  init: RequestInit = {}
): Promise<any> {
  let response: Response;
  let data: any;

  try {
    response = await fetch(`${GRAPH_URL}/${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.headers || {}),
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    });

    data = await response.json().catch(() => ({}));
  } catch (error) {
    console.error('[WhatsApp Send] Meta request failed:', {
      path,
      message:
        error instanceof Error ? error.message : 'Network error',
    });

    throw new WhatsAppSendError(
      'Could not connect to Meta WhatsApp API. Please try again.',
      502
    );
  }

  if (!response.ok) {
    const code = Number(data?.error?.code) || undefined;
    const subcode =
      Number(data?.error?.error_subcode) || undefined;

    // Never log the access token or request authorization headers.
    console.error('[WhatsApp Send] Meta API error:', {
      path,
      httpStatus: response.status,
      code,
      subcode,
      message: data?.error?.message,
      fbtrace_id: data?.error?.fbtrace_id,
    });

    const status =
      code === 190 || response.status === 401
        ? 401
        : response.status === 429
          ? 429
          : response.status >= 500
            ? 502
            : 400;

    throw new WhatsAppSendError(
      friendlyMetaError(data?.error),
      status,
      code,
      subcode
    );
  }

  return data;
}

/* -------------------------------------------------------------------------- */
/* Active WhatsApp connection                                                 */
/* -------------------------------------------------------------------------- */

export async function getActiveConnection(
  userId: number
): Promise<ActiveConnection> {
  const [connection] = await db
    .select({
      phoneNumberId: whatsappConnections.phoneNumberId,
      accessToken: whatsappConnections.accessToken,
      tokenExpiresAt: whatsappConnections.tokenExpiresAt,
      status: whatsappConnections.status,
    })
    .from(whatsappConnections)
    .where(
      and(
        eq(whatsappConnections.userId, userId),
        eq(whatsappConnections.status, 'active')
      )
    )
    // If more than one active connection exists, select the newest row.
    .orderBy(desc(whatsappConnections.id))
    .limit(1);

  if (
    !connection ||
    !connection.phoneNumberId ||
    !connection.accessToken
  ) {
    throw new WhatsAppSendError(
      'No active WhatsApp connection found for this account. Please reconnect your WhatsApp number.',
      400
    );
  }

  if (
    connection.tokenExpiresAt &&
    new Date(connection.tokenExpiresAt).getTime() <= Date.now()
  ) {
    throw new WhatsAppSendError(
      'The WhatsApp access token has expired. Reconnect your WhatsApp account.',
      401
    );
  }

  return {
    phoneNumberId: String(connection.phoneNumberId),
    accessToken: String(connection.accessToken),
  };
}

/* -------------------------------------------------------------------------- */
/* Contact and conversation                                                   */
/* -------------------------------------------------------------------------- */

export async function findOrCreateConversation(
  userId: number,
  phoneNumberId: string,
  phone: string
): Promise<{
  contact: ContactSummary;
  conversation: ConversationSummary;
}> {
  const normalizedPhone = normalizePhone(phone);

  if (!normalizedPhone) {
    throw new WhatsAppSendError(
      'Invalid recipient phone number. Enter a valid number with country code.'
    );
  }

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
    .where(
      and(
        eq(whatsappContacts.userId, userId),
        eq(whatsappContacts.phoneNumber, normalizedPhone)
      )
    )
    .limit(1);

  let contact = existingContact as ContactSummary | undefined;

  if (!contact) {
    const [created] = await db
      .insert(whatsappContacts)
      .values({
        userId,
        waId: normalizedPhone,
        phoneNumber: normalizedPhone,
        isActive: true,
        lastSeenAt: new Date(),
        metadata: { source: 'app_outbound' },
      })
      .$returningId();

    if (!created?.id) {
      throw new WhatsAppSendError(
        'Could not create the WhatsApp contact.',
        500
      );
    }

    contact = {
      id: created.id,
      waId: normalizedPhone,
      phoneNumber: normalizedPhone,
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
      and(
        eq(whatsappConversations.userId, userId),
        eq(whatsappConversations.contactId, contact.id)
      )
    )
    .limit(1);

  if (existingConversation) {
    return {
      contact,
      conversation: existingConversation as ConversationSummary,
    };
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

  if (!createdConversation?.id) {
    throw new WhatsAppSendError(
      'Could not create the WhatsApp conversation.',
      500
    );
  }

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
/* Save outbound message                                                      */
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
    ...(params.errorMessage
      ? { errorMessage: params.errorMessage }
      : {}),
    metadata: params.metadata,
  });

  // Only successful sends update the conversation's last-message preview.
  if (params.status === 'sent') {
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
}

/* -------------------------------------------------------------------------- */
/* Send text or media                                                         */
/* -------------------------------------------------------------------------- */

export async function sendOutbound(input: {
  userId: number;
  conversationId: number;
  connection: ActiveConnection;
  to: string;
  text?: string;
  file?: File | null;
}): Promise<{ waMessageId: string }> {
  const { userId, conversationId, connection } = input;
  const text = (input.text || '').trim();
  const file = input.file && input.file.size > 0 ? input.file : null;
  const to = normalizePhone(input.to);

  let type = 'text';
  let metadata: Record<string, unknown> = {};
  let waMessageId = '';

  if (!to) {
    throw new WhatsAppSendError(
      'Invalid recipient phone number. Enter a valid number with country code.'
    );
  }

  if (!connection.phoneNumberId || !connection.accessToken) {
    throw new WhatsAppSendError(
      'The WhatsApp connection is missing its Phone Number ID or access token.'
    );
  }

  if (!file && !text) {
    throw new WhatsAppSendError(
      'Enter a message or select a file before sending.'
    );
  }

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

      const upload = await metaFetch(
        `${connection.phoneNumberId}/media`,
        connection.accessToken,
        {
          method: 'POST',
          body: form,
        }
      );

      const mediaId = String(upload?.id || '');

      if (!mediaId) {
        throw new WhatsAppSendError(
          'Meta did not return a media ID after upload.'
        );
      }

      metadata = {
        mediaId,
        fileName: file.name,
        mimeType: file.type,
      };

      payload = {
        type,
        [type]: {
          id: mediaId,
          ...(text && type !== 'document' ? { caption: text } : {}),
          ...(type === 'document'
            ? {
                filename: file.name,
                ...(text ? { caption: text } : {}),
              }
            : {}),
        },
      };
    } else {
      payload = {
        type: 'text',
        text: {
          body: text,
          preview_url: false,
        },
      };
    }

    const sent = await metaFetch(
      `${connection.phoneNumberId}/messages`,
      connection.accessToken,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          ...payload,
        }),
      }
    );

    waMessageId = String(sent?.messages?.[0]?.id || '');

    if (!waMessageId) {
      throw new WhatsAppSendError(
        'Meta did not return a WhatsApp message ID.'
      );
    }
  } catch (error) {
    const sendError =
      error instanceof WhatsAppSendError
        ? error
        : new WhatsAppSendError(
            'WhatsApp could not send this message. Please try again.',
            502
          );

    await storeOutbound({
      userId,
      conversationId,
      type,
      text,
      waMessageId: `failed-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      status: 'failed',
      errorMessage: sendError.message,
      metadata: {
        ...metadata,
        ...(sendError.metaCode
          ? { metaCode: sendError.metaCode }
          : {}),
        ...(sendError.metaSubcode
          ? { metaSubcode: sendError.metaSubcode }
          : {}),
      },
    }).catch((storeError) => {
      console.error(
        '[WhatsApp Send] Could not store failed message:',
        storeError
      );
    });

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

export async function sendTemplateOutbound(input: {
  userId: number;
  conversationId: number;
  connection: ActiveConnection;
  to: string;
  templateId: string;
  templateName: string;
  templateLanguage: string;
  parameters: string[];
}): Promise<{ waMessageId: string }> {
  const to = normalizePhone(input.to);

  if (!to) {
    throw new WhatsAppSendError(
      'Invalid recipient phone number. Enter a valid number with country code.'
    );
  }

  const text = `[Template] ${input.templateName}`;
  const metadata = {
    templateId: input.templateId,
    templateName: input.templateName,
    templateLanguage: input.templateLanguage,
    parameters: input.parameters,
  };

  let waMessageId: string;
  try {
    const sent = await metaFetch(
      `${input.connection.phoneNumberId}/messages`,
      input.connection.accessToken,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'template',
          template: {
            name: input.templateName,
            language: { code: input.templateLanguage },
            ...(input.parameters.length
              ? {
                  components: [
                    {
                      type: 'body',
                      parameters: input.parameters.map((parameter) => ({
                        type: 'text',
                        text: parameter,
                      })),
                    },
                  ],
                }
              : {}),
          },
        }),
      }
    );

    waMessageId = String(sent?.messages?.[0]?.id || '');
    if (!waMessageId) {
      throw new WhatsAppSendError(
        'Meta did not return a WhatsApp message ID.'
      );
    }
  } catch (error) {
    const sendError =
      error instanceof WhatsAppSendError
        ? error
        : new WhatsAppSendError(
            'WhatsApp could not send this template message. Please try again.',
            502
          );

    await storeOutbound({
      userId: input.userId,
      conversationId: input.conversationId,
      type: 'template',
      text,
      waMessageId: `failed-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      status: 'failed',
      errorMessage: sendError.message,
      metadata: {
        ...metadata,
        ...(sendError.metaCode ? { metaCode: sendError.metaCode } : {}),
        ...(sendError.metaSubcode
          ? { metaSubcode: sendError.metaSubcode }
          : {}),
      },
    }).catch((storeError) => {
      console.error(
        '[WhatsApp Send] Could not store failed template message:',
        storeError
      );
    });

    throw sendError;
  }

  await storeOutbound({
    userId: input.userId,
    conversationId: input.conversationId,
    type: 'template',
    text,
    waMessageId,
    status: 'sent',
    metadata,
  });

  return { waMessageId };
}
