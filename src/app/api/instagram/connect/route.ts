// src/app/api/instagram/connect/route.ts
import { NextRequest, NextResponse } from "next/server";

import { getUserIdFromRequest, AuthError } from "@/lib/auth";
import { getMetaConfig, createSignedState } from "@/lib/instagramOAuth";

export async function POST(req: NextRequest) {
  try {
    // 1. Logged-in user
    const userId = Number(getUserIdFromRequest(req));

    console.log("Starting Instagram connection:", { userId });

    // 2. Optional request body
    const body = await req.json().catch(() => ({}));

    const bannerId =
      body?.bannerId !== undefined &&
      body?.bannerId !== null &&
      body?.bannerId !== ""
        ? Number(body.bannerId)
        : null;

    // 3. Validate bannerId
    if (bannerId !== null && (!Number.isFinite(bannerId) || bannerId <= 0)) {
      return NextResponse.json(
        { success: false, message: "Invalid bannerId" },
        { status: 400 }
      );
    }

    // 4. Environment (values are trimmed, so a stray \r can't break them)
    const { clientId, redirectUri } = getMetaConfig();

    console.log("Instagram OAuth configuration:", {
      hasMetaAppId: !!clientId,
      redirectUri,
      redirectUriLength: redirectUri.length,
    });

    if (!clientId) {
      console.error("META_APP_ID is missing");
      return NextResponse.json(
        { success: false, message: "META_APP_ID is not configured" },
        { status: 500 }
      );
    }

    // 5. Signed OAuth state
    const state = createSignedState({
      userId,
      bannerId,
      timestamp: Date.now(),
    });

    // 6. Instagram Login URL
    const params = new URLSearchParams();
    params.set("client_id", clientId);
    params.set("redirect_uri", redirectUri);
    params.set(
      "scope",
      [
        "instagram_business_basic",
        "instagram_business_content_publish",
        "instagram_business_manage_insights",
      ].join(
        ","
      )
    );
    params.set("response_type", "code");
    params.set("state", state);
    params.set("enable_fb_login", "0");

    const instagramUrl = `https://www.instagram.com/oauth/authorize?${params.toString()}`;

    console.log("Instagram OAuth URL generated successfully");

    // 7. Return URL to frontend
    return NextResponse.json({
      success: true,
      redirectUrl: instagramUrl,
      userId,
      bannerId,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      console.error("Instagram connect authentication error:", error.message);
      return NextResponse.json(
        { success: false, message: error.message },
        { status: 401 }
      );
    }

    console.error("Instagram connect error:", error);
    return NextResponse.json(
      { success: false, message: "Failed to start Instagram connection" },
      { status: 500 }
    );
  }
}