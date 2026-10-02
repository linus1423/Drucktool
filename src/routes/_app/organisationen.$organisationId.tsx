import { useState } from 'react'
import { createFileRoute, Link, notFound, redirect, useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { OrganisationForm } from '~/components/OrganisationForm'
import { Alert, Badge, Button, Card, Input, PageHeader } from '~/components/ui'
import { errorMessage } from '~/lib/errors'
import { formatDate } from '~/lib/format'
import { managedOrganisationQuery } from '~/lib/queries'
import {
  createInviteFn,
  removeMemberFn,
  revokeInviteFn,
  setMemberAdminFn,
  updateOrganisationDetailsFn,
} from '~/server/organisations/org-admin.functions'

// Verwalter einer Organisation pflegen Mitglieder und Stammdaten selbst (Issue #12).
export const Route = createFileRoute('/_app/organisationen/$organisationId')({
  beforeLoad: ({ context }) => {
    if (context.user.role !== 'customer') throw redirect({ to: '/auftraege' })
  },
  loader: ({ context, params }) => {
    if (!UUID.test(params.organisationId)) throw notFound()
    return context.queryClient.ensureQueryData(managedOrganisationQuery(params.organisationId))
  },
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.name ?? 'Organisation'} · Drucktool` }] }),
  notFoundComponent: () => (
    <div className="space-y-4">
      <Alert>Organisation nicht gefunden</Alert>
      <Link to="/uebersicht" className="text-sm underline">
        Zurück zur Übersicht
      </Link>
    </div>
  ),
  component: ManageOrganisationPage,
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function ManageOrganisationPage() {
  const { organisationId } = Route.useParams()
  const { data: org } = useSuspenseQuery(managedOrganisationQuery(organisationId))
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [saved, setSaved] = useState(false)
  const [link, setLink] = useState<{ url: string; expiresAt: Date } | null>(null)
  const [copied, setCopied] = useState(false)
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['organisations'] })

  const invite = useMutation({
    mutationFn: () => createInviteFn({ data: { organisationId } }),
    onSuccess: async (result) => {
      setCopied(false)
      setLink({ url: `${window.location.origin}/einladung/${result.token}`, expiresAt: result.expiresAt })
      await refresh()
    },
  })
  const revoke = useMutation({
    mutationFn: (inviteId: string) => revokeInviteFn({ data: { organisationId, inviteId } }),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: (userId: string) => removeMemberFn({ data: { organisationId, userId } }),
    onSuccess: async (_, userId) => {
      // Wer sich selbst entfernt, verwaltet die Organisation nicht mehr.
      if (userId === org.me) await navigate({ to: '/profil' })
      await refresh()
    },
  })
  const setAdmin = useMutation({
    mutationFn: (data: { userId: string; isAdmin: boolean }) => setMemberAdminFn({ data: { organisationId, ...data } }),
    onSuccess: async (_, data) => {
      if (data.userId === org.me && !data.isAdmin) await navigate({ to: '/profil' })
      await refresh()
    },
  })
  const memberError = remove.error ?? setAdmin.error
  const busy = remove.isPending || setAdmin.isPending

  return (
    <div className="space-y-6">
      <div>
        <Link to="/profil" className="text-sm text-slate-500 hover:text-slate-900">
          ← Profil
        </Link>
      </div>
      <PageHeader
        title={org.name}
        description="Sie verwalten diese Organisation: Sie laden Kollegen ein und sehen alle Aufträge der Organisation."
        actions={
          <Link
            to="/auftraege"
            search={{ org: org.id, ansicht: 'alle' }}
            className="inline-flex items-center rounded-md px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-100"
          >
            Aufträge der Organisation
          </Link>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Mitglieder">
            <div className="space-y-3 text-sm">
              {memberError ? <Alert>{errorMessage(memberError)}</Alert> : null}
              <ul className="divide-y divide-slate-100">
                {org.members.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div>
                      <div className="font-medium">
                        {m.name}
                        {m.id === org.me ? <span className="font-normal text-slate-500"> (Sie)</span> : null}
                      </div>
                      <div className="text-slate-500">
                        {m.email} · Mitglied seit {formatDate(m.since)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {m.isAdmin ? <Badge className="bg-sky-100 text-sky-800">Verwalter</Badge> : null}
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setAdmin.mutate({ userId: m.id, isAdmin: !m.isAdmin })}
                      >
                        {m.isAdmin ? 'Verwalter-Rolle entziehen' : 'Zum Verwalter machen'}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          const question =
                            m.id === org.me
                              ? `Möchten Sie „${org.name}“ wirklich verlassen?`
                              : `${m.name} aus „${org.name}“ entfernen? Bisherige Aufträge bleiben erhalten.`
                          if (window.confirm(question)) remove.mutate(m.id)
                        }}
                      >
                        {m.id === org.me ? 'Verlassen' : 'Entfernen'}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </Card>
          <Card title="Stammdaten">
            <div className="space-y-4">
              {saved ? <Alert tone="success">Gespeichert.</Alert> : null}
              <p className="text-sm text-slate-600">
                Den Namen der Organisation ändert die Druckerei. Schreiben Sie ihr dazu eine Nachricht.
              </p>
              <OrganisationForm
                key={org.updatedAt.toString()}
                forCustomer
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
                  isSvk: false,
                  status: 'active',
                }}
                submitLabel="Speichern"
                onSubmit={async ({ name: _name, status: _status, ...values }) => {
                  setSaved(false)
                  await updateOrganisationDetailsFn({ data: { ...values, organisationId } })
                  await refresh()
                  setSaved(true)
                }}
              />
            </div>
          </Card>
        </div>
        <Card title="Kollegen einladen">
          <div className="space-y-3 text-sm">
            <p className="text-slate-600">
              Ein Einladungslink gilt 14 Tage und für genau eine Person. Wer ihn öffnet und sich anmeldet, wird Mitglied der
              Organisation.
            </p>
            {invite.error ? <Alert>{errorMessage(invite.error)}</Alert> : null}
            {link ? (
              <div className="space-y-2">
                <label htmlFor="invite-link" className="block font-medium text-slate-700">
                  Neuer Einladungslink
                </label>
                <Input id="invite-link" readOnly value={link.url} onFocus={(e) => e.target.select()} />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">gültig bis {formatDate(link.expiresAt)}</span>
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      await navigator.clipboard?.writeText(link.url).catch(() => {})
                      setCopied(true)
                    }}
                  >
                    {copied ? 'Kopiert' : 'Kopieren'}
                  </Button>
                </div>
                <p className="text-slate-500">Der Link wird nur jetzt angezeigt.</p>
              </div>
            ) : null}
            <Button disabled={invite.isPending} onClick={() => invite.mutate()}>
              Einladungslink erstellen
            </Button>
            {org.invites.length ? (
              <div className="border-t border-slate-100 pt-3">
                <h3 className="mb-1 font-medium text-slate-700">Offene Einladungen</h3>
                {revoke.error ? <Alert>{errorMessage(revoke.error)}</Alert> : null}
                <ul className="divide-y divide-slate-100">
                  {org.invites.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-2 py-2">
                      <span className="text-slate-600">
                        {formatDate(i.createdAt)}
                        {i.createdByName ? ` von ${i.createdByName}` : ''}, gültig bis {formatDate(i.expiresAt)}
                      </span>
                      <Button variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(i.id)}>
                        Widerrufen
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </Card>
      </div>
    </div>
  )
}
