import { useState } from 'react'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { OrganisationForm, type OrganisationValues } from '~/components/OrganisationForm'
import { Alert, Button, Card, Field, PageHeader, Select, Textarea } from '~/components/ui'
import { errorMessage } from '~/lib/errors'
import { formatDateTime } from '~/lib/format'
import { STRONG_MATCH_THRESHOLD } from '~/lib/organisation-match'
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
  // Die naheliegendste bestehende Organisation wird vorgeschlagen (Issue #176); passt sie sehr gut, ist die Zuordnung vorausgewählt.
  const best = r.suggestions[0]
  const [choice, setChoice] = useState<Choice | null>(null)
  const [organisationId, setOrganisationId] = useState('')
  const [note, setNote] = useState('')
  const action = choice ?? (best && best.score >= STRONG_MATCH_THRESHOLD ? 'assign' : 'create')
  const selectedOrganisationId = organisationId || best?.id || ''
  const suggestedIds = new Set(r.suggestions.map((s) => s.id))
  // Die Angaben aus der Anfrage, im Formular nur noch zu korrigieren.
  const initial: OrganisationValues = {
    name: r.name,
    email: r.email ?? '',
    phone: r.phone ?? '',
    street: r.street ?? '',
    zip: r.zip ?? '',
    city: r.city ?? '',
    country: r.country,
    vatId: r.vatId ?? '',
    costCenter: r.costCenter ?? '',
    isSvk: false,
    status: 'active',
  }

  const resolve = useMutation({
    mutationFn: ({ status: _status, ...values }: OrganisationValues = initial) =>
      resolveOrganisationRequestFn({
        data:
          action === 'assign'
            ? { id: r.id, action, organisationId: selectedOrganisationId }
            : action === 'create'
              ? { id: r.id, action, ...values }
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
        {/* Beim Anlegen zeigt das Formular den Fehler selbst an. */}
        {resolve.error && action !== 'create' ? <Alert>{errorMessage(resolve.error)}</Alert> : null}
        <dl className="grid grid-cols-3 gap-2">
          <dt className="text-slate-500">Kunde</dt>
          <dd className="col-span-2">
            {r.userName}
            <span className="block text-slate-500">{r.userEmail}</span>
          </dd>
          <dt className="text-slate-500">Anmerkungen</dt>
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
        {best ? (
          <p className="rounded-md bg-sky-50 px-3 py-2 text-sky-900">
            Vorschlag: „{best.name}“ ({Math.round(best.score * 100)} % Übereinstimmung)
            {action !== 'assign' ? (
              <>
                {' · '}
                <button
                  type="button"
                  className="font-medium underline"
                  onClick={() => {
                    setChoice('assign')
                    setOrganisationId(best.id)
                  }}
                >
                  Zuordnen
                </button>
              </>
            ) : null}
          </p>
        ) : null}
        {action === 'assign' ? (
          <Field label="Organisation" htmlFor={`org-${r.id}`}>
            <Select id={`org-${r.id}`} value={selectedOrganisationId} onChange={(e) => setOrganisationId(e.target.value)}>
              <option value="">Bitte wählen</option>
              {r.suggestions.length > 0 ? (
                <optgroup label="Vorschläge">
                  {r.suggestions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} ({Math.round(o.score * 100)} %)
                    </option>
                  ))}
                </optgroup>
              ) : null}
              <optgroup label="Alle Organisationen">
                {organisations.data
                  ?.filter((o) => !suggestedIds.has(o.id))
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
              </optgroup>
            </Select>
          </Field>
        ) : null}
        {action === 'create' ? (
          <OrganisationForm
            initial={initial}
            withStatus={false}
            submitLabel={resolve.isPending ? 'Wird angelegt …' : 'Anlegen und zuordnen'}
            onSubmit={async (values) => {
              await resolve.mutateAsync(values)
            }}
          />
        ) : null}
        {action === 'reject' ? (
          <Field label="Begründung für den Kunden (optional)" htmlFor={`note-${r.id}`}>
            <Textarea id={`note-${r.id}`} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        ) : null}
        {action === 'create' ? null : (
          <div className="flex justify-end">
            <Button
              variant={action === 'reject' ? 'danger' : 'primary'}
              disabled={resolve.isPending || (action === 'assign' && !selectedOrganisationId)}
              onClick={() => resolve.mutate(initial)}
            >
              {action === 'assign' ? 'Zuordnen' : 'Ablehnen'}
            </Button>
          </div>
        )}
      </div>
    </Card>
  )
}
