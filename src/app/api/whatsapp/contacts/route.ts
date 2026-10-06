// src/app/api/whatsapp/contacts/route.ts
//
//   GET     /whatsapp/contacts            -> list this user's contacts
//   POST    /whatsapp/contacts            -> add one or many contacts
//   PUT     /whatsapp/contacts            -> { id, isActive } turn a contact on/off
//   DELETE  /whatsapp/contacts?id=123     -> remove a contact
//
// Saves into `whatsapp_contacts`:
//   user_id, wa_id, name, phone_number, is_active, metadata
// (id, created_at, updated_at are filled in by the database.)
//
// Every query is scoped to the logged-in user.

import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { whatsappConnections, whatsappContacts } from '@/db/schema';
import { getUserIdFromRequest, AuthError } from '@/lib/auth';

const MAX_CONTACTS_PER_REQUEST = 500;

// International format, digits only, max 15 digits (E.164).
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

/* =========================================================
   HELPERS
========================================================= */

function authFailure(error: unknown) {
  if (error instanceof AuthError) {
    return NextResponse.json(
      { success: false, message: error.message },
      { status: 401 }
    );
  }
  return null;
}

/**
 * "+91 98765-43210", "098765 43210", "9876543210"  ->  "919876543210"
 * A 10-digit number gets the default country code. Returns null if the
 * result can't be a valid number.
 */
function normalizePhone(raw: unknown, defaultCountryCode: string): string | null {
  let digits = String(raw ?? '').replace(/\D/g, '');

  if (digits.startsWith('00')) digits = digits.slice(2);

  if (digits.length === 10 && defaultCountryCode) {
    digits = `${defaultCountryCode}${digits}`;
  }

  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;

  return digits;
}

// MySQL "duplicate entry" (unique key on user_id + phone_number).
function isDuplicateError(error: any): boolean {
  const code = error?.code ?? error?.cause?.code;
  const errno = error?.errno ?? error?.cause?.errno;
  return code === 'ER_DUP_ENTRY' || errno === 1062;
}

// The business's own WhatsApp number (the sender). WhatsApp can't send a
// message from a number to itself, so it must never be a recipient.
async function getBusinessNumber(userId: number): Promise<string | null> {
  try {
    const rows = await db
      .select({ businessPhoneNumber: whatsappConnections.businessPhoneNumber })
      .from(whatsappConnections)
      .where(eq(whatsappConnections.userId, userId))
      .limit(1);

    const digits = String(rows[0]?.businessPhoneNumber ?? '').replace(/\D/g, '');
    return digits || null;
  } catch (error) {
    console.error('[WhatsApp Contacts] Could not read business number:', error);
    return null;
  }
}

/* =========================================================
   GET — list
========================================================= */

export async function GET(req: NextRequest) {
  try {
    let userId: number;

    try {
      userId = getUserIdFromRequest(req);
    } catch (error) {
      const res = authFailure(error);
      if (res) return res;
      throw error;
    }

    const rows = await db
      .select()
      .from(whatsappContacts)
      .where(eq(whatsappContacts.userId, userId));

    // Newest first.
    rows.sort((a: any, b: any) => Number(b.id) - Number(a.id));

    return NextResponse.json({
      success: true,
      total: rows.length,
      activeCount: rows.filter((r: any) => r.isActive).length,
      contacts: rows,
    });
  } catch (error) {
    console.error('[WhatsApp Contacts] List failed:', error);
    return NextResponse.json(
      { success: false, message: 'Could not load contacts' },
      { status: 500 }
    );
  }
}

/* =========================================================
   POST — add one or many
   Body: {
     contacts: [{ name?: string, phoneNumber: string }, ...],
     consent: true,
     defaultCountryCode?: "91"
   }
   A single { name, phoneNumber, consent } body also works.
========================================================= */

export async function POST(req: NextRequest) {
  try {
    let userId: number;

    try {
      userId = getUserIdFromRequest(req);
    } catch (error) {
      const res = authFailure(error);
      if (res) return res;
      throw error;
    }

    const body = await req.json().catch(() => null);

    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { success: false, message: 'Invalid request body' },
        { status: 400 }
      );
    }

    // Marketing messages must only go to people who agreed to receive them.
    if (body.consent !== true) {
      return NextResponse.json(
        {
          success: false,
          message:
            'Confirm that these contacts agreed to receive WhatsApp messages from you.',
        },
        { status: 400 }
      );
    }

    const defaultCountryCode = String(body.defaultCountryCode ?? '91').replace(
      /\D/g,
      ''
    );

    const incoming: { name?: unknown; phoneNumber?: unknown }[] = Array.isArray(
      body.contacts
    )
      ? body.contacts
      : body.phoneNumber
        ? [{ name: body.name, phoneNumber: body.phoneNumber }]
        : [];

    if (incoming.length === 0) {
      return NextResponse.json(
        { success: false, message: 'Add at least one phone number.' },
        { status: 400 }
      );
    }

    if (incoming.length > MAX_CONTACTS_PER_REQUEST) {
      return NextResponse.json(
        {
          success: false,
          message: `Add up to ${MAX_CONTACTS_PER_REQUEST} contacts at a time.`,
        },
        { status: 400 }
      );
    }

    const businessNumber = await getBusinessNumber(userId);

    /* Validate + de-duplicate within the request */

    const valid = new Map<string, { phoneNumber: string; name: string | null }>();
    const invalid: string[] = [];
    let usedOwnNumber = false;

    for (const item of incoming) {
      const rawPhone = String(item?.phoneNumber ?? '').trim() || '(empty)';
      const phoneNumber = normalizePhone(item?.phoneNumber, defaultCountryCode);

      if (!phoneNumber) {
        invalid.push(rawPhone);
        continue;
      }

      if (businessNumber && phoneNumber === businessNumber) {
        usedOwnNumber = true;
        invalid.push(rawPhone);
        continue;
      }

      if (!valid.has(phoneNumber)) {
        const name = String(item?.name ?? '').trim().slice(0, 191);
        valid.set(phoneNumber, { phoneNumber, name: name || null });
      }
    }

    if (valid.size === 0) {
      return NextResponse.json(
        {
          success: false,
          message: usedOwnNumber
            ? "That is your own WhatsApp Business number. Add your customers' numbers instead."
            : 'None of the phone numbers look valid. Use the country code, for example 919876543210.',
          invalid,
        },
        { status: 400 }
      );
    }

    /* Skip numbers this user already has */

    const existingRows = await db
      .select({ phoneNumber: whatsappContacts.phoneNumber })
      .from(whatsappContacts)
      .where(eq(whatsappContacts.userId, userId));

    const existing = new Set(existingRows.map((r: any) => r.phoneNumber));

    const toInsert = Array.from(valid.values()).filter(
      (c) => !existing.has(c.phoneNumber)
    );

    let duplicates = valid.size - toInsert.length;
    let added = 0;
    const failed: string[] = [];

    /* Insert one by one so a single bad row never hides the others,
       and so real database errors are logged instead of swallowed. */

    for (const c of toInsert) {
      try {
        await db.insert(whatsappContacts).values({
          userId,
          // wa_id is WhatsApp's own ID for a person: their number, digits
          // only. Keeping it identical to phone_number lets an incoming
          // webhook message match this row instead of creating a second one.
          waId: c.phoneNumber,
          phoneNumber: c.phoneNumber,
          name: c.name,
          isActive: true,
          metadata: {
            source: 'manual',
            consentConfirmedAt: new Date().toISOString(),
          },
        } as any);

        added++;
      } catch (error) {
        if (isDuplicateError(error)) {
          duplicates++;
          continue;
        }

        console.error(
          '[WhatsApp Contacts] Insert failed for',
          c.phoneNumber,
          error
        );
        failed.push(c.phoneNumber);
      }
    }

    // Nothing saved because of real errors: say so instead of reporting success.
    if (added === 0 && duplicates === 0 && failed.length > 0) {
      return NextResponse.json(
        {
          success: false,
          message:
            'Contacts could not be saved. Check the server log (pm2 logs) for the database error.',
          failed,
          invalid,
        },
        { status: 500 }
      );
    }

    let message =
      added > 0
        ? `Added ${added} contact${added === 1 ? '' : 's'}.`
        : duplicates > 0
          ? 'Those numbers are already in your list.'
          : 'No contacts were added.';

    if (usedOwnNumber) {
      message += " Your own business number can't be a recipient.";
    }

    return NextResponse.json({
      success: true,
      added,
      duplicates,
      invalid,
      failed,
      message,
    });
  } catch (error) {
    console.error('[WhatsApp Contacts] Add failed:', error);
    return NextResponse.json(
      { success: false, message: 'Could not add contacts' },
      { status: 500 }
    );
  }
}

/* =========================================================
   PUT — turn a contact on/off
   Body: { id: number, isActive: boolean }
========================================================= */

export async function PUT(req: NextRequest) {
  try {
    let userId: number;

    try {
      userId = getUserIdFromRequest(req);
    } catch (error) {
      const res = authFailure(error);
      if (res) return res;
      throw error;
    }

    const body = await req.json().catch(() => null);
    const id = Number(body?.id);

    if (!Number.isFinite(id) || id <= 0 || typeof body?.isActive !== 'boolean') {
      return NextResponse.json(
        { success: false, message: 'id and isActive are required' },
        { status: 400 }
      );
    }

    await db
      .update(whatsappContacts)
      .set({ isActive: body.isActive })
      .where(
        and(eq(whatsappContacts.id, id), eq(whatsappContacts.userId, userId))
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[WhatsApp Contacts] Update failed:', error);
    return NextResponse.json(
      { success: false, message: 'Could not update contact' },
      { status: 500 }
    );
  }
}

/* =========================================================
   DELETE — remove a contact
   /whatsapp/contacts?id=123
========================================================= */

export async function DELETE(req: NextRequest) {
  try {
    let userId: number;

    try {
      userId = getUserIdFromRequest(req);
    } catch (error) {
      const res = authFailure(error);
      if (res) return res;
      throw error;
    }

    const id = Number(new URL(req.url).searchParams.get('id'));

    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json(
        { success: false, message: 'id is required' },
        { status: 400 }
      );
    }

    await db
      .delete(whatsappContacts)
      .where(
        and(eq(whatsappContacts.id, id), eq(whatsappContacts.userId, userId))
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[WhatsApp Contacts] Delete failed:', error);
    return NextResponse.json(
      { success: false, message: 'Could not delete contact' },
      { status: 500 }
    );
  }
}