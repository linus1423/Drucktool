import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { isAdminRole } from '~/lib/roles'

export const Route = createFileRoute('/_app/admin')({
  beforeLoad: ({ context }) => {
    if (!isAdminRole(context.user.role)) throw redirect({ to: '/auftraege' })
  },
  component: Outlet,
})
