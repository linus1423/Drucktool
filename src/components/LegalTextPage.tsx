import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { parseSimpleText, type TextPart } from '~/lib/design'
import { SiteBrand, SiteFooter } from './Branding'

function Parts({ parts }: { parts: TextPart[] }) {
  return parts.map((part, i) =>
    part.href ? (
      <a key={i} href={part.href} className="font-medium text-accent-strong underline" rel="noopener noreferrer">
        {part.text}
      </a>
    ) : (
      <span key={i}>{part.text}</span>
    ),
  )
}

/** Öffentliche Textseite für Impressum und Datenschutzerklärung aus der Design-Seite (Issue #190). */
export function LegalTextPage({ title, text }: { title: string; text: string }) {
  const nodes = parseSimpleText(text)
  const content: ReactNode[] = nodes.map((node, i) => {
    if (node.kind === 'h2')
      return (
        <h2 key={i} className="mt-6 text-lg font-semibold">
          <Parts parts={node.parts} />
        </h2>
      )
    if (node.kind === 'h3')
      return (
        <h3 key={i} className="mt-4 font-semibold">
          <Parts parts={node.parts} />
        </h3>
      )
    if (node.kind === 'ul') {
      return (
        <ul key={i} className="list-disc space-y-1 pl-5">
          {node.items.map((item, j) => (
            <li key={j}>
              <Parts parts={item} />
            </li>
          ))}
        </ul>
      )
    }
    return (
      <p key={i} className="whitespace-pre-line">
        <Parts parts={node.parts} />
      </p>
    )
  })
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-header text-header-fg">
        <div className="mx-auto flex max-w-3xl items-center px-4 py-3">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            <SiteBrand />
          </Link>
        </div>
      </header>
      <main id="inhalt" className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <div className="mt-4 space-y-3 text-sm leading-relaxed text-slate-800">{content}</div>
      </main>
      <SiteFooter className="pb-8" />
    </div>
  )
}
