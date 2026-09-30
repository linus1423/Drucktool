import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/konto')({
  beforeLoad: () => {
    throw redirect({ to: '/profil' })
  },
})
