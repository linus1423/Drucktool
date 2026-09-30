// Status-Workflow eines Auftrags (Lastenheft Abschnitt 4). Wird von Server und Client gemeinsam genutzt.
//
//   Eingereicht → Bestätigt / Rückfrage / Abgelehnt → Fertig
//
// Solange ein Auftrag bestätigt ist, führen Mitarbeiter einen internen Unterstatus
// ("In Bearbeitung", "Problem"), den Kunden nie sehen.

export const REQUEST_STATUSES = ['submitted', 'confirmed', 'on_hold', 'completed', 'rejected', 'cancelled'] as const

export type RequestStatus = (typeof REQUEST_STATUSES)[number]

export const STATUS_LABELS: Record<RequestStatus, string> = {
  submitted: 'Eingereicht',
  confirmed: 'Bestätigt',
  on_hold: 'Rückfrage',
  completed: 'Fertig',
  rejected: 'Abgelehnt',
  cancelled: 'Storniert',
}

export const STATUS_TONES: Record<RequestStatus, string> = {
  submitted: 'bg-sky-100 text-sky-800',
  confirmed: 'bg-teal-100 text-teal-800',
  on_hold: 'bg-amber-100 text-amber-800',
  completed: 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-rose-100 text-rose-800',
  cancelled: 'bg-slate-200 text-slate-700',
}

export const TERMINAL_STATUSES: ReadonlySet<RequestStatus> = new Set(['completed', 'rejected', 'cancelled'])

/** Offen = noch nicht fertig, abgelehnt oder storniert. */
export const OPEN_STATUSES: RequestStatus[] = REQUEST_STATUSES.filter((s) => !TERMINAL_STATUSES.has(s))

export const INTERNAL_STATUSES = ['in_progress', 'problem'] as const
export type InternalStatus = (typeof INTERNAL_STATUSES)[number]

export const INTERNAL_STATUS_LABELS: Record<InternalStatus, string> = {
  in_progress: 'In Bearbeitung',
  problem: 'Problem',
}

export const INTERNAL_STATUS_TONES: Record<InternalStatus, string> = {
  in_progress: 'bg-blue-100 text-blue-800',
  problem: 'bg-rose-100 text-rose-800',
}

/** Erlaubte Übergänge für Mitarbeiter (staff, admin, superadmin). */
const STAFF_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  submitted: ['confirmed', 'on_hold', 'rejected'],
  on_hold: ['confirmed', 'rejected'],
  confirmed: ['completed', 'on_hold', 'cancelled'],
  completed: [],
  rejected: [],
  cancelled: [],
}

/** Erlaubte Übergänge für Kunden: Rückfrage beantworten und stornieren, solange nicht bestätigt. */
const CUSTOMER_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  submitted: ['cancelled'],
  on_hold: ['submitted', 'cancelled'],
  confirmed: [],
  completed: [],
  rejected: [],
  cancelled: [],
}

export type Actor = 'staff' | 'customer'

export function allowedTransitions(from: RequestStatus, actor: Actor): RequestStatus[] {
  return (actor === 'staff' ? STAFF_TRANSITIONS : CUSTOMER_TRANSITIONS)[from]
}

export function canTransition(from: RequestStatus, to: RequestStatus, actor: Actor): boolean {
  return allowedTransitions(from, actor).includes(to)
}

/** Den internen Unterstatus gibt es nur bei bestätigten Aufträgen. */
export function hasInternalStatus(status: RequestStatus) {
  return status === 'confirmed'
}

/** Beschriftung der Aktion, die zu einem Zielstatus führt. */
export function transitionLabel(from: RequestStatus, to: RequestStatus, actor: Actor): string {
  if (actor === 'customer') {
    if (from === 'on_hold' && to === 'submitted') return 'Rückfrage beantwortet'
    if (to === 'cancelled') return 'Auftrag stornieren'
  }
  const labels: Record<RequestStatus, string> = {
    submitted: 'Zurück auf Eingereicht',
    confirmed: from === 'on_hold' ? 'Bestätigen' : 'Auftrag annehmen',
    on_hold: 'Rückfrage stellen',
    completed: 'Als fertig markieren',
    rejected: 'Ablehnen',
    cancelled: 'Stornieren',
  }
  return labels[to]
}
