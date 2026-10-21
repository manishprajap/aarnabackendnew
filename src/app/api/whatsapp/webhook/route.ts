// src/app/api/whatsapp/webhook/route.ts
// Folder ka naam lowercase `whatsapp` hi rakhein (Linux/Vercel par URL case-sensitive hai).

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
      console.error('[WhatsApp Webhook] WHATSAPP_WEBHOOK_VERIFY_TOKEN is missing');
      return new NextResponse('Webhook verify token not configured', {
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
    console.error('[WhatsApp Webhook] GET error:', error);
    return new NextResponse('Internal Server Error', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

/* =====================================================
   Signature check (X-Hub-Signature-256)
===================================================== */

const SECRET_ENV_NAMES = [
  'META_APP_SECRET',
  'META_FACEBOOK_APP_SECRET',
  'WHATSAPP_APP_SECRET',
  'FACEBOOK_APP_SECRET',
];

function isValidSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secrets = SECRET_ENV_NAMES
    .map((name) => ({ name, value: (process.env[name] || '').trim().replace(/^["']|["']$/g, '') }))
    .filter((item) => item.value);

  if (secrets.length === 0) {
    console.error('[WhatsApp Webhook] No app secret env found. Tried:', SECRET_ENV_NAMES.join(', '));
    return false;
  }
  if (!signatureHeader) {
    console.warn('[WhatsApp Webhook] Missing X-Hub-Signature-256 header');
    return false;
  }

  const received = Buffer.from(signatureHeader);

  for (const { name, value } of secrets) {
    const expected = Buffer.from(
      'sha256=' + crypto.createHmac('sha256', value).update(rawBody).digest('hex')
    );
    if (expected.length === received.length && crypto.timingSafeEqual(expected, received)) {
      console.log('[WhatsApp Webhook] Signature OK using', name);
      return true;
    }
  }

  console.warn('[WhatsApp Webhook] Signature mismatch. Env tried:', secrets.map((item) => item.name).join(', '));
  return false;
}

/* =====================================================
   Status helpers
   - status sirf aage badhe (sent -> delivered -> read)
   - agar row abhi insert nahi hui (race), thoda ruk kar retry
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
    return 'Customer ne 24 ghante me message nahi kiya. Pehle approved template message bhejein.';
  }
  return String(error?.title || 'Message delivery failed');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function applyStatusUpdate(userId: number, status: any) {
  const waMessageId = String(status.id);
  const statusName = String(status.status || '').toLowerCase();
  if (!(statusName in STATUS_RANK)) return;

  const statusDate = Number(status.timestamp)
    ? new Date(Number(status.timestamp) * 1000)
    : new Date();

  // Webhook outbound insert se pehle aa sakta hai -> 3 baar try (1s gap)
  for (let attempt = 0; attempt < 3; attempt++) {
    const [row] = await db
      .select({ id: whatsappMessages.id, status: whatsappMessages.status })
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
      console.warn('[WhatsApp Webhook] Status for unknown message:', waMessageId, statusName);
      return;
    }

    const currentRank = STATUS_RANK[String(row.status || '').toLowerCase()] ?? 0;
    const newRank = STATUS_RANK[statusName];

    // Purana/late status ignore karo (jaise read ke baad delivered)
    if (statusName !== 'failed' && newRank <= currentRank) return;
    // Already delivered/read ho chuka ho to failed se overwrite mat karo
    if (statusName === 'failed' && currentRank >= STATUS_RANK.delivered) return;

    await db
      .update(whatsappMessages)
      .set({
        status: statusName,
        ...(statusName === 'sent' ? { sentAt: statusDate } : {}),
        ...(statusName === 'delivered' ? { deliveredAt: statusDate } : {}),
        ...(statusName === 'read' ? { readAt: statusDate } : {}),
        ...(statusName === 'failed'
          ? { errorMessage: friendlyStatusError(status) }
          : {}),
      })
      .where(eq(whatsappMessages.id, row.id));
    return;
  }
}

/* =====================================================
   Auto reply (greeting / away / keyword)
   Customer ne abhi message kiya hai -> 24h window khuli hai -> free text allowed.
   Sab kuch .env se badal sakte hain (defaults neeche hain).

   WHATSAPP_AUTO_REPLY=off                 -> auto reply band
   WHATSAPP_AUTO_REPLY_GREETING="..."      -> working hours me pehle message ka jawab
   WHATSAPP_AUTO_REPLY_AWAY="..."          -> working hours ke bahar ka jawab
   WHATSAPP_BUSINESS_START_HOUR=10         -> (24h format)
   WHATSAPP_BUSINESS_END_HOUR=19
   WHATSAPP_BUSINESS_DAYS=1,2,3,4,5,6      -> 0=Sun ... 6=Sat
   WHATSAPP_BUSINESS_TZ=Asia/Kolkata
   WHATSAPP_BUSINESS_ADDRESS="..."         -> "address" keyword ka jawab (set ho tabhi chalega)
   WHATSAPP_AUTO_REPLY_SESSION_HOURS=24    -> greeting/away kitne ghante ke gap ke baad dobara jaye
                                              (0 = har message par, sirf testing ke liye)
   Placeholders: {{name}} {{business}} {{hours}} {{days}}
===================================================== */

const numEnv = (name: string, fallback: number) => {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
};
const textEnv = (name: string, fallback: string) =>
  (process.env[name] || fallback).replace(/\\n/g, '\n');

const AUTO_REPLY_ENABLED = (process.env.WHATSAPP_AUTO_REPLY || 'on').trim().toLowerCase() !== 'off';
const BUSINESS_TZ = process.env.WHATSAPP_BUSINESS_TZ || 'Asia/Kolkata';
const SESSION_HOURS = numEnv('WHATSAPP_AUTO_REPLY_SESSION_HOURS', 24);
const BUSINESS_START_HOUR = numEnv('WHATSAPP_BUSINESS_START_HOUR', 10);
const BUSINESS_END_HOUR = numEnv('WHATSAPP_BUSINESS_END_HOUR', 19);
const BUSINESS_DAYS = (process.env.WHATSAPP_BUSINESS_DAYS || '1,2,3,4,5,6')
  .split(',')
  .map((item) => Number(item.trim()))
  .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);

const GREETING_TEXT = textEnv(
  'WHATSAPP_AUTO_REPLY_GREETING',
  'Namaste {{name}}! 🙏\n{{business}} mein aapka swagat hai. Apna sawal yahan likh dein, hum jaldi aapse sampark karenge.\n\nMenu ke liye "menu" likhein.'
);
const AWAY_TEXT = textEnv(
  'WHATSAPP_AUTO_REPLY_AWAY',
  'Namaste {{name}}! 🙏\nAbhi hamara office band hai. Hum {{days}}, {{hours}} ke beech uplabdh hain.\nAapka message hamein mil gaya hai, hum working hours me jawab denge.'
);

const KEYWORD_REPLIES: { keywords: string[]; reply: string }[] = [
  {
    keywords: ['menu', 'help', 'options'],
    reply:
      'Aap yeh likh sakte hain:\n• *price* - rate / fees\n• *time* - working hours\n' +
      (process.env.WHATSAPP_BUSINESS_ADDRESS ? '• *address* - hamara pata\n' : '') +
      '\nYa seedha apna sawal likh dein.',
  },
  {
    keywords: ['price', 'rate', 'fees', 'charges', 'cost'],
    reply:
      'Rate/fees aapki requirement par depend karta hai. Apni requirement likh dein, hum details bhej denge.',
  },
  {
    keywords: ['time', 'timing', 'timings', 'hours', 'open'],
    reply: 'Hum {{days}}, {{hours}} ke beech uplabdh hain.',
  },
  ...(process.env.WHATSAPP_BUSINESS_ADDRESS
    ? [
        {
          keywords: ['address', 'location', 'pata'],
          reply: 'Hamara address: ' + process.env.WHATSAPP_BUSINESS_ADDRESS,
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

const hoursLabel = () => `${formatHour(BUSINESS_START_HOUR)} - ${formatHour(BUSINESS_END_HOUR)}`;

function daysLabel(): string {
  const days = [...BUSINESS_DAYS].sort((a, b) => a - b);
  if (days.length === 0) return '';
  const contiguous = days.every((day, index) => index === 0 || day === days[index - 1] + 1);
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

    const weekday = DAY_NAMES.indexOf(parts.find((part) => part.type === 'weekday')?.value || '');
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);

    return (
      BUSINESS_DAYS.includes(weekday) &&
      Number.isFinite(hour) &&
      hour >= BUSINESS_START_HOUR &&
      hour < BUSINESS_END_HOUR
    );
  } catch {
    return true; // time nikalne me dikkat ho to greeting hi bhejo
  }
}

function findKeywordReply(text: string): string | null {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9ऀ-ॿ]+/)
    .filter(Boolean);
  // Lambe sentence ka jawab insaan dega, keyword reply sirf chhote message par
  if (words.length === 0 || words.length > 6) return null;
  for (const item of KEYWORD_REPLIES) {
    if (item.keywords.some((keyword) => words.includes(keyword))) return item.reply;
  }
  return null;
}

const renderTemplate = (template: string, vars: Record<string, string>) =>
  template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? '');

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
    console.log('[WhatsApp Webhook] Auto reply skipped: WHATSAPP_AUTO_REPLY=off');
    return;
  }
  if (!params.connection.accessToken) {
    console.log('[WhatsApp Webhook] Auto reply skipped: access token missing');
    return;
  }
  if (params.ownNumber && params.to === params.ownNumber) return; // apne hi number ko reply nahi
  if (['reaction', 'system', 'unsupported'].includes(params.messageType)) return;

  let reply = findKeywordReply(params.text);
  let kind = 'keyword';
  if (!reply && params.isNewSession) {
    const open = isBusinessOpen();
    reply = open ? GREETING_TEXT : AWAY_TEXT;
    kind = open ? 'greeting' : 'away';
  }
  if (!reply) {
    console.log('[WhatsApp Webhook] Auto reply skipped: no keyword match and not a new session');
    return;
  }

  const body = renderTemplate(reply, {
    name: params.customerName || 'ji',
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
    console.log('[WhatsApp Webhook] Auto reply sent:', kind);
  } catch (error) {
    console.error(
      '[WhatsApp Webhook] Auto reply failed:',
      error instanceof Error ? error.message : error
    );
  }
}

/* =====================================================
   POST — incoming events
===================================================== */

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get('x-hub-signature-256');

    if (!isValidSignature(rawBody, signature)) {
      console.warn('[WhatsApp Webhook] Invalid signature, rejecting');
      return NextResponse.json({ success: false, message: 'Invalid signature' }, { status: 401 });
    }

    const body = JSON.parse(rawBody);

    if (body.object !== 'whatsapp_business_account') {
      console.warn('[WhatsApp Webhook] Unknown object:', body.object);
      return NextResponse.json({ success: false, message: 'Unknown webhook object' }, { status: 400 });
    }
    console.log('[WhatsApp Webhook] Accepted business-account event:', {
      entryCount: Array.isArray(body.entry) ? body.entry.length : 0,
    });

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
          const phoneNumberId: string | undefined = value?.phone_number_id;

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
                value?.verified_name || value?.business_name || value?.name;

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
                  ? (updateResult[0] as { affectedRows?: number }).affectedRows
                  : undefined;

              if (!affectedRows) {
                console.warn(
                  '[WhatsApp Webhook] No existing row for WABA ID yet (claim will create it):',
                  wabaId
                );
              }
            } catch (dbError) {
              console.error('[WhatsApp Webhook] DB update failed:', dbError);
            }
          } else {
            console.warn('[WhatsApp Webhook] Account event missing WABA ID');
          }
        }

        /* Messages / statuses */
        if (field === 'messages') {
          const phoneNumberId = value?.metadata?.phone_number_id;
          const displayPhoneNumber = value?.metadata?.display_phone_number;

          console.log('[WhatsApp Webhook] Messages for:', {
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
                    eq(whatsappConnections.phoneNumberId, String(phoneNumberId)),
                    eq(whatsappConnections.status, 'active')
                  )
                )
                .limit(1)
            : [];

          if (!connection) {
            console.warn(
              '[WhatsApp Webhook] No active account matches incoming phone number ID:',
              phoneNumberId
            );
          }

          /* ---------- Incoming messages ---------- */
          for (const message of value?.messages || []) {
            if (!connection) continue;

            const waMessageId = String(message?.id || '').trim();
            const sender = String(message?.from || '').replace(/\D/g, '');
            if (!waMessageId || !sender) {
              console.warn('[WhatsApp Webhook] Ignoring message without id or sender');
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
              (item: any) => String(item?.wa_id || '').replace(/\D/g, '') === sender
            );
            const profileName = String(contactInfo?.profile?.name || '').trim() || null;

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
                  ...(profileName && !existingContact.profileName ? { profileName } : {}),
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
              console.error('[WhatsApp Webhook] Failed to resolve contact for incoming message');
              continue;
            }

            const messageType = String(message?.type || 'unknown').slice(0, 50);
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
            const mediaId = message?.[messageType]?.id ? String(message[messageType].id) : null;
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
                    eq(whatsappConversations.id, existingConversation.id),
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
              console.error('[WhatsApp Webhook] Failed to resolve conversation for incoming message');
              continue;
            }

            // Naya session? (is conversation me pichhla incoming message 24h se purana ya hai hi nahi)
            const [lastInbound] = await db
              .select({ createdAt: whatsappMessages.createdAt })
              .from(whatsappMessages)
              .where(
                and(
                  eq(whatsappMessages.conversationId, conversationId),
                  eq(whatsappMessages.direction, 'inbound')
                )
              )
              .orderBy(desc(whatsappMessages.createdAt))
              .limit(1);
            const isNewSession =
              !lastInbound ||
              messageDate.getTime() - new Date(lastInbound.createdAt as any).getTime() >
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
                ...(message?.context?.id ? { contextMessageId: String(message.context.id) } : {}),
              },
            });

            // Auto reply (greeting / away / keyword)
            await maybeAutoReply({
              userId: connection.userId,
              conversationId,
              connection: {
                phoneNumberId: String(phoneNumberId),
                accessToken: String(connection.accessToken || ''),
              },
              businessName: connection.businessName || 'hamare business',
              to: sender,
              ownNumber: String(displayPhoneNumber || '').replace(/\D/g, ''),
              customerName: profileName ?? existingContact?.profileName ?? null,
              messageType,
              text,
              isNewSession,
            });
          }

          /* ---------- Status updates (sent / delivered / read / failed) ---------- */
          if (connection) {
            const userId = connection.userId;
            const validStatuses = (value?.statuses || []).filter((s: any) => s?.id);
            // Parallel, taaki retry-wait ek hi baar lage
            await Promise.all(
              validStatuses.map((s: any) =>
                applyStatusUpdate(userId, s).catch((err) =>
                  console.error('[WhatsApp Webhook] Status update failed:', err)
                )
              )
            );
          }
        }
      }
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('[WhatsApp Webhook] POST error:', error);
    return NextResponse.json(
      { success: false, error: 'Webhook processing failed' },
      { status: 500 }
    );
  }
}