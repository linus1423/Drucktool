import { useEffect, useState } from 'react'
import { createFileRoute, Link, Outlet, redirect, useRouter, useRouterState } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ROLE_LABELS, isAdminRole, isStaffRole } from '~/lib/roles'
import { logout } from '~/server/auth/auth.functions'
import { LegalLinks } from '~/components/LegalLinks'

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
  const [menuOpen, setMenuOpen] = useState(false)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // Nach dem Navigieren schließt das Menü wieder.
  useEffect(() => setMenuOpen(false), [pathname])

  async function handleLogout() {
    await logout()
    queryClient.clear()
    await router.invalidate()
    await router.navigate({ to: '/login' })
  }

  const links = (
    <>
      <Link to="/uebersicht" className={navLink} activeProps={navActive}>
        Übersicht
      </Link>
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
          <Link to="/admin/emails" className={navLink} activeProps={navActive}>
            E-Mails
          </Link>
        </>
      ) : null}
      {user.role === 'superadmin' ? (
        <Link to="/admin/protokoll" className={navLink} activeProps={navActive}>
          Protokoll
        </Link>
      ) : null}
    </>
  )
  const account = (
    <>
      <Link to="/profil" className="leading-tight hover:underline md:text-right">
        <div className="font-medium">{user.name}</div>
        <div className="text-xs text-slate-600">
          {isStaffRole(user.role) ? ROLE_LABELS[user.role] : (user.organisationName ?? user.email)}
        </div>
      </Link>
      <button type="button" onClick={handleLogout} className={navLink}>
        Abmelden
      </button>
    </>
  )

  return (
    <div className="min-h-screen">
      <a
        href="#inhalt"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:ring-2 focus:ring-sky-500"
      >
        Zum Inhalt springen
      </a>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-3">
          <Link to="/uebersicht" className="mr-auto text-lg font-semibold tracking-tight md:mr-4">
            Drucktool
          </Link>
          {/* Auf schmalen Bildschirmen klappt die Navigation hinter einem Menüknopf zusammen (Issue #20). */}
          <button
            type="button"
            className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 md:hidden"
            aria-expanded={menuOpen}
            aria-controls="hauptmenue"
            onClick={() => setMenuOpen((o) => !o)}
          >
            {menuOpen ? 'Menü schließen' : 'Menü'}
          </button>
          <nav aria-label="Hauptnavigation" className="hidden flex-1 flex-wrap gap-1 md:flex">
            {links}
          </nav>
          <div className="hidden items-center gap-3 text-sm md:flex">{account}</div>
          {menuOpen ? (
            <div id="hauptmenue" className="w-full md:hidden">
              <nav aria-label="Hauptnavigation" className="flex flex-col gap-1">
                {links}
              </nav>
              <div className="mt-3 flex items-center justify-between gap-3 border-t border-slate-200 pt-3 text-sm">{account}</div>
            </div>
          ) : null}
        </div>
      </header>
      <main id="inhalt" tabIndex={-1} className="mx-auto max-w-7xl px-4 py-8 focus:outline-none">
        <Outlet />
      </main>
      <LegalLinks className="pb-8" />
    </div>
  )
}
