import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { OrganisationForm, emptyOrganisation } from '~/components/OrganisationForm'
import { Card, PageHeader } from '~/components/ui'
import { saveOrganisationFn } from '~/server/admin/admin.functions'
import { pageTitle } from '~/lib/design'

export const Route = createFileRoute('/_app/admin/organisationen/neu')({
  head: ({ match }) => ({ meta: [{ title: pageTitle('Neue Organisation', match.context.design) }] }),
  component: NewOrganisationPage,
})

function NewOrganisationPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  return (
    <div className="max-w-3xl">
      <PageHeader title="Neue Organisation" />
      <Card>
        <OrganisationForm
          initial={emptyOrganisation}
          submitLabel="Anlegen"
          onSubmit={async (values) => {
            const { id } = await saveOrganisationFn({ data: values })
            await queryClient.invalidateQueries({ queryKey: ['admin'] })
            await queryClient.invalidateQueries({ queryKey: ['organisations'] })
            await navigate({ to: '/admin/organisationen/$organisationId', params: { organisationId: id } })
          }}
        />
      </Card>
    </div>
  )
}
