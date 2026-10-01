import { useMemo, type ReactNode } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { DataTable, dataColumnHelper } from '~/components/DataTable'
import { Badge, Button, Input, PageHeader, Select, StatusBadge } from '~/components/ui'
import { AttentionBadge } from '~/components/AttentionBadge'
import { formatDate, formatDateTime, formatMoney, formatRequestNumber } from '~/lib/format'
import { DELIVERY_LABELS } from '~/lib/order'
import { activeOrganisationsQuery, assignableStaffQuery, requestListQuery } from '~/lib/queries'
import { isStaffRole } from '~/lib/roles'
import { INTERNAL_STATUS_LABELS, INTERNAL_STATUS_TONES, REQUEST_STATUSES, STATUS_LABELS } from '~/lib/status'

const SORTS = ['number', 'title', 'customer', 'status', 'total', 'created', 'updated'] as const
type Sort = (typeof SORTS)[number]
const date = z.iso.date().optional().catch(undefined)

// Filter, Sortierung und Seite stehen in der URL, damit Links und „Zurück“ funktionieren (Issue #15).
const searchSchema = z.object({
  status: z.enum(REQUEST_STATUSES).optional().catch(undefined),
  ansicht: z.enum(['offen', 'fertig', 'alle', 'meine', 'fuer_mich', 'ueberfaellig']).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  org: z.uuid().optional().catch(undefined),
  zustaendig: z
    .union([z.uuid(), z.literal('none')])
    .optional()
    .catch(undefined),
  von: date,
  bis: date,
  sort: z.enum(SORTS).optional().catch(undefined),
  richtung: z.enum(['asc', 'desc']).optional().catch(undefined),
  seite: z.coerce.number().int().min(1).optional().catch(undefined),
  proSeite: z.coerce
    .number()
    .refine((n) => n === 25 || n === 50 || n === 100)
    .optional()
    .catch(undefined),
})

type Search = z.infer<typeof searchSchema>

/** Spalten-IDs der Tabelle, nach denen der Server sortieren kann. */
const COLUMN_SORT: Record<string, Sort> = {
  number: 'number',
  title: 'title',
  creatorName: 'customer',
  status: 'status',
  totalCents: 'total',
  createdAt: 'created',
  updatedAt: 'updated',
}

export const Route = createFileRoute('/_app/auftraege/')({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(requestListQuery(toFilter(deps))),
  head: () => ({ meta: [{ title: 'Aufträge · Drucktool' }] }),
  component: RequestListPage,
})

function toFilter(search: Search) {
  const view = search.ansicht ?? 'offen'
  return {
    status: search.status,
    open: view === 'offen' && !search.status ? true : undefined,
    done: view === 'fertig' && !search.status ? true : undefined,
    assignedToMe: view === 'meine' ? true : undefined,
    overdue: view === 'ueberfaellig' ? true : undefined,
    watching: view === 'fuer_mich' ? true : undefined,
    search: search.q || undefined,
    organisationId: search.org,
    assigneeId: search.zustaendig,
    from: search.von,
    to: search.bis,
    sort: search.sort,
    dir: search.richtung,
    page: search.seite,
    pageSize: search.proSeite as 25 | 50 | 100 | undefined,
  }
}

type Row = Awaited<ReturnType<NonNullable<ReturnType<typeof requestListQuery>['queryFn']>>>['rows'][number]

const col = dataColumnHelper<Row>()

function RequestListPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { user } = Route.useRouteContext()
  const staff = isStaffRole(user.role)
  const { data } = useSuspenseQuery(requestListQuery(toFilter(search)))
  const organisations = useQuery({ ...activeOrganisationsQuery, enabled: staff })
  const staffList = useQuery({ ...assignableStaffQuery, enabled: staff })
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize))
  // Filteränderungen springen auf Seite 1 zurück.
  const setFilter = (patch: Partial<Search>) => navigate({ search: (prev) => ({ ...prev, ...patch, seite: undefined }) })
  const sortColumn = Object.entries(COLUMN_SORT).find(([, v]) => v === (search.sort ?? 'updated'))?.[0] ?? 'updatedAt'
  const sortDesc = (search.richtung ?? (search.sort === 'title' || search.sort === 'customer' ? 'asc' : 'desc')) === 'desc'
  const { page: _page, pageSize: _size, ...exportFilter } = toFilter(search)
  const exportHref = `/api/auftraege/export?filter=${encodeURIComponent(JSON.stringify(exportFilter))}`

  const columns = useMemo(
    () => [
      col.accessor('number', {
        header: 'Nr.',
        cell: (info) => <span className="font-mono text-slate-600">{formatRequestNumber(info.getValue())}</span>,
      }),
      col.accessor('title', {
        header: 'Titel',
        sortFn: 'text',
        cell: (info) => (
          <Link to="/auftraege/$requestId" params={{ requestId: info.row.original.id }} className="font-medium hover:underline">
            {info.getValue()}
          </Link>
        ),
      }),
      ...(staff
        ? [
            col.accessor('creatorName', {
              header: 'Kunde',
              sortFn: 'text',
              cell: (info) => (
                <>
                  {info.getValue()}
                  {info.row.original.organisationName ? (
                    <span className="block text-xs text-slate-500">{info.row.original.organisationName}</span>
                  ) : null}
                </>
              ),
            }),
          ]
        : []),
      col.accessor('status', {
        header: 'Status',
        cell: (info) => {
          const internal = info.row.original.internalStatus
          return (
            <span className="inline-flex flex-wrap gap-1">
              <StatusBadge status={info.getValue()} />
              {internal ? <Badge className={INTERNAL_STATUS_TONES[internal]}>{INTERNAL_STATUS_LABELS[internal]}</Badge> : null}
              {info.row.original.attention ? <AttentionBadge attention={info.row.original.attention} /> : null}
            </span>
          )
        },
      }),
      col.accessor('promisedDate', {
        header: 'Termin',
        enableSorting: false,
        cell: (info) => (
          <>
            {info.getValue() ? formatDate(info.getValue()) : '–'}
            {info.row.original.internalDueDate ? (
              <span className="block text-xs text-slate-500">intern {formatDate(info.row.original.internalDueDate)}</span>
            ) : null}
          </>
        ),
      }),
      col.accessor('quantity', {
        header: 'Exemplare',
        enableSorting: false,
        cell: (info) => info.getValue()?.toLocaleString('de-DE') ?? '–',
      }),
      col.accessor('totalCents', { header: 'Preis', cell: (info) => formatMoney(info.getValue()) }),
      col.accessor('deliveryMethod', {
        header: 'Lieferung',
        enableSorting: false,
        cell: (info) =>
          info.getValue() === 'house_post' ? (
            <Badge className="bg-violet-100 text-violet-800">{DELIVERY_LABELS.house_post}</Badge>
          ) : (
            <span className="text-slate-500">{DELIVERY_LABELS.pickup}</span>
          ),
      }),
      ...(staff
        ? [col.accessor('assigneeName', { header: 'Zuständig', enableSorting: false, cell: (info) => info.getValue() ?? '–' })]
        : []),
      col.accessor('updatedAt', {
        header: 'Zuletzt geändert',
        sortFn: 'datetime',
        cell: (info) => formatDateTime(info.getValue()),
      }),
    ],
    [staff],
  )

  return (
    <>
      <PageHeader
        title="Aufträge"
        description={staff ? 'Alle Aufträge der Kunden' : 'Ihre Aufträge'}
        actions={
          <Link
            to="/auftraege/neu"
            className="inline-flex items-center rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Neuer Auftrag
          </Link>
        }
      />
      <DataTable
        data={data.rows}
        columns={columns}
        sorting={[{ id: sortColumn, desc: sortDesc }]}
        onSortingChange={(next) => {
          const first = next[0]
          const sort = first ? COLUMN_SORT[first.id] : undefined
          if (!sort) return
          void setFilter({ sort, richtung: first!.desc ? 'desc' : 'asc' })
        }}
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
            <span>
              {data.total.toLocaleString('de-DE')} {data.total === 1 ? 'Auftrag' : 'Aufträge'}
              {pages > 1 ? ` · Seite ${data.page} von ${pages}` : ''}
            </span>
            <div className="flex items-center gap-2">
              <Select
                aria-label="Aufträge pro Seite"
                value={String(data.pageSize)}
                onChange={(e) => setFilter({ proSeite: Number(e.target.value) as 25 | 50 | 100 })}
                className="w-auto"
              >
                {[25, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n} pro Seite
                  </option>
                ))}
              </Select>
              <Button
                variant="secondary"
                disabled={data.page <= 1}
                onClick={() =>
                  navigate({ search: (prev) => ({ ...prev, seite: data.page - 1 > 1 ? data.page - 1 : undefined }) })
                }
              >
                Zurück
              </Button>
              <Button
                variant="secondary"
                disabled={data.page >= pages}
                onClick={() => navigate({ search: (prev) => ({ ...prev, seite: data.page + 1 }) })}
              >
                Weiter
              </Button>
            </div>
          </div>
        }
        onRowClick={(row) => navigate({ to: '/auftraege/$requestId', params: { requestId: row.id } })}
        emptyText="Keine Aufträge gefunden."
        toolbar={
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                const q = new FormData(e.currentTarget).get('q')?.toString() ?? ''
                void setFilter({ q: q || undefined })
              }}
            >
              <Input
                key={search.q ?? ''}
                name="q"
                type="search"
                defaultValue={search.q ?? ''}
                placeholder={staff ? 'Suche nach Titel, Kunde oder Nr.' : 'Suche nach Titel oder Nr.'}
                className="w-72"
              />
            </form>
            <Select
              aria-label="Ansicht"
              value={search.ansicht ?? 'offen'}
              onChange={(e) => setFilter({ ansicht: e.target.value as NonNullable<Search['ansicht']> })}
              className="w-auto"
            >
              <option value="offen">{staff ? 'Warteschlange (offen)' : 'Offene Aufträge'}</option>
              <option value="fertig">Fertige Aufträge</option>
              <option value="alle">Alle Aufträge</option>
              {staff ? <option value="meine">Mir zugewiesen</option> : null}
              {staff ? <option value="fuer_mich">Für mich (beobachtet)</option> : null}
              <option value="ueberfaellig">Überfällig</option>
            </Select>
            <Select
              aria-label="Status"
              value={search.status ?? ''}
              onChange={(e) => setFilter({ status: (e.target.value || undefined) as Row['status'] | undefined })}
              className="w-auto"
            >
              <option value="">Alle Status</option>
              {REQUEST_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
            {staff ? (
              <>
                <Select
                  aria-label="Organisation"
                  value={search.org ?? ''}
                  onChange={(e) => setFilter({ org: e.target.value || undefined })}
                  className="w-auto"
                >
                  <option value="">Alle Organisationen</option>
                  {organisations.data?.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label="Zuständig"
                  value={search.zustaendig ?? ''}
                  onChange={(e) => setFilter({ zustaendig: (e.target.value || undefined) as Search['zustaendig'] })}
                  className="w-auto"
                >
                  <option value="">Alle Zuständigen</option>
                  <option value="none">Niemand zugewiesen</option>
                  {staffList.data?.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </>
            ) : null}
            <DateFilter label="Angelegt ab" value={search.von} onChange={(von) => setFilter({ von })} />
            <DateFilter label="bis" value={search.bis} onChange={(bis) => setFilter({ bis })} />
            <a
              href={exportHref}
              download
              className="ml-auto inline-flex items-center rounded-md px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-100"
            >
              Als CSV exportieren
            </a>
          </>
        }
      />
    </>
  )
}

function DateFilter({
  label,
  value,
  onChange,
}: {
  label: string
  value?: string
  onChange: (v: string | undefined) => void
}): ReactNode {
  return (
    <label className="flex items-center gap-1 text-sm text-slate-600">
      {label}
      <Input type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)} className="w-auto" />
    </label>
  )
}
