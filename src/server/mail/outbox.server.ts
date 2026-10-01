import { schema, type Tx } from '../db/client.server'
import { applyMailTemplate } from './mail-templates.server'
import type { MailContent } from './templates'

/**
 * Legt E-Mails in der Outbox ab. Wird innerhalb der auslösenden Transaktion aufgerufen.
 * Angepasste Vorlagen und das Layout aus der Verwaltung werden hier angewendet (Issue #89).
 */
export async function enqueueMail(tx: Tx, recipients: string[], content: MailContent) {
  const unique = [...new Set(recipients.map((r) => r.trim().toLowerCase()).filter(Boolean))]
  if (unique.length === 0) return
  const mail = await applyMailTemplate(tx, content)
  await tx
    .insert(schema.emailOutbox)
    .values(unique.map((to) => ({ to, subject: mail.subject, text: mail.text, html: mail.html })))
}
