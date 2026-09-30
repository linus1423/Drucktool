import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { formatBillingAddress } from '~/lib/address'
import { RequestFields, toRequestInput, useRequestForm } from '~/components/RequestFields'
import { Alert, Badge, Button, Card, Field, Input, Select, StatusBadge, Textarea, cx } from '~/components/ui'
import { errorMessage, isConflictError } from '~/lib/errors'
import { formatDate, formatDateTime, formatMoney, formatRequestNumber, parseMoneyToCents } from '~/lib/format'
import { assignableStaffQuery, requestDetailQuery } from '~/lib/queries'
import { isStaffRole } from '~/lib/roles'
import { STATUS_LABELS, transitionLabel, type RequestStatus } from '~/lib/status'
import {
  addCommentFn,
  assignRequestFn,
  changeStatusFn,
  updateRequestFn,
} from '~/server/requests/requests.functions'

export const Route = createFileRoute('/_app/anfragen/$requestId')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(requestDetailQuery(params.requestId)),
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData ? `${formatRequestNumber(loaderData.number)} ${loaderData.title} · Drucktool` : 'Anfrage · Drucktool' }],
  }),
  errorComponent: ({ error }) => (
    <div className="space-y-4">
      <Alert>{errorMessage(error)}</Alert>
      <Link to="/anfragen" className="text-sm underline">
        Zurück zur Übersicht
      </Link>
    </div>
  ),
  component: RequestDetailPage,
})

type Detail = Awaited<ReturnType<NonNullable<ReturnType<typeof requestDetailQuery>['queryFn']>>>

function useRefresh(id: string) {
  const queryClient = useQueryClient()
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: requestDetailQuery(id).queryKey }),
      queryClient.invalidateQueries({ queryKey: ['requests', 'list'] }),
    ])
  }
}

function RequestDetailPage() {
  const { requestId } = Route.useParams()
  const { user } = Route.useRouteContext()
  const staff = isStaffRole(user.role)
  const { data: request } = useSuspenseQuery(requestDetailQuery(requestId))
  const [editing, setEditing] = useState(false)

  return (
    <div className="space-y-6">
      <div>
        <Link to="/anfragen" className="text-sm text-slate-500 hover:text-slate-900">
          ← Alle Anfragen
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            <span className="mr-2 font-mono text-slate-400">{formatRequestNumber(request.number)}</span>
            {request.title}
          </h1>
          <StatusBadge status={request.status} />
        </div>
        <p className="mt-1 text-sm text-slate-600">
          {request.organisationName ? `${request.organisationName} · ` : ''}angelegt von {request.creatorName}
          {request.creatorEmail ? ` (${request.creatorEmail})` : ''} am {formatDateTime(request.createdAt)}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {editing ? (
            <EditRequest request={request} onDone={() => setEditing(false)} />
          ) : (
            <Card
              title="Details"
              actions={
                request.canEdit ? (
                  <Button variant="secondary" onClick={() => setEditing(true)}>
                    Bearbeiten
                  </Button>
                ) : null
              }
            >
              <dl className="grid gap-4 text-sm sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <dt className="font-medium text-slate-500">Beschreibung</dt>
                  <dd className="mt-1 whitespace-pre-wrap">{request.description || '–'}</dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-500">Auflage</dt>
                  <dd className="mt-1">{request.quantity?.toLocaleString('de-DE') ?? '–'}</dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-500">Wunschtermin</dt>
                  <dd className="mt-1">{formatDate(request.desiredDate)}</dd>
                </div>
                {request.billingAddress ? (
                  <div>
                    <dt className="font-medium text-slate-500">Rechnungsadresse</dt>
                    <dd className="mt-1">
                      {formatBillingAddress(request.billingAddress).map((line) => (
                        <span key={line} className="block">
                          {line}
                        </span>
                      ))}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </Card>
          )}

          {request.quoteAmountCents !== null ? (
            <Card title="Angebot">
              <p className="text-2xl font-semibold">{formatMoney(request.quoteAmountCents)}</p>
              {request.quoteNote ? <p className="mt-2 text-sm whitespace-pre-wrap text-slate-700">{request.quoteNote}</p> : null}
            </Card>
          ) : null}

          <Comments request={request} staff={staff} />
        </div>

        <div className="space-y-6">
          <StatusActions request={request} staff={staff} />
          {staff ? <Assignment request={request} /> : null}
          <History request={request} />
        </div>
      </div>
    </div>
  )
}

function ErrorBox({ error, onReload }: { error: unknown; onReload: () => void }) {
  if (!error) return null
  return (
    <Alert>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{errorMessage(error)}</span>
        {isConflictError(error) ? (
          <Button variant="secondary" onClick={onReload}>
            Neu laden
          </Button>
        ) : null}
      </div>
    </Alert>
  )
}

function EditRequest({ request, onDone }: { request: Detail; onDone: () => void }) {
  const refresh = useRefresh(request.id)
  const [error, setError] = useState<unknown>(null)
  const form = useRequestForm({
    defaultValues: {
      title: request.title,
      description: request.description,
      quantity: request.quantity?.toString() ?? '',
      desiredDate: request.desiredDate ?? '',
    },
    onSubmit: async (values) => {
      setError(null)
      try {
        await updateRequestFn({ data: { id: request.id, version: request.version, ...toRequestInput(values) } })
        await refresh()
        onDone()
      } catch (e) {
        setError(e)
      }
    },
  })

  return (
    <Card title="Anfrage bearbeiten">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void form.handleSubmit()
        }}
      >
        <ErrorBox error={error} onReload={() => void refresh().then(onDone)} />
        <RequestFields form={form} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onDone}>
            Abbrechen
          </Button>
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(isSubmitting) => (
              <Button type="submit" disabled={isSubmitting}>
                Speichern
              </Button>
            )}
          </form.Subscribe>
        </div>
      </form>
    </Card>
  )
}

function StatusActions({ request, staff }: { request: Detail; staff: boolean }) {
  const refresh = useRefresh(request.id)
  const actor = staff ? 'staff' : 'customer'
  const [target, setTarget] = useState<RequestStatus | null>(null)
  const [note, setNote] = useState('')
  const [price, setPrice] = useState('')

  const mutation = useMutation({
    mutationFn: async (to: RequestStatus) => {
      let quoteAmountCents: number | undefined
      if (to === 'quoted') {
        const cents = parseMoneyToCents(price)
        if (cents === null) throw new Error('Bitte einen gültigen Preis angeben, z. B. 249,90')
        quoteAmountCents = cents
      }
      return changeStatusFn({
        data: { id: request.id, version: request.version, to, note: note.trim() || undefined, quoteAmountCents },
      })
    },
    onSuccess: async () => {
      setTarget(null)
      setNote('')
      setPrice('')
      await refresh()
    },
  })

  if (request.transitions.length === 0) {
    return (
      <Card title="Status">
        <p className="text-sm text-slate-600">
          {staff ? 'Für diesen Status gibt es keine weiteren Schritte.' : 'Aktuell ist keine Aktion von Ihnen nötig.'}
        </p>
      </Card>
    )
  }

  const destructive = (to: RequestStatus) => to === 'rejected' || to === 'cancelled'

  return (
    <Card title="Nächster Schritt">
      <div className="space-y-3">
        <ErrorBox
          error={mutation.error}
          onReload={() => {
            mutation.reset()
            setTarget(null)
            void refresh()
          }}
        />
        {target === null ? (
          <div className="flex flex-col gap-2">
            {request.transitions.map((to) => (
              <Button
                key={to}
                variant={destructive(to) ? 'secondary' : 'primary'}
                className={cx(destructive(to) && 'text-rose-700')}
                onClick={() => {
                  mutation.reset()
                  setTarget(to)
                }}
              >
                {transitionLabel(request.status, to, actor)}
              </Button>
            ))}
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              mutation.mutate(target)
            }}
          >
            <p className="text-sm">
              Status wechseln zu <strong>{STATUS_LABELS[target]}</strong>
            </p>
            {target === 'quoted' ? (
              <Field label="Angebotspreis (netto, EUR)" htmlFor="price">
                <Input id="price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="249,90" required />
              </Field>
            ) : null}
            <Field
              label={target === 'quoted' ? 'Hinweise zum Angebot (optional)' : 'Nachricht (optional)'}
              htmlFor="note"
              hint={target === 'quoted' ? undefined : 'Wird als Kommentar für alle Beteiligten gespeichert.'}
            >
              <Textarea id="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setTarget(null)}>
                Zurück
              </Button>
              <Button type="submit" variant={destructive(target) ? 'danger' : 'primary'} disabled={mutation.isPending}>
                {transitionLabel(request.status, target, actor)}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  )
}

function Assignment({ request }: { request: Detail }) {
  const refresh = useRefresh(request.id)
  const staffList = useQuery(assignableStaffQuery)
  const mutation = useMutation({
    mutationFn: (assigneeId: string | null) =>
      assignRequestFn({ data: { id: request.id, version: request.version, assigneeId } }),
    onSuccess: refresh,
  })

  return (
    <Card title="Zuständig">
      <div className="space-y-3">
        <ErrorBox
          error={mutation.error}
          onReload={() => {
            mutation.reset()
            void refresh()
          }}
        />
        <Select
          aria-label="Zuständiger Mitarbeiter"
          value={request.assigneeId ?? ''}
          disabled={mutation.isPending}
          onChange={(e) => mutation.mutate(e.target.value || null)}
        >
          <option value="">Niemand</option>
          {staffList.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>
    </Card>
  )
}

function Comments({ request, staff }: { request: Detail; staff: boolean }) {
  const refresh = useRefresh(request.id)
  const [body, setBody] = useState('')
  const [internal, setInternal] = useState(false)
  const mutation = useMutation({
    mutationFn: () => addCommentFn({ data: { id: request.id, body, internal } }),
    onSuccess: async () => {
      setBody('')
      setInternal(false)
      await refresh()
    },
  })

  return (
    <Card title="Kommunikation">
      <div className="space-y-4">
        {request.comments.length === 0 ? (
          <p className="text-sm text-slate-500">Noch keine Nachrichten.</p>
        ) : (
          <ul className="space-y-3">
            {request.comments.map((c) => (
              <li
                key={c.id}
                className={cx(
                  'rounded-md p-3 text-sm ring-1',
                  c.internal ? 'bg-amber-50 ring-amber-200' : c.authorIsStaff ? 'bg-slate-50 ring-slate-200' : 'bg-white ring-slate-200',
                )}
              >
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className="font-medium text-slate-800">{c.authorName}</span>
                  {c.authorIsStaff ? <Badge>Druckerei</Badge> : null}
                  {c.internal ? <Badge className="bg-amber-200 text-amber-900">Intern</Badge> : null}
                  <span>{formatDateTime(c.createdAt)}</span>
                </div>
                <p className="whitespace-pre-wrap">{c.body}</p>
              </li>
            ))}
          </ul>
        )}
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (body.trim()) mutation.mutate()
          }}
        >
          {mutation.error ? <Alert>{errorMessage(mutation.error)}</Alert> : null}
          <Textarea
            aria-label="Nachricht"
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={staff ? 'Nachricht an den Kunden oder interne Notiz …' : 'Nachricht an die Druckerei …'}
          />
          <div className="flex items-center justify-between gap-2">
            {staff ? (
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
                Interne Notiz (für Kunden nicht sichtbar)
              </label>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={mutation.isPending || !body.trim()}>
              Senden
            </Button>
          </div>
        </form>
      </div>
    </Card>
  )
}

function describeEvent(e: Detail['events'][number]) {
  switch (e.type) {
    case 'created':
      return 'hat die Anfrage angelegt'
    case 'updated':
      return 'hat die Anfrage bearbeitet'
    case 'status_changed':
      return `Status: ${e.fromStatus ? STATUS_LABELS[e.fromStatus] : '–'} → ${e.toStatus ? STATUS_LABELS[e.toStatus] : '–'}`
    case 'assigned': {
      const name = typeof e.data.assigneeName === 'string' ? e.data.assigneeName : null
      return name ? `hat ${name} zugewiesen` : 'hat die Zuweisung entfernt'
    }
    case 'commented':
      return 'hat kommentiert'
  }
}

function History({ request }: { request: Detail }) {
  return (
    <Card title="Verlauf">
      <ol className="space-y-3 text-sm">
        {request.events.map((e) => (
          <li key={e.id} className="border-l-2 border-slate-200 pl-3">
            <div>
              <span className="font-medium">{e.actorName ?? 'System'}</span> {describeEvent(e)}
            </div>
            <div className="text-xs text-slate-500">{formatDateTime(e.createdAt)}</div>
          </li>
        ))}
      </ol>
    </Card>
  )
}

