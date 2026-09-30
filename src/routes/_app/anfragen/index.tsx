import { useMemo } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { DataTable, dataColumnHelper } from '~/components/DataTable'
import { Input, PageHeader, Select, StatusBadge } from '~/components/ui'
import { formatDate, formatDateTime, formatRequestNumber } from '~/lib/format'
import { requestListQuery } from '~/lib/queries'
import { isStaffRole } from '~/lib/roles'
import { REQUEST_STATUSES, STATUS_LABELS } from '~/lib/status'

const searchSchema = z.object({
  status: z.enum(REQUEST_STATUSES).optional().catch(undefined),
  ansicht: z.enum(['offen', 'alle', 'meine']).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/_app/anfragen/')({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(requestListQuery(toFilter(deps))),
  head: () => ({ meta: [{ title: 'Anfragen · Drucktool' }] }),
  component: RequestListPage,
})

function toFilter(search: z.infer<typeof searchSchema>) {
  const view = search.ansicht ?? 'offen'
  return {
    status: search.status,
    open: view === 'offen' && !search.status ? true : undefined,
    assignedToMe: view === 'meine' ? true : undefined,
    search: search.q || undefined,
  }
}

type Row = Awaited<ReturnType<NonNullable<ReturnType<typeof requestListQuery>['queryFn']>>>[number]

const col = dataColumnHelper<Row>()

function RequestListPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { user } = Route.useRouteContext()
  const staff = isStaffRole(user.role)
  const { data } = useSuspenseQuery(requestListQuery(toFilter(search)))

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
          <Link to="/anfragen/$requestId" params={{ requestId: info.row.original.id }} className="font-medium hover:underline">
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
      col.accessor('status', { header: 'Status', cell: (info) => <StatusBadge status={info.getValue()} /> }),
      col.accessor('quantity', {
        header: 'Auflage',
        cell: (info) => info.getValue()?.toLocaleString('de-DE') ?? '–',
      }),
      col.accessor('desiredDate', { header: 'Wunschtermin', cell: (info) => formatDate(info.getValue()) }),
      ...(staff ? [col.accessor('assigneeName', { header: 'Zuständig', cell: (info) => info.getValue() ?? '–' })] : []),
      col.accessor('updatedAt', { header: 'Zuletzt geändert', sortFn: 'datetime', cell: (info) => formatDateTime(info.getValue()) }),
    ],
    [staff],
  )

  return (
    <>
      <PageHeader
        title="Anfragen"
        description={staff ? 'Alle Anfragen der Kunden' : 'Ihre Anfragen'}
        actions={
          <Link
            to="/anfragen/neu"
            className="inline-flex items-center rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Neue Anfrage
          </Link>
        }
      />
      <DataTable
        data={data}
        columns={columns}
        onRowClick={(row) => navigate({ to: '/anfragen/$requestId', params: { requestId: row.id } })}
        emptyText="Keine Anfragen gefunden."
        toolbar={
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                const q = new FormData(e.currentTarget).get('q')?.toString() ?? ''
                void navigate({ search: (prev) => ({ ...prev, q: q || undefined }) })
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
              onChange={(e) =>
                navigate({ search: (prev) => ({ ...prev, ansicht: e.target.value as 'offen' | 'alle' | 'meine' }) })
              }
              className="w-auto"
            >
              <option value="offen">Offene Anfragen</option>
              <option value="alle">Alle Anfragen</option>
              {staff ? <option value="meine">Mir zugewiesen</option> : null}
            </Select>
            <Select
              aria-label="Status"
              value={search.status ?? ''}
              onChange={(e) =>
                navigate({
                  search: (prev) => ({ ...prev, status: (e.target.value || undefined) as Row['status'] | undefined }),
                })
              }
              className="w-auto"
            >
              <option value="">Alle Status</option>
              {REQUEST_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </>
        }
      />
    </>
  )
}
