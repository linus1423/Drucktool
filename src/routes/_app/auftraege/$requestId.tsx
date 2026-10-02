import { useEffect, useState } from 'react'
import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { formatBillingAddress, formatDeliveryAddress } from '~/lib/address'
import { formatBytes, uploadFile, type UploadedFile } from '~/components/FileUpload'
import { AttentionBadge } from '~/components/AttentionBadge'
import { LexwareExportButton } from '~/components/LexwareExport'
import { ProposalCard, ProposeChangeForm } from '~/components/ChangeProposal'
import { RequestFields, useRequestForm } from '~/components/RequestFields'
import { Alert, Badge, Button, Card, Field, Input, Select, StatusBadge, Textarea, cx } from '~/components/ui'
import { errorMessage, isConflictError } from '~/lib/errors'
import { formatDate, formatDateTime, formatMoney, formatRequestNumber } from '~/lib/format'
import { formatSheetSize, type SheetSize } from '~/lib/catalog'
import { DELIVERY_LABELS, coverPagesFromMainFile } from '~/lib/order'
import { describeOrder } from '~/lib/snapshot'
import { assignableStaffQuery, requestDetailQuery } from '~/lib/queries'
import { isStaffRole } from '~/lib/roles'
import {
  INTERNAL_STATUSES,
  INTERNAL_STATUS_LABELS,
  INTERNAL_STATUS_TONES,
  STATUS_LABELS,
  TERMINAL_STATUSES,
  hasInternalStatus,
  transitionLabel,
  type InternalStatus,
  type RequestStatus,
} from '~/lib/status'
import {
  addCommentFn,
  assignRequestFn,
  changeStatusFn,
  setDatesFn,
  setPrintSheetFn,
  setInternalStatusFn,
  markReadFn,
  setWatchingFn,
  updateRequestFn,
} from '~/server/requests/requests.functions'

export const Route = createFileRoute('/_app/auftraege/$requestId')({
  loader: ({ context, params }) => {
    if (!UUID.test(params.requestId)) throw notFound()
    return context.queryClient.ensureQueryData(requestDetailQuery(params.requestId))
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData ? `${formatRequestNumber(loaderData.number)} ${loaderData.title} · Drucktool` : 'Auftrag · Drucktool' },
    ],
  }),
  errorComponent: ({ error }) => (
    <div className="space-y-4">
      <Alert>{errorMessage(error)}</Alert>
      <Link to="/auftraege" className="text-sm underline">
        Zurück zur Übersicht
      </Link>
    </div>
  ),
  notFoundComponent: () => (
    <div className="space-y-4">
      <Alert>Auftrag nicht gefunden</Alert>
      <Link to="/auftraege" className="text-sm underline">
        Zurück zur Übersicht
      </Link>
    </div>
  ),
  component: RequestDetailPage,
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

type Entry = { createdAt: Date | string; mine: boolean }

/**
 * Ungelesen-Markierung (Issue #18): Merkt sich beim Öffnen, bis wann der Auftrag gelesen war, hebt neuere
 * Einträge anderer hervor und meldet dem Server, dass der Auftrag jetzt gesehen ist.
 */
function useUnreadMarker(request: Detail) {
  const queryClient = useQueryClient()
  const [seen, setSeen] = useState({ id: request.id, at: request.readAt })
  if (seen.id !== request.id) setSeen({ id: request.id, at: request.readAt })
  useEffect(() => {
    void markReadFn({ data: { id: request.id, at: request.loadedAt } })
      .then(() => queryClient.invalidateQueries({ queryKey: ['requests', 'list'] }))
      .catch(() => {})
  }, [request.id, request.loadedAt, queryClient])
  const since = seen.id === request.id ? seen.at : request.readAt
  return (e: Entry) => !!since && !e.mine && new Date(e.createdAt) > new Date(since)
}

function RequestDetailPage() {
  const { requestId } = Route.useParams()
  const { user } = Route.useRouteContext()
  const staff = isStaffRole(user.role)
  const { data: request } = useSuspenseQuery(requestDetailQuery(requestId))
  const [editing, setEditing] = useState(false)
  const [proposing, setProposing] = useState(false)
  const refresh = useRefresh(requestId)
  const canPropose = staff && !!request.order && !TERMINAL_STATUSES.has(request.status)
  const isNew = useUnreadMarker(request)

  return (
    <div className="space-y-6">
      <div>
        <Link to="/auftraege" className="text-sm text-slate-500 hover:text-slate-900">
          ← Alle Aufträge
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            <span className="mr-2 font-mono text-slate-500">{formatRequestNumber(request.number)}</span>
            {request.title}
          </h1>
          <StatusBadge status={request.status} />
          {request.attention ? <AttentionBadge attention={request.attention} /> : null}
          {request.internalStatus ? (
            <Badge className={INTERNAL_STATUS_TONES[request.internalStatus]}>
              {INTERNAL_STATUS_LABELS[request.internalStatus]}
            </Badge>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-slate-600">
          {request.organisationName ? `${request.organisationName} · ` : ''}angelegt von {request.creatorName}
          {request.creatorEmail ? ` (${request.creatorEmail})` : ''} am {formatDateTime(request.createdAt)}
          {request.confirmedAt
            ? ` · bestätigt von ${request.confirmedByName ?? 'der Druckerei'} am ${formatDateTime(request.confirmedAt)}`
            : ''}
          {request.reorderOf ? (
            <>
              {' · Nachbestellung von '}
              <Link to="/auftraege/$requestId" params={{ requestId: request.reorderOf.id }} className="underline">
                {formatRequestNumber(request.reorderOf.number)} {request.reorderOf.title}
              </Link>
            </>
          ) : null}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {request.order && (staff || request.createdById === user.id) ? (
            <Link
              to="/auftraege/neu"
              search={{ vorlage: request.id }}
              className="inline-flex items-center rounded-md px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-100"
            >
              Erneut bestellen
            </Link>
          ) : null}
          {request.canAct ? <WatchButton request={request} /> : null}
          {staff && request.watchers.length ? (
            <span className="text-sm text-slate-600">Beobachtet von {request.watchers.map((w) => w.name).join(', ')}</span>
          ) : null}
        </div>
      </div>

      {request.canAct ? null : (
        <Alert tone="info">
          Sie sehen diesen Auftrag als Verwalter der Organisation. Ändern, freigeben und Nachrichten schreiben kann nur{' '}
          {request.creatorName}.
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {proposing ? (
            <ProposeChangeForm request={request} onDone={() => setProposing(false)} onChanged={refresh} />
          ) : (
            <ProposalCard request={request} staff={staff} onChanged={refresh} onEdit={() => setProposing(true)} />
          )}
          {editing ? (
            <EditRequest request={request} onDone={() => setEditing(false)} />
          ) : (
            <Card
              title="Auftrag"
              actions={
                <div className="flex gap-2">
                  {canPropose && !request.proposal && !proposing ? (
                    <Button
                      variant="secondary"
                      title="Papier, Bindung, Auflage und alle anderen Optionen ändern; der Kunde bekommt ein neues Angebot."
                      onClick={() => setProposing(true)}
                    >
                      Auftrag ändern
                    </Button>
                  ) : null}
                  {request.canEdit ? (
                    <Button variant="secondary" onClick={() => setEditing(true)}>
                      Bearbeiten
                    </Button>
                  ) : null}
                </div>
              }
            >
              <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                {request.order ? (
                  describeOrder(request.order).map(([label, value]) => (
                    <div key={label}>
                      <dt className="font-medium text-slate-500">{label}</dt>
                      <dd className="mt-0.5">{value}</dd>
                    </div>
                  ))
                ) : (
                  <>
                    <div>
                      <dt className="font-medium text-slate-500">Auflage</dt>
                      <dd className="mt-0.5">{request.quantity?.toLocaleString('de-DE') ?? '–'}</dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">Wunschtermin</dt>
                      <dd className="mt-0.5">{formatDate(request.desiredDate)}</dd>
                    </div>
                  </>
                )}
                {request.promisedDate ? (
                  <div>
                    <dt className="font-medium text-slate-500">Zugesagter Termin</dt>
                    <dd className="mt-0.5">{formatDate(request.promisedDate)}</dd>
                  </div>
                ) : null}
                <div className="sm:col-span-2">
                  <dt className="font-medium text-slate-500">Bemerkungen</dt>
                  <dd className="mt-0.5 whitespace-pre-wrap">{request.description || '–'}</dd>
                </div>
                {request.billingAddress ? (
                  <div>
                    <dt className="font-medium text-slate-500">Rechnungsadresse</dt>
                    <dd className="mt-0.5">
                      {formatBillingAddress(request.billingAddress).map((line) => (
                        <span key={line} className="block">
                          {line}
                        </span>
                      ))}
                    </dd>
                  </div>
                ) : null}
                {request.deliveryMethod === 'house_post' && request.deliveryAddress ? (
                  <div>
                    <dt className="font-medium text-slate-500">Lieferadresse (Hauspost)</dt>
                    <dd className="mt-0.5">
                      {formatDeliveryAddress(request.deliveryAddress).map((line) => (
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

          <Files request={request} staff={staff} />
          <Comments request={request} staff={staff} isNew={isNew} />
        </div>

        <div className="space-y-6">
          <PriceCard request={request} staff={staff} />
          <StatusActions request={request} staff={staff} />
          {staff && request.status === 'completed' ? <InvoiceCard request={request} /> : null}
          {staff && hasInternalStatus(request.status) ? <InternalStatusCard request={request} /> : null}
          {staff && !TERMINAL_STATUSES.has(request.status) ? <DatesCard request={request} /> : null}
          {staff && request.order ? <PrintSheetCard request={request} /> : null}
          {staff ? <Assignment request={request} /> : null}
          <History request={request} isNew={isNew} />
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
    defaultValues: { title: request.title, notes: request.description },
    onSubmit: async (values) => {
      setError(null)
      try {
        await updateRequestFn({ data: { id: request.id, version: request.version, ...values } })
        await refresh()
        onDone()
      } catch (e) {
        setError(e)
      }
    },
  })

  return (
    <Card title="Auftrag bearbeiten">
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

  const mutation = useMutation({
    mutationFn: async (to: RequestStatus) =>
      changeStatusFn({ data: { id: request.id, version: request.version, to, note: note.trim() || undefined } }),
    onSuccess: async () => {
      setTarget(null)
      setNote('')
      await refresh()
    },
  })

  if (request.transitions.length === 0) {
    return (
      <Card title="Status">
        <p className="text-sm text-slate-600">
          {staff
            ? 'Für diesen Status gibt es keine weiteren Schritte.'
            : request.canAct
              ? 'Aktuell ist keine Aktion von Ihnen nötig.'
              : 'Nur die Person, die den Auftrag angelegt hat, kann ihn ändern.'}
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
            {target === 'confirmed' ? (
              <p className="text-sm text-slate-600">
                Mit der Bestätigung nimmt die Druckerei den Auftrag verbindlich an. Der Kunde wird per E-Mail informiert.
              </p>
            ) : null}
            <Field
              label={target === 'on_hold' ? 'Rückfrage an den Kunden' : 'Nachricht (optional)'}
              htmlFor="note"
              hint="Wird als Kommentar für alle Beteiligten gespeichert und in der E-Mail mitgeschickt."
            >
              <Textarea
                id="note"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                required={target === 'on_hold'}
              />
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

function InternalStatusCard({ request }: { request: Detail }) {
  const refresh = useRefresh(request.id)
  const mutation = useMutation({
    mutationFn: (internalStatus: InternalStatus | null) =>
      setInternalStatusFn({ data: { id: request.id, version: request.version, internalStatus } }),
    onSuccess: refresh,
  })

  return (
    <Card title="Interner Status">
      <div className="space-y-3">
        <ErrorBox
          error={mutation.error}
          onReload={() => {
            mutation.reset()
            void refresh()
          }}
        />
        <Select
          aria-label="Interner Status"
          value={request.internalStatus ?? ''}
          disabled={mutation.isPending}
          onChange={(e) => mutation.mutate((e.target.value || null) as InternalStatus | null)}
        >
          <option value="">Noch nicht begonnen</option>
          {INTERNAL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {INTERNAL_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
        <p className="text-xs text-slate-500">Nur für Mitarbeiter sichtbar. Der Kunde sieht weiterhin „Bestätigt“.</p>
      </div>
    </Card>
  )
}

function DatesCard({ request }: { request: Detail }) {
  const refresh = useRefresh(request.id)
  const [promised, setPromised] = useState(request.promisedDate ?? '')
  const [internal, setInternal] = useState(request.internalDueDate ?? '')
  const mutation = useMutation({
    mutationFn: () =>
      setDatesFn({
        data: { id: request.id, version: request.version, promisedDate: promised || null, internalDueDate: internal || null },
      }),
    onSuccess: refresh,
  })
  const dirty = promised !== (request.promisedDate ?? '') || internal !== (request.internalDueDate ?? '')

  return (
    <Card title="Termine">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          mutation.mutate()
        }}
      >
        <ErrorBox
          error={mutation.error}
          onReload={() => {
            mutation.reset()
            void refresh()
          }}
        />
        <Field label="Zugesagter Termin" htmlFor="promisedDate" hint="Sieht der Kunde, er bekommt eine E-Mail.">
          <Input id="promisedDate" type="date" value={promised} onChange={(e) => setPromised(e.target.value)} />
        </Field>
        <Field label="Interne Frist" htmlFor="internalDueDate" hint="Nur für Mitarbeiter sichtbar.">
          <Input id="internalDueDate" type="date" value={internal} onChange={(e) => setInternal(e.target.value)} />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" disabled={!dirty || mutation.isPending}>
            Termine speichern
          </Button>
        </div>
      </form>
    </Card>
  )
}

function PrintSheetCard({ request }: { request: Detail }) {
  const refresh = useRefresh(request.id)
  const { inner, cover } = request.printSheetOptions
  const hasCover = !!request.order?.coverPaper
  const [sheet, setSheet] = useState(request.printSheet?.label ?? '')
  const [coverSheet, setCoverSheet] = useState(request.coverPrintSheet?.label ?? '')
  const mutation = useMutation({
    mutationFn: () =>
      setPrintSheetFn({
        data: { id: request.id, version: request.version, sheet: sheet || null, coverSheet: coverSheet || null },
      }),
    onSuccess: refresh,
  })
  const dirty = sheet !== (request.printSheet?.label ?? '') || coverSheet !== (request.coverPrintSheet?.label ?? '')
  const calculated = (imp: { paperSheet: string } | null | undefined) =>
    imp ? `Wie berechnet (${imp.paperSheet})` : 'Wie berechnet'
  const options = (list: SheetSize[], current: SheetSize | null) =>
    // Eine früher gewählte Größe bleibt wählbar, auch wenn sie inzwischen aus dem Katalog entfernt wurde.
    current && !list.some((s) => s.label === current.label) ? [current, ...list] : list

  return (
    <Card title="Druckbogen">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          mutation.mutate()
        }}
      >
        <p className="text-xs text-slate-600">Nur intern: ändert weder Preis noch Status, der Kunde wird nicht benachrichtigt.</p>
        <ErrorBox
          error={mutation.error}
          onReload={() => {
            mutation.reset()
            void refresh()
          }}
        />
        <Field
          label={hasCover ? 'Innenteil' : 'Bogen'}
          htmlFor="printSheet"
          hint={inner.length ? undefined : 'Für dieses Papier sind im Katalog keine Bogengrößen hinterlegt.'}
        >
          <Select id="printSheet" value={sheet} onChange={(e) => setSheet(e.target.value)}>
            <option value="">{calculated(request.order?.price.inner)}</option>
            {options(inner, request.printSheet).map((s) => (
              <option key={s.label} value={s.label}>
                {formatSheetSize(s)}
              </option>
            ))}
          </Select>
        </Field>
        {hasCover ? (
          <Field
            label="Deckblatt"
            htmlFor="coverPrintSheet"
            hint={cover.length ? undefined : 'Für dieses Papier sind im Katalog keine Bogengrößen hinterlegt.'}
          >
            <Select id="coverPrintSheet" value={coverSheet} onChange={(e) => setCoverSheet(e.target.value)}>
              <option value="">{calculated(request.order?.price.cover)}</option>
              {options(cover, request.coverPrintSheet).map((s) => (
                <option key={s.label} value={s.label}>
                  {formatSheetSize(s)}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <div className="flex justify-end">
          <Button type="submit" disabled={!dirty || mutation.isPending}>
            Druckbogen speichern
          </Button>
        </div>
      </form>
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

function WatchButton({ request }: { request: Detail }) {
  const refresh = useRefresh(request.id)
  const mutation = useMutation({
    mutationFn: () => setWatchingFn({ data: { id: request.id, watching: !request.watching } }),
    onSuccess: refresh,
  })
  return (
    <>
      <Button
        variant="secondary"
        aria-pressed={request.watching}
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
        title={
          request.watching
            ? 'Sie bekommen E-Mails zu Nachrichten und Statusänderungen dieses Auftrags.'
            : 'Sie bekommen keine E-Mails zu diesem Auftrag.'
        }
      >
        {request.watching ? '🔔 Beobachten beenden' : '🔕 Beobachten'}
      </Button>
      {mutation.error ? <span className="text-sm text-rose-600">{errorMessage(mutation.error)}</span> : null}
    </>
  )
}

/** Hebt @Name-Erwähnungen in einer Nachricht hervor. */
function MentionText({ body, mentions }: { body: string; mentions: { id: string; name: string }[] }) {
  if (!mentions.length) return <>{body}</>
  const names = [...mentions].sort((a, b) => b.name.length - a.name.length).map((m) => m.name)
  const pattern = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}))`, 'giu')
  return (
    <>
      {body.split(pattern).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-sky-100 px-0.5 font-medium text-sky-900">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  )
}

function MentionPicker({ onPick }: { onPick: (name: string) => void }) {
  const { data: staff = [] } = useQuery(assignableStaffQuery)
  return (
    <Select
      aria-label="Mitarbeiter erwähnen"
      value=""
      onChange={(e) => {
        if (e.target.value) onPick(e.target.value)
      }}
      className="w-auto"
    >
      <option value="">@ Erwähnen …</option>
      {staff.map((s) => (
        <option key={s.id} value={s.name}>
          {s.name}
        </option>
      ))}
    </Select>
  )
}

function Comments({ request, staff, isNew }: { request: Detail; staff: boolean; isNew: (e: Entry) => boolean }) {
  const refresh = useRefresh(request.id)
  const [body, setBody] = useState('')
  const [internal, setInternal] = useState(false)
  const [attachments, setAttachments] = useState<UploadedFile[]>([])
  const [uploading, setUploading] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: () => addCommentFn({ data: { id: request.id, body, internal, attachmentIds: attachments.map((a) => a.id) } }),
    onSuccess: async () => {
      setBody('')
      setInternal(false)
      setAttachments([])
      await refresh()
    },
  })
  const addFiles = async (files: FileList | null) => {
    setUploadError(null)
    for (const file of Array.from(files ?? [])) {
      setUploading(file.name)
      try {
        const uploaded = await uploadFile(file, 'attachment', () => {})
        setAttachments((list) => [...list, uploaded])
      } catch (e) {
        setUploadError(`${file.name}: ${(e as Error).message}`)
      }
    }
    setUploading(null)
  }
  const canSend = (body.trim().length > 0 || attachments.length > 0) && !uploading

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
                  isNew(c) && 'ring-2 ring-sky-400',
                  c.internal
                    ? 'bg-amber-50 ring-amber-200'
                    : c.authorIsStaff
                      ? 'bg-slate-50 ring-slate-200'
                      : 'bg-white ring-slate-200',
                )}
              >
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className="font-medium text-slate-800">{c.authorName}</span>
                  {c.authorIsStaff ? <Badge>Druckerei</Badge> : null}
                  {c.internal ? <Badge className="bg-amber-200 text-amber-900">Intern</Badge> : null}
                  <span>{formatDateTime(c.createdAt)}</span>
                  {isNew(c) ? <Badge className="bg-sky-100 text-sky-900">Neu</Badge> : null}
                </div>
                {c.body ? (
                  <p className="whitespace-pre-wrap">
                    <MentionText body={c.body} mentions={c.mentions} />
                  </p>
                ) : null}
                {c.attachments.length ? (
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {c.attachments.map((a) => (
                      <li key={a.id}>
                        <a
                          href={`/api/dateien/${a.id}`}
                          className="inline-flex items-center gap-1 rounded bg-white px-2 py-1 text-xs ring-1 ring-slate-200 hover:bg-slate-100"
                        >
                          📎 {a.filename} <span className="text-slate-500">{formatBytes(a.sizeBytes)}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {request.canAct ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (canSend) mutation.mutate()
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
            {attachments.length || uploading ? (
              <ul className="flex flex-wrap gap-2 text-xs">
                {attachments.map((a) => (
                  <li key={a.id} className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1">
                    📎 {a.filename}
                    <button
                      type="button"
                      aria-label={`${a.filename} entfernen`}
                      className="ml-1 text-slate-500 hover:text-slate-900"
                      onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
                    >
                      ×
                    </button>
                  </li>
                ))}
                {uploading ? <li className="px-2 py-1 text-slate-500">{uploading} wird hochgeladen …</li> : null}
              </ul>
            ) : null}
            {uploadError ? <p className="text-sm text-rose-600">{uploadError}</p> : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="cursor-pointer text-sm text-slate-700 underline">
                Datei anhängen
                <input
                  type="file"
                  multiple
                  className="sr-only"
                  onChange={(e) => {
                    void addFiles(e.target.files)
                    e.target.value = ''
                  }}
                />
              </label>
              {staff ? (
                <MentionPicker onPick={(name) => setBody((b) => `${b}${b && !/\s$/.test(b) ? ' ' : ''}@${name} `)} />
              ) : null}
              {staff ? (
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
                  Interne Notiz (für Kunden nicht sichtbar)
                </label>
              ) : (
                <span />
              )}
              <Button type="submit" disabled={mutation.isPending || !canSend}>
                Senden
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  )
}

function describeEvent(e: Detail['events'][number]) {
  switch (e.type) {
    case 'created':
      return typeof e.data.reorderOfNumber === 'number'
        ? `hat den Auftrag als Nachbestellung von ${formatRequestNumber(e.data.reorderOfNumber)} eingereicht`
        : 'hat den Auftrag eingereicht'
    case 'updated':
      return 'hat den Auftrag bearbeitet'
    case 'status_changed':
      return `Status: ${e.fromStatus ? STATUS_LABELS[e.fromStatus] : '–'} → ${e.toStatus ? STATUS_LABELS[e.toStatus] : '–'}`
    case 'internal_status_changed': {
      const to = e.data.to as InternalStatus | null
      return `Interner Status: ${to ? INTERNAL_STATUS_LABELS[to] : 'zurückgesetzt'}`
    }
    case 'assigned': {
      const name = typeof e.data.assigneeName === 'string' ? e.data.assigneeName : null
      return name ? `hat ${name} zugewiesen` : 'hat die Zuweisung entfernt'
    }
    case 'commented':
      return 'hat kommentiert'
    case 'change_proposed': {
      const total = typeof e.data.totalCents === 'number' ? e.data.totalCents : null
      return `hat eine Änderung vorgeschlagen${total != null ? ` (neuer Preis ${formatMoney(total)})` : ''}`
    }
    case 'change_accepted':
    case 'change_rejected': {
      const verb = e.type === 'change_accepted' ? 'Zustimmung' : 'Ablehnung'
      // Von Mitarbeitern für den Kunden eingetragen (Issue #113).
      if (e.data.onBehalf === true) {
        const note = typeof e.data.note === 'string' ? e.data.note : ''
        return `hat die ${verb} des Kunden eingetragen${note ? ` („${note}“)` : ''}`
      }
      return e.type === 'change_accepted' ? 'hat der Änderung zugestimmt' : 'hat die Änderung abgelehnt'
    }
    case 'change_withdrawn':
      return 'hat den Änderungsvorschlag zurückgezogen'
    case 'print_sheet_changed': {
      const name = (v: unknown) => (typeof v === 'string' ? v : 'wie berechnet')
      return 'coverSheet' in e.data && e.data.coverSheet !== null
        ? `hat den Druckbogen auf ${name(e.data.sheet)}, Deckblatt ${name(e.data.coverSheet)} gesetzt`
        : `hat den Druckbogen auf ${name(e.data.sheet)} gesetzt`
    }
    case 'dates_changed': {
      const what = e.data.field === 'internalDueDate' ? 'die interne Frist' : 'den zugesagten Termin'
      const to = typeof e.data.to === 'string' ? e.data.to : null
      return to ? `hat ${what} auf ${formatDate(to)} gesetzt` : `hat ${what} entfernt`
    }
  }
}

function History({ request, isNew }: { request: Detail; isNew: (e: Entry) => boolean }) {
  return (
    <Card title="Verlauf">
      <ol className="space-y-3 text-sm">
        {request.events.map((e) => (
          <li key={e.id} className={cx('border-l-2 pl-3', isNew(e) ? 'border-sky-500 bg-sky-50' : 'border-slate-200')}>
            <div>
              <span className="font-medium">{e.actorName ?? 'System'}</span> {describeEvent(e)}
            </div>
            <div className="text-xs text-slate-600">{formatDateTime(e.createdAt)}</div>
          </li>
        ))}
      </ol>
    </Card>
  )
}

const PDF_STATUS_TEXT = {
  ok: null,
  encrypted: 'PDF ist geschützt',
  unreadable: 'PDF konnte nicht gelesen werden',
  not_pdf: 'Keine PDF',
} as const

function Files({ request, staff }: { request: Detail; staff: boolean }) {
  if (request.files.length === 0) return null
  // Ohne eigene Deckblatt-Datei kommt das Deckblatt aus der Druckdatei (Issue #85).
  const coverFromMain = request.order?.coverPaper ? coverPagesFromMainFile(request.order.spec) : null
  return (
    <Card title="Dateien">
      <ul className="divide-y divide-slate-100 text-sm">
        {request.files.map((f) => {
          const problem = PDF_STATUS_TEXT[f.pdfStatus]
          return (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <a href={`/api/dateien/${f.id}`} className="font-medium text-slate-900 underline">
                  {f.filename}
                </a>
                <span className="ml-2 text-slate-500">
                  {f.role === 'cover' ? 'Deckblatt · ' : ''}
                  {formatBytes(f.sizeBytes)}
                  {f.pageCount != null ? ` · ${f.pageCount} S.` : ''}
                  {f.pageWidthMm && f.pageHeightMm ? ` · ${f.pageWidthMm} × ${f.pageHeightMm} mm` : ''}
                </span>
              </div>
              {staff && (problem || f.mixedPageSizes) ? (
                <Badge className="bg-amber-100 text-amber-800">{problem ?? 'Unterschiedliche Seitengrößen'}</Badge>
              ) : null}
            </li>
          )
        })}
      </ul>
      {coverFromMain ? (
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Keine separate Deckblatt-Datei: Das Deckblatt wird aus der Druckdatei gedruckt, vorne {coverFromMain.front}
          {coverFromMain.back ? `, hinten ${coverFromMain.back}` : ''}.
        </p>
      ) : null}
    </Card>
  )
}

function InvoiceCard({ request }: { request: Detail }) {
  return (
    <Card title="Rechnung">
      <div className="space-y-3 text-sm">
        <p>
          {request.invoiceExportedAt
            ? `Am ${formatDateTime(request.invoiceExportedAt)} an Lexware übergeben.`
            : 'Noch nicht an Lexware übergeben.'}
        </p>
        <LexwareExportButton
          ids={[request.id]}
          label={request.invoiceExportedAt ? 'Erneut für Lexware exportieren' : 'Für Lexware exportieren'}
        />
      </div>
    </Card>
  )
}

function PriceCard({ request, staff }: { request: Detail; staff: boolean }) {
  const order = request.order
  if (!order) return null
  const { price } = order
  return (
    <Card title="Preis">
      <dl className="space-y-1 text-sm">
        {staff
          ? price.lines.map((line, i) => (
              <div
                key={line.key}
                className={cx(
                  'flex justify-between gap-2',
                  i === price.lines.length - 1 && 'mb-3 border-b border-slate-100 pb-3',
                )}
              >
                <dt>
                  {line.label}
                  <span className="block text-xs text-slate-600">{line.detail}</span>
                </dt>
                <dd className="whitespace-nowrap">{formatMoney(line.amountCents)}</dd>
              </div>
            ))
          : null}
        <div className="flex justify-between">
          <dt>Druckkosten</dt>
          <dd>{formatMoney(price.printCents)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Lieferkosten ({DELIVERY_LABELS[request.deliveryMethod]})</dt>
          <dd>{formatMoney(price.deliveryCents)}</dd>
        </div>
        <div className="flex justify-between text-base font-semibold">
          <dt>Gesamt</dt>
          <dd>{formatMoney(price.totalCents)}</dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-slate-500">
        Preis zum Zeitpunkt des Absendens
        {request.termsAcceptedAt ? `, Bedingungen akzeptiert am ${formatDateTime(request.termsAcceptedAt)}` : ''}.
      </p>
    </Card>
  )
}
