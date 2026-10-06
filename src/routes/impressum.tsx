import { createFileRoute, notFound } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { LegalTextPage } from '~/components/LegalTextPage'
import { pageTitle } from '~/lib/design'
import { legalTextQuery } from '~/lib/queries'

// Impressum als eigener Text aus der Design-Seite (Issue #190), öffentlich ohne Anmeldung.
export const Route = createFileRoute('/impressum')({
  loader: async ({ context }) => {
    const text = await context.queryClient.ensureQueryData(legalTextQuery('imprint'))
    if (text == null) throw notFound()
  },
  head: ({ match }) => ({ meta: [{ title: pageTitle('Impressum', match.context.design) }] }),
  component: Page,
})

function Page() {
  const { data } = useSuspenseQuery(legalTextQuery('imprint'))
  return <LegalTextPage title="Impressum" text={data ?? ''} />
}
