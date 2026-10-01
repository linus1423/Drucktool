import { createFileRoute, redirect } from '@tanstack/react-router'

// Kunden legen ihr Konto beim ersten Anmeldelink an; die alte Registrierung leitet dorthin weiter.
export const Route = createFileRoute('/registrieren')({
  beforeLoad: () => {
    throw redirect({ to: '/login' })
  },
})
