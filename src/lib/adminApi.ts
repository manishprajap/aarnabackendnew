import { NextRequest, NextResponse } from 'next/server';

import { hasValidAdminSession, SESSION_COOKIE_NAME } from '@/lib/adminAuth';

export function isAdminRequest(request: NextRequest) {
  return hasValidAdminSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
}

export function adminUnauthorized() {
  return NextResponse.json(
    { success: false, message: 'Admin session expired. Please sign in again.' },
    { status: 401 }
  );
}
