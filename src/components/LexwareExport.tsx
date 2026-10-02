// Download der Importdatei für Lexware (Issue #53). Der Export markiert Aufträge als übergeben, daher POST statt Link.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { formatRequestNumber } from '~/lib/format'
import { pendingLexwareQuery } from '~/lib/queries'
import { Alert, Button } from './ui'

async function download(ids?: string[]) {
  const res = await fetch('/api/rechnungen/lexware', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ids ? { ids } : {}),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? 'Der Export ist fehlgeschlagen.')
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'lexware.xml'
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  const skipped = (res.headers.get('x-skipped-numbers') ?? '').split(',').filter(Boolean).map(Number)
  return { count: Number(res.headers.get('x-exported-count') ?? 0), skipped }
}

export function LexwareExportButton({
  ids,
  label,
  variant = 'secondary',
  disabled,
  onDone,
}: {
  ids?: string[]
  label: string
  variant?: 'primary' | 'secondary'
  disabled?: boolean
  onDone?: () => void
}) {
  const queryClient = useQueryClient()
  const [done, setDone] = useState<{ count: number; skipped: number[] } | null>(null)
  const mutation = useMutation({
    mutationFn: () => download(ids),
    onSuccess: async (result) => {
      setDone(result)
      onDone?.()
      await queryClient.invalidateQueries({ queryKey: ['requests'] })
    },
  })
  return (
    <div className="space-y-2">
      <Button variant={variant} disabled={disabled || mutation.isPending} onClick={() => mutation.mutate()}>
        {mutation.isPending ? 'Wird erstellt …' : label}
      </Button>
      {mutation.error ? <Alert>{mutation.error.message}</Alert> : null}
      {done != null && !mutation.error ? (
        <Alert tone="success">
          {done.count === 1 ? '1 Auftrag' : `${done.count} Aufträge`} exportiert. Die Datei in Lexware über die Shopschnittstelle
          importieren.
        </Alert>
      ) : null}
      {done && done.skipped.length > 0 && !mutation.error ? (
        <Alert>
          Nicht übergeben, weil Rechnungsadresse oder Preis fehlen: {done.skipped.map(formatRequestNumber).join(', ')}. Bitte von
          Hand in Lexware erfassen.
        </Alert>
      ) : null}
    </div>
  )
}

/** Hinweis in der Auftragsliste für Mitarbeiter, solange fertige Aufträge auf die Rechnung warten. */
export function LexwarePending() {
  const { data: pending } = useQuery(pendingLexwareQuery)
  const [shown, setShown] = useState(false)
  if (!pending && !shown) return null
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-md bg-white px-4 py-3 text-sm ring-1 ring-slate-200">
      <p className="py-2">
        {pending
          ? `${pending === 1 ? '1 fertiger Auftrag wartet' : `${pending} fertige Aufträge warten`} auf die Rechnung in Lexware.`
          : 'Alle fertigen Aufträge sind an Lexware übergeben.'}
      </p>
      <LexwareExportButton label="Für Lexware exportieren" disabled={!pending} onDone={() => setShown(true)} />
    </div>
  )
}
