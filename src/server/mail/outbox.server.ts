import { schema, type Tx } from '../db/client.server'
import type { MailContent } from './templates'

/** Legt E-Mails in der Outbox ab. Wird innerhalb der auslösenden Transaktion aufgerufen. */
export async function enqueueMail(tx: Tx, recipients: string[], content: MailContent) {
  const unique = [...new Set(recipients.map((r) => r.trim().toLowerCase()).filter(Boolean))]
  if (unique.length === 0) return
  await tx.insert(schema.emailOutbox).values(unique.map((to) => ({ to, ...content })))
}
