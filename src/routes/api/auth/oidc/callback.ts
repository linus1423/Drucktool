import { createFileRoute } from '@tanstack/react-router'
import { finishOidcLogin } from '~/server/auth/oidc-flow.server'

export const Route = createFileRoute('/api/auth/oidc/callback')({
  server: { handlers: { GET: ({ request }) => finishOidcLogin(request) } },
})
