import type { ReactNode } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { HeadContent, Link, Outlet, Scripts, createRootRouteWithContext } from '@tanstack/react-router'
import { currentUserQuery } from '~/lib/queries'
import appCss from '~/styles.css?url'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(currentUserQuery)
    return { user }
  },
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Drucktool' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
  component: Outlet,
  notFoundComponent: NotFound,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
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
