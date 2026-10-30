import { asc, and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { businessCategories, customerServices, services, users } from "@/db/schema";
import { AuthError, getUserIdFromRequest } from "@/lib/auth";
import { corsHeaders } from "@/lib/cors";

export const dynamic = "force-dynamic";

function respond(request: NextRequest, data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: {
      ...corsHeaders(request.headers.get("origin")),
      "Cache-Control": "no-store",
    },
  });
}

function serviceSlug(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 210)
    .replace(/-+$/g, "") || "service";
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request.headers.get("origin")),
  });
}

export async function GET(request: NextRequest) {
  try {
    const userId = await getUserIdFromRequest(request);
    const userServiceRows = await db
      .select({
        id: services.id,
        name: services.name,
        slug: services.slug,
        description: services.description,
        status: services.status,
      })
      .from(customerServices)
      .innerJoin(services, eq(customerServices.serviceId, services.id))
      .where(eq(customerServices.customerId, userId))
      .orderBy(asc(services.name));

    return respond(request, {
      success: true,
      services: userServiceRows.map((service) => ({ ...service, id: Number(service.id) })),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return respond(request, { success: false, message: "Unauthorized" }, 401);
    }
    console.error("GET /api/business/services error:", error);
    return respond(request, { success: false, message: "Could not load services" }, 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const userId = await getUserIdFromRequest(request);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return respond(request, { success: false, message: "Invalid request body" }, 400);
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return respond(request, { success: false, message: "Invalid request body" }, 400);
    }

    const { name: nameValue, description: descriptionValue } = body as {
      name?: unknown;
      description?: unknown;
    };
    const name = typeof nameValue === "string" ? nameValue.trim() : "";
    const description = typeof descriptionValue === "string" ? descriptionValue.trim() : "";

    if (!name || name.length > 190) {
      return respond(request, { success: false, message: "Service name is required and must be 190 characters or fewer" }, 400);
    }
    if (description.length > 5000) {
      return respond(request, { success: false, message: "Description must be 5,000 characters or fewer" }, 400);
    }

    const [user] = await db
      .select({ businessCategoryId: users.businessCategoryId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const categoryId = Number(user?.businessCategoryId);
    if (!Number.isSafeInteger(categoryId) || categoryId <= 0) {
      return respond(request, { success: false, message: "Complete your business category setup before adding a service" }, 400);
    }

    const [category] = await db
      .select({ id: businessCategories.id })
      .from(businessCategories)
      .where(and(
        eq(businessCategories.id, categoryId),
        eq(businessCategories.status, "ACTIVE"),
      ))
      .limit(1);
    if (!category) {
      return respond(request, { success: false, message: "Your business category is unavailable. Update your business profile and try again." }, 400);
    }

    const slug = serviceSlug(name);
    const [existing] = await db
      .select({ id: services.id })
      .from(services)
      .where(and(
        eq(services.businessCategoryId, categoryId),
        eq(services.slug, slug),
      ))
      .limit(1);
    if (existing) {
      return respond(request, { success: false, message: "A service with this name already exists for your business category" }, 409);
    }

    const serviceId = await db.transaction(async (tx) => {
      const [insertResult] = await tx.insert(services).values({
        businessCategoryId: categoryId,
        name,
        slug,
        description: description || null,
        status: "ACTIVE",
      });
      const insertedId = Number(insertResult.insertId);
      if (!Number.isSafeInteger(insertedId) || insertedId <= 0) {
        throw new Error("Service insert did not return a valid ID");
      }

      await tx.insert(customerServices).values({
        customerId: userId,
        serviceId: insertedId,
        isPrimary: false,
      });
      return insertedId;
    });

    return respond(request, {
      success: true,
      message: "Service saved successfully",
      service: {
        id: serviceId,
        name,
        slug,
        description: description || null,
        status: "ACTIVE",
      },
    }, 201);
  } catch (error) {
    if (error instanceof AuthError) {
      return respond(request, { success: false, message: "Unauthorized" }, 401);
    }
    console.error("POST /api/business/services error:", error);
    return respond(request, { success: false, message: "Could not save this service" }, 500);
  }
}
