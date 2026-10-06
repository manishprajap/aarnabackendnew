// src/app/api/meta/callback/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { instagramConnections, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  getEnv,
  getMetaConfig,
  verifySignedState,
} from "@/lib/instagramOAuth";

const INSTAGRAM_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const INSTAGRAM_GRAPH_URL = "https://graph.instagram.com";

// ---------------------------------------------------------
// Authorization codes are single-use. If the browser / a proxy / React
// strict mode hits this route twice with the same code, the second call
// would fail with "Error validating verification code". Track recent codes.
// ---------------------------------------------------------
const processedCodes = new Map<string, number>();
const CODE_TTL_MS = 10 * 60 * 1000;

function markCodeSeen(code: string): boolean {
  const now = Date.now();
  for (const [key, ts] of processedCodes) {
    if (now - ts > CODE_TTL_MS) processedCodes.delete(key);
  }
  if (processedCodes.has(code)) return false; // duplicate
  processedCodes.set(code, now);
  return true;
}

function getFrontendUrl() {
  return (
    getEnv("FRONTEND_URL") ||
    getEnv("NEXT_PUBLIC_FRONTEND_URL") ||
    "http://localhost:8100"
  ).replace(/\/+$/, "");
}

function redirectToFrontend(path: string, params: Record<string, string>) {
  const url = new URL(`${getFrontendUrl()}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url);
}

function fail(message: string) {
  return redirectToFrontend("/posters", { instagram: "error", message });
}

export async function GET(req: NextRequest) {
  const requestId = Math.random().toString(36).slice(2, 8);

  console.log("========================================");
  console.log(`[${requestId}] Instagram OAuth callback started`);
  console.log("========================================");

  try {
    const { searchParams } = new URL(req.url);

    // Instagram may append "#_" to the code; strip it just in case.
    const code = searchParams.get("code")?.replace(/#_$/, "") || null;
    const state = searchParams.get("state");

    const oauthError = searchParams.get("error");
    const oauthErrorReason = searchParams.get("error_reason");
    const oauthErrorDescription = searchParams.get("error_description");

    console.log(`[${requestId}] Callback params:`, {
      hasCode: !!code,
      codeLength: code ? code.length : 0,
      hasState: !!state,
      oauthError,
      oauthErrorReason,
      oauthErrorDescription,
    });

    // 1. Instagram returned an OAuth error
    if (oauthError) {
      console.error(`[${requestId}] Instagram OAuth error:`, {
        oauthError,
        oauthErrorReason,
        oauthErrorDescription,
      });
      return fail(
        oauthErrorDescription ||
          oauthErrorReason ||
          oauthError ||
          "instagram_oauth_error"
      );
    }

    // 2. Validate code / state presence
    if (!code) {
      console.error(`[${requestId}] Instagram callback missing code`);
      return fail("missing_code");
    }

    if (!state) {
      console.error(`[${requestId}] Instagram callback missing state`);
      return fail("missing_state");
    }

    // 3. Verify signed state (signature + expiry)
    const stateData = verifySignedState(state);

    if (!stateData || !stateData.userId) {
      console.error(`[${requestId}] Invalid or expired Instagram OAuth state`);
      return fail("invalid_state");
    }

    const userId = Number(stateData.userId);
    const bannerId = stateData.bannerId ? Number(stateData.bannerId) : undefined;

    if (!Number.isFinite(userId) || userId <= 0) {
      console.error(`[${requestId}] Invalid userId in OAuth state:`, userId);
      return fail("invalid_user");
    }

    console.log(`[${requestId}] OAuth belongs to user:`, userId, "banner:", bannerId);

    // 4. Duplicate-callback protection
    if (!markCodeSeen(code)) {
      console.warn(
        `[${requestId}] Duplicate callback with an already-used code; ignoring`
      );
      // The first request is handling it; send user to the same place.
      return redirectToFrontend("/posters", {
        instagram: "connected",
        ...(bannerId ? { bannerId: String(bannerId) } : {}),
      });
    }

    // 5. Environment variables (trimmed)
    const { clientId, clientSecret, redirectUri } = getMetaConfig();

    console.log(`[${requestId}] Redirect URI:`, JSON.stringify(redirectUri));
    console.log(`[${requestId}] Redirect URI length:`, redirectUri.length);

    if (!clientId) {
      console.error(`[${requestId}] META_APP_ID is missing`);
      return fail("missing_app_id");
    }

    if (!clientSecret) {
      console.error(`[${requestId}] META_APP_SECRET is missing`);
      return fail("missing_app_secret");
    }

    // 6. Authorization code -> short-lived token
    console.log(`[${requestId}] Exchanging Instagram authorization code...`);

    const shortTokenBody = new URLSearchParams();
    shortTokenBody.set("client_id", clientId);
    shortTokenBody.set("client_secret", clientSecret);
    shortTokenBody.set("grant_type", "authorization_code");
    shortTokenBody.set("redirect_uri", redirectUri);
    shortTokenBody.set("code", code);

    const shortTokenResponse = await fetch(INSTAGRAM_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: shortTokenBody.toString(),
      cache: "no-store",
    });

    const shortTokenText = await shortTokenResponse.text();

    console.log(
      `[${requestId}] Short token response status:`,
      shortTokenResponse.status
    );

    if (!shortTokenResponse.ok) {
      console.error(
        `[${requestId}] Instagram short token exchange failed:`,
        shortTokenText
      );
      return fail("short_token_exchange");
    }

    let shortTokenData: any;
    try {
      shortTokenData = JSON.parse(shortTokenText);
    } catch {
      console.error(
        `[${requestId}] Invalid JSON from short token response:`,
        shortTokenText
      );
      return fail("invalid_short_token_response");
    }

    const shortAccessToken = shortTokenData?.access_token;
    const shortInstagramUserId = shortTokenData?.user_id;

    if (!shortAccessToken) {
      console.error(`[${requestId}] Short token missing access_token`);
      return fail("missing_short_token");
    }

    console.log(
      `[${requestId}] Short token received for IG user:`,
      shortInstagramUserId
    );

    // 7. Short-lived -> long-lived token
    console.log(`[${requestId}] Exchanging for long-lived token...`);

    const longTokenUrl = new URL(`${INSTAGRAM_GRAPH_URL}/access_token`);
    longTokenUrl.searchParams.set("grant_type", "ig_exchange_token");
    longTokenUrl.searchParams.set("client_secret", clientSecret);
    longTokenUrl.searchParams.set("access_token", shortAccessToken);

    const longTokenResponse = await fetch(longTokenUrl.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    const longTokenText = await longTokenResponse.text();

    console.log(
      `[${requestId}] Long token response status:`,
      longTokenResponse.status
    );

    if (!longTokenResponse.ok) {
      // Do not log the raw success body (it contains the token); errors are safe.
      console.error(`[${requestId}] Long-lived token exchange failed:`, {
        status: longTokenResponse.status,
        response: longTokenText,
      });
      return fail("long_token_exchange");
    }

    let longTokenData: any;
    try {
      longTokenData = JSON.parse(longTokenText);
    } catch {
      console.error(`[${requestId}] Invalid JSON from long token response`);
      return fail("invalid_long_token_response");
    }

    const longAccessToken = longTokenData?.access_token;
    const expiresIn = Number(longTokenData?.expires_in) || 0;

    if (!longAccessToken) {
      console.error(`[${requestId}] Long token response has no access_token`);
      return fail("missing_long_token");
    }

    console.log(`[${requestId}] Long-lived token received; expires in:`, expiresIn);

    // 8. Token expiry
    const tokenExpiresAt =
      expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null;

    // 9. Instagram profile
    console.log(`[${requestId}] Fetching Instagram profile...`);

    const profileUrl = new URL(`${INSTAGRAM_GRAPH_URL}/me`);
    profileUrl.searchParams.set(
      "fields",
      "user_id,username,name,profile_picture_url"
    );
    profileUrl.searchParams.set("access_token", longAccessToken);

    const profileResponse = await fetch(profileUrl.toString(), {
      method: "GET",
      cache: "no-store",
    });

    const profileText = await profileResponse.text();

    console.log(
      `[${requestId}] Profile response status:`,
      profileResponse.status
    );

    if (!profileResponse.ok) {
      console.error(`[${requestId}] Profile request failed:`, profileText);
      return fail("instagram_profile");
    }

    let profileData: any;
    try {
      profileData = JSON.parse(profileText);
    } catch {
      console.error(`[${requestId}] Invalid profile response:`, profileText);
      return fail("invalid_profile_response");
    }

    console.log(`[${requestId}] Instagram profile:`, {
      user_id: profileData?.user_id,
      username: profileData?.username,
      name: profileData?.name,
    });

    // 10. Instagram user ID
    const instagramUserId = String(
      profileData?.user_id || profileData?.id || shortInstagramUserId || ""
    );

    if (!instagramUserId) {
      console.error(`[${requestId}] Instagram user ID could not be determined`);
      return fail("missing_instagram_user_id");
    }

    const instagramUsername = profileData?.username || null;
    const instagramName = profileData?.name || null;
    const instagramProfilePicture = profileData?.profile_picture_url || null;

    // 11. Existing connection?
    const existingConnections = await db
      .select()
      .from(instagramConnections)
      .where(eq(instagramConnections.instagramUserId, instagramUserId))
      .limit(1);

    const existingConnection = existingConnections[0];

    if (existingConnection) {
      console.log(`[${requestId}] Existing connection found:`, {
        connectionId: existingConnection.id,
        dbUserId: existingConnection.userId,
        currentUserId: userId,
      });

      if (Number(existingConnection.userId) !== userId) {
        console.error(
          `[${requestId}] Instagram account already connected to another BizMyntra user`
        );
        return fail("instagram_already_connected");
      }

      await db
        .update(instagramConnections)
        .set({
          instagramUsername,
          instagramName,
          instagramProfilePicture,
          accessToken: longAccessToken,
          tokenExpiresAt,
          status: "active",
          updatedAt: new Date(),
        })
        .where(eq(instagramConnections.id, existingConnection.id));

      console.log(`[${requestId}] Instagram connection updated`);
    } else {
      const inserted = await db
        .insert(instagramConnections)
        .values({
          userId,
          instagramUserId,
          instagramUsername,
          instagramName,
          instagramProfilePicture,
          accessToken: longAccessToken,
          tokenExpiresAt,
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .$returningId();

      console.log(`[${requestId}] Instagram connection created:`, inserted);
    }

    // 12. Mark user as connected
    await db
      .update(users)
      .set({ instagramConnected: true })
      .where(eq(users.id, userId));

    console.log(`[${requestId}] Instagram connection completed successfully`);

    // 13. Redirect frontend
    return redirectToFrontend("/posters", {
      instagram: "connected",
      ...(bannerId ? { bannerId: String(bannerId) } : {}),
    });
  } catch (error: any) {
    console.error("========================================");
    console.error(`[${requestId}] Instagram callback fatal error:`);
    console.error(error);
    console.error("========================================");

    return fail(error?.message || "instagram_callback_failed");
  }
}