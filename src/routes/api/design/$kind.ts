import { createFileRoute } from '@tanstack/react-router'
import { LOGO_KINDS, type LogoKind } from '~/lib/design'
import { getLogo } from '~/server/design/design.server'

// Logo und Favicon aus der Design-Seite (Issue #188). Öffentlich, weil Login-Seite und E-Mails sie ohne Anmeldung
// zeigen. Die URLs tragen einen Versionsparameter, deshalb darf der Browser lange zwischenspeichern.
export const Route = createFileRoute('/api/design/$kind')({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const kind = LOGO_KINDS.includes(params.kind as LogoKind) ? (params.kind as LogoKind) : null
        const logo = kind ? await getLogo(kind) : null
        if (!logo) return new Response('Nicht gefunden', { status: 404 })
        const versioned = new URL(request.url).searchParams.has('v')
        return new Response(new Uint8Array(logo.bytes), {
          headers: {
            'Content-Type': logo.type,
            'Content-Length': String(logo.bytes.length),
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
            // SVG kann Skripte enthalten. Als Bild eingebunden laufen sie nie; ruft jemand die Datei direkt auf,
            // verhindert die Sandbox, dass sie im Kontext der App laufen.
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            // E-Mail-Programme im Browser laden das Logo von einer anderen Adresse.
            'Cross-Origin-Resource-Policy': 'cross-origin',
          },
        })
      },
    },
  },
})
