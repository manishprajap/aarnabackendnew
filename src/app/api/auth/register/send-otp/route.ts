import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { z } from 'zod';

import { db } from '@/db';
import { otps, users } from '@/db/schema';

export const runtime = 'nodejs';

type EmailMessage = {
  from: string;
  to: string;
  name: string;
  otp: string;
};

function escapeHtml(value: string) {
  return value.replace(/[<>&"']/g, (character) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] || character);
}

function brandedSender(value: string) {
  const sender = value.trim();
  if (sender.includes('<')) return sender;
  return `AarnexAi <${sender}>`;
}

function getMailConfig() {
  const driver = process.env.MAIL_DRIVER?.trim().toLowerCase();
  const resendApiKey = process.env.RESEND_API_KEY?.trim();
  const resendFrom = (process.env.EMAIL_FROM || process.env.FROM_EMAIL)?.trim();
  const smtpHost = process.env.MAIL_HOST?.trim();
  const smtpPort = Number(process.env.MAIL_PORT || 587);
  const smtpUser = process.env.MAIL_USERNAME?.trim();
  const smtpPassword = process.env.MAIL_PASSWORD?.trim();
  const smtpEncryption = process.env.MAIL_ENCRYPTION?.trim().toLowerCase();
  const smtpFrom = (process.env.FROM_EMAIL || process.env.EMAIL_FROM)?.trim();
  const smtpConfigured = Boolean(
    smtpHost && Number.isInteger(smtpPort) && smtpPort > 0 && smtpPort <= 65535 &&
    smtpUser && smtpPassword && smtpFrom
  );

  if (driver === 'smtp') {
    return smtpConfigured
      ? { driver: 'smtp' as const, host: smtpHost!, port: smtpPort, user: smtpUser!, password: smtpPassword!, encryption: smtpEncryption || 'tls', from: brandedSender(smtpFrom!) }
      : null;
  }
  if (driver && driver !== 'resend') return null;
  if (driver === 'resend' || (!driver && resendApiKey && resendFrom)) {
    return resendApiKey && resendFrom
      ? { driver: 'resend' as const, apiKey: resendApiKey, from: brandedSender(resendFrom) }
      : null;
  }
  if (!driver && smtpConfigured) {
    return { driver: 'smtp' as const, host: smtpHost!, port: smtpPort, user: smtpUser!, password: smtpPassword!, encryption: smtpEncryption || 'tls', from: brandedSender(smtpFrom!) };
  }
  return null;
}

async function sendSmtpEmail(config: Extract<NonNullable<ReturnType<typeof getMailConfig>>, { driver: 'smtp' }>, message: EmailMessage) {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.encryption === 'ssl' || config.port === 465,
    requireTLS: config.encryption === 'tls',
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  await transporter.sendMail({
    from: message.from,
    to: message.to,
    subject: 'Your AarnexAi verification code',
    text: `Hello ${message.name},\n\nYour AarnexAi verification code is ${message.otp}. It expires in 5 minutes. If you did not request this code, you can ignore this email.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#0f2a4a"><h2>Verify your AarnexAi account</h2><p>Hello ${escapeHtml(message.name)},</p><p>Use this one-time code to verify your email:</p><div style="font-size:32px;font-weight:700;letter-spacing:8px;padding:18px;background:#f0f7ff;border-radius:12px;text-align:center">${message.otp}</div><p>This code expires in 5 minutes. If you did not request it, ignore this email.</p></div>`,
  });
}

async function sendResendEmail(config: Extract<NonNullable<ReturnType<typeof getMailConfig>>, { driver: 'resend' }>, message: EmailMessage) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: message.from,
      to: [message.to],
      subject: 'Your AarnexAi verification code',
      text: `Hello ${message.name},\n\nYour AarnexAi verification code is ${message.otp}. It expires in 5 minutes. If you did not request this code, you can ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#0f2a4a"><h2>Verify your AarnexAi account</h2><p>Hello ${escapeHtml(message.name)},</p><p>Use this one-time code to verify your email:</p><div style="font-size:32px;font-weight:700;letter-spacing:8px;padding:18px;background:#f0f7ff;border-radius:12px;text-align:center">${message.otp}</div><p>This code expires in 5 minutes. If you did not request it, ignore this email.</p></div>`,
    }),
    cache: 'no-store',
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    console.error('[Registration OTP] Resend rejected send request:', {
      status: response.status,
      details: details.slice(0, 500),
    });
    throw new Error('Email provider rejected the send request.');
  }
}

const schema = z.object({
  name: z.string().trim().min(2).max(191),
  mobile: z.string().trim().regex(/^[6-9]\d{9}$/),
  email: z.string().trim().email().max(191),
});

export async function POST(request: NextRequest) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, message: parsed.error.issues[0]?.message || 'Enter valid account details.' },
      { status: 400 },
    );
  }

  const name = parsed.data.name;
  const mobile = parsed.data.mobile;
  const email = parsed.data.email.toLowerCase();

  try {
    const [existing] = await db.select({ id: users.id })
      .from(users)
      .where(eq(users.mobile, mobile))
      .limit(1);
    if (existing) {
      return NextResponse.json(
        { success: false, message: 'This mobile number already has an account. Sign in with mobile OTP.' },
        { status: 409 },
      );
    }

    const [emailOwner] = await db.select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (emailOwner) {
      return NextResponse.json(
        { success: false, message: 'This email is already registered. Sign in or use another email.' },
        { status: 409 },
      );
    }

    const mailConfig = getMailConfig();
    if (process.env.NODE_ENV === 'production' && !mailConfig) {
      console.error('[Registration OTP] Configure MAIL_DRIVER and its required server-side email settings.');
      return NextResponse.json(
        { success: false, message: 'Email verification is temporarily unavailable. Please contact support.' },
        { status: 503 },
      );
    }

    const otp = String(randomInt(100000, 1000000));
    const [inserted] = await db.insert(otps).values({
      mobile,
      email,
      otp,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    const otpId = inserted.insertId;

    if (!mailConfig) {
      return NextResponse.json({
        success: true,
        message: 'Verification code created for development.',
        ...(process.env.NODE_ENV !== 'production' ? { devOtp: otp } : {}),
      });
    }

    try {
      const message = {
        from: mailConfig.from,
        to: email,
        name,
        otp,
      };
      if (mailConfig.driver === 'smtp') {
        await sendSmtpEmail(mailConfig, message);
      } else {
        await sendResendEmail(mailConfig, message);
      }
    } catch (mailError) {
      console.error('[Registration OTP] Email delivery failed:', mailError);
      await db.delete(otps).where(eq(otps.id, otpId));
      return NextResponse.json(
        { success: false, message: 'Could not send the verification email. Check the address and try again.' },
        { status: 502 },
      );
    }

    return NextResponse.json({ success: true, message: 'Verification code sent to your email.' });
  } catch (error) {
    const failure = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    const cause = failure.cause && typeof failure.cause === 'object'
      ? failure.cause as Record<string, unknown>
      : {};
    console.error('[Registration OTP] Could not send verification code:', {
      code: cause.code ?? failure.code ?? 'UNKNOWN',
      message: cause.sqlMessage ?? cause.message ?? failure.message ?? 'Unknown database or email error',
    });
    return NextResponse.json(
      { success: false, message: 'Could not send the verification code. Please try again.' },
      { status: 500 },
    );
  }
}
