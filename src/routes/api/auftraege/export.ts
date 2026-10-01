import { createFileRoute } from '@tanstack/react-router'
import { getSessionUser } from '~/server/auth/session.server'
import { requestsCsv } from '~/server/requests/export.server'
import { listFilterSchema } from '~/server/requests/requests.server'

// Export der gefilterten Auftragsliste als CSV. Die Filter kommen als JSON im Parameter "filter".
export const Route = createFileRoute('/api/auftraege/export')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await getSessionUser()
        if (!user) return new Response('Nicht angemeldet', { status: 401 })
        let raw: unknown = {}
        try {
          raw = JSON.parse(new URL(request.url).searchParams.get('filter') ?? '{}')
        } catch {
          return new Response('Ungültiger Filter', { status: 400 })
        }
        const parsed = listFilterSchema.omit({ page: true, pageSize: true }).safeParse(raw)
        if (!parsed.success) return new Response('Ungültiger Filter', { status: 400 })
        const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date())
        return new Response(await requestsCsv(user, parsed.data), {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="auftraege-${day}.csv"`,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, no-store',
          },
        })
      },
    },
  },
})
