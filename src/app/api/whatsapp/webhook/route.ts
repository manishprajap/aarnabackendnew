// src/app/api/whatsapp/webhook/route.ts
//
// IMPORTANT: folder ka naam lowercase `whatsapp` hona chahiye (pehle `WhatsApp` tha).
// Linux/Vercel par URL case-sensitive hai, isliye Meta ka /api/whatsapp/webhook 404 deta tha.

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { whatsappConnections } from '@/db/schema';

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

    console.log('[WhatsApp Webhook] Incoming event:', JSON.stringify(body));

    if (body.object !== 'whatsapp_business_account') {
      console.warn('[WhatsApp Webhook] Unknown object:', body.object);
      return NextResponse.json({ success: false, message: 'Unknown webhook object' }, { status: 400 });
    }

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

          for (const message of value?.messages || []) {
            console.log('[WhatsApp Webhook] Message:', {
              from: message.from,
              id: message.id,
              type: message.type,
              text: message.type === 'text' ? message.text?.body || '' : undefined,
            });

            // TODO: incoming message DB me save karo
          }

          for (const status of value?.statuses || []) {
            console.log('[WhatsApp Webhook] Status:', {
              id: status.id,
              status: status.status,
              recipient: status.recipient_id,
            });

            // TODO: message status DB me update karo
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