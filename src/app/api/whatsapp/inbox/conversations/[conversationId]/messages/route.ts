import {
  NextRequest,
  NextResponse,
} from "next/server";

import { db } from "@/db";

import {
  whatsappMessages,
  whatsappConversations,
} from "@/db/schema";

import {
  eq,
  and,
  asc,
} from "drizzle-orm";

import {
  getUserIdFromRequest,
} from "@/lib/auth";


export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{
      conversationId: string;
    }>;
  }
) {
  try {
    const userId =
      await getUserIdFromRequest(request);

    if (!userId) {
      return NextResponse.json(
        {
          success: false,
          message: "Unauthorized",
        },
        { status: 401 }
      );
    }

    const {
      conversationId,
    } = await context.params;

    const conversationIdNumber =
      Number(conversationId);

    const [conversation] =
      await db
        .select({
          id:
            whatsappConversations.id,
        })
        .from(
          whatsappConversations
        )
        .where(
          and(
            eq(
              whatsappConversations.id,
              conversationIdNumber
            ),
            eq(
              whatsappConversations.userId,
              userId
            )
          )
        )
        .limit(1);

    if (!conversation) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Conversation not found",
        },
        { status: 404 }
      );
    }

    const messages =
      await db
        .select()
        .from(whatsappMessages)
        .where(
          and(
            eq(
              whatsappMessages.conversationId,
              conversationIdNumber
            ),
            eq(
              whatsappMessages.userId,
              userId
            )
          )
        )
        .orderBy(
          asc(
            whatsappMessages.createdAt
          )
        );

    return NextResponse.json({
      success: true,
      messages,
    });
  } catch (error) {
    console.error(
      "[WhatsApp Messages GET]",
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          "Failed to load messages",
      },
      { status: 500 }
    );
  }
}