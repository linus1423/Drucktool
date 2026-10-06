import { createFileRoute, notFound } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { LegalTextPage } from '~/components/LegalTextPage'
import { pageTitle } from '~/lib/design'
import { legalTextQuery } from '~/lib/queries'

// Datenschutzerklärung als eigener Text aus der Design-Seite (Issue #190), öffentlich ohne Anmeldung.
export const Route = createFileRoute('/datenschutz')({
  loader: async ({ context }) => {
    const text = await context.queryClient.ensureQueryData(legalTextQuery('privacy'))
    if (text == null) throw notFound()
  },
  head: ({ match }) => ({ meta: [{ title: pageTitle('Datenschutzerklärung', match.context.design) }] }),
  component: Page,
})

function Page() {
  const { data } = useSuspenseQuery(legalTextQuery('privacy'))
  return <LegalTextPage title="Datenschutzerklärung" text={data ?? ''} />
}
