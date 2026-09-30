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
import { createUserFn, updateUserFn } from '~/server/admin/admin.functions'

export const Route = createFileRoute('/_app/admin/benutzer')({
  loader: ({ context }) => context.queryClient.ensureQueryData(usersQuery),
  head: () => ({ meta: [{ title: 'Benutzer · Drucktool' }] }),
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
  col.accessor('organisationName', { header: 'Organisation', cell: (i) => i.getValue() ?? '–' }),
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
  const roles = USER_ROLES.filter((r) => actorRole === 'superadmin' || (r !== 'admin' && r !== 'superadmin'))

  const form = useForm({
    defaultValues: {
      name: existing?.name ?? '',
      email: existing?.email ?? '',
      role: (existing?.role ?? 'staff') as UserRole,
      status: (existing?.status ?? 'active') as UserStatus,
      organisationId: existing?.organisationId ?? '',
      password: '',
    },
    onSubmit: async ({ value }) => {
      setError(null)
      try {
        const base = {
          name: value.name,
          email: value.email,
          role: value.role,
          organisationId: value.role === 'customer' ? value.organisationId || null : null,
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
        <form.Field name="name">
          {(field) => (
            <Field label="Name" htmlFor="user-name" error={fieldError(field.state.meta.errors)}>
              <Input id="user-name" value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} required />
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
        <form.Subscribe selector={(s) => s.values.role}>
          {(role) =>
            role === 'customer' ? (
              <form.Field name="organisationId">
                {(field) => (
                  <Field label="Organisation" htmlFor="user-org">
                    <Select id="user-org" value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} required>
                      <option value="">Bitte wählen …</option>
                      {organisations.data?.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
              </form.Field>
            ) : (
              <div />
            )
          }
        </form.Subscribe>
        {existing ? (
          <form.Field name="status">
            {(field) => (
              <Field label="Status" htmlFor="user-status">
                <Select id="user-status" value={field.state.value} onChange={(e) => field.handleChange(e.target.value as UserStatus)}>
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
              label={existing ? 'Neues Passwort' : 'Passwort'}
              htmlFor="user-password"
              hint={existing ? 'Leer lassen, um das Passwort nicht zu ändern.' : 'Mindestens 10 Zeichen'}
            >
              <Input
                id="user-password"
                type="password"
                autoComplete="new-password"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                required={!existing}
              />
            </Field>
          )}
        </form.Field>
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
    </Card>
  )
}
