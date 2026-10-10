import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';

const JWT_EXPIRES_IN = '30d';

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('JWT_SECRET is not set in your environment variables.');
  }

  return secret;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export interface JwtPayload {
  userId: number;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): JwtPayload | null {
  const secret = getJwtSecret();

  try {
    return jwt.verify(token, secret) as JwtPayload;
  } catch {
    return null;
  }
}

// ==================================================
// Request helper for API routes (used by the subscription endpoints).
// Reads `Authorization: Bearer <token>`, verifies it with the same
// verifyToken() above, and returns the userId or throws AuthError.
// ==================================================

export class AuthError extends Error {}

export function getUserIdFromRequest(req: NextRequest): number {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    throw new AuthError('Missing bearer token');
  }

  const payload = verifyToken(token);

  if (!payload) {
    throw new AuthError('Invalid or expired token');
  }

  return payload.userId;
}