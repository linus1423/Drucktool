import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Alert, Button, Card, PageHeader } from '~/components/ui'
import { errorMessage } from '~/lib/errors'
import { inviteQuery } from '~/lib/queries'
import { acceptInviteFn } from '~/server/organisations/org-admin.functions'

// Einladung in eine Organisation (Issue #12). Wer nicht angemeldet ist, landet über _app beim Login und danach hier.
export const Route = createFileRoute('/_app/einladung/$token')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(inviteQuery(params.token)),
  head: () => ({ meta: [{ title: 'Einladung · Drucktool' }, { name: 'referrer', content: 'no-referrer' }] }),
  component: InvitePage,
})

function InvitePage() {
  const { token } = Route.useParams()
  const { data: invite } = useSuspenseQuery(inviteQuery(token))
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const accept = useMutation({
    mutationFn: () => acceptInviteFn({ data: { token } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      await navigate({ to: '/profil' })
    },
  })

  return (
    <div className="max-w-xl space-y-6">
      <PageHeader title="Einladung" />
      <Card>
        <div className="space-y-4 text-sm">
          {!invite.valid ? (
            <Alert>{invite.message}</Alert>
          ) : invite.alreadyMember ? (
            <Alert tone="info">Sie gehören „{invite.organisationName}“ bereits an.</Alert>
          ) : !invite.canJoin ? (
            <Alert tone="info">
              Mitarbeiter der Druckerei können keiner Kunden-Organisation beitreten. Bitte öffnen Sie den Link mit dem Konto der
              eingeladenen Person.
            </Alert>
          ) : (
            <>
              <p>
                Sie wurden eingeladen, der Organisation <strong>{invite.organisationName}</strong> beizutreten. Danach können Sie
                beim Bestellen für sie bestellen, und ihre Verwalter sehen Ihre Aufträge für die Organisation.
              </p>
              {accept.error ? <Alert>{errorMessage(accept.error)}</Alert> : null}
              <div className="flex justify-end gap-2">
                <Link
                  to="/uebersicht"
                  className="inline-flex items-center rounded-md px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-100"
                >
                  Ablehnen
                </Link>
                <Button disabled={accept.isPending} onClick={() => accept.mutate()}>
                  Beitreten
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>
    </div>
  )
}
