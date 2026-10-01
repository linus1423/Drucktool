import { createFileRoute } from '@tanstack/react-router'
import { Readable } from 'node:stream'
import { getSessionUser } from '~/server/auth/session.server'
import { fileForDownload } from '~/server/files/files.server'
import { openStored } from '~/server/files/storage.server'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Download nur nach Rechteprüfung, nie über eine öffentliche URL.
export const Route = createFileRoute('/api/dateien/$fileId')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const user = await getSessionUser()
        if (!user) return new Response('Nicht angemeldet', { status: 401 })
        const file = UUID.test(params.fileId) ? await fileForDownload(user, params.fileId) : null
        if (!file) return new Response('Datei nicht gefunden', { status: 404 })
        const ascii = file.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
        return new Response(Readable.toWeb(openStored(file.storageKey)) as ReadableStream, {
          headers: {
            'Content-Type': file.pdfStatus === 'not_pdf' ? 'application/octet-stream' : 'application/pdf',
            'Content-Length': String(file.sizeBytes),
            'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, no-store',
          },
        })
      },
    },
  },
})
