import { createFileRoute, redirect } from '@tanstack/react-router'

// Alte Links aus früheren E-Mails (/anfragen/<id>) führen zum Auftrag.
export const Route = createFileRoute('/anfragen/$')({
  beforeLoad: ({ params }) => {
    const id = params._splat ?? ''
    if (/^[0-9a-f-]{36}$/i.test(id)) throw redirect({ to: '/auftraege/$requestId', params: { requestId: id }, statusCode: 301 })
    throw redirect({ to: '/auftraege', statusCode: 301 })
  },
})
