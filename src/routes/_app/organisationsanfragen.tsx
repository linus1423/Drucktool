import { useState } from 'react'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Alert, Button, Card, Field, Input, PageHeader, Select, Textarea } from '~/components/ui'
import { errorMessage } from '~/lib/errors'
import { formatDateTime } from '~/lib/format'
import { activeOrganisationsQuery, organisationRequestsQuery } from '~/lib/queries'
import { isStaffRole } from '~/lib/roles'
import { resolveOrganisationRequestFn } from '~/server/admin/admin.functions'

// Kunden fragen im Profil eine Organisation an; hier ordnen Mitarbeiter sie zu (Issue #68).
export const Route = createFileRoute('/_app/organisationsanfragen')({
  beforeLoad: ({ context }) => {
    if (!isStaffRole(context.user.role)) throw redirect({ to: '/auftraege' })
  },
  loader: ({ context }) => context.queryClient.ensureQueryData(organisationRequestsQuery),
  head: () => ({ meta: [{ title: 'Organisationsanfragen · Drucktool' }] }),
  component: OrganisationRequestsPage,
})

type OrganisationRequest = Awaited<ReturnType<NonNullable<(typeof organisationRequestsQuery)['queryFn']>>>[number]

function OrganisationRequestsPage() {
  const { data } = useSuspenseQuery(organisationRequestsQuery)
  return (
    <>
      <PageHeader
        title="Organisationsanfragen"
        description="Kunden möchten einer Organisation zugeordnet werden. Ordnen Sie sie einer bestehenden zu, legen Sie eine neue an oder lehnen Sie ab."
      />
      {data.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-600">Keine offenen Anfragen.</p>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {data.map((r) => (
            <RequestCard key={r.id} request={r} />
          ))}
        </div>
      )}
    </>
  )
}

type Choice = 'assign' | 'create' | 'reject'

function RequestCard({ request: r }: { request: OrganisationRequest }) {
  const queryClient = useQueryClient()
  const organisations = useQuery(activeOrganisationsQuery)
  // Gibt es schon eine Organisation mit diesem Namen, liegt die Zuordnung nahe.
  const match = organisations.data?.find((o) => o.name.trim().toLowerCase() === r.name.trim().toLowerCase())
  const [choice, setChoice] = useState<Choice | null>(null)
  const [organisationId, setOrganisationId] = useState('')
  const [name, setName] = useState(r.name)
  const [note, setNote] = useState('')
  const action = choice ?? (match ? 'assign' : 'create')
  const selectedOrganisationId = organisationId || match?.id || ''

  const resolve = useMutation({
    mutationFn: () =>
      resolveOrganisationRequestFn({
        data:
          action === 'assign'
            ? { id: r.id, action, organisationId: selectedOrganisationId }
            : action === 'create'
              ? { id: r.id, action, name }
              : { id: r.id, action, note },
      }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['organisations'] }),
        queryClient.invalidateQueries({ queryKey: ['admin'] }),
      ]),
  })

  return (
    <Card title={r.name}>
      <div className="space-y-4 text-sm">
        {resolve.error ? <Alert>{errorMessage(resolve.error)}</Alert> : null}
        <dl className="grid grid-cols-3 gap-2">
          <dt className="text-slate-500">Kunde</dt>
          <dd className="col-span-2">
            {r.userName}
            <span className="block text-slate-500">{r.userEmail}</span>
          </dd>
          <dt className="text-slate-500">Angaben</dt>
          <dd className="col-span-2 whitespace-pre-wrap">{r.details || '–'}</dd>
          <dt className="text-slate-500">Angefragt</dt>
          <dd className="col-span-2">{formatDateTime(r.createdAt)}</dd>
        </dl>
        <fieldset className="space-y-2">
          <legend className="sr-only">Entscheidung</legend>
          {(
            [
              ['assign', 'Bestehender Organisation zuordnen'],
              ['create', 'Neue Organisation anlegen'],
              ['reject', 'Ablehnen'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2">
              <input type="radio" name={`choice-${r.id}`} checked={action === value} onChange={() => setChoice(value)} />
              {label}
            </label>
          ))}
        </fieldset>
        {action === 'assign' ? (
          <Field label="Organisation" htmlFor={`org-${r.id}`}>
            <Select id={`org-${r.id}`} value={selectedOrganisationId} onChange={(e) => setOrganisationId(e.target.value)}>
              <option value="">Bitte wählen</option>
              {organisations.data?.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {action === 'create' ? (
          <Field
            label="Name der neuen Organisation"
            htmlFor={`name-${r.id}`}
            hint="Weitere Stammdaten lassen sich danach unter „Organisationen“ ergänzen."
          >
            <Input id={`name-${r.id}`} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        ) : null}
        {action === 'reject' ? (
          <Field label="Begründung für den Kunden (optional)" htmlFor={`note-${r.id}`}>
            <Textarea id={`note-${r.id}`} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        ) : null}
        <div className="flex justify-end">
          <Button
            variant={action === 'reject' ? 'danger' : 'primary'}
            disabled={
              resolve.isPending || (action === 'assign' && !selectedOrganisationId) || (action === 'create' && !name.trim())
            }
            onClick={() => resolve.mutate()}
          >
            {action === 'assign' ? 'Zuordnen' : action === 'create' ? 'Anlegen und zuordnen' : 'Ablehnen'}
          </Button>
        </div>
      </div>
    </Card>
  )
}
