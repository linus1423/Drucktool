import { createFileRoute } from '@tanstack/react-router'
import { startOidcLogin } from '~/server/auth/oidc-flow.server'

export const Route = createFileRoute('/api/auth/oidc/login')({
  server: { handlers: { GET: ({ request }) => startOidcLogin(request) } },
})
