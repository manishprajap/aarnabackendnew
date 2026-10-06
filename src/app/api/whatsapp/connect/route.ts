// src/app/api/whatsapp/connect/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { whatsappConnections } from "@/db/schema";
import { eq } from "drizzle-orm";

const GRAPH_VERSION =
  process.env.META_GRAPH_VERSION || "v26.0";

const GRAPH_URL =
  `https://graph.facebook.com/${GRAPH_VERSION}`;


function jsonError(
  message: string,
  status = 400,
  extra: Record<string, unknown> = {}
) {
  return NextResponse.json(
    {
      success: false,
      message,
      ...extra,
    },
    { status }
  );
}


export async function POST(
  req: NextRequest
) {

  try {

    /* =====================================================
       AUTHENTICATION
    ===================================================== */

    /*
     * Replace this with your existing authenticated-user
     * lookup if you already have one.
     *
     * IMPORTANT:
     * Do not trust userId coming from browser.
     */

    const userIdHeader =
      req.headers.get("x-user-id");

    const userId =
      userIdHeader
        ? Number(userIdHeader)
        : null;


    if (
      !userId ||
      !Number.isFinite(userId)
    ) {

      return jsonError(
        "Authenticated user was not found.",
        401
      );

    }


    /* =====================================================
       REQUEST
    ===================================================== */

    const body =
      await req.json();


    const code =
      typeof body.code === "string"
        ? body.code.trim()
        : "";


    const wabaId =
      typeof body.wabaId === "string"
        ? body.wabaId.trim()
        : "";


    let phoneNumberId =
      typeof body.phoneNumberId === "string"
        ? body.phoneNumberId.trim()
        : "";


    if (!code) {

      return jsonError(
        "Missing Meta authorization code."
      );

    }


    if (!wabaId) {

      return jsonError(
        "Missing WhatsApp Business Account ID."
      );

    }


    /* =====================================================
       META APP CREDENTIALS
    ===================================================== */

    const appId =
      process.env.META_APP_ID;

    const appSecret =
      process.env.META_APP_SECRET;


    if (!appId) {

      return jsonError(
        "META_APP_ID is not configured.",
        500
      );

    }


    if (!appSecret) {

      return jsonError(
        "META_APP_SECRET is not configured.",
        500
      );

    }


    /* =====================================================
       1. EXCHANGE EMBEDDED SIGNUP CODE
    ===================================================== */

    const tokenUrl =
      new URL(
        `${GRAPH_URL}/oauth/access_token`
      );


    tokenUrl.searchParams.set(
      "client_id",
      appId
    );


    tokenUrl.searchParams.set(
      "client_secret",
      appSecret
    );


    tokenUrl.searchParams.set(
      "code",
      code
    );


    console.log(
      "[WhatsApp] Exchanging Embedded Signup code..."
    );


    const tokenResponse =
      await fetch(
        tokenUrl.toString(),
        {
          method: "GET",
          cache: "no-store",
        }
      );


    const tokenData =
      await tokenResponse
        .json()
        .catch(() => ({}));


    if (
      !tokenResponse.ok ||
      !tokenData.access_token
    ) {

      console.error(
        "[WhatsApp] Token exchange failed:",
        tokenData
      );


      return jsonError(
        tokenData?.error?.message ||
        "Meta authorization code exchange failed.",
        400
      );

    }


    const accessToken =
      tokenData.access_token;


    /* =====================================================
       2. GET WABA
    ===================================================== */

    const wabaResponse =
      await fetch(
        `${GRAPH_URL}/${encodeURIComponent(
          wabaId
        )}?fields=id,name`,
        {
          headers: {
            Authorization:
              `Bearer ${accessToken}`,
          },
          cache: "no-store",
        }
      );


    const wabaData =
      await wabaResponse
        .json()
        .catch(() => ({}));


    if (
      !wabaResponse.ok ||
      !wabaData.id
    ) {

      console.error(
        "[WhatsApp] WABA lookup failed:",
        wabaData
      );


      return jsonError(
        wabaData?.error?.message ||
        "Unable to access WhatsApp Business Account.",
        400
      );

    }


    /* =====================================================
       3. DISCOVER PHONE NUMBER
    ===================================================== */

    if (!phoneNumberId) {

      console.log(
        "[WhatsApp] Discovering phone number from WABA..."
      );


      const phoneResponse =
        await fetch(
          `${GRAPH_URL}/${encodeURIComponent(
            wabaId
          )}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`,
          {
            headers: {
              Authorization:
                `Bearer ${accessToken}`,
            },
            cache: "no-store",
          }
        );


      const phoneData =
        await phoneResponse
          .json()
          .catch(() => ({}));


      console.log(
        "[WhatsApp] Phone number response:",
        phoneData
      );


      if (
        !phoneResponse.ok ||
        !Array.isArray(phoneData.data) ||
        phoneData.data.length === 0
      ) {

        return jsonError(
          phoneData?.error?.message ||
          "No WhatsApp phone number was found under this WABA.",
          400
        );

      }


      /*
       * If multiple numbers exist, you should eventually
       * let the user choose one.
       *
       * For now use the first returned number.
       */

      phoneNumberId =
        phoneData.data[0].id;

    }


    /* =====================================================
       4. GET PHONE DETAILS
    ===================================================== */

    const phoneResponse =
      await fetch(
        `${GRAPH_URL}/${encodeURIComponent(
          phoneNumberId
        )}?fields=id,display_phone_number,verified_name,quality_rating`,
        {
          headers: {
            Authorization:
              `Bearer ${accessToken}`,
          },
          cache: "no-store",
        }
      );


    const phoneData =
      await phoneResponse
        .json()
        .catch(() => ({}));


    if (
      !phoneResponse.ok ||
      !phoneData.id
    ) {

      console.error(
        "[WhatsApp] Phone lookup failed:",
        phoneData
      );


      return jsonError(
        phoneData?.error?.message ||
        "Unable to access WhatsApp phone number.",
        400
      );

    }


    /* =====================================================
       5. SUBSCRIBE WABA TO APP
    ===================================================== */

    const subscribeResponse =
      await fetch(
        `${GRAPH_URL}/${encodeURIComponent(
          wabaId
        )}/subscribed_apps`,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${accessToken}`,
          },

          cache: "no-store",
        }
      );


    const subscribeData =
      await subscribeResponse
        .json()
        .catch(() => ({}));


    console.log(
      "[WhatsApp] WABA subscription:",
      subscribeData
    );


    if (
      !subscribeResponse.ok
    ) {

      return jsonError(
        subscribeData?.error?.message ||
        "Unable to subscribe WhatsApp Business Account to the app.",
        400
      );

    }


    /* =====================================================
       6. IMPORTANT:
          DO NOT CALL /register HERE FOR COEXISTENCE
    ===================================================== */

    /*
     * The number already belongs to WhatsApp Business App.
     *
     * Do NOT do this:
     *
     * POST /{phoneNumberId}/register
     *
     * with a fake/default PIN such as 000000.
     *
     * That is not the correct way to handle an existing
     * WhatsApp Business App coexistence number.
     */


    /* =====================================================
       7. SAVE CONNECTION
    ===================================================== */

    const existing =
      await db
        .select({
          id: whatsappConnections.id,
        })
        .from(whatsappConnections)
        .where(
          eq(
            whatsappConnections.userId,
            userId
          )
        )
        .limit(1);


    const connectionData = {

      wabaId,

      phoneNumberId,

      businessPhoneNumber:
        phoneData.display_phone_number ||
        null,

      businessName:
        phoneData.verified_name ||
        wabaData.name ||
        null,

      accessToken,

      status: "active" as const,

    };


    if (existing.length > 0) {

      await db
        .update(
          whatsappConnections
        )
        .set(
          connectionData
        )
        .where(
          eq(
            whatsappConnections.userId,
            userId
          )
        );

    } else {

      await db
        .insert(
          whatsappConnections
        )
        .values({
          userId,
          ...connectionData,
        });

    }


    /* =====================================================
       SUCCESS
    ===================================================== */

    console.log(
      "[WhatsApp] Connection saved:",
      {
        userId,
        wabaId,
        phoneNumberId,
        phone:
          phoneData.display_phone_number,
      }
    );


    return NextResponse.json({
      success: true,

      message:
        "WhatsApp Business connected successfully.",

      wabaId,

      phoneNumberId,

      phoneNumber:
        phoneData.display_phone_number ||
        null,

      businessName:
        phoneData.verified_name ||
        wabaData.name ||
        null,
    });


  } catch (error) {

    console.error(
      "[WhatsApp] Connect route error:",
      error
    );


    return NextResponse.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "WhatsApp connection failed.",
      },
      {
        status: 500,
      }
    );

  }

}