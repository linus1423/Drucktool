// Design-Einstellungen lesen (Issue #186). Bewusst ohne Abhängigkeit zu TanStack Start, weil der Mail-Worker dieses
// Modul für Logo und Farben in Mails mitbündelt. Speichern: design-admin.server.ts.
import { eq, inArray } from 'drizzle-orm'
import {
  DEFAULT_DESIGN,
  colorVariables,
  legalHref,
  parseDesign,
  siteName,
  type Design,
  type LogoKind,
  type LogoType,
} from '~/lib/design'
import { getDb, schema, type Tx } from '../db/client.server'

const { settings } = schema
export type Db = ReturnType<typeof getDb> | Tx

export const DESIGN_KEY = 'design'
export const LOGO_KEYS: Record<LogoKind, string> = { logo: 'design_logo', favicon: 'design_favicon' }

/** Gespeichertes Bild: Format und Inhalt als Base64. Klein genug für die Tabelle settings (höchstens 512 KB). */
export type StoredLogo = { type: LogoType; data: string; sizeBytes: number }

export async function getDesign(db: Db = getDb()): Promise<Design> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, DESIGN_KEY))
  return parseDesign(row?.value ?? DEFAULT_DESIGN)
}

/** Zeitstempel der hochgeladenen Bilder, für Versionsparameter in den URLs (neues Logo = neue URL, kein alter Cache). */
export async function logoVersions(db: Db): Promise<Record<LogoKind, number | null>> {
  const rows = await db
    .select({ key: settings.key, updatedAt: settings.updatedAt })
    .from(settings)
    .where(inArray(settings.key, Object.values(LOGO_KEYS)))
  const version = (kind: LogoKind) => rows.find((r) => r.key === LOGO_KEYS[kind])?.updatedAt.getTime() ?? null
  return { logo: version('logo'), favicon: version('favicon') }
}

export function logoPath(kind: LogoKind, version: number) {
  return `/api/design/${kind}?v=${version}`
}

/** Was jede Seite braucht, auch ohne Anmeldung: Name, Logo, Farben als CSS-Variablen und die Fußzeile. */
export async function getPublicDesign(db: Db = getDb()) {
  const [design, versions] = await Promise.all([getDesign(db), logoVersions(db)])
  return {
    siteName: siteName(design),
    tagline: design.tagline,
    logoMode: design.logoMode,
    logoUrl: versions.logo ? logoPath('logo', versions.logo) : null,
    faviconUrl: versions.favicon ? logoPath('favicon', versions.favicon) : null,
    colors: design.colors,
    cssVariables: colorVariables(design.colors),
    footer: {
      imprintHref: legalHref(design.imprint, '/impressum', process.env.IMPRINT_URL),
      privacyHref: legalHref(design.privacy, '/datenschutz', process.env.PRIVACY_URL),
      links: design.footerLinks,
      text: design.footerText,
    },
  }
}
export type PublicDesign = Awaited<ReturnType<typeof getPublicDesign>>

export async function getLogo(kind: LogoKind, db: Db = getDb()) {
  const [row] = await db.select().from(settings).where(eq(settings.key, LOGO_KEYS[kind]))
  const stored = row?.value as StoredLogo | undefined
  if (!stored?.data) return null
  return { type: stored.type, bytes: Buffer.from(stored.data, 'base64'), updatedAt: row!.updatedAt }
}

/** Eigener Text für /impressum bzw. /datenschutz, null wenn dort kein Text gepflegt ist. */
export async function getLegalText(page: 'imprint' | 'privacy', db: Db = getDb()) {
  const design = await getDesign(db)
  const entry = design[page]
  return entry.mode === 'text' ? entry.text : null
}
