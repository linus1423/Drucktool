import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { DataTable, dataColumnHelper } from '~/components/DataTable'
import { Badge, PageHeader } from '~/components/ui'
import { formatDate } from '~/lib/format'
import { organisationsQuery } from '~/lib/queries'
import { ORG_STATUS } from '~/lib/roles'

export const Route = createFileRoute('/_app/admin/organisationen/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(organisationsQuery),
  head: () => ({ meta: [{ title: 'Organisationen · Drucktool' }] }),
  component: OrganisationsPage,
})

type Row = Awaited<ReturnType<NonNullable<(typeof organisationsQuery)['queryFn']>>>[number]
const col = dataColumnHelper<Row>()


const columns = [
  col.accessor('name', { header: 'Name', sortFn: 'text', cell: (i) => <span className="font-medium">{i.getValue()}</span> }),
  col.accessor('city', { header: 'Ort', cell: (i) => i.getValue() ?? '–' }),
  col.accessor('email', { header: 'E-Mail', cell: (i) => i.getValue() ?? '–' }),
  col.accessor('memberCount', { header: 'Benutzer' }),
  col.accessor('requestCount', { header: 'Aufträge' }),
  col.accessor('status', {
    header: 'Status',
    cell: (i) => <Badge className={ORG_STATUS[i.getValue()].className}>{ORG_STATUS[i.getValue()].label}</Badge>,
  }),
  col.accessor('createdAt', { header: 'Angelegt', sortFn: 'datetime', cell: (i) => formatDate(i.getValue()) }),
]

function OrganisationsPage() {
  const { data } = useSuspenseQuery(organisationsQuery)
  const navigate = useNavigate()
  return (
    <>
      <PageHeader
        title="Organisationen"
        description="Kunden der Druckerei. Organisationen sind optional; ein Kunde kann keiner, einer oder mehreren angehören."
        actions={
          <Link
            to="/admin/organisationen/neu"
            className="inline-flex items-center rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Neue Organisation
          </Link>
        }
      />
      <DataTable
        data={data}
        columns={columns}
        initialSorting={[{ id: 'name', desc: false }]}
        searchPlaceholder="Organisationen durchsuchen"
        onRowClick={(row) => navigate({ to: '/admin/organisationen/$organisationId', params: { organisationId: row.id } })}
      />
    </>
  )
}
