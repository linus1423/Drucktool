// Status-Workflow einer Anfrage. Wird von Server und Client gemeinsam genutzt.

export const REQUEST_STATUSES = [
  'new',
  'in_review',
  'on_hold',
  'quoted',
  'approved',
  'printing',
  'shipped',
  'completed',
  'rejected',
  'cancelled',
] as const

export type RequestStatus = (typeof REQUEST_STATUSES)[number]

export const STATUS_LABELS: Record<RequestStatus, string> = {
  new: 'Neu',
  in_review: 'In Prüfung',
  on_hold: 'Rückfrage',
  quoted: 'Angebot',
  approved: 'Freigegeben',
  printing: 'Im Druck',
  shipped: 'Versendet',
  completed: 'Abgeschlossen',
  rejected: 'Abgelehnt',
  cancelled: 'Storniert',
}

export const STATUS_TONES: Record<RequestStatus, string> = {
  new: 'bg-sky-100 text-sky-800',
  in_review: 'bg-indigo-100 text-indigo-800',
  on_hold: 'bg-amber-100 text-amber-800',
  quoted: 'bg-violet-100 text-violet-800',
  approved: 'bg-teal-100 text-teal-800',
  printing: 'bg-blue-100 text-blue-800',
  shipped: 'bg-cyan-100 text-cyan-800',
  completed: 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-rose-100 text-rose-800',
  cancelled: 'bg-slate-200 text-slate-700',
}

export const TERMINAL_STATUSES: ReadonlySet<RequestStatus> = new Set([
  'completed',
  'rejected',
  'cancelled',
])

/** Erlaubte Übergänge für Mitarbeiter (staff, admin, superadmin). */
const STAFF_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  new: ['in_review', 'rejected', 'cancelled'],
  in_review: ['quoted', 'on_hold', 'rejected', 'cancelled'],
  on_hold: ['in_review', 'rejected', 'cancelled'],
  quoted: ['approved', 'in_review', 'rejected', 'cancelled'],
  approved: ['printing', 'cancelled'],
  printing: ['shipped', 'completed'],
  shipped: ['completed'],
  completed: [],
  rejected: [],
  cancelled: [],
}

/** Erlaubte Übergänge für Kunden. */
const CUSTOMER_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  new: ['cancelled'],
  in_review: ['cancelled'],
  on_hold: ['in_review', 'cancelled'],
  quoted: ['approved', 'cancelled'],
  approved: [],
  printing: [],
  shipped: [],
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

/** Beschriftung der Aktion, die zu einem Zielstatus führt. */
export function transitionLabel(from: RequestStatus, to: RequestStatus, actor: Actor): string {
  if (actor === 'customer') {
    if (from === 'quoted' && to === 'approved') return 'Angebot annehmen'
    if (from === 'quoted' && to === 'cancelled') return 'Angebot ablehnen'
    if (from === 'on_hold' && to === 'in_review') return 'Rückfrage beantwortet'
    if (to === 'cancelled') return 'Anfrage stornieren'
  }
  if (from === 'quoted' && to === 'in_review') return 'Angebot überarbeiten'
  if (from === 'quoted' && to === 'approved') return 'Freigabe erfassen'
  const labels: Record<RequestStatus, string> = {
    new: 'Neu',
    in_review: 'Prüfung starten',
    on_hold: 'Rückfrage stellen',
    quoted: 'Angebot senden',
    approved: 'Freigeben',
    printing: 'Druck starten',
    shipped: 'Als versendet markieren',
    completed: 'Abschließen',
    rejected: 'Ablehnen',
    cancelled: 'Stornieren',
  }
  return labels[to]
}
