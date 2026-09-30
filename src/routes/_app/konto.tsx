import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Alert, Card, PageHeader } from '~/components/ui'
import { errorMessage } from '~/lib/errors'
import { ROLE_LABELS } from '~/lib/roles'
import { getMyAccountFn, updateMyNotificationsFn } from '~/server/account/account.functions'

const accountQuery = queryOptions({ queryKey: ['account'], queryFn: () => getMyAccountFn() })

export const Route = createFileRoute('/_app/konto')({
  loader: ({ context }) => context.queryClient.ensureQueryData(accountQuery),
  head: () => ({ meta: [{ title: 'Mein Konto · Drucktool' }] }),
  component: AccountPage,
})

function AccountPage() {
  const { data: account } = useSuspenseQuery(accountQuery)
  const queryClient = useQueryClient()
  const [notifications, setNotifications] = useState(account.emailNotifications)
  const mutation = useMutation({
    mutationFn: (emailNotifications: boolean) => updateMyNotificationsFn({ data: { emailNotifications } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountQuery.queryKey }),
    onError: (_error, value) => setNotifications(!value),
  })

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Mein Konto" />
      <Card title="Angaben">
        <dl className="grid grid-cols-3 gap-2 text-sm">
          <dt className="text-slate-500">Name</dt>
          <dd className="col-span-2">{account.name}</dd>
          <dt className="text-slate-500">E-Mail</dt>
          <dd className="col-span-2">{account.email}</dd>
          <dt className="text-slate-500">Rolle</dt>
          <dd className="col-span-2">{ROLE_LABELS[account.role]}</dd>
          {account.organisationName ? (
            <>
              <dt className="text-slate-500">Organisation</dt>
              <dd className="col-span-2">{account.organisationName}</dd>
            </>
          ) : null}
        </dl>
      </Card>
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
              <span className="font-medium">E-Mails zu Anfragen erhalten</span>
              <span className="block text-slate-600">
                Bei Statuswechseln, neuen Nachrichten und {account.role === 'customer' ? 'Angeboten' : 'neuen Anfragen oder Zuweisungen'}.
              </span>
            </span>
          </label>
        </div>
      </Card>
    </div>
  )
}
