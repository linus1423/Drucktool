import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Alert, Badge, Button, Card, Field, Input, Textarea } from '~/components/ui'
import { errorMessage } from '~/lib/errors'
import { formatDate } from '~/lib/format'
import { accountQuery, currentUserQuery } from '~/lib/queries'
import { ORG_STATUS } from '~/lib/roles'
import { requestOrganisationFn, withdrawOrganisationRequestFn, type getMyAccountFn } from '~/server/account/account.functions'

type Account = Awaited<ReturnType<typeof getMyAccountFn>>

const REQUEST_STATUS = {
  open: { label: 'Wartet auf Bearbeitung', className: 'bg-amber-100 text-amber-800' },
  approved: { label: 'Angenommen', className: 'bg-emerald-100 text-emerald-800' },
  rejected: { label: 'Abgelehnt', className: 'bg-rose-100 text-rose-800' },
} as const

/**
 * Organisationen im Profil eines Kunden (Issue #68): Sie sind optional, ein Kunde kann mehreren
 * angehören und eine Organisation anfragen; die Druckerei ordnet ihn dann zu.
 */
export function OrganisationsCard({ account }: { account: Pick<Account, 'memberships' | 'organisationRequests'> }) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [details, setDetails] = useState('')
  const [sent, setSent] = useState(false)

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: accountQuery.queryKey })
    await queryClient.invalidateQueries({ queryKey: currentUserQuery.queryKey })
    await router.invalidate()
  }
  const request = useMutation({
    mutationFn: () => requestOrganisationFn({ data: { name, details } }),
    onSuccess: async () => {
      setName('')
      setDetails('')
      setOpen(false)
      setSent(true)
      await refresh()
    },
  })
  const withdraw = useMutation({
    mutationFn: (id: string) => withdrawOrganisationRequestFn({ data: { id } }),
    onSuccess: refresh,
  })
  const error = request.error ?? withdraw.error

  return (
    <Card
      title="Organisationen"
      actions={
        open ? null : (
          <Button
            variant="secondary"
            onClick={() => {
              setOpen(true)
              setSent(false)
            }}
          >
            Organisation anfragen
          </Button>
        )
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-slate-600">
          Eine Organisation ist optional. Gehören Sie einer an, können Sie sie beim Bestellen auswählen.
        </p>
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        {sent ? (
          <Alert tone="success">
            Ihre Anfrage ist eingegangen. Sie erhalten eine E-Mail, sobald die Druckerei sie bearbeitet hat.
          </Alert>
        ) : null}
        {account.memberships.length === 0 ? (
          <p className="text-slate-500">Sie gehören keiner Organisation an.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {account.memberships.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 py-2">
                <span className="font-medium">{m.name}</span>
                {m.status !== 'active' ? (
                  <Badge className={ORG_STATUS[m.status].className}>{ORG_STATUS[m.status].label}</Badge>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {open ? (
          <form
            className="space-y-3 border-t border-slate-100 pt-4"
            onSubmit={(e) => {
              e.preventDefault()
              request.mutate()
            }}
          >
            <Field
              label="Name der Organisation"
              htmlFor="org-request-name"
              hint="z. B. Lehrstuhl, Institut, Fachschaft oder Firma"
            >
              <Input id="org-request-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <Field
              label="Weitere Angaben (optional)"
              htmlFor="org-request-details"
              hint="z. B. Adresse, Kostenstelle oder Ansprechpartner"
            >
              <Textarea
                id="org-request-details"
                rows={3}
                maxLength={2000}
                value={details}
                onChange={(e) => setDetails(e.target.value)}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Abbrechen
              </Button>
              <Button type="submit" disabled={request.isPending || !name.trim()}>
                {request.isPending ? 'Wird gesendet …' : 'Anfrage senden'}
              </Button>
            </div>
          </form>
        ) : null}
        {account.organisationRequests.length > 0 ? (
          <div className="border-t border-slate-100 pt-4">
            <h3 className="mb-1 font-medium text-slate-700">Ihre Anfragen</h3>
            <ul className="divide-y divide-slate-100">
              {account.organisationRequests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div>
                    <div className="font-medium">{r.name}</div>
                    <div className="text-slate-500">
                      {formatDate(r.createdAt)}
                      {r.status === 'approved' && r.organisationName ? ` · zugeordnet zu „${r.organisationName}“` : ''}
                      {r.status === 'rejected' && r.note ? ` · ${r.note}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge className={REQUEST_STATUS[r.status].className}>{REQUEST_STATUS[r.status].label}</Badge>
                    {r.status === 'open' ? (
                      <Button variant="ghost" disabled={withdraw.isPending} onClick={() => withdraw.mutate(r.id)}>
                        Zurückziehen
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  )
}
