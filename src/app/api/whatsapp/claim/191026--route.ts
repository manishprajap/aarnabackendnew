// src/app/api/whatsapp/claim/route.ts
//
// Called by the app after Meta onboarding ("Get started").
// Finds the newly shared client WABA, subscribes the app to it, and saves it
// for the logged-in user in whatsapp_connections.
//
// Response contract (the client relies on this):
//   { success: true,  state: 'linked',  data }                -> saved
//   { success: false, state: 'waiting', message }             -> nothing shared yet, keep polling
//   { success: false, state: 'error',   step, message, code? } -> real error, STOP polling

import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { whatsappConnections } from '@/db/schema';
import { getUserIdFromRequest, AuthError } from '@/lib/auth';
import { corsHeaders } from '@/lib/cors';
import { verifyWhatsAppSession } from '@/lib/whatsappSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

type GraphError = {
  message?: string;
  code?: number;
  error_subcode?: number;
  error_user_msg?: string;
  fbtrace_id?: string;
};

type Waba = { id: string; name?: string };
type Phone = { id: string; display_phone_number?: string; verified_name?: string };

function reply(origin: string | null, body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: corsHeaders(origin) });
}

function waiting(origin: string | null, message: string) {
  return reply(origin, { success: false, state: 'waiting', message }, 200);
}

// Meta OAuth error 190 = access token invalid / expired / session invalidated.
function isTokenError(err?: GraphError) {
  return err?.code === 190;
}

function fail(
  origin: string | null,
  step: string,
  message: string,
  status = 400,
  detail?: GraphError
) {
  // A dead system-user token is a server configuration problem, not a user
  // problem. Log loudly, return a stable code the client can stop retrying on,
  // and do not show Meta's confusing "user changed password" text to end users.
  if (isTokenError(detail)) {
    console.error(
      '[WhatsApp Claim] META_SYSTEM_USER_TOKEN is invalid or revoked. ' +
        'Generate a new System User token in Business Settings and update the env var.',
      { step, code: detail?.code, subcode: detail?.error_subcode, fbtrace_id: detail?.fbtrace_id }
    );

    return reply(
      origin,
      {
        success: false,
        state: 'error',
        step,
        code: 'SERVER_TOKEN_INVALID',
        message:
          'WhatsApp connection is temporarily unavailable. Please contact support.',
        detail: {
          code: detail?.code,
          subcode: detail?.error_subcode,
          fbtrace_id: detail?.fbtrace_id,
        },
      },
      503
    );
  }

  return reply(
    origin,
    {
      success: false,
      state: 'error',
      step,
      message: detail?.error_user_msg || detail?.message || message,
      detail: detail
        ? { code: detail.code, subcode: detail.error_subcode, fbtrace_id: detail.fbtrace_id }
        : undefined,
    },
    status
  );
}

async function graph<T>(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, cache: 'no-store' });
  const data = (await res.json().catch(() => ({}))) as T & { error?: GraphError };
  return { ok: res.ok && !data.error, data };
}

// All WABAs shared with the business (with pagination)
async function listClientWabas(businessId: string, token: string) {
  const all: Waba[] = [];
  let url: string | undefined =
    `${GRAPH}/${encodeURIComponent(businessId)}/client_whatsapp_business_accounts?fields=id,name&limit=100`;

  for (let page = 0; url && page < 5; page++) {
    const r: {
      ok: boolean;
      data: { data?: Waba[]; paging?: { next?: string }; error?: GraphError };
    } = await graph(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });

    if (!r.ok) return { ok: false as const, error: r.data.error, wabas: [] as Waba[] };

    all.push(...(r.data.data ?? []));
    url = r.data.paging?.next;
  }

  return { ok: true as const, error: undefined, wabas: all };
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req.headers.get('origin')),
  });
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');

  try {
    // Always normalize userId to a number (string/number mismatch caused duplicate inserts)
    const userId = Number(getUserIdFromRequest(req));
    if (!Number.isFinite(userId)) {
      return reply(origin, { success: false, state: 'error', step: 'auth', message: 'Invalid user' }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId) {
      return reply(
        origin,
        { success: false, state: 'error', step: 'session', message: 'WhatsApp connection session is required' },
        400
      );
    }

    let session: ReturnType<typeof verifyWhatsAppSession>;
    try {
      session = verifyWhatsAppSession(sessionId);
    } catch (error) {
      return reply(
        origin,
        {
          success: false,
          state: 'error',
          step: 'session',
          message: error instanceof Error ? error.message : 'Invalid WhatsApp connection session',
        },
        401
      );
    }

    if (Number(session.userId) !== userId) {
      return reply(
        origin,
        { success: false, state: 'error', step: 'session', message: 'WhatsApp session does not belong to this user' },
        403
      );
    }

    const businessId = process.env.META_BUSINESS_ID?.trim();
    const systemToken = process.env.META_SYSTEM_USER_TOKEN?.trim();

    if (!businessId || !systemToken) {
      console.error('[WhatsApp Claim] Missing META_BUSINESS_ID / META_SYSTEM_USER_TOKEN');
      return fail(origin, 'config', 'Server is missing Meta business credentials', 500);
    }

    /* STEP 1 — all WABAs shared with the business */
    const listed = await listClientWabas(businessId, systemToken);

    if (!listed.ok) {
      console.error('[WhatsApp Claim] Failed to list client WABAs:', listed.error);
      return fail(
        origin,
        'list_client_wabas',
        'Unable to list WhatsApp accounts shared with your business',
        400,
        listed.error
      );
    }

    /* STEP 2 — work out candidates */
    const saved = await db
      .select({
        wabaId: whatsappConnections.wabaId,
        userId: whatsappConnections.userId,
        status: whatsappConnections.status,
      })
      .from(whatsappConnections);

    const savedByOthers = new Set(
      saved.filter((r) => Number(r.userId) !== userId).map((r) => r.wabaId)
    );
    const mine = saved.find((r) => Number(r.userId) === userId);

    // New (unclaimed) accounts, newest first
    const unclaimed = listed.wabas
      .filter((w) => !savedByOthers.has(w.id) && w.id !== mine?.wabaId)
      .reverse();

    // If the user's old row is not active (expired), include it as a reconnect candidate
    const mineWaba =
      mine && mine.status !== 'active' ? listed.wabas.find((w) => w.id === mine.wabaId) : undefined;

    const candidates: Waba[] = [...unclaimed, ...(mineWaba ? [mineWaba] : [])];

    console.log('[WhatsApp Claim]', {
      userId,
      shared: listed.wabas.map((w) => w.id),
      candidates: candidates.map((w) => w.id),
      hasActiveRow: mine?.status === 'active',
    });

    if (candidates.length === 0) {
      // Already linked and active -> idempotent success
      if (mine && mine.status === 'active') {
        return reply(origin, {
          success: true,
          state: 'linked',
          message: 'WhatsApp already linked',
          data: { wabaId: mine.wabaId },
        });
      }
      return waiting(origin, 'No newly shared WhatsApp account found yet. Complete the "Get started" flow.');
    }

    /* STEP 3 — first candidate that has a phone number */
    let waba: Waba | undefined;
    let phone: Phone | undefined;

    for (const candidate of candidates) {
      const phones = await graph<{ data?: Phone[] }>(
        `${GRAPH}/${encodeURIComponent(candidate.id)}/phone_numbers?fields=id,display_phone_number,verified_name`,
        { method: 'GET', headers: { Authorization: `Bearer ${systemToken}` } }
      );

      if (!phones.ok) {
        console.error('[WhatsApp Claim] Phone lookup failed for', candidate.id, phones.data.error);

        // A dead token will fail for every candidate, so stop immediately.
        if (isTokenError(phones.data.error)) {
          return fail(origin, 'phone_lookup', 'Invalid access token', 503, phones.data.error);
        }
        continue;
      }

      if (phones.data.data?.length) {
        waba = candidate;
        phone = phones.data.data[0];
        break;
      }
    }

    if (!waba || !phone) {
      // Account shared but phone number not added yet -> not an error, keep waiting
      return waiting(origin, 'WhatsApp account shared. Waiting for the phone number to be added.');
    }

    /* STEP 4 — subscribe the app to the WABA (for webhooks) */
    const subscribe = await graph<{ success?: boolean }>(
      `${GRAPH}/${encodeURIComponent(waba.id)}/subscribed_apps`,
      { method: 'POST', headers: { Authorization: `Bearer ${systemToken}` } }
    );

    if (!subscribe.ok) {
      console.error('[WhatsApp Claim] Subscribe failed:', subscribe.data);
      return fail(
        origin,
        'subscribe',
        'Failed to subscribe app to WhatsApp Business Account',
        400,
        subscribe.data.error
      );
    }

    /* STEP 5 — save for the logged-in user */
    const record = {
      wabaId: waba.id,
      phoneNumberId: phone.id,
      businessPhoneNumber: phone.display_phone_number ?? null,
      businessName: phone.verified_name ?? waba.name ?? null,
      accessToken: systemToken,
      status: 'active' as const,
    };

    try {
      if (mine) {
        await db
          .update(whatsappConnections)
          .set({ ...record, updatedAt: new Date() })
          .where(eq(whatsappConnections.userId, userId));
      } else {
        await db.insert(whatsappConnections).values({ userId, ...record });
      }
    } catch (dbError) {
      // The real reason (missing column, unique key, type mismatch) shows up in the console
      console.error('[WhatsApp Claim] DB save failed:', dbError);
      return fail(
        origin,
        'db_save',
        dbError instanceof Error ? dbError.message : 'Failed to save WhatsApp connection',
        500
      );
    }

    console.log('[WhatsApp Claim] Connection saved:', {
      userId,
      wabaId: waba.id,
      phoneNumberId: phone.id,
    });

    return reply(origin, {
      success: true,
      state: 'linked',
      message: 'WhatsApp account linked successfully',
      data: {
        wabaId: waba.id,
        phoneNumberId: phone.id,
        businessPhoneNumber: record.businessPhoneNumber,
        businessName: record.businessName,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return reply(origin, { success: false, state: 'error', step: 'auth', message: error.message }, 401);
    }

    console.error('[WhatsApp Claim] Error:', error);
    return fail(origin, 'unknown', 'Failed to link WhatsApp account', 500);
  }
}