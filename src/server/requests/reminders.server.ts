// Erinnerungen an den Kunden, wenn die Druckerei auf ihn wartet (Issue #174): offene Rückfrage, nicht
// angenommenes Angebot oder offener Änderungsvorschlag. Läuft im stündlichen Job des Mail-Workers.
// Höchstens eine Erinnerung je Wartephase: requests.reminded_at merkt sich die letzte Erinnerung, und eine neue
// gibt es erst, wenn danach eine neue Phase begonnen hat (Statuswechsel oder neuer Vorschlag).
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { DeadlineSettings } from '~/lib/deadlines'
import type { MailTemplateKey } from '~/lib/mail-templates'
import type { RequestStatus } from '~/lib/status'
import { getDeadlineSettings } from '../catalog/catalog.server'
import { schema, type getDb } from '../db/client.server'
import { logger } from '../log.server'
import { enqueueMail } from '../mail/outbox.server'
import { compose, requestVars } from '../mail/templates'
import { mutedIds } from './watchers.server'

type Db = ReturnType<typeof getDb>
const { requests, requestEvents, users } = schema

export type ReminderKind = 'on_hold' | 'offered' | 'proposal'

const DAY_MS = 24 * 60 * 60 * 1000

const TEMPLATE: Record<ReminderKind, MailTemplateKey> = {
  on_hold: 'reminder_on_hold',
  offered: 'reminder_offered',
  proposal: 'reminder_proposal',
}

type Waiting = {
  status: RequestStatus
  statusChangedAt: Date
  /** proposedAt des offenen Änderungsvorschlags, sonst null. */
  proposedAt: string | null
  remindedAt: Date | null
}

/**
 * Ist für den Auftrag eine Erinnerung fällig? Liefert die Art und den Beginn der Wartephase. Ein offener
 * Vorschlag hat Vorrang vor der Rückfrage, weil der Auftrag dabei ebenfalls auf „Rückfrage“ steht.
 */
export function dueReminder(r: Waiting, settings: DeadlineSettings, now = new Date()) {
  let kind: ReminderKind
  let since: Date
  let days: number
  if (r.status === 'on_hold' && r.proposedAt) {
    kind = 'proposal'
    since = new Date(r.proposedAt)
    days = settings.remindProposalDays
  } else if (r.status === 'on_hold') {
    kind = 'on_hold'
    since = r.statusChangedAt
    days = settings.remindOnHoldDays
  } else if (r.status === 'offered') {
    kind = 'offered'
    since = r.statusChangedAt
    days = settings.remindOfferedDays
  } else {
    return null
  }
  if (!days || Number.isNaN(since.getTime())) return null
  if (r.remindedAt && r.remindedAt.getTime() >= since.getTime()) return null
  const waited = now.getTime() - since.getTime()
  if (waited < days * DAY_MS) return null
  return { kind, since, days: Math.floor(waited / DAY_MS) }
}

const waitingColumns = {
  id: requests.id,
  number: requests.number,
  title: requests.title,
  createdById: requests.createdById,
  status: requests.status,
  statusChangedAt: requests.statusChangedAt,
  proposedAt: sql<string | null>`${requests.proposal}->>'proposedAt'`,
  reason: sql<string | null>`${requests.proposal}->>'reason'`,
  remindedAt: requests.remindedAt,
}

/**
 * Verschickt alle fälligen Erinnerungen und gibt ihre Anzahl zurück. Jeder Auftrag wird in einer eigenen
 * Transaktion gesperrt und erneut geprüft; laufen mehrere Worker gleichzeitig, erinnert nur einer.
 */
export async function sendWaitingReminders(db: Db, opts: { settings?: DeadlineSettings; now?: Date } = {}) {
  const settings = opts.settings ?? (await getDeadlineSettings(db))
  if (!settings.remindOnHoldDays && !settings.remindOfferedDays && !settings.remindProposalDays) return 0
  const now = opts.now ?? new Date()
  const candidates = await db
    .select(waitingColumns)
    .from(requests)
    .where(inArray(requests.status, ['on_hold', 'offered']))
  let sent = 0
  for (const candidate of candidates) {
    if (!dueReminder(candidate, settings, now)) continue
    const done = await db.transaction(async (tx) => {
      const [r] = await tx.select(waitingColumns).from(requests).where(eq(requests.id, candidate.id)).for('update')
      const due = r && dueReminder(r, settings, now)
      if (!r || !due) return false
      // Ohne Versionserhöhung, damit Mitarbeiter mit geöffnetem Auftrag keinen Konflikt bekommen.
      await tx.update(requests).set({ remindedAt: now }).where(eq(requests.id, r.id))
      const muted = await mutedIds(tx, r.id)
      if (muted.has(r.createdById)) return false
      const [customer] = await tx
        .select({ email: users.email })
        .from(users)
        .where(and(eq(users.id, r.createdById), eq(users.status, 'active'), eq(users.emailNotifications, true)))
      if (!customer) return false
      const dauer = due.days === 1 ? 'einem Tag' : `${due.days} Tagen`
      const vars: Record<string, string> = { ...requestVars(r), dauer }
      if (due.kind === 'offered') vars.email = customer.email
      if (due.kind === 'proposal') vars.grund = r.reason ?? ''
      await enqueueMail(tx, [customer.email], compose(TEMPLATE[due.kind], vars))
      await tx.insert(requestEvents).values({
        requestId: r.id,
        actorId: null,
        type: 'reminder_sent',
        data: { kind: due.kind, days: due.days },
      })
      return true
    })
    if (done) sent++
  }
  return sent
}

/** Für den stündlichen Job: Fehler landen im Log und beenden den Worker nicht. */
export async function runWaitingReminders(db: Db) {
  try {
    const sent = await sendWaitingReminders(db)
    if (sent) logger.info('Erinnerungen an Kunden verschickt', { count: sent })
  } catch (error) {
    logger.error('Erinnerungen fehlgeschlagen', { err: error })
  }
}
