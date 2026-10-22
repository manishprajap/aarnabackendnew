
import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { whatsappConnections } from '@/db/schema';
import { ensurePhoneRegistered } from '@/lib/whatsapp-register';

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v25.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Conservative cooldown for Meta error 133016.
// This is not a guarantee that Meta's restriction expires after 72 hours.
const REGISTRATION_COOLDOWN_MS = 72 * 60 * 60 * 1000;

type GraphError = {
  message?: string;
  code?: number;
  error_subcode?: number;
  error_user_msg?: string;
  fbtrace_id?: string;
};

type Waba = { id: string; name?: string };

type Phone = {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
};

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
      detail?: {
        code?: number;
        subcode?: number;
        fbtrace_id?: string;
      };
    };

function claimError(
  step: string,
  message: string,
  httpStatus = 400,
  detail?: GraphError
): ClaimResult {
  if (detail?.code === 190) {
    console.error(
      '[WhatsApp Claim] META_SYSTEM_USER_TOKEN is invalid or revoked.',
      {
        step,
        code: detail.code,
        subcode: detail.error_subcode,
        fbtrace_id: detail.fbtrace_id,
      }
    );

    return {
      state: 'error',
      step,
      code: 'SERVER_TOKEN_INVALID',
      message:
        'WhatsApp connection is temporarily unavailable. Please contact support.',
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
      ? {
          code: detail.code,
          subcode: detail.error_subcode,
          fbtrace_id: detail.fbtrace_id,
        }
      : undefined,
  };
}

async function graph<T>(url: string, init: RequestInit) {
  const res = await fetch(url, {
    ...init,
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
  });

  const data = (await res.json().catch(() => ({}))) as T & {
    error?: GraphError;
  };

  return { ok: res.ok && !data.error, data };
}

async function listClientWabas(businessId: string, token: string) {
  const all: Waba[] = [];

  let url: string | undefined =
    `${GRAPH}/${encodeURIComponent(businessId)}` +
    '/client_whatsapp_business_accounts?fields=id,name&limit=100';

  for (let page = 0; url && page < 5; page++) {
    const result: {
      ok: boolean;
      data: {
        data?: Waba[];
        paging?: { next?: string };
        error?: GraphError;
      };
    } = await graph(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!result.ok) {
      return {
        ok: false as const,
        error: result.data.error,
        wabas: [] as Waba[],
      };
    }

    all.push(...(result.data.data ?? []));
    url = result.data.paging?.next;
  }

  return {
    ok: true as const,
    error: undefined,
    wabas: all,
  };
}

/*
 * In-process registration protection.
 *
 * IMPORTANT:
 * This Map survives requests but not a PM2/process restart.
 * See the persistence note below for production-grade protection.
 */
const registrationBlockedUntil = new Map<string, number>();

function isTooManyRegistrationAttempts(message: string): boolean {
  return (
    /133016/.test(message) ||
    /too many attempts for this phone number/i.test(message) ||
    /registration or deregistration failed because there were too many attempts/i.test(
      message
    )
  );
}

function getRegistrationBlock(phoneNumberId: string): number | undefined {
  const blockedUntil = registrationBlockedUntil.get(phoneNumberId);

  if (!blockedUntil) return undefined;

  if (Date.now() >= blockedUntil) {
    registrationBlockedUntil.delete(phoneNumberId);
    return undefined;
  }

  return blockedUntil;
}

/**
 * Register the phone number without making connection linking depend on it.
 * Error 133016 activates a cooldown to prevent retries on every claim poll.
 */
async function tryRegister(phoneNumberId: string, token: string) {
  const blockedUntil = getRegistrationBlock(phoneNumberId);

  if (blockedUntil) {
    const retryAfter = new Date(blockedUntil).toISOString();

    return {
      registered: false,
      activationMessage:
        `Meta has temporarily limited registration attempts. ` +
        `Automatic retries are paused until ${retryAfter}. ` +
        'Please verify the phone registration status before retrying.',
    };
  }

  try {
    const result = await ensurePhoneRegistered(phoneNumberId, token);

    return {
      registered: result.registered,
      activationMessage: result.registered
        ? null
        : 'WhatsApp phone registration is pending. Check the registration status before retrying.',
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'WhatsApp activation failed';

    if (isTooManyRegistrationAttempts(message)) {
      const blockedUntil = Date.now() + REGISTRATION_COOLDOWN_MS;

      registrationBlockedUntil.set(phoneNumberId, blockedUntil);

      console.error(
        '[WhatsApp Claim] Registration cooldown activated.',
        {
          phoneNumberId,
          errorCode: 133016,
          blockedUntil: new Date(blockedUntil).toISOString(),
        }
      );

      return {
        registered: false,
        activationMessage:
          'Meta has temporarily limited registration attempts for this phone number. ' +
          'Automatic retries are paused. Wait for the restriction to clear, ' +
          'then verify registration status before trying again.',
      };
    }

    console.error('[WhatsApp Claim] Auto-register failed:', {
      phoneNumberId,
      message,
    });

    return {
      registered: false,
      activationMessage: message,
    };
  }
}

/*
 * Callback and /claim can arrive together.
 * Share one in-flight run per user.
 */
const inFlight = new Map<number, Promise<ClaimResult>>();

export function claimWhatsAppForUser(
  userId: number
): Promise<ClaimResult> {
  const running = inFlight.get(userId);

  if (running) return running;

  const task = runClaim(userId).finally(() => {
    inFlight.delete(userId);
  });

  inFlight.set(userId, task);

  return task;
}

async function runClaim(userId: number): Promise<ClaimResult> {
  const businessId = process.env.META_BUSINESS_ID?.trim();
  const systemToken = process.env.META_SYSTEM_USER_TOKEN?.trim();

  if (!businessId || !systemToken) {
    console.error(
      '[WhatsApp Claim] Missing META_BUSINESS_ID / META_SYSTEM_USER_TOKEN'
    );

    return claimError(
      'config',
      'Server is missing Meta business credentials',
      500
    );
  }

  // STEP 1: Find WABAs shared with our business.
  const listed = await listClientWabas(businessId, systemToken);

  if (!listed.ok) {
    console.error(
      '[WhatsApp Claim] Failed to list client WABAs:',
      listed.error
    );

    return claimError(
      'list_client_wabas',
      'Unable to list WhatsApp accounts shared with your business',
      400,
      listed.error
    );
  }

  // STEP 2: Identify this user's existing connection and available WABAs.
  const saved = await db
    .select({
      wabaId: whatsappConnections.wabaId,
      phoneNumberId: whatsappConnections.phoneNumberId,
      userId: whatsappConnections.userId,
      status: whatsappConnections.status,
    })
    .from(whatsappConnections);

  const savedByOthers = new Set(
    saved
      .filter((row) => Number(row.userId) !== userId)
      .map((row) => String(row.wabaId))
  );

  const mine = saved.find(
    (row) => Number(row.userId) === userId
  );

  const unclaimed = listed.wabas
    .filter(
      (waba) =>
        !savedByOthers.has(waba.id) &&
        waba.id !== String(mine?.wabaId ?? '')
    )
    .reverse();

  const mineWaba =
    mine && mine.status !== 'active'
      ? listed.wabas.find(
          (waba) => waba.id === String(mine.wabaId)
        )
      : undefined;

  const candidates: Waba[] = [
    ...unclaimed,
    ...(mineWaba ? [mineWaba] : []),
  ];

  console.log('[WhatsApp Claim]', {
    userId,
    shared: listed.wabas.map((waba) => waba.id),
    candidates: candidates.map((waba) => waba.id),
    hasActiveRow: mine?.status === 'active',
  });

  /*
   * STEP 3A: Existing active connection.
   *
   * Do not repeatedly register a number when Meta has blocked attempts.
   * tryRegister() checks the cooldown before calling Meta.
   */
  if (candidates.length === 0) {
    if (mine && mine.status === 'active') {
      const phoneNumberId = mine.phoneNumberId
        ? String(mine.phoneNumberId)
        : '';

      const activation = phoneNumberId
        ? await tryRegister(phoneNumberId, systemToken)
        : {
            registered: false,
            activationMessage: 'Phone number ID is missing from the saved connection.',
          };

      return {
        state: 'linked',
        message: 'WhatsApp already linked',
        data: {
          wabaId: String(mine.wabaId),
          phoneNumberId: phoneNumberId || undefined,
          ...activation,
        },
      };
    }

    return {
      state: 'waiting',
      message:
        'No newly shared WhatsApp account found yet. Complete the "Get started" flow.',
    };
  }

  // STEP 3B: Find the first candidate with a phone number.
  let waba: Waba | undefined;
  let phone: Phone | undefined;

  for (const candidate of candidates) {
    const phones = await graph<{ data?: Phone[] }>(
      `${GRAPH}/${encodeURIComponent(candidate.id)}` +
        '/phone_numbers?fields=id,display_phone_number,verified_name',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${systemToken}` },
      }
    );

    if (!phones.ok) {
      console.error(
        '[WhatsApp Claim] Phone lookup failed for',
        candidate.id,
        phones.data.error
      );

      if (phones.data.error?.code === 190) {
        return claimError(
          'phone_lookup',
          'Invalid access token',
          503,
          phones.data.error
        );
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
      message:
        'WhatsApp account shared. Waiting for the phone number to be added.',
    };
  }

  // STEP 4: Subscribe the app to the WABA for webhook events.
  const subscribe = await graph<{ success?: boolean }>(
    `${GRAPH}/${encodeURIComponent(waba.id)}/subscribed_apps`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${systemToken}` },
    }
  );

  if (!subscribe.ok) {
    console.error(
      '[WhatsApp Claim] Subscribe failed:',
      subscribe.data
    );

    return claimError(
      'subscribe',
      'Failed to subscribe app to WhatsApp Business Account',
      400,
      subscribe.data.error
    );
  }

  // STEP 5: Save the connection before attempting phone registration.
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
        .set({
          ...record,
          updatedAt: new Date(),
        })
        .where(eq(whatsappConnections.userId, userId));
    } else {
      await db
        .insert(whatsappConnections)
        .values({ userId, ...record });
    }
  } catch (dbError) {
    console.error('[WhatsApp Claim] DB save failed:', dbError);

    return claimError(
      'db_save',
      dbError instanceof Error
        ? dbError.message
        : 'Failed to save WhatsApp connection',
      500
    );
  }

  console.log('[WhatsApp Claim] Connection saved:', {
    userId,
    wabaId: waba.id,
    phoneNumberId: phone.id,
  });

  // STEP 6: Non-fatal activation; the connection stays saved if it fails.
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
