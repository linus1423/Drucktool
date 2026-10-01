// Security-Header für alle Antworten der App (Issue #24). Gilt auch ohne Reverse Proxy.
// Keine Node-Importe: die Datei wird von src/start.ts eingebunden.

/** Läuft die App hinter HTTPS? Dieselbe Regel wie für das Secure-Flag der Cookies. */
export function isHttps() {
  if (process.env.COOKIE_SECURE) return process.env.COOKIE_SECURE !== 'false'
  return process.env.NODE_ENV === 'production'
}

/** Zufälliger Nonce pro Antwort für die Inline-Skripte von TanStack Start (Hydration). */
export function createNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
}

/**
 * Content-Security-Policy. Skripte nur vom eigenen Server oder mit dem Nonce dieser Antwort.
 * Inline-Styles in style-Attributen (z. B. der Fortschrittsbalken beim Upload) sind erlaubt,
 * style-Elemente brauchen dagegen ebenfalls den Nonce.
 */
export function contentSecurityPolicy(nonce: string) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

export function securityHeaders(options: { nonce: string; https: boolean; csp: boolean }): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  }
  if (options.csp) headers['Content-Security-Policy'] = contentSecurityPolicy(options.nonce)
  // HSTS nur mit HTTPS, sonst wäre die App lokal nicht mehr per http erreichbar.
  if (options.https) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
  return headers
}

/** Setzt die Header auf eine Antwort. Unveränderliche Header (z. B. bei Redirects) werden kopiert. */
export function withSecurityHeaders(response: Response, headers: Record<string, string>): Response {
  try {
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
    return response
  } catch {
    const copy = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    })
    for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value)
    return copy
  }
}
