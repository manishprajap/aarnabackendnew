///src/app/api/whatsapp/catalog/sync/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  whatsappProducts,
  whatsappCatalogs,
  whatsappConnections,
} from "@/db/schema";
import { eq, and } from "drizzle-orm";

import { getUserIdFromRequest } from "@/lib/auth";

export const runtime = "nodejs";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v23.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Domain root where Nginx serves /upload (same as the products route)
const MEDIA_ORIGIN =
  process.env.NEXT_PUBLIC_MEDIA_URL || "https://aarnexai.com";

// Meta requires a product "link". Used when a product has no url of its own.
const DEFAULT_PRODUCT_LINK = process.env.CATALOG_DEFAULT_LINK || MEDIA_ORIGIN;

// Platform-level Business ID and a system-user token that has
// catalog_management + business_management. When both are set, catalogs are
// created in the PLATFORM business with the PLATFORM token, then linked to the
// seller's WABA.
const PLATFORM_BUSINESS_ID = process.env.META_BUSINESS_ID || null;
const PLATFORM_CATALOG_TOKEN =
  process.env.META_CATALOG_ACCESS_TOKEN || process.env.META_SYSTEM_USER_TOKEN || null;

// Optional: only used to log which scopes a failing token really has.
const DEBUG_APP_ID =
  process.env.META_APP_ID ||
  process.env.META_FACEBOOK_APP_ID ||
  process.env.FACEBOOK_APP_ID ||
  null;
const DEBUG_APP_SECRET =
  process.env.META_APP_SECRET ||
  process.env.META_FACEBOOK_APP_SECRET ||
  process.env.FACEBOOK_APP_SECRET ||
  null;

const BATCH_SIZE = 100;

// Optional: comma-separated Meta business user IDs that are given full control of
// every catalog the backend creates, so they never see "No access" in Business settings.
const CATALOG_ADMIN_USER_IDS = (process.env.META_CATALOG_ADMIN_USER_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => /^\d+$/.test(value));

/* =========================================================
   Helpers
========================================================= */

class MetaError extends Error {
  code?: number;
  subcode?: number;

  constructor(message: string, code?: number, subcode?: number) {
    super(message);
    this.name = "MetaError";
    this.code = code;
    this.subcode = subcode;
  }
}

/** Absolute public URL, with duplicate slashes removed ("//uploads" -> "/uploads"). */
function toPublicUrl(value: string | null): string | null {
  if (!value) return null;
  const absolute = /^https?:\/\//i.test(value)
    ? value
    : `${MEDIA_ORIGIN}${value.startsWith("/") ? "" : "/"}${value}`;
  return absolute.replace(/([^:]\/)\/+/g, "$1");
}

async function graphRequest(
  method: "GET" | "POST",
  pathName: string,
  token: string,
  body?: unknown
) {
  const res = await fetch(`${GRAPH}/${pathName}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data: any = await res.json().catch(() => ({}));

  if (!res.ok || data?.error) {
    // Full Meta error body (error_user_msg, fbtrace_id, ...) for debugging.
    console.error(
      `[Catalog Sync] Graph ${method} ${pathName.split("?")[0]} failed:`,
      JSON.stringify(data?.error ?? data)
    );

    throw new MetaError(
      data?.error?.error_user_msg ||
        data?.error?.message ||
        `Meta request failed (${res.status})`,
      data?.error?.code,
      data?.error?.error_subcode
    );
  }

  return data;
}

/** True when the token can load this Meta catalog (it exists and is accessible). */
async function isCatalogUsable(metaCatalogId: string, token: string): Promise<boolean> {
  try {
    const result = await graphRequest("GET", `${metaCatalogId}?fields=id,name`, token);
    return Boolean(result?.id);
  } catch {
    return false;
  }
}

/** Logs the scopes of a token (never the token itself). Debug aid only. */
async function logTokenScopes(label: string, token: string) {
  if (!DEBUG_APP_ID || !DEBUG_APP_SECRET) return;
  try {
    const res = await fetch(
      `${GRAPH}/debug_token?input_token=${encodeURIComponent(token)}` +
        `&access_token=${encodeURIComponent(`${DEBUG_APP_ID}|${DEBUG_APP_SECRET}`)}`
    );
    const data: any = await res.json().catch(() => ({}));
    console.error(
      `[Catalog Sync] ${label} token -> type=${data?.data?.type} valid=${data?.data?.is_valid} ` +
        `scopes=${JSON.stringify(data?.data?.scopes)} ` +
        `granular=${JSON.stringify(data?.data?.granular_scopes)}`
    );
  } catch (error) {
    console.error("[Catalog Sync] debug_token failed", error);
  }
}

/**
 * Makes sure the catalog is linked to the seller's WhatsApp Business Account and that
 * the catalog icon (and cart) is switched on for the seller's number. Best effort:
 * never throws, returns what worked so the caller can report it.
 */
async function prepareWhatsAppCatalog(
  wabaId: string,
  metaCatalogId: string,
  tokens: Array<string | null | undefined>,
  phoneNumberId: string | null
): Promise<{ linked: boolean; visible: boolean; note: string }> {
  const result = { linked: false, visible: false, note: "" };
  const usableTokens = Array.from(new Set(tokens.filter((t): t is string => Boolean(t))));

  // 1) Catalog must be linked to the WABA.
  for (const token of usableTokens) {
    try {
      const linked = await graphRequest(
        "GET",
        `${wabaId}/product_catalogs?fields=id&limit=25`,
        token
      );
      const ids: string[] = (Array.isArray(linked?.data) ? linked.data : []).map((item: any) =>
        String(item?.id)
      );
      if (!ids.includes(metaCatalogId)) {
        await graphRequest("POST", `${wabaId}/product_catalogs`, token, {
          catalog_id: metaCatalogId,
        });
      }
      result.linked = true;
      break;
    } catch (error) {
      console.error("[Catalog Sync] could not confirm WABA catalog link", error);
    }
  }

  if (!result.linked) {
    result.note = "Catalog could not be linked to the WhatsApp account.";
    return result;
  }

  // 2) Show the catalog icon and cart in the WhatsApp chat.
  for (const token of usableTokens) {
    try {
      let phoneIds: string[] = phoneNumberId ? [phoneNumberId] : [];
      if (phoneIds.length === 0) {
        const phones = await graphRequest(
          "GET",
          `${wabaId}/phone_numbers?fields=id&limit=10`,
          token
        );
        phoneIds = (Array.isArray(phones?.data) ? phones.data : []).map((item: any) =>
          String(item?.id)
        );
      }
      if (phoneIds.length === 0) continue;

      for (const phoneId of phoneIds) {
        await graphRequest("POST", `${phoneId}/whatsapp_commerce_settings`, token, {
          is_catalog_visible: true,
          is_cart_enabled: true,
        });
      }
      result.visible = true;
      break;
    } catch (error) {
      console.error("[Catalog Sync] could not enable catalog visibility", error);
    }
  }

  if (!result.visible) {
    result.note = "Catalog is linked, but the catalog icon could not be enabled on WhatsApp.";
  }

  return result;
}

/** Catalog ID does not exist or the token cannot load it (code 100, subcode 33). */
function isCatalogNotFound(error: unknown): boolean {
  return error instanceof MetaError && error.code === 100 && error.subcode === 33;
}

/** "(#100) Missing Permission", OAuthException 10, or the 200-299 permission range. */
function isPermissionError(error: unknown): boolean {
  if (!(error instanceof MetaError)) return false;
  if (isCatalogNotFound(error)) return false;
  if (error.code === 10) return true;
  if (error.code !== undefined && error.code >= 200 && error.code <= 299) return true;
  return error.code === 100 && /permission/i.test(error.message);
}

/** Expired / invalid access token. */
function isTokenError(error: unknown): boolean {
  return error instanceof MetaError && error.code === 190;
}

const PERMISSION_MESSAGE =
  "Meta rejected the request: the WhatsApp access token is missing a permission. " +
  "It needs catalog_management (and business_management to create a catalog). " +
  "Reconnect WhatsApp after adding these permissions to your Meta app, " +
  "or link an existing Meta catalog by saving its ID in whatsapp_catalogs.meta_catalog_id.";

const TOKEN_MESSAGE =
  "The WhatsApp access token is invalid or expired. Please reconnect WhatsApp.";

const CATALOG_NOT_FOUND_MESSAGE =
  "The linked Meta catalog no longer exists or the platform token cannot access it. " +
  "Tap Sync Meta again to create a fresh catalog, or save a valid catalog ID in " +
  "whatsapp_catalogs.meta_catalog_id.";

function metaErrorResponse(error: unknown, fallback: string) {
  if (isCatalogNotFound(error)) {
    return NextResponse.json(
      {
        success: false,
        code: "META_CATALOG_NOT_FOUND",
        message: CATALOG_NOT_FOUND_MESSAGE,
        metaMessage: (error as MetaError).message,
      },
      { status: 400 }
    );
  }

  if (isPermissionError(error)) {
    return NextResponse.json(
      {
        success: false,
        code: "META_PERMISSION",
        message: PERMISSION_MESSAGE,
        metaMessage: (error as MetaError).message,
      },
      { status: 400 }
    );
  }

  if (isTokenError(error)) {
    return NextResponse.json(
      { success: false, code: "META_TOKEN", message: TOKEN_MESSAGE },
      { status: 400 }
    );
  }

  return NextResponse.json(
    {
      success: false,
      code: "META_ERROR",
      message: error instanceof Error && error.message ? error.message : fallback,
    },
    { status: 502 }
  );
}

/* =========================================================
   POST /api/whatsapp/catalog/sync
   Body: { catalogId, metaCatalogId? }
   - metaCatalogId (optional) links an existing Meta catalog manually.
========================================================= */

export async function POST(request: NextRequest) {
  try {
    const userId = await getUserIdFromRequest(request);

    if (!userId) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const catalogId = Number(body?.catalogId);
    const manualMetaCatalogId = String(body?.metaCatalogId ?? "").trim();

    if (!Number.isInteger(catalogId) || catalogId <= 0) {
      return NextResponse.json(
        { success: false, message: "catalogId is required" },
        { status: 400 }
      );
    }

    if (manualMetaCatalogId && !/^\d+$/.test(manualMetaCatalogId)) {
      return NextResponse.json(
        { success: false, message: "metaCatalogId must contain digits only" },
        { status: 400 }
      );
    }

    /* ---- Catalog (must belong to this user) ---- */

    const [catalog] = await db
      .select()
      .from(whatsappCatalogs)
      .where(
        and(
          eq(whatsappCatalogs.id, catalogId),
          eq(whatsappCatalogs.userId, userId)
        )
      )
      .limit(1);

    if (!catalog) {
      return NextResponse.json(
        { success: false, message: "Catalog not found" },
        { status: 404 }
      );
    }

    /* ---- WhatsApp connection (token + WABA id) ---- */

    const [connection] = await db
      .select()
      .from(whatsappConnections)
      .where(eq(whatsappConnections.userId, userId))
      .limit(1);

    if (!connection || !connection.accessToken) {
      return NextResponse.json(
        {
          success: false,
          message: "WhatsApp is not connected. Connect your WhatsApp first.",
        },
        { status: 400 }
      );
    }

    if (
      connection.status !== "active" ||
      (connection.tokenExpiresAt && connection.tokenExpiresAt.getTime() < Date.now())
    ) {
      return NextResponse.json(
        {
          success: false,
          code: "META_TOKEN",
          message: TOKEN_MESSAGE,
        },
        { status: 400 }
      );
    }

    const accessToken = connection.accessToken;
    const wabaId = connection.wabaId || null;

    // Business that owns this seller's WABA (only used when no platform token is set).
    let ownerBusinessId: string | null = null;
    if (wabaId) {
      try {
        const waba = await graphRequest(
          "GET",
          `${wabaId}?fields=owner_business_info`,
          accessToken
        );
        ownerBusinessId = waba?.owner_business_info?.id
          ? String(waba.owner_business_info.id)
          : null;
      } catch (error) {
        console.error("[Catalog Sync] could not read WABA owner business", error);
      }
    }

    // IMPORTANT: a token can only create a catalog inside a business it belongs to.
    // - Platform token + platform business  -> create in YOUR business, then link to the seller's WABA.
    // - Otherwise (seller token)             -> create in the seller's own business.
    const usingPlatformToken = Boolean(PLATFORM_CATALOG_TOKEN && PLATFORM_BUSINESS_ID);
    const businessId = usingPlatformToken
      ? PLATFORM_BUSINESS_ID
      : ownerBusinessId || PLATFORM_BUSINESS_ID;

    // The same token is used to create the catalog AND to push products, so every
    // catalog we reuse must be reachable with this token.
    const catalogToken = PLATFORM_CATALOG_TOKEN || accessToken;

    /* ---- Make sure the catalog exists on Meta ---- */

    let metaCatalogId: string | null = null;

    // 0) A manually supplied ID must be usable, otherwise tell the caller.
    if (manualMetaCatalogId) {
      if (!(await isCatalogUsable(manualMetaCatalogId, catalogToken))) {
        return NextResponse.json(
          {
            success: false,
            code: "META_CATALOG_NOT_FOUND",
            message:
              `Meta catalog ${manualMetaCatalogId} was not found or the platform token cannot access it. ` +
              "Assign the catalog to the system user with full control, then try again.",
          },
          { status: 400 }
        );
      }
      metaCatalogId = manualMetaCatalogId;
    }

    // 1) The catalog ID saved in the database. It may be stale (deleted on Meta,
    //    or owned by a business this token cannot reach), so verify it first.
    if (!metaCatalogId && catalog.metaCatalogId) {
      if (await isCatalogUsable(catalog.metaCatalogId, catalogToken)) {
        metaCatalogId = catalog.metaCatalogId;
      } else {
        console.warn(
          `[Catalog Sync] saved Meta catalog ${catalog.metaCatalogId} is not usable; ` +
            "it will be replaced."
        );
      }
    }

    // 2) Reuse a catalog already linked to the seller's WABA, if the platform token can use it.
    if (!metaCatalogId && wabaId) {
      try {
        const linked = await graphRequest(
          "GET",
          `${wabaId}/product_catalogs?fields=id,name&limit=10`,
          accessToken
        );
        const candidates: any[] = Array.isArray(linked?.data) ? linked.data : [];
        for (const candidate of candidates) {
          if (candidate?.id && (await isCatalogUsable(String(candidate.id), catalogToken))) {
            metaCatalogId = String(candidate.id);
            break;
          }
          console.warn(
            `[Catalog Sync] WABA catalog ${candidate?.id} skipped: not accessible with the catalog token`
          );
        }
      } catch (error) {
        // Not fatal: fall through to creating a catalog.
        console.error("[Catalog Sync] could not list WABA catalogs", error);
      }
    }

    // 3) Create a new catalog on Meta.
    if (!metaCatalogId) {
      if (!businessId) {
        return NextResponse.json(
          {
            success: false,
            code: "META_BUSINESS_ID_MISSING",
            message:
              "No Meta catalog is linked to this WhatsApp account and META_BUSINESS_ID is not set, " +
              "so a catalog cannot be created. Set META_BUSINESS_ID, or save an existing " +
              "Meta catalog ID in whatsapp_catalogs.meta_catalog_id.",
          },
          { status: 400 }
        );
      }

      const creationToken = catalogToken;

      try {
        const created = await graphRequest(
          "POST",
          `${businessId}/owned_product_catalogs`,
          creationToken,
          { name: catalog.name || "WhatsApp Catalog", vertical: "commerce" }
        );
        metaCatalogId = String(created.id);
      } catch (error) {
        console.error(
          `[Catalog Sync] catalog creation failed (business=${businessId}, ` +
            `platformToken=${usingPlatformToken})`,
          error
        );
        if (isPermissionError(error)) {
          await logTokenScopes(
            PLATFORM_CATALOG_TOKEN ? "platform" : "seller",
            creationToken
          );
        }
        return metaErrorResponse(error, "Could not create the catalog on Meta.");
      }

      // Give your own team full control of the new catalog (best effort)
      for (const adminUserId of CATALOG_ADMIN_USER_IDS) {
        try {
          await graphRequest("POST", `${metaCatalogId}/assigned_users`, creationToken, {
            user: adminUserId,
            tasks: ["MANAGE"],
          });
        } catch (error) {
          console.error(
            `[Catalog Sync] could not assign catalog ${metaCatalogId} to user ${adminUserId}`,
            error
          );
        }
      }

      // Link the new catalog to the WhatsApp Business Account (best effort)
      if (wabaId) {
        try {
          await graphRequest("POST", `${wabaId}/product_catalogs`, creationToken, {
            catalog_id: metaCatalogId,
          });
        } catch (error) {
          console.error("[Catalog Sync] linking catalog to WABA failed", error);
        }
      }
    }

    if (metaCatalogId !== catalog.metaCatalogId) {
      await db
        .update(whatsappCatalogs)
        .set({ metaCatalogId })
        .where(eq(whatsappCatalogs.id, catalogId));
    }

    /* ---- Link to WhatsApp and show the catalog icon (best effort) ---- */

    const connectionPhoneId =
      String(
        (connection as any).phoneNumberId ?? (connection as any).phone_number_id ?? ""
      ).trim() || null;

    let whatsappState = { linked: false, visible: false, note: "" };
    if (wabaId && metaCatalogId) {
      whatsappState = await prepareWhatsAppCatalog(
        wabaId,
        metaCatalogId,
        [catalogToken, accessToken],
        connectionPhoneId
      );
    }

    /* ---- Remove deleted products from Meta (best effort) ---- */

    let removed = 0;
    try {
      const inactiveProducts = await db
        .select()
        .from(whatsappProducts)
        .where(
          and(
            eq(whatsappProducts.catalogId, catalogId),
            eq(whatsappProducts.isActive, false)
          )
        );

      const toRemove = inactiveProducts.filter((p) => Boolean(p.retailerId));

      for (let i = 0; i < toRemove.length; i += BATCH_SIZE) {
        const chunk = toRemove.slice(i, i + BATCH_SIZE);
        try {
          await graphRequest("POST", `${metaCatalogId}/items_batch`, catalogToken, {
            allow_upsert: true,
            item_type: "PRODUCT_ITEM",
            requests: chunk.map((p) => ({
              method: "DELETE",
              data: { id: p.retailerId },
            })),
          });
          removed += chunk.length;
        } catch (error) {
          console.error("[Catalog Sync] removing deleted products failed", error);
        }
      }
    } catch (error) {
      console.error("[Catalog Sync] could not load deleted products", error);
    }

    /* ---- Products to push ---- */

    const products = await db
      .select()
      .from(whatsappProducts)
      .where(
        and(
          eq(whatsappProducts.catalogId, catalogId),
          eq(whatsappProducts.isActive, true)
        )
      );

    if (products.length === 0) {
      return NextResponse.json({
        success: true,
        message: "Catalog is linked with Meta. There are no products to sync yet.",
        synced: 0,
        failed: 0,
        removed,
        linkedToWhatsApp: whatsappState.linked,
        catalogVisible: whatsappState.visible,
        note: whatsappState.note || undefined,
      });
    }

    let synced = 0;
    let failed = 0;
    const errors: unknown[] = [];

    for (let i = 0; i < products.length; i += BATCH_SIZE) {
      const chunk = products.slice(i, i + BATCH_SIZE);

      const requests = chunk.map((p) => {
        const retailerId = p.retailerId || `prod-${p.id}`;
        const price = Number(p.price || 0).toFixed(2);

        return {
          method: "UPDATE", // with allow_upsert this creates or updates
          data: {
            id: retailerId,
            title: p.name,
            description: p.description || p.name,
            availability: p.availability || "in stock",
            condition: p.condition || "new",
            price: `${price} ${p.currency || "INR"}`,
            link: p.url || DEFAULT_PRODUCT_LINK,
            image_link: toPublicUrl(p.imageUrl),
            brand: p.brand || catalog.name || "Brand",
          },
        };
      });

      try {
        await graphRequest("POST", `${metaCatalogId}/items_batch`, catalogToken, {
          allow_upsert: true,
          item_type: "PRODUCT_ITEM",
          requests,
        });

        for (const p of chunk) {
          await db
            .update(whatsappProducts)
            .set({
              retailerId: p.retailerId || `prod-${p.id}`,
              syncStatus: "synced",
              syncError: null,
            })
            .where(eq(whatsappProducts.id, p.id));
        }
        synced += chunk.length;
      } catch (error: any) {
        console.error("[Catalog Sync] batch failed", error);
        errors.push(error);

        const message = isCatalogNotFound(error)
          ? CATALOG_NOT_FOUND_MESSAGE
          : isPermissionError(error)
            ? PERMISSION_MESSAGE
            : error?.message || "Sync failed";

        for (const p of chunk) {
          await db
            .update(whatsappProducts)
            .set({
              syncStatus: "failed",
              syncError: String(message).slice(0, 500),
            })
            .where(eq(whatsappProducts.id, p.id));
        }
        failed += chunk.length;
      }
    }

    if (synced === 0 && failed > 0) {
      const response = metaErrorResponse(errors[0], "Catalog sync failed");
      const payload = await response.json();
      return NextResponse.json(
        { ...payload, synced, failed },
        { status: response.status }
      );
    }

    return NextResponse.json({
      success: true,
      message:
        failed > 0
          ? `${synced} products sent to Meta, ${failed} failed.`
          : `${synced} products sent to Meta. Meta may take a few minutes to review them.`,
      synced,
      failed,
      removed,
      linkedToWhatsApp: whatsappState.linked,
      catalogVisible: whatsappState.visible,
      note: whatsappState.note || undefined,
    });
  } catch (error) {
    console.error("[WhatsApp Catalog Sync]", error);

    return NextResponse.json(
      { success: false, message: "Failed to sync catalog" },
      { status: 500 }
    );
  }
}