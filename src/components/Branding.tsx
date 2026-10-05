import { useQuery } from '@tanstack/react-query'
import { DEFAULT_SITE_NAME } from '~/lib/design'
import { designQuery } from '~/lib/queries'
import { cx } from './ui'

/** Design der Instanz (Issue #186). Wird im Root geladen; bis dahin gelten die Standardwerte. */
export function useDesign() {
  const { data } = useQuery(designQuery)
  return (
    data ?? {
      siteName: DEFAULT_SITE_NAME,
      tagline: '',
      logoMode: 'logo_and_name' as const,
      logoUrl: null,
      faviconUrl: null,
      footer: { imprintHref: null, privacyHref: null, links: [], text: '' },
    }
  )
}

/** Logo und/oder Name der Instanz, für Kopfzeile und Anmeldeseiten. */
export function SiteBrand({ size = 'header' }: { size?: 'header' | 'auth' }) {
  const design = useDesign()
  const showName = !design.logoUrl || design.logoMode === 'logo_and_name'
  return (
    <span className={cx('flex items-center gap-2', size === 'auth' && 'flex-col')}>
      {design.logoUrl ? (
        <img
          src={design.logoUrl}
          alt={showName ? '' : design.siteName}
          className={cx('w-auto max-w-48 object-contain', size === 'auth' ? 'max-h-16' : 'max-h-9')}
        />
      ) : null}
      {showName ? (
        <span className="leading-tight">
          <span className="block">{design.siteName}</span>
          {design.tagline ? (
            <span className={cx('text-xs font-normal opacity-80', size === 'header' ? 'hidden sm:block' : 'block')}>
              {design.tagline}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}

/** Fußzeile mit Impressum, Datenschutz, weiteren Links und freiem Text (Issue #190). */
export function SiteFooter({ className }: { className?: string }) {
  const { footer } = useDesign()
  const links = [
    ...(footer.privacyHref ? [{ label: 'Datenschutzerklärung', url: footer.privacyHref }] : []),
    ...(footer.imprintHref ? [{ label: 'Impressum', url: footer.imprintHref }] : []),
    ...footer.links,
  ]
  if (!links.length && !footer.text) return null
  return (
    <div className={cx('space-y-2 px-4 text-center text-xs text-slate-600', className)}>
      {links.length ? (
        <nav aria-label="Rechtliches">
          <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1">
            {links.map((link) => (
              <li key={`${link.label}-${link.url}`}>
                <a
                  href={link.url}
                  className="hover:text-slate-900 hover:underline"
                  {...(link.url.startsWith('/') ? {} : { rel: 'noopener noreferrer' })}
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      {footer.text ? <p className="whitespace-pre-line">{footer.text}</p> : null}
    </div>
  )
}
