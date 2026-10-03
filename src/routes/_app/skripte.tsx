import { useState } from 'react'
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, StatusBadge, Textarea } from '~/components/ui'
import { errorMessage } from '~/lib/errors'
import { formatDate, formatRequestNumber } from '~/lib/format'
import { scriptsQuery } from '~/lib/queries'
import { isStaffRole } from '~/lib/roles'
import type { RequestStatus } from '~/lib/status'
import { copyScriptFn, createScriptFn, updateScriptFn } from '~/server/scripts/scripts.functions'

// Skriptenverwaltung der SVK (Issue #59). Mitarbeiter sehen alle Skripte, die SVK nur ihre. Verwalten dürfen
// SVK-Mitglieder, Admins und dafür freigegebene Mitarbeiter (Issue #158); nachbestellen nur SVK-Mitglieder.
export const Route = createFileRoute('/_app/skripte')({
  validateSearch: z.object({
    semester: z.string().max(50).optional().catch(undefined),
    archiv: z.coerce.boolean().optional().catch(undefined),
  }),
  beforeLoad: ({ context }) => {
    const user = context.user
    if (!isStaffRole(user.role) && !user.organisations.some((o) => o.isSvk)) throw redirect({ to: '/auftraege' })
  },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(scriptsQuery({ semester: deps.semester, archived: deps.archiv })),
  head: () => ({ meta: [{ title: 'Skripte · Drucktool' }] }),
  component: ScriptsPage,
})

type Data = Awaited<ReturnType<NonNullable<ReturnType<typeof scriptsQuery>['queryFn']>>>
type Script = Data['rows'][number]

const linkButton =
  'inline-flex items-center rounded-md px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-100'

function ScriptsPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { data } = useSuspenseQuery(scriptsQuery({ semester: search.semester, archived: search.archiv }))
  const [creating, setCreating] = useState(false)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Skripte"
        description={
          data.canManage
            ? 'Skripte als Vorlagen: Nachbestellen übernimmt Dateien und Optionen des letzten Auftrags. Fertige Aufträge erhöhen den Bestand.'
            : 'Skripte der SVK mit Bestand und Nachbestellungen.'
        }
        actions={
          data.canManage && data.organisations.length > 0 && !creating ? (
            <Button onClick={() => setCreating(true)}>Neues Skript</Button>
          ) : null
        }
      />
      {creating ? <ScriptForm organisations={data.organisations} onDone={() => setCreating(false)} /> : null}
      <div className="flex flex-wrap gap-2">
        <Select
          aria-label="Semester"
          className="w-auto"
          value={search.semester ?? ''}
          onChange={(e) => navigate({ search: (prev) => ({ ...prev, semester: e.target.value || undefined }) })}
        >
          <option value="">Alle Semester</option>
          {data.semesters.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Archiv"
          className="w-auto"
          value={search.archiv ? 'archiv' : ''}
          onChange={(e) => navigate({ search: (prev) => ({ ...prev, archiv: e.target.value ? true : undefined }) })}
        >
          <option value="">Aktuelle Skripte</option>
          <option value="archiv">Archiviert</option>
        </Select>
      </div>
      {data.rows.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">
            {data.canManage ? 'Noch keine Skripte. Legen Sie mit „Neues Skript“ das erste an.' : 'Keine Skripte.'}
          </p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {data.rows.map((s) => (
            <ScriptRow
              key={s.id}
              script={s}
              canManage={data.canManage}
              canOrder={data.canOrder}
              showOrganisation={data.showOrganisation}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function ScriptRow({
  script: s,
  canManage,
  canOrder,
  showOrganisation,
}: {
  script: Script
  canManage: boolean
  canOrder: boolean
  showOrganisation: boolean
}) {
  const [editing, setEditing] = useState(false)
  const queryClient = useQueryClient()
  const copy = useMutation({
    mutationFn: (semester: string) => copyScriptFn({ data: { id: s.id, semester } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scripts'] }),
  })
  if (editing) return <ScriptForm script={s} onDone={() => setEditing(false)} />
  return (
    <li>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3 text-sm">
          <div className="min-w-0 space-y-1">
            <h2 className="text-base font-semibold">
              {s.title} {s.archived ? <Badge>Archiviert</Badge> : null}
            </h2>
            <p className="text-slate-600">
              {[s.lecturer, s.semester, showOrganisation ? s.organisationName : null].filter(Boolean).join(' · ')}
            </p>
            <p>
              <strong>Bestand: {s.stock.toLocaleString('de-DE')}</strong>
              {s.openCopies ? ` · ${s.openCopies.toLocaleString('de-DE')} in Arbeit` : ''}
              {` · ${s.printedCopies.toLocaleString('de-DE')} gedruckt in ${s.orders} ${s.orders === 1 ? 'Auftrag' : 'Aufträgen'}`}
            </p>
            {s.lastOrder ? (
              <p className="flex flex-wrap items-center gap-2 text-slate-600">
                Letzter Auftrag:
                <Link to="/auftraege/$requestId" params={{ requestId: s.lastOrder.id }} className="underline">
                  {formatRequestNumber(s.lastOrder.number)}
                </Link>
                vom {formatDate(s.lastOrder.createdAt)}
                <StatusBadge status={s.lastOrder.status as RequestStatus} />
              </p>
            ) : null}
            {s.notes ? <p className="whitespace-pre-wrap text-slate-600">{s.notes}</p> : null}
            {copy.error ? <Alert>{errorMessage(copy.error)}</Alert> : null}
          </div>
          {canManage && !s.archived ? (
            <div className="flex flex-wrap gap-2">
              {canOrder ? (
                <Link
                  to="/auftraege/neu"
                  search={{ vorlage: s.templateRequestId ?? undefined, skript: s.id }}
                  className={
                    s.templateRequestId
                      ? 'inline-flex items-center rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700'
                      : linkButton
                  }
                >
                  {s.templateRequestId ? 'Nachbestellen' : 'Erste Bestellung'}
                </Link>
              ) : null}
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Bearbeiten
              </Button>
              <Button
                variant="ghost"
                disabled={copy.isPending}
                onClick={() => {
                  const semester = window.prompt('Für welches Semester? (z. B. SS 2027)')?.trim()
                  if (semester) copy.mutate(semester)
                }}
              >
                Für neues Semester kopieren
              </Button>
            </div>
          ) : null}
        </div>
      </Card>
    </li>
  )
}

function ScriptForm({
  script,
  organisations = [],
  onDone,
}: {
  script?: Script
  organisations?: { id: string; name: string }[]
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const [values, setValues] = useState({
    title: script?.title ?? '',
    lecturer: script?.lecturer ?? '',
    semester: script?.semester ?? '',
    stock: String(script?.stock ?? 0),
    notes: script?.notes ?? '',
    archived: script?.archived ?? false,
    organisationId: organisations[0]?.id ?? '',
  })
  const set = (patch: Partial<typeof values>) => setValues((v) => ({ ...v, ...patch }))
  const save = useMutation({
    mutationFn: async () => {
      const common = {
        title: values.title,
        lecturer: values.lecturer,
        semester: values.semester,
        stock: Number.parseInt(values.stock, 10) || 0,
        notes: values.notes,
      }
      if (script) {
        await updateScriptFn({ data: { ...common, id: script.id, archived: values.archived, previousStock: script.stock } })
      } else await createScriptFn({ data: { ...common, organisationId: values.organisationId } })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['scripts'] })
      onDone()
    },
  })
  const id = script?.id ?? 'neu'
  return (
    <Card title={script ? `${script.title} bearbeiten` : 'Neues Skript'}>
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        {save.error ? (
          <div className="sm:col-span-2">
            <Alert>{errorMessage(save.error)}</Alert>
          </div>
        ) : null}
        <div className="sm:col-span-2">
          <Field label="Titel" htmlFor={`${id}-title`}>
            <Input
              id={`${id}-title`}
              required
              maxLength={200}
              value={values.title}
              onChange={(e) => set({ title: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Dozent oder Lehrstuhl" htmlFor={`${id}-lecturer`}>
          <Input
            id={`${id}-lecturer`}
            maxLength={200}
            value={values.lecturer}
            onChange={(e) => set({ lecturer: e.target.value })}
          />
        </Field>
        <Field label="Semester" htmlFor={`${id}-semester`} hint="z. B. WS 2026/27">
          <Input
            id={`${id}-semester`}
            required
            maxLength={50}
            value={values.semester}
            onChange={(e) => set({ semester: e.target.value })}
          />
        </Field>
        <Field label="Bestand (Exemplare)" htmlFor={`${id}-stock`}>
          <Input
            id={`${id}-stock`}
            type="number"
            min={0}
            inputMode="numeric"
            value={values.stock}
            onChange={(e) => set({ stock: e.target.value })}
          />
        </Field>
        {!script && organisations.length > 1 ? (
          <Field label="SVK" htmlFor={`${id}-org`}>
            <Select id={`${id}-org`} value={values.organisationId} onChange={(e) => set({ organisationId: e.target.value })}>
              {organisations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <div className="sm:col-span-2">
          <Field label="Notizen" htmlFor={`${id}-notes`}>
            <Textarea
              id={`${id}-notes`}
              rows={2}
              maxLength={2000}
              value={values.notes}
              onChange={(e) => set({ notes: e.target.value })}
            />
          </Field>
        </div>
        {script ? (
          <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2">
            <input type="checkbox" checked={values.archived} onChange={(e) => set({ archived: e.target.checked })} />
            Archiviert (wird nicht mehr nachbestellt)
          </label>
        ) : null}
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button variant="secondary" onClick={onDone}>
            Abbrechen
          </Button>
          <Button type="submit" disabled={save.isPending}>
            Speichern
          </Button>
        </div>
      </form>
    </Card>
  )
}
