import { useQuery } from '@tanstack/react-query'
import { siteLinksQuery } from '~/lib/queries'

/** Links auf Datenschutzerklärung und Impressum, sofern PRIVACY_URL bzw. IMPRINT_URL gesetzt sind. */
export function LegalLinks({ className }: { className?: string }) {
  const { data } = useQuery(siteLinksQuery)
  if (!data?.privacyUrl && !data?.imprintUrl) return null
  return (
    <nav className={className} aria-label="Rechtliches">
      <ul className="flex justify-center gap-4 text-xs text-slate-500">
        {data.privacyUrl ? (
          <li>
            <a href={data.privacyUrl} className="hover:text-slate-800 hover:underline" rel="noopener noreferrer">
              Datenschutzerklärung
            </a>
          </li>
        ) : null}
        {data.imprintUrl ? (
          <li>
            <a href={data.imprintUrl} className="hover:text-slate-800 hover:underline" rel="noopener noreferrer">
              Impressum
            </a>
          </li>
        ) : null}
      </ul>
    </nav>
  )
}
