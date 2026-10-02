import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { isStaffRole } from '~/lib/roles'
import { getSessionUser } from '~/server/auth/session.server'
import { exportForLexware, LexwareExportError } from '~/server/invoices/lexware.server'
import { logger } from '~/server/log.server'

const bodySchema = z.object({ ids: z.array(z.uuid()).min(1).max(500).optional() })

// Importdatei für Lexware (Issue #53). POST, weil der Export die Aufträge als übergeben markiert.
// Ohne ids alle fertigen, noch nicht übergebenen Aufträge, mit ids genau diese (erneuter Export).
export const Route = createFileRoute('/api/rechnungen/lexware')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const user = await getSessionUser()
        if (!user) return Response.json({ error: 'Nicht angemeldet' }, { status: 401 })
        if (!isStaffRole(user.role)) return Response.json({ error: 'Keine Berechtigung' }, { status: 403 })
        const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
        if (!parsed.success) return Response.json({ error: 'Ungültige Auswahl' }, { status: 400 })
        try {
          const result = await exportForLexware(user.id, parsed.data.ids)
          if (!result.count) return Response.json({ error: 'Keine fertigen Aufträge zu übergeben.' }, { status: 404 })
          logger.info('Aufträge für Lexware exportiert', { userId: user.id, numbers: result.numbers })
          const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date())
          const name = result.count === 1 ? `lexware-auftrag-${result.numbers[0]}.xml` : `lexware-auftraege-${day}.xml`
          return new Response(result.xml, {
            headers: {
              'Content-Type': 'application/xml; charset=utf-8',
              'Content-Disposition': `attachment; filename="${name}"`,
              'X-Content-Type-Options': 'nosniff',
              'Cache-Control': 'private, no-store',
              'X-Exported-Count': String(result.count),
            },
          })
        } catch (e) {
          if (e instanceof LexwareExportError) return Response.json({ error: e.message }, { status: 422 })
          throw e
        }
      },
    },
  },
})
