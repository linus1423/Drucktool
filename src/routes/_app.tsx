import { useEffect, useRef, useState } from 'react'
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

  const adminLinks = [
    ...(user.role === 'superadmin' ? [{ to: '/admin/freigaben', label: 'Freigaben' } as const] : []),
    ...(isAdminRole(user.role)
      ? ([
          { to: '/admin/organisationen', label: 'Organisationen' },
          { to: '/admin/benutzer', label: 'Benutzer' },
          { to: '/admin/katalog', label: 'Katalog und Preise' },
          { to: '/admin/emails', label: 'E-Mails' },
        ] as const)
      : []),
    ...(user.role === 'superadmin' ? [{ to: '/admin/protokoll', label: 'Protokoll' } as const] : []),
  ]

  const links = (
    <>
      <Link to="/uebersicht" className={navLink} activeProps={navActive}>
        Übersicht
      </Link>
      <Link to="/auftraege" className={navLink} activeProps={navActive}>
        Aufträge
      </Link>
      {isStaffRole(user.role) || user.organisations.some((o) => o.isSvk) ? (
        <Link to="/skripte" className={navLink} activeProps={navActive}>
          Skripte
        </Link>
      ) : null}
      {isStaffRole(user.role) ? (
        <Link to="/organisationsanfragen" className={navLink} activeProps={navActive}>
          Organisationsanfragen
        </Link>
      ) : null}
    </>
  )
  const adminLinkList = adminLinks.map((link) => (
    <Link key={link.to} to={link.to} className={navLink} activeProps={navActive}>
      {link.label}
    </Link>
  ))
  const account = (
    <>
      <Link to="/profil" className="leading-tight hover:underline md:text-right">
        <div className="font-medium">{user.name}</div>
        <div className="text-xs text-slate-600">
          {isStaffRole(user.role) ? ROLE_LABELS[user.role] : user.organisations.map((o) => o.name).join(', ') || user.email}
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
          <Link to="/uebersicht" className="mr-auto text-lg font-semibold tracking-tight lg:mr-4">
            Drucktool
          </Link>
          {/* Unter 1024 px klappt die Navigation hinter einem Menüknopf zusammen (Issue #20, #152). */}
          <button
            type="button"
            className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 lg:hidden"
            aria-expanded={menuOpen}
            aria-controls="hauptmenue"
            onClick={() => setMenuOpen((o) => !o)}
          >
            {menuOpen ? 'Menü schließen' : 'Menü'}
          </button>
          <nav aria-label="Hauptnavigation" className="hidden flex-1 flex-wrap gap-1 lg:flex">
            {links}
            {adminLinks.length > 0 ? <AdminMenu pathname={pathname} links={adminLinks} /> : null}
          </nav>
          <div className="hidden items-center gap-3 text-sm lg:flex">{account}</div>
          {menuOpen ? (
            <div id="hauptmenue" className="w-full lg:hidden">
              <nav aria-label="Hauptnavigation" className="flex flex-col gap-1">
                {links}
                {adminLinks.length > 0 ? (
                  <>
                    <p className="mt-2 px-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Verwaltung</p>
                    {adminLinkList}
                  </>
                ) : null}
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
      {isAdminRole(user.role) ? <VersionInfo /> : null}
    </div>
  )
}

type AdminPath =
  '/admin/freigaben' | '/admin/organisationen' | '/admin/benutzer' | '/admin/katalog' | '/admin/emails' | '/admin/protokoll'

/**
 * Verwaltungsseiten als Aufklappmenü, damit die Navigation auch für Superadmins in eine Zeile passt (Issue #152).
 * Schließt beim Klick auf einen Eintrag, mit Escape und bei Klick außerhalb.
 */
function AdminMenu({ pathname, links }: { pathname: string; links: readonly { to: AdminPath; label: string }[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const active = pathname.startsWith('/admin/')
  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      ref.current?.querySelector('button')?.focus()
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={`${navLink} ${active ? navActive.className : ''}`}
        aria-expanded={open}
        aria-controls="verwaltungsmenue"
        onClick={() => setOpen((o) => !o)}
      >
        Verwaltung <span aria-hidden>▾</span>
      </button>
      {open ? (
        <div
          id="verwaltungsmenue"
          className="absolute left-0 z-20 mt-1 flex min-w-48 flex-col gap-1 rounded-md bg-white p-1 shadow-lg ring-1 ring-slate-200"
        >
          {links.map((link) => (
            <Link key={link.to} to={link.to} className={navLink} activeProps={navActive} onClick={() => setOpen(false)}>
              {link.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Laufende Version für Admins, z. B. für Fehlermeldungen und Rollbacks. */
function VersionInfo() {
  const { appInfo } = Route.useRouteContext()
  return (
    <p className="pb-6 text-center text-xs text-slate-500">
      Version {appInfo.version}
      {appInfo.commit ? ` (${appInfo.commit})` : null}
      {appInfo.environment !== 'production' ? ` · ${appInfo.environment === 'staging' ? 'Testsystem' : 'Entwicklung'}` : null}
    </p>
  )
}
