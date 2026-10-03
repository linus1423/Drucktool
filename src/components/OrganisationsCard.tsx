import { useState } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { organisationTextFields } from '~/components/OrganisationForm'
import { Alert, Badge, Button, Card, Field, Input, Textarea } from '~/components/ui'
import { errorMessage } from '~/lib/errors'
import { formatDate } from '~/lib/format'
import { accountQuery, currentUserQuery } from '~/lib/queries'
import { ORG_STATUS } from '~/lib/roles'
import { requestOrganisationFn, withdrawOrganisationRequestFn, type getMyAccountFn } from '~/server/account/account.functions'

type Account = Awaited<ReturnType<typeof getMyAccountFn>>

const emptyRequest = {
  name: '',
  email: '',
  phone: '',
  street: '',
  zip: '',
  city: '',
  country: 'DE',
  vatId: '',
  costCenter: '',
  details: '',
}

const FIELD_HINTS: Partial<Record<keyof typeof emptyRequest, string>> = {
  name: 'z. B. Lehrstuhl, Institut, Fachschaft oder Firma',
  email: 'Allgemeine Adresse der Organisation, etwa für Rechnungen',
  costCenter: 'Falls über eine Kostenstelle abgerechnet wird',
}

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
  const [values, setValues] = useState(emptyRequest)
  const set = (key: keyof typeof emptyRequest, value: string) => setValues((v) => ({ ...v, [key]: value }))
  const [sent, setSent] = useState(false)

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: accountQuery.queryKey })
    // Ohne Beobachter würde invalidateQueries die Kopfzeile nicht neu laden (Issue #147).
    await queryClient.fetchQuery({ ...currentUserQuery, staleTime: 0 })
    await router.invalidate()
  }
  const request = useMutation({
    mutationFn: () => requestOrganisationFn({ data: values }),
    onSuccess: async () => {
      setValues(emptyRequest)
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
          Eine Organisation ist optional. Gehören Sie einer an, können Sie sie beim Bestellen auswählen. Verwalter laden Kollegen
          ein und sehen alle Aufträge der Organisation.
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
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="font-medium">{m.name}</span>
                <span className="flex items-center gap-2">
                  {m.status !== 'active' ? (
                    <Badge className={ORG_STATUS[m.status].className}>{ORG_STATUS[m.status].label}</Badge>
                  ) : m.isAdmin ? (
                    <>
                      <Badge className="bg-sky-100 text-sky-800">Verwalter</Badge>
                      <Link
                        to="/organisationen/$organisationId"
                        params={{ organisationId: m.id }}
                        className="font-medium text-sky-700 hover:underline"
                      >
                        Verwalten
                      </Link>
                    </>
                  ) : null}
                </span>
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
            <p className="text-slate-600">
              Bitte geben Sie die Daten der Organisation möglichst vollständig an. Die Druckerei legt sie daraus an oder ordnet
              Sie einer bestehenden zu.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {organisationTextFields.map((f) => (
                <div key={f.name} className={f.span ? 'sm:col-span-2' : ''}>
                  <Field
                    label={f.name === 'name' ? 'Name der Organisation' : f.label}
                    htmlFor={`org-request-${f.name}`}
                    hint={FIELD_HINTS[f.name]}
                  >
                    <Input
                      id={`org-request-${f.name}`}
                      type={f.name === 'email' ? 'email' : 'text'}
                      value={values[f.name]}
                      maxLength={f.name === 'country' ? 2 : 200}
                      onChange={(e) => set(f.name, e.target.value)}
                      required={f.name === 'name' || f.name === 'country'}
                    />
                  </Field>
                </div>
              ))}
              <div className="sm:col-span-2">
                <Field
                  label="Anmerkungen (optional)"
                  htmlFor="org-request-details"
                  hint="z. B. Ansprechpartner oder Hinweise zur Abrechnung"
                >
                  <Textarea
                    id="org-request-details"
                    rows={3}
                    maxLength={2000}
                    value={values.details}
                    onChange={(e) => set('details', e.target.value)}
                  />
                </Field>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Abbrechen
              </Button>
              <Button type="submit" disabled={request.isPending || !values.name.trim()}>
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
