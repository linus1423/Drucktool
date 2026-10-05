// Board nach Status für Mitarbeiter (Issue #16). Status lassen sich per Drag & Drop oder per Tastatur
// über das Menü an jeder Karte wechseln; beides nutzt dieselbe Server-Funktion mit Versionsprüfung.
import { useState, type DragEvent } from 'react'
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { AttentionBadge } from '~/components/AttentionBadge'
import { Alert, Badge, Button, Input, PageHeader, Select, Textarea, cx } from '~/components/ui'
import { errorMessage, isConflictError } from '~/lib/errors'
import { formatDate, formatRequestNumber } from '~/lib/format'
import { requestBoardQuery } from '~/lib/queries'
import { HANDOVER_LABELS } from '~/lib/order'
import { isStaffRole } from '~/lib/roles'
import {
  INTERNAL_STATUS_LABELS,
  INTERNAL_STATUS_TONES,
  STATUS_LABELS,
  allowedTransitions,
  transitionLabel,
  type RequestStatus,
} from '~/lib/status'
import { recordHandoverFn } from '~/server/requests/handover.functions'
import { changeStatusFn } from '~/server/requests/requests.functions'
import { pageTitle } from '~/lib/design'

const searchSchema = z.object({
  meine: z.boolean().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  bereit: z.boolean().optional().catch(undefined),
})

export const Route = createFileRoute('/_app/auftraege/board')({
  validateSearch: searchSchema,
  beforeLoad: ({ context }) => {
    if (!isStaffRole(context.user.role)) throw redirect({ to: '/auftraege' })
  },
  head: ({ match }) => ({ meta: [{ title: pageTitle('Board', match.context.design) }] }),
  component: BoardPage,
})

const COLUMNS: { status: RequestStatus; title: string; hint?: string }[] = [
  { status: 'offered', title: STATUS_LABELS.offered, hint: 'wartet auf den Kunden' },
  { status: 'submitted', title: STATUS_LABELS.submitted },
  { status: 'on_hold', title: STATUS_LABELS.on_hold },
  { status: 'confirmed', title: STATUS_LABELS.confirmed },
  { status: 'completed', title: STATUS_LABELS.completed, hint: 'letzte 14 Tage' },
]
const BOARD_SET = new Set<RequestStatus>(COLUMNS.map((c) => c.status))

type Board = Awaited<ReturnType<NonNullable<ReturnType<typeof requestBoardQuery>['queryFn']>>>
type Card = Board['rows'][number]
type Move = { card: Card; to: RequestStatus }

/** Ziele, die vom Board aus erreichbar sind (Ablehnen und Stornieren gehen über die Detailseite). */
function boardTargets(card: Card) {
  return allowedTransitions(card.status, 'staff').filter((s) => BOARD_SET.has(s))
}

function BoardPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const queryClient = useQueryClient()
  const filter = { mine: search.meine || undefined, search: search.q || undefined, ready: search.bereit || undefined }
  const { data, isPending, error } = useQuery(requestBoardQuery(filter))
  const [dragging, setDragging] = useState<Card | null>(null)
  const [pending, setPending] = useState<Move | null>(null)
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)

  const move = useMutation({
    mutationFn: ({ card, to, note }: Move & { note?: string }) =>
      changeStatusFn({ data: { id: card.id, version: card.version, to, note } }),
    onSuccess: (_r, { card, to }) => {
      setMessage({ tone: 'success', text: `${formatRequestNumber(card.number)} ist jetzt „${STATUS_LABELS[to]}“.` })
      setPending(null)
    },
    onError: (e, { card }) => {
      setPending(null)
      setMessage({
        tone: 'error',
        text: isConflictError(e)
          ? `${formatRequestNumber(card.number)} wurde inzwischen geändert. Die Karte ist neu geladen, bitte noch einmal versuchen.`
          : errorMessage(e),
      })
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['requests'] }),
  })

  // Abholung bzw. Zustellung erfassen (Issue #173).
  const handover = useMutation({
    mutationFn: (card: Card) => recordHandoverFn({ data: { id: card.id, handedOver: true } }),
    onSuccess: (_r, card) => {
      setMessage({
        tone: 'success',
        text: `${formatRequestNumber(card.number)} ist als „${HANDOVER_LABELS[card.deliveryMethod]}“ erfasst.`,
      })
    },
    onError: (e) => setMessage({ tone: 'error', text: errorMessage(e) }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['requests'] }),
  })

  const request = (card: Card, to: RequestStatus) => {
    setMessage(null)
    // Eine Rückfrage braucht einen Text an den Kunden.
    if (to === 'on_hold') setPending({ card, to })
    else move.mutate({ card, to })
  }

  const rows = data?.rows ?? []
  return (
    <div className="space-y-4">
      <PageHeader
        title="Board"
        description="Aufträge nach Status. Karten ziehen oder über „Status“ an der Karte verschieben."
        actions={
          <Link
            to="/auftraege"
            className="inline-flex items-center rounded-md px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-100"
          >
            Als Liste
          </Link>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const q = new FormData(e.currentTarget).get('q')
            const search = typeof q === 'string' ? q.trim() : ''
            void navigate({ search: (s) => ({ ...s, q: search || undefined }) })
          }}
        >
          <Input
            name="q"
            type="search"
            defaultValue={search.q ?? ''}
            placeholder="Suche nach Titel, Kunde oder Nr."
            className="w-72"
          />
        </form>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={!!search.meine}
            onChange={(e) => void navigate({ search: (s) => ({ ...s, meine: e.target.checked || undefined }) })}
          />
          Nur mir zugewiesen
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={!!search.bereit}
            onChange={(e) => void navigate({ search: (s) => ({ ...s, bereit: e.target.checked || undefined }) })}
          />
          Liegt zur Abholung bereit
        </label>
      </div>
      <div aria-live="polite">{message ? <Alert tone={message.tone}>{message.text}</Alert> : null}</div>
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      {data?.truncated ? <Alert tone="info">Es werden nur die ersten 500 Aufträge angezeigt. Bitte filtern.</Alert> : null}
      {pending ? (
        <OnHoldForm
          move={pending}
          busy={move.isPending}
          onCancel={() => setPending(null)}
          onSubmit={(note) => move.mutate({ ...pending, note })}
        />
      ) : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {COLUMNS.map((col) => {
          const cards = rows.filter((r) => r.status === col.status)
          const canDrop = !!dragging && dragging.status !== col.status && boardTargets(dragging).includes(col.status)
          return (
            // Ziehen ist nur eine Abkürzung; per Tastatur geht es über das Menü „Status …“ an der Karte.
            // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
            <section
              key={col.status}
              aria-label={col.title}
              className={cx(
                'flex min-h-40 flex-col rounded-lg bg-slate-100 p-2 ring-1 ring-slate-200 transition',
                dragging && (canDrop ? 'ring-2 ring-accent' : dragging.status !== col.status && 'opacity-50'),
              )}
              onDragOver={(e: DragEvent) => {
                if (canDrop) e.preventDefault()
              }}
              onDrop={(e: DragEvent) => {
                e.preventDefault()
                if (dragging && canDrop) request(dragging, col.status)
                setDragging(null)
              }}
            >
              <h2 className="flex items-baseline justify-between px-1 pb-2 text-sm font-semibold text-slate-700">
                <span>
                  {col.title}{' '}
                  {col.status === 'completed' && search.bereit ? (
                    <span className="font-normal text-slate-600">(noch nicht übergeben)</span>
                  ) : col.hint ? (
                    <span className="font-normal text-slate-600">({col.hint})</span>
                  ) : null}
                </span>
                <span className="text-slate-600">{isPending ? '…' : cards.length}</span>
              </h2>
              <ul className="space-y-2">
                {cards.map((card) => (
                  <BoardCard
                    key={card.id}
                    card={card}
                    busy={
                      (move.isPending && move.variables?.card.id === card.id) ||
                      (handover.isPending && handover.variables?.id === card.id)
                    }
                    onDragStart={() => setDragging(card)}
                    onDragEnd={() => setDragging(null)}
                    onMove={(to) => request(card, to)}
                    onHandover={() => {
                      setMessage(null)
                      handover.mutate(card)
                    }}
                  />
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function BoardCard({
  card,
  busy,
  onDragStart,
  onDragEnd,
  onMove,
  onHandover,
}: {
  card: Card
  busy: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onMove: (to: RequestStatus) => void
  onHandover: () => void
}) {
  const targets = boardTargets(card)
  return (
    // Ziehen ist nur eine Abkürzung; per Tastatur geht es über das Menü „Status …“ an der Karte.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <li
      draggable={targets.length > 0 && !busy}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', card.id)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      className={cx(
        'rounded-md bg-white p-3 text-sm shadow-sm ring-1 ring-slate-200',
        targets.length > 0 && 'cursor-grab',
        busy && 'opacity-60',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <Link to="/auftraege/$requestId" params={{ requestId: card.id }} className="font-medium hover:underline">
          <span className="mr-1 font-mono text-slate-500">{formatRequestNumber(card.number)}</span>
          {card.title}
        </Link>
      </div>
      <p className="mt-1 text-xs text-slate-600">
        {card.organisationName ?? card.creatorName}
        {card.assigneeName ? ` · ${card.assigneeName}` : ' · niemand zuständig'}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        {card.promisedDate ? <span className="text-slate-600">Termin {formatDate(card.promisedDate)}</span> : null}
        {card.attention ? <AttentionBadge attention={card.attention} /> : null}
        {card.internalStatus ? (
          <Badge className={INTERNAL_STATUS_TONES[card.internalStatus]}>{INTERNAL_STATUS_LABELS[card.internalStatus]}</Badge>
        ) : null}
        {card.hasProposal ? <Badge className="bg-amber-100 text-amber-900">Vorschlag offen</Badge> : null}
        {card.status === 'completed' && card.handedOverAt ? (
          <Badge className="bg-emerald-100 text-emerald-800">{HANDOVER_LABELS[card.deliveryMethod]}</Badge>
        ) : null}
      </div>
      {card.status === 'completed' && !card.handedOverAt ? (
        <Button variant="secondary" disabled={busy} onClick={onHandover} className="mt-2 w-full">
          {card.deliveryMethod === 'house_post' ? 'Als zugestellt markieren' : 'Als abgeholt markieren'}
          <span className="sr-only"> ({formatRequestNumber(card.number)})</span>
        </Button>
      ) : null}
      {targets.length ? (
        <Select
          aria-label={`Status von ${formatRequestNumber(card.number)} ändern`}
          value=""
          disabled={busy}
          onChange={(e) => {
            if (e.target.value) onMove(e.target.value as RequestStatus)
          }}
          className="mt-2 w-full text-xs"
        >
          <option value="">Status …</option>
          {targets.map((t) => (
            <option key={t} value={t}>
              {transitionLabel(card.status, t, 'staff')}
            </option>
          ))}
        </Select>
      ) : null}
    </li>
  )
}

function OnHoldForm({
  move,
  busy,
  onCancel,
  onSubmit,
}: {
  move: Move
  busy: boolean
  onCancel: () => void
  onSubmit: (note: string) => void
}) {
  const [note, setNote] = useState('')
  return (
    <form
      className="space-y-2 rounded-lg bg-amber-50 p-4 ring-1 ring-amber-200"
      onSubmit={(e) => {
        e.preventDefault()
        if (note.trim()) onSubmit(note.trim())
      }}
    >
      <label htmlFor="onhold-note" className="block text-sm font-medium">
        Rückfrage zu {formatRequestNumber(move.card.number)} {move.card.title}
      </label>
      <Textarea
        id="onhold-note"
        // Das Feld erscheint erst nach dem Verschieben; der Fokus soll direkt dorthin.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Was soll der Kunde klären? Der Text geht per E-Mail an ihn."
      />
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !note.trim()}>
          Rückfrage stellen
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Abbrechen
        </Button>
      </div>
    </form>
  )
}
