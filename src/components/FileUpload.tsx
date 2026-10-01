import { useRef, useState } from 'react'
import type { PublicFile } from '~/server/files/files.server'
import { Button, cx } from './ui'

export type UploadedFile = Omit<PublicFile, 'createdAt'> & { createdAt: string | Date }

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`
}

/** Lädt eine Datei als Rohdaten hoch; XHR statt fetch, damit der Fortschritt sichtbar ist. */
function upload(file: File, role: 'main' | 'cover', onProgress: (p: number) => void) {
  return new Promise<UploadedFile>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/dateien?rolle=${role}&name=${encodeURIComponent(file.name)}`)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onload = () => {
      let body: unknown = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        // leer
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as UploadedFile)
      else reject(new Error((body as { error?: string } | null)?.error ?? 'Der Upload ist fehlgeschlagen.'))
    }
    xhr.onerror = () => reject(new Error('Der Upload ist fehlgeschlagen. Bitte die Verbindung prüfen.'))
    xhr.send(file)
  })
}

export function FileUpload({
  role,
  value,
  onChange,
  label,
}: {
  role: 'main' | 'cover'
  value: UploadedFile | null
  onChange: (file: UploadedFile | null) => void
  label: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const start = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    setProgress(0)
    try {
      onChange(await upload(file, role, setProgress))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setProgress(null)
      if (input.current) input.current.value = ''
    }
  }

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void start(e.dataTransfer.files[0])
        }}
        className={cx(
          'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm',
          dragging ? 'border-slate-900 bg-slate-50' : 'border-slate-300',
        )}
      >
        {value ? (
          <div className="space-y-1">
            <p className="font-medium text-slate-900">{value.filename}</p>
            <p className="text-slate-500">
              {formatBytes(value.sizeBytes)}
              {value.pageCount != null ? ` · ${value.pageCount} ${value.pageCount === 1 ? 'Seite' : 'Seiten'}` : ''}
              {value.pageWidthMm && value.pageHeightMm ? ` · ${value.pageWidthMm} × ${value.pageHeightMm} mm` : ''}
            </p>
          </div>
        ) : (
          <p className="text-slate-600">{label}: PDF hierher ziehen oder auswählen.</p>
        )}
        {progress != null ? (
          <div
            className="h-2 w-full max-w-xs overflow-hidden rounded bg-slate-200"
            role="progressbar"
            aria-valuenow={Math.round(progress * 100)}
          >
            <div className="h-full bg-slate-900 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        ) : (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => input.current?.click()}>
              {value ? 'Andere Datei wählen' : 'Datei auswählen'}
            </Button>
            {value ? (
              <Button variant="ghost" onClick={() => onChange(null)}>
                Entfernen
              </Button>
            ) : null}
          </div>
        )}
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          aria-label={label}
          onChange={(e) => void start(e.target.files?.[0])}
        />
      </div>
      {error ? <p className="text-sm text-rose-600">{error}</p> : null}
    </div>
  )
}
