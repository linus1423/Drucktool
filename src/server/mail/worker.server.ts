import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { schema, type getDb } from '../db/client.server'
import type { MailTransport } from './transport.server'
type Db = ReturnType<typeof getDb>

export const MAX_ATTEMPTS = 8

/** Wartezeit bis zum nächsten Versuch: 1, 2, 4, … Minuten, höchstens 2 Stunden. */
export function retryDelayMs(attempts: number) {
  return Math.min(2 ** Math.max(attempts - 1, 0) * 60_000, 2 * 60 * 60_000)
}

/**
 * Verschickt fällige E-Mails. Mehrere Worker können parallel laufen:
 * FOR UPDATE SKIP LOCKED verhindert, dass eine Mail doppelt verschickt wird.
 * Gibt die Anzahl der bearbeiteten Mails zurück.
 */
export async function processOutbox(db: Db, transport: MailTransport, batchSize = 20): Promise<number> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(schema.emailOutbox)
      .where(and(eq(schema.emailOutbox.status, 'pending'), lte(schema.emailOutbox.nextAttemptAt, new Date())))
      .orderBy(asc(schema.emailOutbox.createdAt))
      .limit(batchSize)
      .for('update', { skipLocked: true })

    for (const mail of due) {
      try {
        await transport.send({ to: mail.to, subject: mail.subject, text: mail.text, html: mail.html })
        await tx
          .update(schema.emailOutbox)
          .set({ status: 'sent', sentAt: new Date(), attempts: sql`${schema.emailOutbox.attempts} + 1`, lastError: null })
          .where(eq(schema.emailOutbox.id, mail.id))
      } catch (error) {
        const attempts = mail.attempts + 1
        await tx
          .update(schema.emailOutbox)
          .set({
            attempts,
            status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
            lastError: error instanceof Error ? error.message.slice(0, 1000) : String(error),
            nextAttemptAt: new Date(Date.now() + retryDelayMs(attempts)),
          })
          .where(eq(schema.emailOutbox.id, mail.id))
      }
    }
    return due.length
  })
}
