import { createFileRoute } from '@tanstack/react-router'
import { isAdminRole } from '~/lib/roles'
import { getSessionUser } from '~/server/auth/session.server'
import { exportUserData } from '~/server/privacy/privacy.server'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Datenauskunft (Art. 15 DSGVO) als JSON-Datei, nur für Admins. Jeder Abruf steht im Audit-Log.
export const Route = createFileRoute('/api/admin/datenauskunft/$userId')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const user = await getSessionUser()
        if (!user) return new Response('Nicht angemeldet', { status: 401 })
        if (!isAdminRole(user.role)) return new Response('Keine Berechtigung', { status: 403 })
        if (!UUID.test(params.userId)) return new Response('Benutzer nicht gefunden', { status: 404 })
        try {
          const data = await exportUserData(user, params.userId)
          const date = data.exportedAt.slice(0, 10)
          return new Response(JSON.stringify(data, null, 2), {
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Disposition': `attachment; filename="datenauskunft-${params.userId}-${date}.json"`,
              'Cache-Control': 'private, no-store',
            },
          })
        } catch (e) {
          return new Response((e as Error).message, { status: 404 })
        }
      },
    },
  },
})
