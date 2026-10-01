import { createFileRoute } from '@tanstack/react-router'
import { sql } from 'drizzle-orm'
import { getDb } from '~/server/db/client.server'
import { getAppInfo } from '~/server/app-info'

// Für Docker-Healthchecks und Monitoring. Zeigt auch, welche Version in welcher Umgebung läuft.
export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => {
        const { version, commit, environment } = getAppInfo()
        try {
          await getDb().execute(sql`select 1`)
          return Response.json({ status: 'ok', version, commit, environment })
        } catch {
          return Response.json({ status: 'error', database: 'unreachable', version, commit, environment }, { status: 503 })
        }
      },
    },
  },
})
