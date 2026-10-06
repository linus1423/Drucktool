import type { ReactNode } from 'react'
import { SiteBrand, SiteFooter } from './Branding'

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="flex justify-center text-sm font-semibold tracking-widest text-slate-600 uppercase">
            <SiteBrand size="auth" />
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? <p className="mt-1 text-sm text-slate-600">{subtitle}</p> : null}
        </div>
        <div className="rounded-lg bg-white p-6 shadow-sm ring-1 ring-slate-200">{children}</div>
        <SiteFooter className="mt-6" />
      </div>
    </div>
  )
}
