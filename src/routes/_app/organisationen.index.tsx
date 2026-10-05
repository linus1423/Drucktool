import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { Card, PageHeader } from '~/components/ui'
import { pageTitle } from '~/lib/design'

// Einstieg „Organisation“ in der Kopfzeile (Issue #162): Wer genau eine Organisation verwaltet, landet direkt
// in deren Verwaltung, wer mehrere verwaltet, wählt hier aus.
export const Route = createFileRoute('/_app/organisationen/')({
  beforeLoad: ({ context }) => {
    const managed = context.user.organisations.filter((o) => o.isAdmin)
    if (managed.length === 0) throw redirect({ to: '/profil' })
    if (managed.length === 1) {
      throw redirect({ to: '/organisationen/$organisationId', params: { organisationId: managed[0]!.id }, replace: true })
    }
    return { managed }
  },
  head: ({ match }) => ({ meta: [{ title: pageTitle('Organisationen', match.context.design) }] }),
  component: ChooseOrganisationPage,
})

function ChooseOrganisationPage() {
  const { managed } = Route.useRouteContext()
  return (
    <div className="space-y-6">
      <PageHeader title="Organisationen" description="Wählen Sie die Organisation, die Sie verwalten möchten." />
      <Card>
        <ul className="divide-y divide-slate-100 text-sm">
          {managed.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="font-medium">{o.name}</span>
              <Link
                to="/organisationen/$organisationId"
                params={{ organisationId: o.id }}
                className="font-medium text-accent-strong hover:underline"
              >
                Verwalten
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
