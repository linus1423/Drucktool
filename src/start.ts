import { createCsrfMiddleware, createStart } from '@tanstack/react-start'

// Schützt alle schreibenden Anfragen (Server-Funktionen, Formulare) vor Cross-Site-Requests.
const csrf = createCsrfMiddleware({
  filter: ({ request }) => request.method !== 'GET' && request.method !== 'HEAD',
})

export const startInstance = createStart(() => ({
  requestMiddleware: [csrf],
}))
