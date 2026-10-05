// Angepasste E-Mail-Vorlagen und das gemeinsame Layout beim Versand anwenden (Issue #89).
// Bewusst ohne Abhängigkeit zu TanStack Start, weil der Mail-Worker dieses Modul mitbündelt.
import { eq } from 'drizzle-orm'
import { colorTokens, legalHref, siteName } from '~/lib/design'
import {
  DEFAULT_MAIL_LAYOUT,
  defaultTemplate,
  mailLayoutSchema,
  renderMail,
  type MailBrand,
  type MailLayout,
  type MailTemplateKey,
  type StoredTemplate,
} from '~/lib/mail-templates'
import { getDb, schema, type Tx } from '../db/client.server'
import { getDesign, logoPath, logoVersions } from '../design/design.server'
import { appUrl, type MailContent } from './templates'

const { mailTemplates, settings } = schema
export type Db = ReturnType<typeof getDb> | Tx

export const LAYOUT_KEY = 'mail_layout'

/** Mail-Layout; ohne eigene Kopfzeile gilt der Name aus der Design-Seite (Issue #191). */
export async function getMailLayout(db: Db = getDb()): Promise<MailLayout> {
  const [[row], design] = await Promise.all([
    db.select({ value: settings.value }).from(settings).where(eq(settings.key, LAYOUT_KEY)),
    getDesign(db),
  ])
  const parsed = mailLayoutSchema.partial().safeParse(row?.value ?? {})
  return { ...DEFAULT_MAIL_LAYOUT, header: siteName(design), ...(parsed.success ? parsed.data : {}) }
}

/** Logo, Primärfarbe und Fußzeilenlinks aus der Design-Seite für HTML-Mails, mit absoluten Adressen. */
export async function getMailBrand(db: Db = getDb()): Promise<MailBrand> {
  const [design, versions] = await Promise.all([getDesign(db), logoVersions(db)])
  const tokens = colorTokens(design.colors)
  const absolute = (href: string) => (href.startsWith('/') ? appUrl(href) : href)
  const imprint = legalHref(design.imprint, '/impressum', process.env.IMPRINT_URL)
  const privacy = legalHref(design.privacy, '/datenschutz', process.env.PRIVACY_URL)
  return {
    siteName: siteName(design),
    logoUrl: versions.logo ? appUrl(logoPath('logo', versions.logo)) : null,
    primary: tokens.primary,
    primaryFg: tokens.primaryFg,
    links: [
      ...(privacy ? [{ label: 'Datenschutzerklärung', href: absolute(privacy) }] : []),
      ...(imprint ? [{ label: 'Impressum', href: absolute(imprint) }] : []),
      ...design.footerLinks.map((l) => ({ label: l.label, href: l.url })),
    ],
  }
}

export async function storedTemplate(db: Db, key: MailTemplateKey): Promise<StoredTemplate> {
  const [row] = await db.select().from(mailTemplates).where(eq(mailTemplates.key, key))
  return row ? { subject: row.subject, mode: row.mode, blocks: row.blocks, html: row.html } : defaultTemplate(key)
}

/** Rendert eine Mail neu mit der gespeicherten Vorlage und dem Layout; ohne Vorlageninfo bleibt sie unverändert. */
export async function applyMailTemplate(db: Db, content: MailContent) {
  const { template, ...plain } = content
  if (!template) return plain
  const [t, layout, brand] = await Promise.all([storedTemplate(db, template.key), getMailLayout(db), getMailBrand(db)])
  return renderMail(t, template.vars, layout, brand)
}
