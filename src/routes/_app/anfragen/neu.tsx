import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RequestFields, emptyRequestValues, toRequestInput, useRequestForm } from '~/components/RequestFields'
import { Alert, Button, Card, Field, PageHeader, Select } from '~/components/ui'
import { errorMessage } from '~/lib/errors'
import { activeOrganisationsQuery } from '~/lib/queries'
import { isStaffRole } from '~/lib/roles'
import { createRequestFn } from '~/server/requests/requests.functions'

export const Route = createFileRoute('/_app/anfragen/neu')({
  head: () => ({ meta: [{ title: 'Neue Anfrage · Drucktool' }] }),
  component: NewRequestPage,
})

function NewRequestPage() {
  const { user } = Route.useRouteContext()
  const staff = isStaffRole(user.role)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [organisationId, setOrganisationId] = useState('')
  const organisations = useQuery({ ...activeOrganisationsQuery, enabled: staff })

  const form = useRequestForm({
    defaultValues: emptyRequestValues,
    onSubmit: async (values) => {
      setError(null)
      try {
        const created = await createRequestFn({
          data: { ...toRequestInput(values), organisationId: staff ? organisationId || undefined : undefined },
        })
        await queryClient.invalidateQueries({ queryKey: ['requests'] })
        await navigate({ to: '/anfragen/$requestId', params: { requestId: created.id } })
      } catch (e) {
        setError(errorMessage(e))
      }
    },
  })

  return (
    <div className="max-w-3xl">
      <PageHeader title="Neue Anfrage" description="Beschreiben Sie Ihren Druckauftrag. Wir melden uns mit einem Angebot." />
      <Card>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void form.handleSubmit()
          }}
        >
          {error ? <Alert>{error}</Alert> : null}
          {staff ? (
            <Field label="Organisation (optional)" htmlFor="organisationId">
              <Select id="organisationId" value={organisationId} onChange={(e) => setOrganisationId(e.target.value)}>
                <option value="">Keine</option>
                {organisations.data?.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <RequestFields form={form} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => navigate({ to: '/anfragen' })}>
              Abbrechen
            </Button>
            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(isSubmitting) => (
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? 'Wird gesendet …' : 'Anfrage senden'}
                </Button>
              )}
            </form.Subscribe>
          </div>
        </form>
      </Card>
    </div>
  )
}
