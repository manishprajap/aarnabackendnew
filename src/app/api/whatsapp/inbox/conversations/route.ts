import { NextRequest, NextResponse } from "next/server";

import { db } from "@/db";

import {
  whatsappConversations,
  whatsappContacts,
} from "@/db/schema";

import {
  eq,
  and,
  desc,
} from "drizzle-orm";

import { getUserIdFromRequest } from "@/lib/auth";


export async function GET(
  request: NextRequest
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

    const conversations = await db
      .select({
        id:
          whatsappConversations.id,

        status:
          whatsappConversations.status,

        lastMessageText:
          whatsappConversations.lastMessageText,

        lastMessageAt:
          whatsappConversations.lastMessageAt,

        unreadCount:
          whatsappConversations.unreadCount,

        contact: {
          id:
            whatsappContacts.id,

          waId:
            whatsappContacts.waId,

          phoneNumber:
            whatsappContacts.phoneNumber,

          name:
            whatsappContacts.name,

          profileName:
            whatsappContacts.profileName,

          avatarUrl:
            whatsappContacts.avatarUrl,
        },
      })
      .from(whatsappConversations)
      .innerJoin(
        whatsappContacts,
        eq(
          whatsappConversations.contactId,
          whatsappContacts.id
        )
      )
      .where(
        eq(
          whatsappConversations.userId,
          userId
        )
      )
      .orderBy(
        desc(
          whatsappConversations.lastMessageAt
        )
      );

    return NextResponse.json({
      success: true,
      conversations,
    });
  } catch (error) {
    console.error(
      "[WhatsApp Inbox GET]",
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          "Failed to load conversations",
      },
      { status: 500 }
    );
  }
}