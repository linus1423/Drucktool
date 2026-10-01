// Angepasste E-Mail-Vorlagen und das gemeinsame Layout beim Versand anwenden (Issue #89).
// Bewusst ohne Abhängigkeit zu TanStack Start, weil der Mail-Worker dieses Modul mitbündelt.
import { eq } from 'drizzle-orm'
import {
  DEFAULT_MAIL_LAYOUT,
  defaultTemplate,
  mailLayoutSchema,
  renderMail,
  type MailLayout,
  type MailTemplateKey,
  type StoredTemplate,
} from '~/lib/mail-templates'
import { getDb, schema, type Tx } from '../db/client.server'
import type { MailContent } from './templates'

const { mailTemplates, settings } = schema
export type Db = ReturnType<typeof getDb> | Tx

export const LAYOUT_KEY = 'mail_layout'

export async function getMailLayout(db: Db = getDb()): Promise<MailLayout> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, LAYOUT_KEY))
  const parsed = mailLayoutSchema.partial().safeParse(row?.value ?? {})
  return { ...DEFAULT_MAIL_LAYOUT, ...(parsed.success ? parsed.data : {}) }
}

export async function storedTemplate(db: Db, key: MailTemplateKey): Promise<StoredTemplate> {
  const [row] = await db.select().from(mailTemplates).where(eq(mailTemplates.key, key))
  return row ? { subject: row.subject, mode: row.mode, blocks: row.blocks, html: row.html } : defaultTemplate(key)
}

/** Rendert eine Mail neu mit der gespeicherten Vorlage und dem Layout; ohne Vorlageninfo bleibt sie unverändert. */
export async function applyMailTemplate(db: Db, content: MailContent) {
  const { template, ...plain } = content
  if (!template) return plain
  const [t, layout] = await Promise.all([storedTemplate(db, template.key), getMailLayout(db)])
  return renderMail(t, template.vars, layout)
}
