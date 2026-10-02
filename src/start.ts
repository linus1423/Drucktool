import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start'
import { z } from 'zod'
import { createNonce, isHttps, securityHeaders, withSecurityHeaders } from './server/security-headers'
import { errorMiddleware, requestLogMiddleware } from './server/middleware'

// Zod-Meldungen ohne eigenen Text auf Deutsch, auf Server und Client (Issue #117).
z.config(z.locales.de())

// Setzt CSP, HSTS und weitere Security-Header auf jede Antwort. Der Nonce wird über den
// Kontext an den Router weitergegeben (siehe router.tsx), der ihn an seine Inline-Skripte hängt.
// Im Vite-Dev-Server ohne CSP, weil dessen HMR-Skripte keinen Nonce tragen.
const securityHeadersMiddleware = createMiddleware().server(async ({ next }) => {
  const nonce = createNonce()
  const result = await next({ context: { nonce } })
  const headers = securityHeaders({ nonce, https: isHttps(), csp: process.env.NODE_ENV === 'production' })
  return { ...result, response: withSecurityHeaders(result.response, headers) }
})

// Schützt alle schreibenden Anfragen (Server-Funktionen, Formulare, Uploads) vor Cross-Site-Requests:
// Sec-Fetch-Site muss "same-origin" sein, ältere Browser ohne diesen Header müssen einen Origin
// (oder Referer) der App mitschicken. Hinter einem Proxy zählt die Adresse aus APP_URL.
function appOrigin() {
  try {
    return process.env.APP_URL ? new URL(process.env.APP_URL).origin : undefined
  } catch {
    return undefined
  }
}

const csrf = createCsrfMiddleware({
  filter: ({ request }) => request.method !== 'GET' && request.method !== 'HEAD',
  origin: (origin: string, { request }: { request: Request }) => origin === new URL(request.url).origin || origin === appOrigin(),
})

export const startInstance = createStart(() => ({
  // Zuerst die Request-ID, damit alle Logeinträge der Anfrage sie tragen.
  requestMiddleware: [requestLogMiddleware, securityHeadersMiddleware, csrf],
  functionMiddleware: [errorMiddleware],
}))
