import { createRouter } from '@tanstack/react-router'
import { createIsomorphicFn, getGlobalStartContext } from '@tanstack/react-start'
import { QueryClient } from '@tanstack/react-query'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { routeTree } from './routeTree.gen'

// Nonce für die Content-Security-Policy, gesetzt von der Middleware in start.ts. Im Browser
// liest der Router ihn selbst aus dem Meta-Tag "csp-nonce".
const getCspNonce = createIsomorphicFn()
  .server(() => {
    try {
      return (getGlobalStartContext() as { nonce?: string } | undefined)?.nonce
    } catch {
      return undefined
    }
  })
  .client(() => undefined)

export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 10_000 } },
  })
  const nonce = getCspNonce()
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: 'intent',
    ...(nonce ? { ssr: { nonce } } : {}),
  })
  setupRouterSsrQueryIntegration({ router, queryClient })
  return router
}
