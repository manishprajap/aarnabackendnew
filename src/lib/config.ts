export const NEXT_PUBLIC_BASE_PATH =
  process.env.NEXT_PUBLIC_BASE_PATH || '/aarnexai-backend';

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL || `${NEXT_PUBLIC_BASE_PATH}/api`;

export const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL || NEXT_PUBLIC_BASE_PATH;
