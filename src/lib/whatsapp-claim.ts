import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { whatsappConnections } from '@/db/schema';
import { ensurePhoneRegistered } from '@/lib/whatsapp-register';

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v25.0';
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

export type ClaimData = {
  wabaId: string;
  phoneNumberId?: string;
  businessPhoneNumber?: string | null;
  businessName?: string | null;
  registered: boolean;
  activationMessage: string | null;
};

export type ClaimResult =
  | { state: 'linked'; message: string; data: ClaimData }
  | { state: 'waiting'; message: string }
  | {
      state: 'error';
      step: string;
      message: string;
      httpStatus: number;
      code?: string;
      detail?: { code?: number; subcode?: number; fbtrace_id?: string };
    };

function claimError(
  step: string,
  message: string,
  httpStatus = 400,
  detail?: GraphError
): ClaimResult {
  // Error 190 = the shared system-user token is dead. Server problem, not user problem.
  if (detail?.code === 190) {
    console.error(
      '[WhatsApp Claim] META_SYSTEM_USER_TOKEN is invalid or revoked. ' +
        'Generate a new System User token in Business Settings and update the env var.',
      { step, code: detail.code, subcode: detail.error_subcode, fbtrace_id: detail.fbtrace_id }
    );
    return {
      state: 'error',
      step,
      code: 'SERVER_TOKEN_INVALID',
      message: 'WhatsApp connection is temporarily unavailable. Please contact support.',
      httpStatus: 503,
      detail: {
        code: detail.code,
        subcode: detail.error_subcode,
        fbtrace_id: detail.fbtrace_id,
      },
    };
  }

  return {
    state: 'error',
    step,
    message: detail?.error_user_msg || detail?.message || message,
    httpStatus,
    detail: detail
      ? { code: detail.code, subcode: detail.error_subcode, fbtrace_id: detail.fbtrace_id }
      : undefined,
  };
}

async function graph<T>(url: string, init: RequestInit) {
  const res = await fetch(url, {
    ...init,
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: GraphError };
  return { ok: res.ok && !data.error, data };
}

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

/** Register without ever failing the connection. */
async function tryRegister(phoneNumberId: string, token: string) {
  try {
    const result = await ensurePhoneRegistered(phoneNumberId, token);
    return {
      registered: result.registered,
      activationMessage: result.registered ? null : 'Registration is still pending. Try again in a minute.',
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Activation failed';
    console.error('[WhatsApp Claim] Auto-register failed:', message);
    return { registered: false, activationMessage: message };
  }
}

/* Callback and /claim can arrive together. Share one run per user. */
const inFlight = new Map<number, Promise<ClaimResult>>();

export function claimWhatsAppForUser(userId: number): Promise<ClaimResult> {
  const running = inFlight.get(userId);
  if (running) return running;

  const task = runClaim(userId).finally(() => inFlight.delete(userId));
  inFlight.set(userId, task);
  return task;
}

async function runClaim(userId: number): Promise<ClaimResult> {
  const businessId = process.env.META_BUSINESS_ID?.trim();
  const systemToken = process.env.META_SYSTEM_USER_TOKEN?.trim();

  if (!businessId || !systemToken) {
    console.error('[WhatsApp Claim] Missing META_BUSINESS_ID / META_SYSTEM_USER_TOKEN');
    return claimError('config', 'Server is missing Meta business credentials', 500);
  }

  /* STEP 1: all WABAs shared with the business */
  const listed = await listClientWabas(businessId, systemToken);
  if (!listed.ok) {
    console.error('[WhatsApp Claim] Failed to list client WABAs:', listed.error);
    return claimError(
      'list_client_wabas',
      'Unable to list WhatsApp accounts shared with your business',
      400,
      listed.error
    );
  }

  /* STEP 2: work out candidates */
  const saved = await db
    .select({
      wabaId: whatsappConnections.wabaId,
      phoneNumberId: whatsappConnections.phoneNumberId,
      userId: whatsappConnections.userId,
      status: whatsappConnections.status,
    })
    .from(whatsappConnections);

  const savedByOthers = new Set(
    saved.filter((r) => Number(r.userId) !== userId).map((r) => r.wabaId)
  );
  const mine = saved.find((r) => Number(r.userId) === userId);

  const unclaimed = listed.wabas
    .filter((w) => !savedByOthers.has(w.id) && w.id !== mine?.wabaId)
    .reverse();

  const mineWaba =
    mine && mine.status !== 'active'
      ? listed.wabas.find((w) => w.id === mine.wabaId)
      : undefined;

  const candidates: Waba[] = [...unclaimed, ...(mineWaba ? [mineWaba] : [])];

  console.log('[WhatsApp Claim]', {
    userId,
    shared: listed.wabas.map((w) => w.id),
    candidates: candidates.map((w) => w.id),
    hasActiveRow: mine?.status === 'active',
  });

  if (candidates.length === 0) {
    // Already linked: idempotent success. Also heal registration if it was missed earlier.
    if (mine && mine.status === 'active') {
      const activation = mine.phoneNumberId
        ? await tryRegister(String(mine.phoneNumberId), systemToken)
        : { registered: false, activationMessage: 'Phone number is missing.' };

      return {
        state: 'linked',
        message: 'WhatsApp already linked',
        data: { wabaId: String(mine.wabaId), ...activation },
      };
    }
    return {
      state: 'waiting',
      message: 'No newly shared WhatsApp account found yet. Complete the "Get started" flow.',
    };
  }

  /* STEP 3: first candidate that has a phone number */
  let waba: Waba | undefined;
  let phone: Phone | undefined;

  for (const candidate of candidates) {
    const phones = await graph<{ data?: Phone[] }>(
      `${GRAPH}/${encodeURIComponent(candidate.id)}/phone_numbers?fields=id,display_phone_number,verified_name`,
      { method: 'GET', headers: { Authorization: `Bearer ${systemToken}` } }
    );

    if (!phones.ok) {
      console.error('[WhatsApp Claim] Phone lookup failed for', candidate.id, phones.data.error);
      if (phones.data.error?.code === 190) {
        return claimError('phone_lookup', 'Invalid access token', 503, phones.data.error);
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
    return {
      state: 'waiting',
      message: 'WhatsApp account shared. Waiting for the phone number to be added.',
    };
  }

  /* STEP 4: subscribe the app to the WABA (webhooks) */
  const subscribe = await graph<{ success?: boolean }>(
    `${GRAPH}/${encodeURIComponent(waba.id)}/subscribed_apps`,
    { method: 'POST', headers: { Authorization: `Bearer ${systemToken}` } }
  );

  if (!subscribe.ok) {
    console.error('[WhatsApp Claim] Subscribe failed:', subscribe.data);
    return claimError(
      'subscribe',
      'Failed to subscribe app to WhatsApp Business Account',
      400,
      subscribe.data.error
    );
  }

  /* STEP 5: save for the user */
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
    console.error('[WhatsApp Claim] DB save failed:', dbError);
    return claimError(
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

  /* STEP 6: auto-register the number for Cloud API (non-fatal) */
  const activation = await tryRegister(phone.id, systemToken);

  return {
    state: 'linked',
    message: 'WhatsApp account linked successfully',
    data: {
      wabaId: waba.id,
      phoneNumberId: phone.id,
      businessPhoneNumber: record.businessPhoneNumber,
      businessName: record.businessName,
      ...activation,
    },
  };
}