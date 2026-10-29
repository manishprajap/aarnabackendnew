/**
 * Single source of truth for CORS.
 * Origin ko sirf allowlist se echo karte hain, '*' kabhi nahi
 * (credentials/cookies ke saath '*' browser reject karta hai).
 */
const ALLOWED_ORIGINS = [
  'http://localhost:8100',   // ionic serve (browser dev)
  'http://localhost:5173',   // Vite browser dev
  'https://localhost',       // Capacitor Android (v6+ default)
  'http://localhost',        // Capacitor Android (androidScheme: 'http' / purane versions)
  'capacitor://localhost',   // Capacitor iOS
  'ionic://localhost',       // purana Ionic iOS
  'https://aarnexai.com',    // production web app
  'https://www.aarnexai.com',
];

export function corsHeaders(origin?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, Accept, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }

  return headers;
}