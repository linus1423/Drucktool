import { useState } from 'react'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Alert, Button, Card, Field, PageHeader, Select } from '~/components/ui'
import { errorMessage } from '~/lib/errors'
import { formatDateTime } from '~/lib/format'
import { activeOrganisationsQuery, pendingRegistrationsQuery } from '~/lib/queries'
import { approveRegistrationFn, rejectRegistrationFn } from '~/server/admin/admin.functions'
import { pageTitle } from '~/lib/design'

export const Route = createFileRoute('/_app/admin/freigaben')({
  beforeLoad: ({ context }) => {
    if (context.user.role !== 'superadmin') throw redirect({ to: '/auftraege' })
  },
  loader: ({ context }) => context.queryClient.ensureQueryData(pendingRegistrationsQuery),
  head: ({ match }) => ({ meta: [{ title: pageTitle('Freigaben', match.context.design) }] }),
  component: ApprovalsPage,
})

type Registration = Awaited<ReturnType<NonNullable<(typeof pendingRegistrationsQuery)['queryFn']>>>[number]

function ApprovalsPage() {
  const { data } = useSuspenseQuery(pendingRegistrationsQuery)
  return (
    <>
      <PageHeader
        title="Freigaben"
        description="Neue Kunden können sich erst anmelden, nachdem ein Superadmin ihre Registrierung freigegeben hat."
      />
      {data.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-600">Keine offenen Registrierungen.</p>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {data.map((r) => (
            <RegistrationCard key={r.id} registration={r} />
          ))}
        </div>
      )}
    </>
  )
}

function RegistrationCard({ registration: r }: { registration: Registration }) {
  const queryClient = useQueryClient()
  const organisations = useQuery(activeOrganisationsQuery)
  const [existingOrganisationId, setExistingOrganisationId] = useState('')
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: pendingRegistrationsQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: ['admin'] }),
      queryClient.invalidateQueries({ queryKey: ['organisations'] }),
    ])

  const approve = useMutation({
    mutationFn: () => approveRegistrationFn({ data: { userId: r.id, existingOrganisationId: existingOrganisationId || null } }),
    onSuccess: refresh,
  })
  const reject = useMutation({
    mutationFn: () => rejectRegistrationFn({ data: { userId: r.id } }),
    onSuccess: refresh,
  })
  const error = approve.error ?? reject.error

  return (
    <Card title={r.name}>
      <div className="space-y-4 text-sm">
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        <dl className="grid grid-cols-3 gap-2">
          <dt className="text-slate-500">E-Mail</dt>
          <dd className="col-span-2">{r.email}</dd>
          <dt className="text-slate-500">Firma</dt>
          <dd className="col-span-2">{r.organisationName ?? 'Keine Angabe (Anmeldung über Single Sign-on)'}</dd>
          <dt className="text-slate-500">Adresse</dt>
          <dd className="col-span-2">
            {[r.street, [r.zip, r.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '–'}
          </dd>
          <dt className="text-slate-500">Telefon</dt>
          <dd className="col-span-2">{r.phone || '–'}</dd>
          <dt className="text-slate-500">Registriert</dt>
          <dd className="col-span-2">{formatDateTime(r.createdAt)}</dd>
        </dl>
        <Field
          label="Organisation (optional)"
          htmlFor={`org-${r.id}`}
          hint="Gehört die Person zu einer bestehenden Organisation, hier auswählen."
        >
          <Select id={`org-${r.id}`} value={existingOrganisationId} onChange={(e) => setExistingOrganisationId(e.target.value)}>
            <option value="">
              {r.organisationId ? `Neue Organisation „${r.organisationName}“ freigeben` : 'Ohne Organisation'}
            </option>
            {organisations.data?.map((o) => (
              <option key={o.id} value={o.id}>
                Zu „{o.name}“ hinzufügen
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            className="text-rose-700"
            disabled={reject.isPending || approve.isPending}
            onClick={() => reject.mutate()}
          >
            Ablehnen
          </Button>
          <Button disabled={approve.isPending || reject.isPending} onClick={() => approve.mutate()}>
            Freigeben
          </Button>
        </div>
      </div>
    </Card>
  )
}
