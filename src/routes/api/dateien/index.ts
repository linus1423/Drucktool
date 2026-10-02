import { createFileRoute } from '@tanstack/react-router'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebStream } from 'node:stream/web'
import { assertRateLimit } from '~/server/auth/rate-limit.server'
import { getSessionUser } from '~/server/auth/session.server'
import { AttachmentTypeError, EmptyUploadError, createUpload, uploadLimit } from '~/server/files/files.server'
import { UploadTooLargeError } from '~/server/files/storage.server'
import { logger } from '~/server/log.server'
import { VirusFoundError, VirusScanUnavailableError } from '~/server/files/virus-scan.server'

const json = (body: unknown, status = 200) => Response.json(body, { status })

// Upload als Rohdaten (kein Multipart): POST /api/dateien?rolle=main|cover|attachment&name=datei.pdf
export const Route = createFileRoute('/api/dateien/')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const user = await getSessionUser()
        if (!user) return json({ error: 'Nicht angemeldet' }, 401)
        try {
          await assertRateLimit('upload', 60, 60 * 60 * 1000, user.id)
        } catch (e) {
          return json({ error: (e as Error).message }, 429)
        }
        const url = new URL(request.url)
        const role = url.searchParams.get('rolle')
        if (role !== 'main' && role !== 'cover' && role !== 'attachment') return json({ error: 'Unbekannte Dateirolle' }, 400)
        const length = Number(request.headers.get('content-length') ?? 0)
        if (length > uploadLimit(role)) return json({ error: new UploadTooLargeError(uploadLimit(role)).message }, 413)
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
          if (e instanceof EmptyUploadError || e instanceof AttachmentTypeError) return json({ error: e.message }, 400)
          if (e instanceof VirusFoundError) return json({ error: e.message }, 422)
          if (e instanceof VirusScanUnavailableError) return json({ error: e.message }, 503)
          logger.error('Upload fehlgeschlagen', { err: e })
          return json({ error: 'Die Datei konnte nicht gespeichert werden.' }, 500)
        }
      },
    },
  },
})
