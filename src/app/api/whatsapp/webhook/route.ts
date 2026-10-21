
 // src/app/api/whatsapp/webhook/route.ts
// Keep the folder name lowercase as `whatsapp` because URLs are case-sensitive on Linux/Vercel.

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { and, desc, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import {
  whatsappConnections,
  whatsappContacts,
  whatsappConversations,
  whatsappMessages,
} from '@/db/schema';
import { sendOutbound, type ActiveConnection } from '@/lib/whatsapp-send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* =====================================================
   GET — Meta webhook verification
===================================================== */

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('hub.mode');
    const token = searchParams.get('hub.verify_token');
    const challenge = searchParams.get('hub.challenge');
    const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN?.trim();

    if (!verifyToken) {
      console.error(
        '[WhatsApp Webhook] WHATSAPP_WEBHOOK_VERIFY_TOKEN is missing'
      );
      return new NextResponse('Webhook verification token is not configured', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    if (mode === 'subscribe' && token !== null && token === verifyToken) {
      console.log('[WhatsApp Webhook] Verification successful');
      return new NextResponse(challenge || '', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    console.warn('[WhatsApp Webhook] Verification failed', {
      mode,
      tokenReceived: Boolean(token),
      tokenMatch: token === verifyToken,
    });

    return new NextResponse('Forbidden', {
      status: 403,
      headers: { 'Content-Type': 'text/plain' },
    });
  } catch (error) {
    console.error('[WhatsApp Webhook] GET request failed:', error);
    return new NextResponse('Internal Server Error', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

/* =====================================================
   Signature verification (X-Hub-Signature-256)
===================================================== */

const SECRET_ENV_NAMES = [
  'META_APP_SECRET',
  'META_FACEBOOK_APP_SECRET',
  'WHATSAPP_APP_SECRET',
  'FACEBOOK_APP_SECRET',
];

function isValidSignature(
  rawBody: string,
  signatureHeader: string | null
): boolean {
  const secrets = SECRET_ENV_NAMES
    .map((name) => ({
      name,
      value: (process.env[name] || '')
        .trim()
        .replace(/^["']|["']$/g, ''),
    }))
    .filter((item) => item.value);

  if (secrets.length === 0) {
    console.error(
      '[WhatsApp Webhook] No app secret environment variable was found. Checked:',
      SECRET_ENV_NAMES.join(', ')
    );
    return false;
  }

  if (!signatureHeader) {
    console.warn(
      '[WhatsApp Webhook] Missing X-Hub-Signature-256 header'
    );
    return false;
  }

  const received = Buffer.from(signatureHeader);

  for (const { name, value } of secrets) {
    const expected = Buffer.from(
      'sha256=' +
        crypto.createHmac('sha256', value).update(rawBody).digest('hex')
    );

    if (
      expected.length === received.length &&
      crypto.timingSafeEqual(expected, received)
    ) {
      console.log(
        '[WhatsApp Webhook] Signature verification succeeded using',
        name
      );
      return true;
    }
  }

  console.warn(
    '[WhatsApp Webhook] Signature verification failed. Checked environment variables:',
    secrets.map((item) => item.name).join(', ')
  );

  return false;
}

/* =====================================================
   Status helpers
   - Status must only progress forward (sent -> delivered -> read).
   - If the message row has not been inserted yet due to a race
     condition, wait briefly and retry.
===================================================== */

const STATUS_RANK: Record<string, number> = {
  failed: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

function friendlyStatusError(status: any): string {
  const error = status?.errors?.[0];

  if (Number(error?.code) === 131047) {
    return 'The customer has not messaged within the last 24 hours. Send an approved template message first.';
  }

  return String(error?.title || 'Message delivery failed');
}

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function applyStatusUpdate(userId: number, status: any) {
  const waMessageId = String(status.id);
  const statusName = String(status.status || '').toLowerCase();

  if (!(statusName in STATUS_RANK)) return;

  const statusDate = Number(status.timestamp)
    ? new Date(Number(status.timestamp) * 1000)
    : new Date();

  // The webhook may arrive before the outbound message is inserted.
  // Retry three times with a one-second delay between attempts.
  for (let attempt = 0; attempt < 3; attempt++) {
    const [row] = await db
      .select({
        id: whatsappMessages.id,
        status: whatsappMessages.status,
      })
      .from(whatsappMessages)
      .where(
        and(
          eq(whatsappMessages.userId, userId),
          eq(whatsappMessages.waMessageId, waMessageId)
        )
      )
      .limit(1);

    if (!row) {
      if (attempt < 2) {
        await sleep(1000);
        continue;
      }

      console.warn(
        '[WhatsApp Webhook] Status received for an unknown message:',
        waMessageId,
        statusName
      );
      return;
    }

    const currentRank =
      STATUS_RANK[String(row.status || '').toLowerCase()] ?? 0;

    const newRank = STATUS_RANK[statusName];

    // Ignore outdated status updates, such as delivered after read.
    if (statusName !== 'failed' && newRank <= currentRank) return;

    // Do not overwrite a delivered or read status with a failed status.
    if (
      statusName === 'failed' &&
      currentRank >= STATUS_RANK.delivered
    ) {
      return;
    }

    await db
      .update(whatsappMessages)
      .set({
        status: statusName,
        ...(statusName === 'sent' ? { sentAt: statusDate } : {}),
        ...(statusName === 'delivered'
          ? { deliveredAt: statusDate }
          : {}),
        ...(statusName === 'read' ? { readAt: statusDate } : {}),
        ...(statusName === 'failed'
          ? { errorMessage: friendlyStatusError(status) }
          : {}),
      })
      .where(eq(whatsappMessages.id, row.id));

    return;
  }
}


const numEnv = (name: string, fallback: number) => {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

const textEnv = (name: string, fallback: string) =>
  (process.env[name] || fallback).replace(/\\n/g, '\n');

const AUTO_REPLY_ENABLED =
  (process.env.WHATSAPP_AUTO_REPLY || 'on').trim().toLowerCase() !== 'off';

const BUSINESS_TZ =
  process.env.WHATSAPP_BUSINESS_TZ || 'Asia/Kolkata';

const SESSION_HOURS = numEnv(
  'WHATSAPP_AUTO_REPLY_SESSION_HOURS',
  24
);

const BUSINESS_START_HOUR = numEnv(
  'WHATSAPP_BUSINESS_START_HOUR',
  10
);

const BUSINESS_END_HOUR = numEnv(
  'WHATSAPP_BUSINESS_END_HOUR',
  19
);

const BUSINESS_DAYS = (
  process.env.WHATSAPP_BUSINESS_DAYS || '1,2,3,4,5,6'
)
  .split(',')
  .map((item) => Number(item.trim()))
  .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);

const GREETING_TEXT = textEnv(
  'WHATSAPP_AUTO_REPLY_GREETING',
  'Hello {{name}}! 👋\nWelcome to {{business}}. Please send us your question, and our team will get back to you shortly.\n\nType "menu" to see the available options.'
);

const AWAY_TEXT = textEnv(
  'WHATSAPP_AUTO_REPLY_AWAY',
  'Hello {{name}}! 👋\nOur office is currently closed. Our business hours are {{hours}}, {{days}}.\nWe have received your message and will respond during business hours.'
);

const KEYWORD_REPLIES: { keywords: string[]; reply: string }[] = [
  {
    keywords: ['menu', 'help', 'options'],
    reply:
      'You can type one of the following:\n' +
      '• *price* - View our pricing or fees\n' +
      '• *time* - View our business hours\n' +
      (process.env.WHATSAPP_BUSINESS_ADDRESS
        ? '• *address* - View our business address\n'
        : '') +
      '\nOr simply type your question, and our team will assist you.',
  },
  {
    keywords: ['price', 'rate', 'fees', 'charges', 'cost'],
    reply:
      'Our pricing depends on your specific requirements. Please share more details about what you need, and we will provide the relevant pricing information.',
  },
  {
    keywords: ['time', 'timing', 'timings', 'hours', 'open'],
    reply: 'Our business hours are {{days}}, {{hours}}.',
  },
  ...(process.env.WHATSAPP_BUSINESS_ADDRESS
    ? [
        {
          keywords: ['address', 'location'],
          reply:
            'Our business address is: ' +
            process.env.WHATSAPP_BUSINESS_ADDRESS,
        },
      ]
    : []),
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const formatHour = (hour: number) => {
  const suffix = hour >= 12 && hour < 24 ? 'PM' : 'AM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:00 ${suffix}`;
};

const hoursLabel = () =>
  `${formatHour(BUSINESS_START_HOUR)} - ${formatHour(BUSINESS_END_HOUR)}`;

function daysLabel(): string {
  const days = [...BUSINESS_DAYS].sort((a, b) => a - b);

  if (days.length === 0) return '';

  const contiguous = days.every(
    (day, index) => index === 0 || day === days[index - 1] + 1
  );

  return contiguous && days.length > 1
    ? `${DAY_NAMES[days[0]]}-${DAY_NAMES[days[days.length - 1]]}`
    : days.map((day) => DAY_NAMES[day]).join(', ');
}

function isBusinessOpen(): boolean {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: BUSINESS_TZ,
      weekday: 'short',
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date());

    const weekday = DAY_NAMES.indexOf(
      parts.find((part) => part.type === 'weekday')?.value || ''
    );

    const hour = Number(
      parts.find((part) => part.type === 'hour')?.value
    );

    return (
      BUSINESS_DAYS.includes(weekday) &&
      Number.isFinite(hour) &&
      hour >= BUSINESS_START_HOUR &&
      hour < BUSINESS_END_HOUR
    );
  } catch {
    return true; // Default to greeting behavior if timezone processing fails.
  }
}

function findKeywordReply(text: string): string | null {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9ऀ-ॿ]+/)
    .filter(Boolean);

  // Let a human handle long messages. Keyword replies are intended
  // only for short messages.
  if (words.length === 0 || words.length > 6) return null;

  for (const item of KEYWORD_REPLIES) {
    if (item.keywords.some((keyword) => words.includes(keyword))) {
      return item.reply;
    }
  }

  return null;
}

const renderTemplate = (
  template: string,
  vars: Record<string, string>
) =>
  template.replace(
    /\{\{(\w+)\}\}/g,
    (_match, key: string) => vars[key] ?? ''
  );

async function maybeAutoReply(params: {
  userId: number;
  conversationId: number;
  connection: ActiveConnection;
  businessName: string;
  to: string;
  ownNumber: string;
  customerName: string | null;
  messageType: string;
  text: string;
  isNewSession: boolean;
}) {
  if (!AUTO_REPLY_ENABLED) {
    console.log(
      '[WhatsApp Webhook] Automatic reply skipped: automatic replies are disabled'
    );
    return;
  }

  if (!params.connection.accessToken) {
    console.log(
      '[WhatsApp Webhook] Automatic reply skipped: access token is missing'
    );
    return;
  }

  // Do not reply to our own business number.
  if (params.ownNumber && params.to === params.ownNumber) return;

  if (['reaction', 'system', 'unsupported'].includes(params.messageType)) {
    return;
  }

  let reply = findKeywordReply(params.text);
  let kind = 'keyword';

  if (!reply && params.isNewSession) {
    const open = isBusinessOpen();
    reply = open ? GREETING_TEXT : AWAY_TEXT;
    kind = open ? 'greeting' : 'away';
  }

  if (!reply) {
    console.log(
      '[WhatsApp Webhook] Automatic reply skipped: no keyword matched and this is not a new session'
    );
    return;
  }

  const body = renderTemplate(reply, {
    name: params.customerName || 'there',
    business: params.businessName,
    hours: hoursLabel(),
    days: daysLabel(),
  }).trim();

  try {
    await sendOutbound({
      userId: params.userId,
      conversationId: params.conversationId,
      connection: params.connection,
      to: params.to,
      text: body,
    });

    console.log('[WhatsApp Webhook] Automatic reply sent:', kind);
  } catch (error) {
    console.error(
      '[WhatsApp Webhook] Automatic reply failed:',
      error instanceof Error ? error.message : error
    );
  }
}

/* =====================================================
   POST — Incoming webhook events
===================================================== */

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get('x-hub-signature-256');

    if (!isValidSignature(rawBody, signature)) {
      console.warn(
        '[WhatsApp Webhook] Invalid signature. Rejecting the request.'
      );

      return NextResponse.json(
        { success: false, message: 'Invalid signature' },
        { status: 401 }
      );
    }

    const body = JSON.parse(rawBody);

    if (body.object !== 'whatsapp_business_account') {
      console.warn('[WhatsApp Webhook] Unknown webhook object:', body.object);

      return NextResponse.json(
        { success: false, message: 'Unknown webhook object' },
        { status: 400 }
      );
    }

    console.log(
      '[WhatsApp Webhook] Accepted business-account event:',
      {
        entryCount: Array.isArray(body.entry) ? body.entry.length : 0,
      }
    );

    for (const entry of body.entry || []) {
      const wabaId: string | undefined = entry.id;

      for (const change of entry.changes || []) {
        const field: string = change.field;
        const value = change.value;

        /* Account events */
        if (
          field === 'account_update' ||
          field === 'business_status_update' ||
          field === 'account_review_update'
        ) {
          const phoneNumberId: string | undefined =
            value?.phone_number_id;

          console.log('[WhatsApp Webhook] Account event:', {
            field,
            event: value?.event,
            wabaId,
            phoneNumberId,
          });

          if (wabaId) {
            try {
              const businessPhoneNumber: string | undefined =
                value?.display_phone_number || value?.phone_number;

              const businessName: string | undefined =
                value?.verified_name ||
                value?.business_name ||
                value?.name;

              const updateResult = await db
                .update(whatsappConnections)
                .set({
                  ...(phoneNumberId ? { phoneNumberId } : {}),
                  ...(businessPhoneNumber ? { businessPhoneNumber } : {}),
                  ...(businessName ? { businessName } : {}),
                  status: 'active',
                  updatedAt: new Date(),
                })
                .where(eq(whatsappConnections.wabaId, wabaId));

              const affectedRows =
                Array.isArray(updateResult) && updateResult[0]
                  ? (
                      updateResult[0] as {
                        affectedRows?: number;
                      }
                    ).affectedRows
                  : undefined;

              if (!affectedRows) {
                console.warn(
                  '[WhatsApp Webhook] No existing connection was found for this WABA ID. The connection may be created during account claiming:',
                  wabaId
                );
              }
            } catch (dbError) {
              console.error(
                '[WhatsApp Webhook] Database update failed:',
                dbError
              );
            }
          } else {
            console.warn(
              '[WhatsApp Webhook] Account event is missing the WABA ID'
            );
          }
        }

        /* Messages and status updates */
        if (field === 'messages') {
          const phoneNumberId = value?.metadata?.phone_number_id;
          const displayPhoneNumber =
            value?.metadata?.display_phone_number;

          console.log('[WhatsApp Webhook] Messages received for:', {
            phoneNumberId,
            displayPhoneNumber,
            incoming: (value?.messages || []).length,
            statuses: (value?.statuses || []).length,
          });

          const [connection] = phoneNumberId
            ? await db
                .select({
                  userId: whatsappConnections.userId,
                  accessToken: whatsappConnections.accessToken,
                  businessName: whatsappConnections.businessName,
                })
                .from(whatsappConnections)
                .where(
                  and(
                    eq(
                      whatsappConnections.phoneNumberId,
                      String(phoneNumberId)
                    ),
                    eq(whatsappConnections.status, 'active')
                  )
                )
                .limit(1)
            : [];

          if (!connection) {
            console.warn(
              '[WhatsApp Webhook] No active account matches the incoming phone number ID:',
              phoneNumberId
            );
          }

          /* ---------- Incoming messages ---------- */
          for (const message of value?.messages || []) {
            if (!connection) continue;

            const waMessageId = String(message?.id || '').trim();
            const sender = String(message?.from || '').replace(/\D/g, '');

            if (!waMessageId || !sender) {
              console.warn(
                '[WhatsApp Webhook] Ignoring a message without an ID or sender'
              );
              continue;
            }

            const [alreadyStored] = await db
              .select({ id: whatsappMessages.id })
              .from(whatsappMessages)
              .where(
                and(
                  eq(whatsappMessages.userId, connection.userId),
                  eq(whatsappMessages.waMessageId, waMessageId)
                )
              )
              .limit(1);

            if (alreadyStored) continue;

            const contactInfo = (value?.contacts || []).find(
              (item: any) =>
                String(item?.wa_id || '').replace(/\D/g, '') === sender
            );

            const profileName =
              String(contactInfo?.profile?.name || '').trim() || null;

            const [existingContact] = await db
              .select({
                id: whatsappContacts.id,
                profileName: whatsappContacts.profileName,
              })
              .from(whatsappContacts)
              .where(
                and(
                  eq(whatsappContacts.userId, connection.userId),
                  eq(whatsappContacts.phoneNumber, sender)
                )
              )
              .limit(1);

            let contactId = existingContact?.id;

            if (existingContact) {
              await db
                .update(whatsappContacts)
                .set({
                  ...(profileName && !existingContact.profileName
                    ? { profileName }
                    : {}),
                  waId: sender,
                  lastSeenAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(whatsappContacts.id, existingContact.id),
                    eq(whatsappContacts.userId, connection.userId)
                  )
                );
            } else {
              const [createdContact] = await db
                .insert(whatsappContacts)
                .values({
                  userId: connection.userId,
                  waId: sender,
                  phoneNumber: sender,
                  name: profileName,
                  profileName,
                  isActive: true,
                  lastSeenAt: new Date(),
                  metadata: { source: 'whatsapp_webhook' },
                })
                .$returningId();

              contactId = createdContact?.id;
            }

            if (!contactId) {
              console.error(
                '[WhatsApp Webhook] Failed to resolve the contact for the incoming message'
              );
              continue;
            }

            const messageType = String(
              message?.type || 'unknown'
            ).slice(0, 50);

            const text =
              messageType === 'text'
                ? String(message?.text?.body || '')
                : String(
                    message?.[messageType]?.caption ||
                      message?.interactive?.button_reply?.title ||
                      message?.interactive?.list_reply?.title ||
                      message?.button?.text ||
                      ''
                  );

            const mediaId = message?.[messageType]?.id
              ? String(message[messageType].id)
              : null;

            const timestampSeconds = Number(message?.timestamp);

            const messageDate =
              Number.isFinite(timestampSeconds) && timestampSeconds > 0
                ? new Date(timestampSeconds * 1000)
                : new Date();

            const [existingConversation] = await db
              .select({ id: whatsappConversations.id })
              .from(whatsappConversations)
              .where(
                and(
                  eq(whatsappConversations.userId, connection.userId),
                  eq(whatsappConversations.contactId, contactId)
                )
              )
              .limit(1);

            let conversationId = existingConversation?.id;

            if (existingConversation) {
              await db
                .update(whatsappConversations)
                .set({
                  lastMessageText: text || `[${messageType}]`,
                  lastMessageAt: messageDate,
                  unreadCount: sql`${whatsappConversations.unreadCount} + 1`,
                  status: 'open',
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(
                      whatsappConversations.id,
                      existingConversation.id
                    ),
                    eq(whatsappConversations.userId, connection.userId)
                  )
                );
            } else {
              const [createdConversation] = await db
                .insert(whatsappConversations)
                .values({
                  userId: connection.userId,
                  contactId,
                  phoneNumberId: String(phoneNumberId),
                  status: 'open',
                  lastMessageText: text || `[${messageType}]`,
                  lastMessageAt: messageDate,
                  unreadCount: 1,
                  createdAt: messageDate,
                  updatedAt: new Date(),
                })
                .$returningId();

              conversationId = createdConversation?.id;
            }

            if (!conversationId) {
              console.error(
                '[WhatsApp Webhook] Failed to resolve the conversation for the incoming message'
              );
              continue;
            }

            // A new session begins when there is no previous inbound
            // message or the previous inbound message is older than
            // the configured session interval.
            const [lastInbound] = await db
              .select({
                createdAt: whatsappMessages.createdAt,
              })
              .from(whatsappMessages)
              .where(
                and(
                  eq(
                    whatsappMessages.conversationId,
                    conversationId
                  ),
                  eq(whatsappMessages.direction, 'inbound')
                )
              )
              .orderBy(desc(whatsappMessages.createdAt))
              .limit(1);

            const isNewSession =
              !lastInbound ||
              messageDate.getTime() -
                new Date(lastInbound.createdAt as any).getTime() >
                SESSION_HOURS * 60 * 60 * 1000;

            await db.insert(whatsappMessages).values({
              conversationId,
              userId: connection.userId,
              waMessageId,
              direction: 'inbound',
              type: messageType,
              text: text || null,
              status: 'received',
              createdAt: messageDate,
              metadata: {
                ...(mediaId ? { mediaId } : {}),
                ...(message?.context?.id
                  ? {
                      contextMessageId: String(message.context.id),
                    }
                  : {}),
              },
            });

            // Send an automatic greeting, away message, or keyword reply.
            await maybeAutoReply({
              userId: connection.userId,
              conversationId,
              connection: {
                phoneNumberId: String(phoneNumberId),
                accessToken: String(connection.accessToken || ''),
              },
              businessName:
                connection.businessName || 'our business',
              to: sender,
              ownNumber: String(displayPhoneNumber || '').replace(
                /\D/g,
                ''
              ),
              customerName:
                profileName ?? existingContact?.profileName ?? null,
              messageType,
              text,
              isNewSession,
            });
          }

          /* ---------- Status updates (sent / delivered / read / failed) ---------- */
          if (connection) {
            const userId = connection.userId;

            const validStatuses = (value?.statuses || []).filter(
              (status: any) => status?.id
            );

            // Process statuses in parallel so retry delays do not block
            // other status updates.
            await Promise.all(
              validStatuses.map((status: any) =>
                applyStatusUpdate(userId, status).catch((err) =>
                  console.error(
                    '[WhatsApp Webhook] Status update failed:',
                    err
                  )
                )
              )
            );
          }
        }
      }
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('[WhatsApp Webhook] POST request failed:', error);

    return NextResponse.json(
      {
        success: false,
        error: 'Webhook processing failed',
      },
      { status: 500 }
    );
  }
}
