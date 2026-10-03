import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { useQueryErrorResetBoundary } from '@tanstack/react-query'
import { Alert, Button } from '~/components/ui'
import { errorMessage } from '~/lib/errors'

/**
 * Fehlerseite für alle Routen ohne eigene errorComponent (Issue #150). Ersetzt die englische Standardseite von TanStack.
 * Serverfehler kommen von der Middleware bereits als deutsche Meldung mit Fehlernummer an.
 */
export function ErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  const queryReset = useQueryErrorResetBoundary()

  async function retry() {
    queryReset.reset()
    await router.invalidate()
    reset()
  }

  return (
    <div className="mx-auto max-w-xl space-y-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Das hat nicht geklappt</h1>
      <Alert>{errorMessage(error)}</Alert>
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => void retry()}>Erneut versuchen</Button>
        <Link
          to="/"
          className="inline-flex items-center rounded-md px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-100"
        >
          Zur Startseite
        </Link>
      </div>
    </div>
  )
}
