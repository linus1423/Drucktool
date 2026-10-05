import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { DataTable, dataColumnHelper } from '~/components/DataTable'
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, fieldError } from '~/components/ui'
import { errorMessage } from '~/lib/errors'
import { formatDateTime } from '~/lib/format'
import { activeOrganisationsQuery, usersQuery } from '~/lib/queries'
import { ROLE_LABELS, USER_ROLES, USER_STATUSES, USER_STATUS_LABELS, type UserRole, type UserStatus } from '~/lib/roles'
import { anonymizeUserFn, createUserFn, updateUserFn } from '~/server/admin/admin.functions'
import { pageTitle } from '~/lib/design'

export const Route = createFileRoute('/_app/admin/benutzer')({
  loader: ({ context }) => context.queryClient.ensureQueryData(usersQuery),
  head: ({ match }) => ({ meta: [{ title: pageTitle('Benutzer', match.context.design) }] }),
  component: UsersPage,
})

type Row = Awaited<ReturnType<NonNullable<(typeof usersQuery)['queryFn']>>>[number]
const col = dataColumnHelper<Row>()

const statusTone: Record<UserStatus, string> = {
  active: 'bg-emerald-100 text-emerald-800',
  pending: 'bg-amber-100 text-amber-800',
  rejected: 'bg-rose-100 text-rose-800',
  disabled: 'bg-slate-200 text-slate-700',
}

const columns = [
  col.accessor('name', { header: 'Name', sortFn: 'text', cell: (i) => <span className="font-medium">{i.getValue()}</span> }),
  col.accessor('email', { header: 'E-Mail', sortFn: 'text' }),
  col.accessor('role', { header: 'Rolle', cell: (i) => ROLE_LABELS[i.getValue()] }),
  col.accessor('organisationNames', { header: 'Organisationen', cell: (i) => i.getValue() || '–' }),
  col.accessor('status', {
    header: 'Status',
    cell: (i) => <Badge className={statusTone[i.getValue()]}>{USER_STATUS_LABELS[i.getValue()]}</Badge>,
  }),
  col.accessor('lastLoginAt', { header: 'Letzte Anmeldung', sortFn: 'datetime', cell: (i) => formatDateTime(i.getValue()) }),
]

type Editing = { mode: 'create' } | { mode: 'edit'; user: Row }

function UsersPage() {
  const { data } = useSuspenseQuery(usersQuery)
  const { user: me } = Route.useRouteContext()
  const [editing, setEditing] = useState<Editing | null>(null)

  return (
    <>
      <PageHeader
        title="Benutzer"
        description="Mitarbeiter, Administratoren und Kundenkonten."
        actions={<Button onClick={() => setEditing({ mode: 'create' })}>Neuer Benutzer</Button>}
      />
      {editing ? (
        <div className="mb-6">
          <UserForm
            key={editing.mode === 'edit' ? editing.user.id : 'new'}
            editing={editing}
            actorRole={me.role}
            onDone={() => setEditing(null)}
          />
        </div>
      ) : null}
      <DataTable
        data={data}
        columns={columns}
        initialSorting={[{ id: 'name', desc: false }]}
        searchPlaceholder="Benutzer durchsuchen"
        onRowClick={(row) => setEditing({ mode: 'edit', user: row })}
      />
    </>
  )
}

function UserForm({ editing, actorRole, onDone }: { editing: Editing; actorRole: UserRole; onDone: () => void }) {
  const queryClient = useQueryClient()
  const organisations = useQuery(activeOrganisationsQuery)
  const [error, setError] = useState<string | null>(null)
  const existing = editing.mode === 'edit' ? editing.user : null
  // Nur Superadmins dürfen Administratoren vergeben.
  // Aktive Organisationen plus die bisherigen des Benutzers, auch wenn sie inzwischen deaktiviert sind.
  const organisationOptions = [
    ...(organisations.data ?? []),
    ...(existing?.organisations ?? []).filter((o) => !organisations.data?.some((a) => a.id === o.id)),
  ]
  const roles = USER_ROLES.filter((r) => actorRole === 'superadmin' || (r !== 'admin' && r !== 'superadmin'))

  const form = useForm({
    defaultValues: {
      firstName: existing?.firstName ?? '',
      lastName: existing?.lastName ?? '',
      email: existing?.email ?? '',
      role: (existing?.role ?? 'staff') as UserRole,
      status: (existing?.status ?? 'active') as UserStatus,
      organisationIds: existing?.organisations.map((o) => o.id) ?? [],
      canManageScripts: existing?.canManageScripts ?? false,
      password: '',
    },
    onSubmit: async ({ value }) => {
      setError(null)
      try {
        const base = {
          firstName: value.firstName,
          lastName: value.lastName,
          email: value.email,
          role: value.role,
          organisationIds: value.organisationIds,
          canManageScripts: value.role === 'staff' && value.canManageScripts,
        }
        if (existing) {
          await updateUserFn({ data: { ...base, id: existing.id, status: value.status, password: value.password } })
        } else {
          await createUserFn({ data: { ...base, password: value.password } })
        }
        await queryClient.invalidateQueries({ queryKey: ['admin'] })
        await queryClient.invalidateQueries({ queryKey: ['staff'] })
        onDone()
      } catch (e) {
        setError(errorMessage(e))
      }
    },
  })

  return (
    <Card title={existing ? `${existing.name} bearbeiten` : 'Neuer Benutzer'}>
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          void form.handleSubmit()
        }}
      >
        {error ? (
          <div className="sm:col-span-2">
            <Alert>{error}</Alert>
          </div>
        ) : null}
        <form.Field name="firstName">
          {(field) => (
            <Field label="Vorname" htmlFor="user-first-name" error={fieldError(field.state.meta.errors)}>
              <Input id="user-first-name" value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />
            </Field>
          )}
        </form.Field>
        <form.Field name="lastName">
          {(field) => (
            <Field label="Nachname" htmlFor="user-last-name" error={fieldError(field.state.meta.errors)}>
              <Input
                id="user-last-name"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                required
              />
            </Field>
          )}
        </form.Field>
        <form.Field name="email">
          {(field) => (
            <Field label="E-Mail" htmlFor="user-email">
              <Input
                id="user-email"
                type="email"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                required
              />
            </Field>
          )}
        </form.Field>
        <form.Field name="role">
          {(field) => (
            <Field label="Rolle" htmlFor="user-role">
              <Select id="user-role" value={field.state.value} onChange={(e) => field.handleChange(e.target.value as UserRole)}>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </form.Field>
        {/* Auch Mitarbeiter können Mitglied oder Verwalter einer Organisation sein (Issue #164). */}
        <form.Field name="organisationIds">
          {(field) => (
            <fieldset className="space-y-1 text-sm">
              <legend className="mb-1 font-medium text-slate-700">Organisationen (optional)</legend>
              {organisationOptions.length === 0 ? <p className="text-slate-500">Keine Organisationen angelegt.</p> : null}
              <div className="max-h-48 space-y-1 overflow-y-auto">
                {organisationOptions.map((o) => (
                  <label key={o.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={field.state.value.includes(o.id)}
                      onChange={(e) =>
                        field.handleChange(
                          e.target.checked ? [...field.state.value, o.id] : field.state.value.filter((id) => id !== o.id),
                        )
                      }
                    />
                    {o.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </form.Field>
        {existing ? (
          <form.Field name="status">
            {(field) => (
              <Field label="Status" htmlFor="user-status">
                <Select
                  id="user-status"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value as UserStatus)}
                >
                  {USER_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {USER_STATUS_LABELS[s]}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </form.Field>
        ) : null}
        <form.Field name="password">
          {(field) => (
            <Field
              label={existing ? 'Neues Passwort' : 'Passwort (optional)'}
              htmlFor="user-password"
              hint={
                existing
                  ? 'Leer lassen, um das Passwort nicht zu ändern.'
                  : 'Mindestens 10 Zeichen. Ohne Passwort meldet sich die Person per Anmeldelink oder Single Sign-on an.'
              }
            >
              <Input
                id="user-password"
                type="password"
                autoComplete="new-password"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </Field>
          )}
        </form.Field>
        <form.Subscribe selector={(s) => s.values.role}>
          {(role) =>
            role === 'staff' ? (
              <form.Field name="canManageScripts">
                {(field) => (
                  <label className="flex items-start gap-2 self-end text-sm text-slate-700">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={field.state.value}
                      onChange={(e) => field.handleChange(e.target.checked)}
                    />
                    <span>
                      Darf Skripte der SVK verwalten
                      <span className="block text-slate-500">Administratoren dürfen das immer.</span>
                    </span>
                  </label>
                )}
              </form.Field>
            ) : null
          }
        </form.Subscribe>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button variant="secondary" onClick={onDone}>
            Abbrechen
          </Button>
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(isSubmitting) => (
              <Button type="submit" disabled={isSubmitting}>
                {existing ? 'Speichern' : 'Anlegen'}
              </Button>
            )}
          </form.Subscribe>
        </div>
      </form>
      {existing && !existing.anonymizedAt ? <PrivacyActions user={existing} onDone={onDone} /> : null}
    </Card>
  )
}

/** Datenauskunft und Anonymisierung (DSGVO). */
function PrivacyActions({ user, onDone }: { user: Row; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function anonymize() {
    setError(null)
    setBusy(true)
    try {
      await anonymizeUserFn({ data: { id: user.id } })
      await queryClient.invalidateQueries({ queryKey: ['admin'] })
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-6 space-y-3 border-t border-slate-200 pt-4 text-sm">
      <h3 className="font-medium">Datenschutz</h3>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <a
          href={`/api/admin/datenauskunft/${user.id}`}
          download
          className="inline-flex items-center rounded-md bg-white px-3 py-2 font-medium text-slate-900 ring-1 ring-slate-300 hover:bg-slate-100"
        >
          Datenauskunft herunterladen (JSON)
        </a>
        {confirming ? null : (
          <Button variant="secondary" className="text-rose-700" onClick={() => setConfirming(true)}>
            Anonymisieren …
          </Button>
        )}
      </div>
      {confirming ? (
        <Alert tone="info">
          <p>
            Name, E-Mail-Adresse, Adressen, Sitzungen und Anmeldewege von {user.name} werden endgültig entfernt; das Konto ist
            danach gesperrt und die E-Mail-Adresse wieder frei. Aufträge und Nachrichten bleiben erhalten und zeigen „Gelöschter
            Nutzer“. Das lässt sich nicht rückgängig machen.
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="danger" disabled={busy} onClick={() => void anonymize()}>
              Endgültig anonymisieren
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Abbrechen
            </Button>
          </div>
        </Alert>
      ) : null}
    </div>
  )
}
