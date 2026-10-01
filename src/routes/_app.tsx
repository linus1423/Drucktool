import { createFileRoute, Link, Outlet, redirect, useRouter } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ROLE_LABELS, isAdminRole, isStaffRole } from '~/lib/roles'
import { logout } from '~/server/auth/auth.functions'

export const Route = createFileRoute('/_app')({
  beforeLoad: ({ context, location }) => {
    if (!context.user) {
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }
    return { user: context.user }
  },
  component: AppLayout,
})

const navLink = 'rounded-md px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900'
const navActive = { className: 'bg-slate-100 text-slate-900' }

function AppLayout() {
  const { user } = Route.useRouteContext()
  const router = useRouter()
  const queryClient = useQueryClient()

  async function handleLogout() {
    await logout()
    queryClient.clear()
    await router.invalidate()
    await router.navigate({ to: '/login' })
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-3">
          <Link to="/auftraege" className="mr-4 text-lg font-semibold tracking-tight">
            Drucktool
          </Link>
          <nav className="flex flex-1 flex-wrap gap-1">
            <Link to="/auftraege" className={navLink} activeProps={navActive}>
              Aufträge
            </Link>
            {user.role === 'superadmin' ? (
              <Link to="/admin/freigaben" className={navLink} activeProps={navActive}>
                Freigaben
              </Link>
            ) : null}
            {isAdminRole(user.role) ? (
              <>
                <Link to="/admin/organisationen" className={navLink} activeProps={navActive}>
                  Organisationen
                </Link>
                <Link to="/admin/benutzer" className={navLink} activeProps={navActive}>
                  Benutzer
                </Link>
                <Link to="/admin/katalog" className={navLink} activeProps={navActive}>
                  Katalog und Preise
                </Link>
              </>
            ) : null}
            {user.role === 'superadmin' ? (
              <Link to="/admin/protokoll" className={navLink} activeProps={navActive}>
                Protokoll
              </Link>
            ) : null}
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <Link to="/profil" className="text-right leading-tight hover:underline">
              <div className="font-medium">{user.name}</div>
              <div className="text-xs text-slate-500">
                {isStaffRole(user.role) ? ROLE_LABELS[user.role] : (user.organisationName ?? user.email)}
              </div>
            </Link>
            <button type="button" onClick={handleLogout} className={navLink}>
              Abmelden
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  )
}
