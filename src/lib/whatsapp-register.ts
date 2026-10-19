import { WhatsAppSendError } from '@/lib/whatsapp-send';

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v25.0';
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

export type MetaPhoneStatus = {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
  status?: string;
  code_verification_status?: string;
  platform_type?: string;
};

export async function getMetaPhoneStatus(
  phoneNumberId: string,
  accessToken: string
): Promise<MetaPhoneStatus> {
  const url = new URL(`${GRAPH_URL}/${phoneNumberId}`);
  url.searchParams.set(
    'fields',
    'display_phone_number,verified_name,status,code_verification_status,platform_type'
  );

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new WhatsAppSendError(
      data?.error?.message || 'Unable to fetch WhatsApp phone status.',
      response.status === 401 ? 401 : 400,
      Number(data?.error?.code) || undefined,
      Number(data?.error?.error_subcode) || undefined
    );
  }

  return data as MetaPhoneStatus;
}

/**
 * Idempotent. If the number is already CONNECTED nothing is sent to /register,
 * so it is safe to call on every connect / claim / retry.
 */
export async function ensurePhoneRegistered(
  phoneNumberId: string,
  accessToken: string
): Promise<{
  registered: boolean;
  alreadyConnected: boolean;
  phone: MetaPhoneStatus;
}> {
  const before = await getMetaPhoneStatus(phoneNumberId, accessToken);

  if (before.status === 'CONNECTED') {
    return { registered: true, alreadyConnected: true, phone: before };
  }

  const pin = process.env.WHATSAPP_REGISTRATION_PIN;
  if (!pin || !/^\d{6}$/.test(pin)) {
    throw new WhatsAppSendError(
      'WHATSAPP_REGISTRATION_PIN is missing or invalid. Configure a 6-digit PIN in the server environment.',
      500
    );
  }

  const response = await fetch(`${GRAPH_URL}/${phoneNumberId}/register`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Never log the access token or the PIN.
    console.error('[WhatsApp Register] Meta API failed:', {
      httpStatus: response.status,
      code: result?.error?.code,
      subcode: result?.error?.error_subcode,
      message: result?.error?.message,
      fbtrace_id: result?.error?.fbtrace_id,
    });

    throw new WhatsAppSendError(
      result?.error?.error_user_msg ||
        result?.error?.message ||
        'Meta rejected the WhatsApp registration request.',
      response.status === 401 ? 401 : 400,
      Number(result?.error?.code) || undefined,
      Number(result?.error?.error_subcode) || undefined
    );
  }

  let after: MetaPhoneStatus = before;
  try {
    after = await getMetaPhoneStatus(phoneNumberId, accessToken);
  } catch {
    // Registration may be accepted even if the follow-up read fails.
  }

  return {
    registered: after.status === 'CONNECTED',
    alreadyConnected: false,
    phone: after,
  };
}

/** Subscribes the Meta app to the WABA so webhooks reach the server. */
export async function subscribeWabaToApp(
  wabaId: string,
  accessToken: string
): Promise<void> {
  const response = await fetch(`${GRAPH_URL}/${wabaId}/subscribed_apps`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('[WhatsApp Subscribe] Meta API failed:', {
      httpStatus: response.status,
      code: data?.error?.code,
      message: data?.error?.message,
    });
    throw new WhatsAppSendError(
      data?.error?.message || 'Could not subscribe the app to this WhatsApp account.',
      400
    );
  }
}