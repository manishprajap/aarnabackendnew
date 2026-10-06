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

// Optional: platform-level Business ID and a system-user token that has
// catalog_management + business_management. Used only to CREATE a catalog
// when the seller's own token is not allowed to.
const PLATFORM_BUSINESS_ID = process.env.META_BUSINESS_ID || null;
const PLATFORM_CATALOG_TOKEN =
  process.env.META_CATALOG_ACCESS_TOKEN || process.env.META_SYSTEM_USER_TOKEN || null;

const BATCH_SIZE = 100;

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

/** "(#100) Missing Permission", OAuthException 10, or the 200-299 permission range. */
function isPermissionError(error: unknown): boolean {
  if (!(error instanceof MetaError)) return false;
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

function metaErrorResponse(error: unknown, fallback: string) {
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

    // Business that owns this seller's WABA. Each seller can belong to a different
    // business, so the catalog has to be created in that business.
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

    const businessId = ownerBusinessId || PLATFORM_BUSINESS_ID;

    // The platform system-user token has partner access to every connected seller WABA,
    // so prefer it for catalog calls and fall back to the seller's own token.
    const catalogToken = PLATFORM_CATALOG_TOKEN || accessToken;

    /* ---- Make sure the catalog exists on Meta ---- */

    let metaCatalogId: string | null = manualMetaCatalogId || catalog.metaCatalogId || null;

    // 1) Reuse a catalog that is already linked to the seller's WABA.
    if (!metaCatalogId && wabaId) {
      try {
        const linked = await graphRequest(
          "GET",
          `${wabaId}/product_catalogs?fields=id,name&limit=10`,
          accessToken
        );
        const first = Array.isArray(linked?.data) ? linked.data[0] : null;
        if (first?.id) metaCatalogId = String(first.id);
      } catch (error) {
        // Not fatal: fall through to creating a catalog.
        console.error("[Catalog Sync] could not list WABA catalogs", error);
      }
    }

    // 2) Create a new catalog on Meta.
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
        console.error("[Catalog Sync] catalog creation failed", error);
        return metaErrorResponse(error, "Could not create the catalog on Meta.");
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

        const message = isPermissionError(error)
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
    });
  } catch (error) {
    console.error("[WhatsApp Catalog Sync]", error);

    return NextResponse.json(
      { success: false, message: "Failed to sync catalog" },
      { status: 500 }
    );
  }
}