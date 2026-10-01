// Verwaltung der E-Mail-Vorlagen und des Layouts durch Admins (Issue #89).
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { isAdminRole } from '~/lib/roles'
import {
  MAIL_TEMPLATES,
  MAIL_TEMPLATE_KEYS,
  defaultTemplate,
  mailTemplateKeySchema,
  renderMail,
  storedTemplateSchema,
  unknownPlaceholders,
  type MailLayout,
  type MailTemplateKey,
} from '~/lib/mail-templates'
import { writeAudit } from '../audit/audit.server'
import { getDb, schema } from '../db/client.server'
import { LAYOUT_KEY, getMailLayout, storedTemplate } from './mail-templates.server'

const { mailTemplates, settings } = schema
type Actor = { id: string; role: 'superadmin' | 'admin' | 'staff' | 'customer' }

function requireAdminActor(actor: Actor) {
  if (!isAdminRole(actor.role)) throw new Error('Keine Berechtigung')
}

/** Alle Vorlagen mit Beschreibung, Platzhaltern und aktuellem Stand für die Verwaltung. */
export async function listMailTemplates(actor: Actor) {
  requireAdminActor(actor)
  const db = getDb()
  const rows = await db.select().from(mailTemplates)
  const layout = await getMailLayout(db)
  return {
    layout,
    templates: MAIL_TEMPLATE_KEYS.map((key) => {
      const def = MAIL_TEMPLATES[key]
      const row = rows.find((r) => r.key === key)
      return {
        key,
        label: def.label,
        description: def.description,
        audience: def.audience,
        variables: def.variables as Record<string, string>,
        sample: def.sample as Record<string, string>,
        standard: defaultTemplate(key),
        current: row ? { subject: row.subject, mode: row.mode, blocks: row.blocks, html: row.html } : defaultTemplate(key),
        customized: !!row,
        updatedAt: row?.updatedAt ?? null,
      }
    }),
  }
}

export const saveMailTemplateSchema = z.object({ key: mailTemplateKeySchema, template: storedTemplateSchema })

export async function saveMailTemplate(actor: Actor, input: z.infer<typeof saveMailTemplateSchema>) {
  requireAdminActor(actor)
  const { key, template } = input
  const unknown = unknownPlaceholders(key, template)
  if (unknown.length) throw new Error(`Unbekannte Platzhalter: ${unknown.map((n) => `{{${n}}}`).join(', ')}`)
  if (template.mode === 'html' && !template.html.trim()) throw new Error('Im HTML-Modus fehlt der Inhalt')
  if (template.mode === 'blocks' && template.blocks.length === 0) throw new Error('Die Vorlage braucht mindestens einen Baustein')
  return getDb().transaction(async (tx) => {
    const before = await storedTemplate(tx, key)
    const values = { ...template, updatedById: actor.id, updatedAt: new Date() }
    await tx
      .insert(mailTemplates)
      .values({ key, ...values })
      .onConflictDoUpdate({ target: mailTemplates.key, set: values })
    await writeAudit(tx, {
      actorId: actor.id,
      action: 'mail_template.updated',
      targetType: 'mail_template',
      targetId: key,
      before,
      after: template,
    })
    return { ok: true }
  })
}

export async function resetMailTemplate(actor: Actor, key: MailTemplateKey) {
  requireAdminActor(actor)
  return getDb().transaction(async (tx) => {
    const before = await storedTemplate(tx, key)
    await tx.delete(mailTemplates).where(eq(mailTemplates.key, key))
    await writeAudit(tx, {
      actorId: actor.id,
      action: 'mail_template.reset',
      targetType: 'mail_template',
      targetId: key,
      before,
      after: defaultTemplate(key),
    })
    return { ok: true }
  })
}

export async function saveMailLayout(actor: Actor, layout: MailLayout) {
  requireAdminActor(actor)
  return getDb().transaction(async (tx) => {
    const before = await getMailLayout(tx)
    await tx
      .insert(settings)
      .values({ key: LAYOUT_KEY, value: layout })
      .onConflictDoUpdate({ target: settings.key, set: { value: layout, updatedAt: new Date() } })
    await writeAudit(tx, {
      actorId: actor.id,
      action: 'mail_layout.updated',
      targetType: 'mail_template',
      targetId: null,
      before,
      after: layout,
    })
    return { ok: true }
  })
}

export const testMailSchema = saveMailTemplateSchema

/** Schickt den aktuellen Entwurf mit Beispielwerten an die eigene Adresse, ohne ihn zu speichern. */
export async function sendTestMail(actor: Actor & { email: string }, input: z.infer<typeof testMailSchema>) {
  requireAdminActor(actor)
  const db = getDb()
  const mail = renderMail(input.template, MAIL_TEMPLATES[input.key].sample, await getMailLayout(db))
  await db
    .insert(schema.emailOutbox)
    .values({ to: actor.email, subject: `[Test] ${mail.subject}`, text: mail.text, html: mail.html })
  return { ok: true, to: actor.email }
}
