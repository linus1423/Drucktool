// Termine und Fristen (Issue #14): zugesagter Termin für den Kunden, interne Frist für die Druckerei
// und Hinweise auf Aufträge, die zu lange im selben Status stehen.
import { z } from 'zod'
import type { DeliveryMethod } from './order'
import { TERMINAL_STATUSES, type RequestStatus } from './status'

const days = z.number().int().min(1, 'Mindestens 1 Tag').max(365)
// Erinnerungen (Issue #174): 0 schaltet ab. Fehlt der Wert in älteren Einstellungen, ist die Erinnerung aus.
const reminderDays = z.number().int().min(0, 'Mindestens 0 Tage').max(365).default(0)

/**
 * Ab wie vielen Tagen im selben Status ein Auftrag hervorgehoben wird, und nach wie vielen Tagen der Kunde
 * an eine offene Rückfrage, ein Angebot oder einen Änderungsvorschlag erinnert wird.
 */
export const deadlineSettingsSchema = z.object({
  staleSubmittedDays: days,
  staleOnHoldDays: days,
  staleConfirmedDays: days,
  remindOnHoldDays: reminderDays,
  remindOfferedDays: reminderDays,
  remindProposalDays: reminderDays,
  /** Ab wie vielen Tagen ein fertiger Abholauftrag als nicht abgeholt gilt und der Kunde erinnert wird (Issue #173). */
  pickupReminderDays: days,
})
export type DeadlineSettings = z.infer<typeof deadlineSettingsSchema>

export const DEFAULT_DEADLINE_SETTINGS: DeadlineSettings = {
  staleSubmittedDays: 2,
  staleOnHoldDays: 5,
  staleConfirmedDays: 10,
  remindOnHoldDays: 0,
  remindOfferedDays: 0,
  remindProposalDays: 0,
  pickupReminderDays: 7,
}

export type Attention = 'overdue' | 'due_today' | 'stale' | 'not_picked_up'

export const ATTENTION_LABELS: Record<Attention, string> = {
  overdue: 'Überfällig',
  due_today: 'Heute fällig',
  stale: 'Wartet lange',
  not_picked_up: 'Nicht abgeholt',
}

export const ATTENTION_TONES: Record<Attention, string> = {
  overdue: 'bg-rose-100 text-rose-800',
  due_today: 'bg-amber-100 text-amber-800',
  stale: 'bg-orange-100 text-orange-800',
  not_picked_up: 'bg-orange-100 text-orange-800',
}

/** Heutiges Datum in deutscher Zeit als YYYY-MM-DD. */
export function berlinToday(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(now)
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Was an einem Auftrag Aufmerksamkeit braucht, wichtigstes zuerst. Die interne Frist zählt nur,
 * wenn sie übergeben wird (Mitarbeiter); Kunden sehen nur den zugesagten Termin. Ebenso zählt ein nicht
 * abgeholter Auftrag nur, wenn handedOverAt übergeben wird (Issue #173, nur für Mitarbeiter).
 */
export function attentionFor(
  r: {
    status: RequestStatus
    promisedDate: string | null
    internalDueDate?: string | null
    statusChangedAt: Date | string
    deliveryMethod?: DeliveryMethod
    handedOverAt?: Date | string | null
  },
  settings: DeadlineSettings,
  now = new Date(),
): Attention | null {
  if (r.status === 'completed' && r.deliveryMethod === 'pickup' && r.handedOverAt === null) {
    return waitingForPickup(r.statusChangedAt, settings, now) ? 'not_picked_up' : null
  }
  if (TERMINAL_STATUSES.has(r.status)) return null
  const today = berlinToday(now)
  const dates = [r.promisedDate, r.internalDueDate].filter((d): d is string => !!d)
  if (dates.some((d) => d < today)) return 'overdue'
  if (dates.some((d) => d === today)) return 'due_today'
  const limit = {
    submitted: settings.staleSubmittedDays,
    on_hold: settings.staleOnHoldDays,
    confirmed: settings.staleConfirmedDays,
  }[r.status as 'submitted' | 'on_hold' | 'confirmed']
  if (limit && now.getTime() - new Date(r.statusChangedAt).getTime() > limit * DAY_MS) return 'stale'
  return null
}

/** Ob ein fertiger Abholauftrag schon länger als die eingestellte Frist in der Druckerei liegt (Issue #173). */
export function waitingForPickup(completedAt: Date | string, settings: DeadlineSettings, now = new Date()) {
  return now.getTime() - new Date(completedAt).getTime() > settings.pickupReminderDays * DAY_MS
}
