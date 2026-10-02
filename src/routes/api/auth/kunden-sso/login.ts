import { createFileRoute } from '@tanstack/react-router'
import { startOidcLogin } from '~/server/auth/oidc-flow.server'

// Kunden-Anmeldung über den Federated TUM Keycloak oder einen anderen OIDC-Anbieter (Issue #60).
export const Route = createFileRoute('/api/auth/kunden-sso/login')({
  server: { handlers: { GET: ({ request }) => startOidcLogin(request, 'customer') } },
})
