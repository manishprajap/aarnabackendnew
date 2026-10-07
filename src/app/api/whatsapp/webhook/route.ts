// src/app/api/whatsapp/webhook/route.ts
//
// IMPORTANT: folder ka naam lowercase `whatsapp` hona chahiye (pehle `WhatsApp` tha).
// Linux/Vercel par URL case-sensitive hai, isliye Meta ka /api/whatsapp/webhook 404 deta tha.

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

/* =====================================================
   GET — Meta webhook verification
   hub.mode, hub.verify_token, hub.challenge
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

function isValidSignature(rawBody: string, signatureHeader: string | null): boolean {
  // Dono env names support: pehle META_APP_SECRET, fir purana META_FACEBOOK_APP_SECRET
  const appSecret = (process.env.META_APP_SECRET || process.env.META_FACEBOOK_APP_SECRET)?.trim();

  if (!appSecret) {
    console.error('[WhatsApp Webhook] META_APP_SECRET (or META_FACEBOOK_APP_SECRET) is missing');
    return false;
  }

  if (!signatureHeader) {
    console.warn('[WhatsApp Webhook] Missing X-Hub-Signature-256 header');
    return false;
  }

  const expected =
    'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

  try {
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/* =====================================================
   POST — incoming events
===================================================== */

export async function POST(request: NextRequest) {
  try {
    // Raw text pehle padho taaki signature verify ho sake
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

        /*
         * Account events: PARTNER_ADDED, account_update, etc.
         * Row sirf tab update hoti hai jab /whatsapp/claim ne pehle se bana di ho
         * (userId sirf claim route ko pata hota hai).
         */
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

              // mysql2 via Drizzle: [ResultSetHeader, FieldPacket[]]
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

          console.log('[WhatsApp Webhook] Messages for:', { phoneNumberId, displayPhoneNumber });

          const [connection] = phoneNumberId
            ? await db
                .select({ userId: whatsappConnections.userId })
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
                      ''
                  );
            const mediaId = message?.[messageType]?.id
              ? String(message[messageType].id)
              : null;
            const timestampSeconds = Number(message?.timestamp);
            const messageDate = Number.isFinite(timestampSeconds) && timestampSeconds > 0
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
          }

          for (const status of value?.statuses || []) {
            if (!connection || !status?.id) continue;
            const statusName = String(status.status || '').toLowerCase();
            if (!['sent', 'delivered', 'read', 'failed'].includes(statusName)) continue;

            const statusDate = Number(status.timestamp)
              ? new Date(Number(status.timestamp) * 1000)
              : new Date();
            await db
              .update(whatsappMessages)
              .set({
                status: statusName,
                ...(statusName === 'sent' ? { sentAt: statusDate } : {}),
                ...(statusName === 'delivered' ? { deliveredAt: statusDate } : {}),
                ...(statusName === 'read' ? { readAt: statusDate } : {}),
                ...(statusName === 'failed'
                  ? { errorMessage: String(status?.errors?.[0]?.title || 'Message delivery failed') }
                  : {}),
              })
              .where(
                and(
                  eq(whatsappMessages.userId, connection.userId),
                  eq(whatsappMessages.waMessageId, String(status.id))
                )
              );
          }
        }
      }
    }

    // Meta ko hamesha jaldi 200 chahiye
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('[WhatsApp Webhook] POST error:', error);
    return NextResponse.json(
      { success: false, error: 'Webhook processing failed' },
      { status: 500 }
    );
  }
}