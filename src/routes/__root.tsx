import type { CSSProperties, ReactNode } from 'react'
import { useQuery, type QueryClient } from '@tanstack/react-query'
import { HeadContent, Link, Outlet, Scripts, createRootRouteWithContext } from '@tanstack/react-router'
import { appInfoQuery, currentUserQuery, designQuery } from '~/lib/queries'
import { DEFAULT_SITE_NAME } from '~/lib/design'
import appCss from '~/styles.css?url'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  beforeLoad: async ({ context }) => {
    const [user, design, appInfo] = await Promise.all([
      context.queryClient.ensureQueryData(currentUserQuery),
      context.queryClient.ensureQueryData(designQuery),
      context.queryClient.ensureQueryData(appInfoQuery),
    ])
    return { user, design, appInfo }
  },
  head: ({ match }) => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: match.context.design?.siteName ?? DEFAULT_SITE_NAME },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      // Ohne Favicon fragt jeder Browser /favicon.ico ab und bekommt 404 (Issue #148). Eigenes Favicon: Issue #188.
      match.context.design?.faviconUrl
        ? { rel: 'icon', href: match.context.design.faviconUrl }
        : { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
    ],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
  notFoundComponent: NotFound,
})

function RootDocument({ children }: { children: ReactNode }) {
  // Farben aus der Design-Seite als CSS-Variablen (Issue #189); serverseitig gerendert, damit nichts flackert.
  const { data: design } = useQuery(designQuery)
  return (
    <html lang="de" style={design?.cssVariables as CSSProperties | undefined}>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function RootComponent() {
  const { appInfo } = Route.useRouteContext()
  return (
    <>
      {appInfo.environment === 'staging' ? (
        <div role="status" className="bg-amber-400 px-4 py-1.5 text-center text-sm font-semibold text-amber-950">
          Testsystem – Aufträge werden hier nicht gedruckt, E-Mails gehen nicht an die echten Empfänger.
        </div>
      ) : null}
      <Outlet />
    </>
  )
}

function NotFound() {
  return (
    <div className="mx-auto max-w-md p-12 text-center">
      <h1 className="text-xl font-semibold">Seite nicht gefunden</h1>
      <Link to="/" className="mt-4 inline-block text-sm underline">
        Zur Startseite
      </Link>
    </div>
  )
}
