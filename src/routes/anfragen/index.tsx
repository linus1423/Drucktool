import { createFileRoute, redirect } from '@tanstack/react-router'

// Alte Adresse aus früheren E-Mails.
export const Route = createFileRoute('/anfragen/')({
  beforeLoad: () => {
    throw redirect({ to: '/auftraege', statusCode: 301 })
  },
})
