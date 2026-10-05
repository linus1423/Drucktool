import { useState } from 'react'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { AuthLayout } from '~/components/AuthLayout'
import { Alert, Button } from '~/components/ui'
import { errorMessage } from '~/lib/errors'
import { redeemLoginLinkFn } from '~/server/auth/auth.functions'
import { pageTitle } from '~/lib/design'

// Der Link aus der Mail führt hierher. Eingelöst wird erst per Klick, damit Link-Vorschauen
// von Mailprogrammen den Einmal-Link nicht verbrauchen.
export const Route = createFileRoute('/anmelden')({
  validateSearch: z.object({ token: z.string().max(200).optional().catch(undefined) }),
  head: ({ match }) => ({ meta: [{ title: pageTitle('Anmelden', match.context.design) }] }),
  component: RedeemPage,
})

function RedeemPage() {
  const { token } = Route.useSearch()
  const router = useRouter()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function redeem() {
    if (!token) return
    setPending(true)
    setError(null)
    try {
      const { redirect } = await redeemLoginLinkFn({ data: { token } })
      queryClient.clear()
      await router.invalidate()
      await router.navigate({ href: redirect, replace: true })
    } catch (e) {
      setError(errorMessage(e))
      setPending(false)
    }
  }

  return (
    <AuthLayout title="Anmelden">
      <div className="space-y-4">
        {!token ? <Alert>Der Link ist unvollständig. Bitte öffnen Sie ihn direkt aus der E-Mail.</Alert> : null}
        {error ? <Alert>{error}</Alert> : null}
        {token && !error ? (
          <Button className="w-full" onClick={redeem} disabled={pending}>
            {pending ? 'Anmelden …' : 'Jetzt anmelden'}
          </Button>
        ) : (
          <Link to="/login" className="block text-center text-sm font-medium text-slate-900 underline">
            Neuen Link anfordern
          </Link>
        )}
      </div>
    </AuthLayout>
  )
}
