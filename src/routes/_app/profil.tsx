import { useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { Alert, Button, Card, Field, Input, PageHeader, fieldError } from '~/components/ui'
import { EMPTY_BILLING, EMPTY_DELIVERY } from '~/lib/address'
import { errorMessage } from '~/lib/errors'
import { formatDateTime } from '~/lib/format'
import { accountQuery, currentUserQuery } from '~/lib/queries'
import { ROLE_LABELS } from '~/lib/roles'
import {
  type getMyAccountFn,
  profileSchema,
  revokeMySessionsFn,
  updateMyNotificationsFn,
  updateMyProfileFn,
} from '~/server/account/account.functions'

export const Route = createFileRoute('/_app/profil')({
  validateSearch: z.object({ neu: z.coerce.boolean().optional().catch(undefined) }),
  loader: ({ context }) => context.queryClient.ensureQueryData(accountQuery),
  head: () => ({ meta: [{ title: 'Profil · Drucktool' }] }),
  component: ProfilePage,
})

function ProfilePage() {
  const { data: account } = useSuspenseQuery(accountQuery)
  const { neu } = Route.useSearch()
  const customer = account.role === 'customer'

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Profil" description={`${account.email} · ${ROLE_LABELS[account.role]}`} />
      {neu && customer && !account.billingAddress ? (
        <Alert tone="info">Willkommen! Bitte hinterlegen Sie Ihre Rechnungsadresse, bevor Sie den ersten Auftrag aufgeben.</Alert>
      ) : null}
      <ProfileForm account={account} />
      <NotificationsCard initial={account.emailNotifications} customer={customer} />
      <SessionsCard sessions={account.sessions} />
    </div>
  )
}

type Account = Awaited<ReturnType<typeof getMyAccountFn>>

const billingFields = [
  { name: 'name', label: 'Name', autoComplete: 'name', span: true },
  { name: 'organisation', label: 'Lehrstuhl, Einrichtung oder Firma (optional)', autoComplete: 'organization', span: true },
  { name: 'street', label: 'Straße und Hausnummer', autoComplete: 'street-address', span: true },
  { name: 'zip', label: 'PLZ', autoComplete: 'postal-code', span: false },
  { name: 'city', label: 'Ort', autoComplete: 'address-level2', span: false },
  { name: 'country', label: 'Land (optional)', autoComplete: 'country-name', span: false },
] as const

const deliveryFields = [
  { name: 'recipient', label: 'Empfänger', span: true },
  { name: 'department', label: 'Lehrstuhl oder Einrichtung', span: true },
  { name: 'building', label: 'Gebäude', span: false },
  { name: 'room', label: 'Raum', span: false },
  { name: 'note', label: 'Hinweis für die Hauspost (optional)', span: true },
] as const

function ProfileForm({ account }: { account: Account }) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [withDelivery, setWithDelivery] = useState(!!account.deliveryAddress)

  const form = useForm({
    defaultValues: {
      name: account.name,
      billingAddress: account.billingAddress ?? { ...EMPTY_BILLING, name: account.name },
      deliveryAddress: account.deliveryAddress ?? { ...EMPTY_DELIVERY, recipient: account.name },
    },
    validators: {
      onSubmit: ({ value }) => {
        const result = profileSchema.safeParse({ ...value, deliveryAddress: withDelivery ? value.deliveryAddress : null })
        if (result.success) return undefined
        return {
          fields: Object.fromEntries(result.error.issues.map((i) => [i.path.join('.'), i.message])),
        }
      },
    },
    onSubmit: async ({ value }) => {
      setError(null)
      setSaved(false)
      try {
        await updateMyProfileFn({ data: { ...value, deliveryAddress: withDelivery ? value.deliveryAddress : null } })
        await queryClient.invalidateQueries({ queryKey: accountQuery.queryKey })
        // Der Name steht auch in der Kopfzeile.
        await queryClient.invalidateQueries({ queryKey: currentUserQuery.queryKey })
        await router.invalidate()
        setSaved(true)
      } catch (e) {
        setError(errorMessage(e))
      }
    },
  })

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      <Card title="Name">
        <form.Field name="name">
          {(field) => (
            <Field label="Anzeigename" htmlFor="name" error={fieldError(field.state.meta.errors)}>
              <Input
                id="name"
                autoComplete="name"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </Field>
          )}
        </form.Field>
      </Card>
      <Card title="Rechnungsadresse">
        <div className="grid gap-4 sm:grid-cols-3">
          {billingFields.map((f) => (
            <form.Field key={f.name} name={`billingAddress.${f.name}`}>
              {(field) => (
                <div className={f.span ? 'sm:col-span-3' : undefined}>
                  <Field label={f.label} htmlFor={`billing-${f.name}`} error={fieldError(field.state.meta.errors)}>
                    <Input
                      id={`billing-${f.name}`}
                      autoComplete={`billing ${f.autoComplete}`}
                      value={field.state.value ?? ''}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                    />
                  </Field>
                </div>
              )}
            </form.Field>
          ))}
        </div>
      </Card>
      <Card title="Lieferadresse für die Hauspost">
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" checked={withDelivery} onChange={(e) => setWithDelivery(e.target.checked)} />
          Adresse für die Lieferung per Hauspost hinterlegen
        </label>
        {withDelivery ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {deliveryFields.map((f) => (
              <form.Field key={f.name} name={`deliveryAddress.${f.name}`}>
                {(field) => (
                  <div className={f.span ? 'sm:col-span-2' : undefined}>
                    <Field label={f.label} htmlFor={`delivery-${f.name}`} error={fieldError(field.state.meta.errors)}>
                      <Input
                        id={`delivery-${f.name}`}
                        value={field.state.value ?? ''}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                      />
                    </Field>
                  </div>
                )}
              </form.Field>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-500">Ohne Lieferadresse holen Sie Ihre Aufträge im Regal ab.</p>
        )}
      </Card>
      <div className="flex items-center gap-4">
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Speichern …' : 'Profil speichern'}
            </Button>
          )}
        </form.Subscribe>
        {saved ? <span className="text-sm text-emerald-700">Gespeichert</span> : null}
        {error ? <Alert>{error}</Alert> : null}
      </div>
    </form>
  )
}

function NotificationsCard({ initial, customer }: { initial: boolean; customer: boolean }) {
  const queryClient = useQueryClient()
  const [notifications, setNotifications] = useState(initial)
  const mutation = useMutation({
    mutationFn: (emailNotifications: boolean) => updateMyNotificationsFn({ data: { emailNotifications } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountQuery.queryKey }),
    onError: (_error, value) => setNotifications(!value),
  })

  return (
    <Card title="Benachrichtigungen">
      <div className="space-y-3">
        {mutation.error ? <Alert>{errorMessage(mutation.error)}</Alert> : null}
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={notifications}
            onChange={(e) => {
              setNotifications(e.target.checked)
              mutation.mutate(e.target.checked)
            }}
          />
          <span>
            <span className="font-medium">E-Mails zu Aufträgen erhalten</span>
            <span className="block text-slate-600">
              {customer
                ? 'Bei Statuswechseln, Rückfragen und Nachrichten der Druckerei.'
                : 'Bei neuen Aufträgen, Nachrichten und Zuweisungen.'}{' '}
              Anmeldelinks kommen immer.
            </span>
          </span>
        </label>
      </div>
    </Card>
  )
}

function SessionsCard({ sessions }: { sessions: Account['sessions'] }) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const revoke = useMutation({
    mutationFn: (id: string | null) => revokeMySessionsFn({ data: { id } }),
    onSuccess: async (_data, id) => {
      const wasCurrent = sessions.find((s) => s.id === id)?.current
      if (wasCurrent) {
        queryClient.clear()
        await router.invalidate()
        await router.navigate({ to: '/login' })
        return
      }
      await queryClient.invalidateQueries({ queryKey: accountQuery.queryKey })
    },
  })
  const others = sessions.filter((s) => !s.current).length

  return (
    <Card
      title="Angemeldete Geräte"
      actions={
        others > 0 ? (
          <Button variant="secondary" onClick={() => revoke.mutate(null)} disabled={revoke.isPending}>
            Alle anderen abmelden
          </Button>
        ) : null
      }
    >
      {revoke.error ? <Alert>{errorMessage(revoke.error)}</Alert> : null}
      <ul className="divide-y divide-slate-100 text-sm">
        {sessions.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div>
              <div className="font-medium">
                {describeAgent(s.userAgent)}
                {s.current ? <span className="ml-2 text-xs font-normal text-emerald-700">dieses Gerät</span> : null}
              </div>
              <div className="text-slate-500">
                Angemeldet am {formatDateTime(s.createdAt)}
                {s.ip ? ` · ${s.ip}` : ''}
              </div>
            </div>
            <Button variant="ghost" onClick={() => revoke.mutate(s.id)} disabled={revoke.isPending}>
              Abmelden
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function describeAgent(agent: string | null) {
  if (!agent) return 'Unbekanntes Gerät'
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Firefox\//.test(agent)
      ? 'Firefox'
      : /Chrome\//.test(agent)
        ? 'Chrome'
        : /Safari\//.test(agent)
          ? 'Safari'
          : 'Browser'
  const os = /Windows/.test(agent)
    ? 'Windows'
    : /Android/.test(agent)
      ? 'Android'
      : /iPhone|iPad/.test(agent)
        ? 'iOS'
        : /Mac OS X/.test(agent)
          ? 'macOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : ''
  return os ? `${browser} auf ${os}` : browser
}
