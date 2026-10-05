// Design-Seite der Verwaltung: Einstellungen, Logo und Favicon speichern (Issue #186), mit Eintrag im Protokoll.
import { eq } from 'drizzle-orm'
import { LOGO_MAX_BYTES, detectImageType, type Design, type LogoKind } from '~/lib/design'
import { isAdminRole } from '~/lib/roles'
import { writeAudit } from '../audit/audit.server'
import { getDb, schema } from '../db/client.server'
import { DESIGN_KEY, LOGO_KEYS, getDesign, logoPath, logoVersions, type StoredLogo } from './design.server'

const { settings } = schema
type Actor = { id: string; role: 'superadmin' | 'admin' | 'staff' | 'customer' }

function requireAdminActor(actor: Actor) {
  if (!isAdminRole(actor.role)) throw new Error('Keine Berechtigung')
}

/** Für die Design-Seite: gespeicherte Werte plus, was aus der Serverkonfiguration kommt. */
export async function getDesignSettings(actor: Actor) {
  requireAdminActor(actor)
  const db = getDb()
  const [design, versions] = await Promise.all([getDesign(db), logoVersions(db)])
  return {
    design,
    logoUrl: versions.logo ? logoPath('logo', versions.logo) : null,
    faviconUrl: versions.favicon ? logoPath('favicon', versions.favicon) : null,
    fallback: { imprintUrl: process.env.IMPRINT_URL || null, privacyUrl: process.env.PRIVACY_URL || null },
  }
}

const FIELD_LABELS: Record<keyof Design, string> = {
  siteName: 'Name',
  tagline: 'Untertitel',
  logoMode: 'Logo-Anzeige',
  colors: 'Farben',
  imprint: 'Impressum',
  privacy: 'Datenschutz',
  footerLinks: 'Links',
  footerText: 'Fußzeilentext',
}

export async function saveDesign(actor: Actor, design: Design) {
  requireAdminActor(actor)
  return getDb().transaction(async (tx) => {
    const before = await getDesign(tx)
    await tx
      .insert(settings)
      .values({ key: DESIGN_KEY, value: design })
      .onConflictDoUpdate({ target: settings.key, set: { value: design, updatedAt: new Date() } })
    const changed = (Object.keys(FIELD_LABELS) as (keyof Design)[])
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(design[k]))
      .map((k) => FIELD_LABELS[k])
    await writeAudit(tx, {
      actorId: actor.id,
      action: 'design.updated',
      targetType: 'design',
      targetId: null,
      before,
      after: design,
      data: { changed },
    })
    return { ok: true }
  })
}

/** Prüft Größe und Format am Inhalt und speichert das Bild. */
export async function saveLogo(actor: Actor, kind: LogoKind, base64: string) {
  requireAdminActor(actor)
  const bytes = Buffer.from(base64, 'base64')
  if (!bytes.length) throw new Error('Die Datei ist leer.')
  if (bytes.length > LOGO_MAX_BYTES) throw new Error(`Die Datei ist zu groß (höchstens ${LOGO_MAX_BYTES / 1024} KB).`)
  const type = detectImageType(bytes)
  if (!type) throw new Error('Bitte ein Bild als PNG, JPEG, WebP oder SVG hochladen.')
  const value: StoredLogo = { type, data: bytes.toString('base64'), sizeBytes: bytes.length }
  return getDb().transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ key: LOGO_KEYS[kind], value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
    await writeAudit(tx, {
      actorId: actor.id,
      action: 'design.logo_updated',
      targetType: 'design',
      targetId: kind,
      data: { type, sizeBytes: bytes.length },
    })
    return { ok: true }
  })
}

export async function removeLogo(actor: Actor, kind: LogoKind) {
  requireAdminActor(actor)
  return getDb().transaction(async (tx) => {
    const deleted = await tx.delete(settings).where(eq(settings.key, LOGO_KEYS[kind])).returning({ key: settings.key })
    if (deleted.length) {
      await writeAudit(tx, { actorId: actor.id, action: 'design.logo_removed', targetType: 'design', targetId: kind })
    }
    return { ok: true }
  })
}
