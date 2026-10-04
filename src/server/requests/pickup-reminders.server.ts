// Erinnerung an nicht abgeholte Aufträge (Issue #173). Läuft im stündlichen Aufräumjob des Mail-Workers: Liegt ein
// fertiger Abholauftrag länger als die eingestellte Frist in der Druckerei, bekommt der Kunde genau eine Mail über die
// Outbox, und im Verlauf steht, dass erinnert wurde. Bewusst ohne Abhängigkeit zu TanStack Start, weil der Mail-Worker
// dieses Modul mitbündelt.
import { and, asc, eq, isNull, lt } from 'drizzle-orm'
import { getDb, schema, type Tx } from '../db/client.server'
import { getDeadlineSettings } from '../catalog/catalog.server'
import { enqueueMail } from '../mail/outbox.server'
import { pickupReminderMail } from '../mail/templates'
import { mutedIds } from './watchers.server'

type Db = ReturnType<typeof getDb>
const { requests, requestEvents, users } = schema

/** Höchstens so viele Erinnerungen je Lauf; der Rest folgt im nächsten Lauf. */
const BATCH = 200

/** Der Kunde, sofern aktiv, mit eingeschalteten Benachrichtigungen und ohne den Auftrag stummgeschaltet zu haben. */
async function reminderRecipient(tx: Tx, request: { id: string; createdById: string }) {
  if ((await mutedIds(tx, request.id)).has(request.createdById)) return null
  const [row] = await tx
    .select({ email: users.email })
    .from(users)
    .where(
      and(
        eq(users.id, request.createdById),
        eq(users.role, 'customer'),
        eq(users.status, 'active'),
        eq(users.emailNotifications, true),
      ),
    )
  return row?.email ?? null
}

/**
 * Verschickt die fälligen Erinnerungen und gibt deren Zahl zurück. Mehrere Worker stören sich nicht: gesperrte Zeilen
 * werden übersprungen, und jeder Auftrag wird nur einmal erinnert.
 */
export async function sendPickupReminders(db: Db = getDb(), now = new Date()) {
  const { pickupReminderDays } = await getDeadlineSettings(db)
  const due = new Date(now.getTime() - pickupReminderDays * 24 * 60 * 60 * 1000)
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: requests.id,
        number: requests.number,
        title: requests.title,
        createdById: requests.createdById,
        statusChangedAt: requests.statusChangedAt,
      })
      .from(requests)
      .where(
        and(
          eq(requests.status, 'completed'),
          eq(requests.deliveryMethod, 'pickup'),
          isNull(requests.handedOverAt),
          isNull(requests.pickupReminderSentAt),
          lt(requests.statusChangedAt, due),
        ),
      )
      .orderBy(asc(requests.statusChangedAt))
      .limit(BATCH)
      .for('update', { skipLocked: true })
    for (const r of rows) {
      const email = await reminderRecipient(tx, r)
      if (email) await enqueueMail(tx, [email], pickupReminderMail({ ...r, completedAt: r.statusChangedAt, now }))
      await tx.update(requests).set({ pickupReminderSentAt: now }).where(eq(requests.id, r.id))
      // Intern im Verlauf, damit die Druckerei sieht, ob und wann erinnert wurde.
      await tx.insert(requestEvents).values({
        requestId: r.id,
        actorId: null,
        type: 'pickup_reminder_sent',
        internal: true,
        data: { emailed: !!email, days: pickupReminderDays },
      })
    }
    return rows.length
  })
}
