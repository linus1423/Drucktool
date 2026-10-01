// Termine und Fristen (Issue #14): zugesagter Termin für den Kunden, interne Frist für die Druckerei
// und Hinweise auf Aufträge, die zu lange im selben Status stehen.
import { z } from 'zod'
import { TERMINAL_STATUSES, type RequestStatus } from './status'

const days = z.number().int().min(1, 'Mindestens 1 Tag').max(365)

/** Ab wie vielen Tagen im selben Status ein Auftrag hervorgehoben wird. */
export const deadlineSettingsSchema = z.object({
  staleSubmittedDays: days,
  staleOnHoldDays: days,
  staleConfirmedDays: days,
})
export type DeadlineSettings = z.infer<typeof deadlineSettingsSchema>

export const DEFAULT_DEADLINE_SETTINGS: DeadlineSettings = { staleSubmittedDays: 2, staleOnHoldDays: 5, staleConfirmedDays: 10 }

export type Attention = 'overdue' | 'due_today' | 'stale'

export const ATTENTION_LABELS: Record<Attention, string> = {
  overdue: 'Überfällig',
  due_today: 'Heute fällig',
  stale: 'Wartet lange',
}

export const ATTENTION_TONES: Record<Attention, string> = {
  overdue: 'bg-rose-100 text-rose-800',
  due_today: 'bg-amber-100 text-amber-800',
  stale: 'bg-orange-100 text-orange-800',
}

/** Heutiges Datum in deutscher Zeit als YYYY-MM-DD. */
export function berlinToday(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(now)
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Was an einem Auftrag Aufmerksamkeit braucht, wichtigstes zuerst. Die interne Frist zählt nur,
 * wenn sie übergeben wird (Mitarbeiter); Kunden sehen nur den zugesagten Termin.
 */
export function attentionFor(
  r: { status: RequestStatus; promisedDate: string | null; internalDueDate?: string | null; statusChangedAt: Date | string },
  settings: DeadlineSettings,
  now = new Date(),
): Attention | null {
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
