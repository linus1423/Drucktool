import { createFileRoute } from '@tanstack/react-router'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebStream } from 'node:stream/web'
import { assertRateLimit } from '~/server/auth/rate-limit.server'
import { getSessionUser } from '~/server/auth/session.server'
import { EmptyUploadError, createUpload } from '~/server/files/files.server'
import { UploadTooLargeError, maxUploadBytes } from '~/server/files/storage.server'

const json = (body: unknown, status = 200) => Response.json(body, { status })

// Upload der Druckdaten als Rohdaten (kein Multipart): POST /api/dateien?rolle=main&name=datei.pdf
export const Route = createFileRoute('/api/dateien/')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const user = await getSessionUser()
        if (!user) return json({ error: 'Nicht angemeldet' }, 401)
        try {
          assertRateLimit('upload', 60, 60 * 60 * 1000, user.id)
        } catch (e) {
          return json({ error: (e as Error).message }, 429)
        }
        const url = new URL(request.url)
        const role = url.searchParams.get('rolle')
        if (role !== 'main' && role !== 'cover') return json({ error: 'Unbekannte Dateirolle' }, 400)
        const length = Number(request.headers.get('content-length') ?? 0)
        if (length > maxUploadBytes()) return json({ error: new UploadTooLargeError(maxUploadBytes()).message }, 413)
        if (!request.body) return json({ error: 'Die Datei ist leer.' }, 400)

        try {
          const file = await createUpload(user, {
            role,
            filename: url.searchParams.get('name') ?? 'datei.pdf',
            mimeType: request.headers.get('content-type') ?? 'application/octet-stream',
            body: Readable.fromWeb(request.body as unknown as NodeWebStream<Uint8Array>),
          })
          return json(file, 201)
        } catch (e) {
          if (e instanceof UploadTooLargeError) return json({ error: e.message }, 413)
          if (e instanceof EmptyUploadError) return json({ error: e.message }, 400)
          console.error('Upload fehlgeschlagen', e)
          return json({ error: 'Die Datei konnte nicht gespeichert werden.' }, 500)
        }
      },
    },
  },
})
