import { useState } from 'react'
import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { OrganisationForm } from '~/components/OrganisationForm'
import { Alert, Card, PageHeader } from '~/components/ui'
import { USER_STATUS_LABELS } from '~/lib/roles'
import { organisationQuery } from '~/lib/queries'
import { errorMessage } from '~/lib/errors'
import { saveOrganisationFn, setOrganisationAdminFn } from '~/server/admin/admin.functions'
import { pageTitle } from '~/lib/design'

export const Route = createFileRoute('/_app/admin/organisationen/$organisationId')({
  loader: ({ context, params }) => {
    if (!UUID.test(params.organisationId)) throw notFound()
    return context.queryClient.ensureQueryData(organisationQuery(params.organisationId))
  },
  head: ({ loaderData, match }) => ({ meta: [{ title: pageTitle(loaderData?.name ?? 'Organisation', match.context.design) }] }),
  notFoundComponent: () => (
    <div className="space-y-4">
      <Alert>Organisation nicht gefunden</Alert>
      <Link to="/admin/organisationen" className="text-sm underline">
        Zurück zur Übersicht
      </Link>
    </div>
  ),
  component: OrganisationPage,
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function OrganisationPage() {
  const { organisationId } = Route.useParams()
  const { data: org } = useSuspenseQuery(organisationQuery(organisationId))
  const queryClient = useQueryClient()
  const [saved, setSaved] = useState(false)
  const setAdmin = useMutation({
    mutationFn: (data: { userId: string; isAdmin: boolean }) => setOrganisationAdminFn({ data: { ...data, organisationId } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: organisationQuery(organisationId).queryKey }),
  })

  return (
    <div className="space-y-6">
      <div>
        <Link to="/admin/organisationen" className="text-sm text-slate-500 hover:text-slate-900">
          ← Alle Organisationen
        </Link>
      </div>
      <PageHeader title={org.name} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Stammdaten" className="lg:col-span-2">
          <div className="space-y-4">
            {saved ? <Alert tone="success">Gespeichert.</Alert> : null}
            <OrganisationForm
              key={org.updatedAt.toString()}
              initial={{
                name: org.name,
                email: org.email ?? '',
                phone: org.phone ?? '',
                street: org.street ?? '',
                zip: org.zip ?? '',
                city: org.city ?? '',
                country: org.country,
                vatId: org.vatId ?? '',
                costCenter: org.costCenter ?? '',
                isSvk: org.isSvk,
                status: org.status,
              }}
              submitLabel="Speichern"
              onSubmit={async (values) => {
                setSaved(false)
                await saveOrganisationFn({ data: { ...values, id: org.id } })
                await queryClient.invalidateQueries({ queryKey: ['admin'] })
                await queryClient.invalidateQueries({ queryKey: ['organisations'] })
                setSaved(true)
              }}
            />
          </div>
        </Card>
        <Card title="Benutzer">
          <p className="mb-2 text-sm text-slate-500">
            Verwalter laden Kollegen selbst ein, entfernen Mitglieder und sehen alle Aufträge der Organisation.
          </p>
          {setAdmin.error ? <Alert>{errorMessage(setAdmin.error)}</Alert> : null}
          {org.members.length === 0 ? (
            <p className="text-sm text-slate-500">Keine Benutzer.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {org.members.map((m) => (
                <li key={m.id} className="py-2">
                  <div className="font-medium">{m.name}</div>
                  <div className="text-slate-500">
                    {m.email} · {USER_STATUS_LABELS[m.status]}
                  </div>
                  <label className="mt-1 flex items-center gap-2 text-slate-700">
                    <input
                      type="checkbox"
                      checked={m.isAdmin}
                      disabled={setAdmin.isPending}
                      onChange={(e) => setAdmin.mutate({ userId: m.id, isAdmin: e.target.checked })}
                    />
                    Verwalter
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}
