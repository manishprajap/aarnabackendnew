
import { NextRequest, NextResponse } from "next/server";
import { getUserIdFromRequest, AuthError } from "@/lib/auth";
import { getActiveConnection } from "@/lib/whatsapp-send";

export const dynamic = "force-dynamic";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

type MetaPhoneStatus = {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
  status?: string;
  code_verification_status?: string;
  platform_type?: string;
};

async function getMetaPhoneStatus(
  phoneNumberId: string,
  accessToken: string
) {
  const url = new URL(`${GRAPH_URL}/${phoneNumberId}`);
  url.searchParams.set(
    "fields",
    "display_phone_number,verified_name,status,code_verification_status,platform_type"
  );

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message || "Unable to fetch WhatsApp phone status."
    );
  }

  return data as MetaPhoneStatus;
}

function jsonError(message: string, status: number) {
  return NextResponse.json(
    { success: false, message },
    { status }
  );
}

/**
 * GET /api/whatsapp/register
 * Checks the connected WhatsApp phone number's Meta status.
 */
export async function GET(req: NextRequest) {
  try {
    const userId = await getUserIdFromRequest(req);

    const connection = await getActiveConnection(userId);

    if (!connection?.phoneNumberId || !connection?.accessToken) {
      return jsonError(
        "No active WhatsApp connection found. Please connect WhatsApp first.",
        404
      );
    }

    const phoneStatus = await getMetaPhoneStatus(
      String(connection.phoneNumberId),
      connection.accessToken
    );

    return NextResponse.json({
      success: true,
      phone: {
        phoneNumberId: phoneStatus.id,
        displayPhoneNumber: phoneStatus.display_phone_number,
        verifiedName: phoneStatus.verified_name,
        status: phoneStatus.status,
        codeVerificationStatus:
          phoneStatus.code_verification_status,
        platformType: phoneStatus.platform_type,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonError(error.message, 401);
    }

    console.error(
      "[WhatsApp Register GET]",
      error instanceof Error ? error.message : "Unknown error"
    );

    return jsonError(
      error instanceof Error
        ? error.message
        : "Unable to check WhatsApp registration status.",
      500
    );
  }
}

/**
 * POST /api/whatsapp/register
 * Registers the connected phone number using the PIN from .env.
 * No PIN is accepted from the frontend.
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getUserIdFromRequest(req);

    const pin = process.env.WHATSAPP_REGISTRATION_PIN;

    if (!pin || !/^\d{6}$/.test(pin)) {
      return jsonError(
        "WHATSAPP_REGISTRATION_PIN is missing or invalid. Configure a 6-digit PIN in the server environment.",
        500
      );
    }

    const connection = await getActiveConnection(userId);

    if (!connection?.phoneNumberId || !connection?.accessToken) {
      return jsonError(
        "No active WhatsApp connection found. Please connect WhatsApp first.",
        404
      );
    }

    const phoneNumberId = String(connection.phoneNumberId);
    const accessToken = connection.accessToken;

    // Check current Meta status before registration.
    const currentStatus = await getMetaPhoneStatus(
      phoneNumberId,
      accessToken
    );

    if (
      currentStatus.platform_type === "NOT_APPLICABLE" &&
      currentStatus.status === "PENDING"
    ) {
      // This status alone does not prove whether the number uses
      // Coexistence. Confirm the onboarding flow before proceeding.
      console.warn(
        "[WhatsApp Register] Phone status is PENDING; verify onboarding flow."
      );
    }

    // Register the phone number with Meta.
    const response = await fetch(
      `${GRAPH_URL}/${phoneNumberId}/register`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          pin,
        }),
        cache: "no-store",
      }
    );

    const result = await response.json();

    if (!response.ok) {
      // Do not log the access token or registration PIN.
      console.error("[WhatsApp Register] Meta API failed:", {
        httpStatus: response.status,
        errorCode: result?.error?.code,
        errorSubcode: result?.error?.error_subcode,
        message: result?.error?.message,
        fbtraceId: result?.error?.fbtrace_id,
      });

      return NextResponse.json(
        {
          success: false,
          message:
            result?.error?.message ||
            "Meta rejected the WhatsApp registration request.",
          errorCode: result?.error?.code,
          errorSubcode: result?.error?.error_subcode,
        },
        { status: response.status }
      );
    }

    // Registration API accepted the request. Check status again.
    let phoneStatus: MetaPhoneStatus | null = null;

    try {
      phoneStatus = await getMetaPhoneStatus(
        phoneNumberId,
        accessToken
      );
    } catch {
      // Registration may be accepted even if the follow-up
      // status request temporarily fails.
    }

    return NextResponse.json({
      success: true,
      registrationAccepted: true,
      registered: phoneStatus?.status === "CONNECTED",
      message:
        phoneStatus?.status === "CONNECTED"
          ? "WhatsApp registration completed."
          : "Meta accepted the registration request. Check the phone status before sending messages.",
      phone: phoneStatus
        ? {
            phoneNumberId: phoneStatus.id,
            displayPhoneNumber: phoneStatus.display_phone_number,
            verifiedName: phoneStatus.verified_name,
            status: phoneStatus.status,
            codeVerificationStatus:
              phoneStatus.code_verification_status,
          }
        : undefined,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonError(error.message, 401);
    }

    console.error(
      "[WhatsApp Register POST]",
      error instanceof Error ? error.message : "Unknown error"
    );

    return jsonError(
      error instanceof Error
        ? error.message
        : "Unable to register the WhatsApp phone number.",
      500
    );
  }
}
