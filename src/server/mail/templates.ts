// E-Mail-Vorlagen. Reine Funktionen ohne Datenbankzugriff, damit sie testbar bleiben. Sie liefern die Mail mit
// den Standardtexten und merken sich Vorlage und Platzhalterwerte; enqueueMail wendet beim Einreihen die von
// Admins geänderten Vorlagen und das Layout an (Issue #89).
import { formatDate, formatMoney, formatRequestNumber } from '~/lib/format'
import { DEFAULT_MAIL_LAYOUT, defaultTemplate, renderMail, type MailTemplateKey } from '~/lib/mail-templates'
import { describeOrder, type OrderSnapshot } from '~/lib/snapshot'
import { STATUS_LABELS, type RequestStatus } from '~/lib/status'

export type MailContent = {
  subject: string
  text: string
  html: string
  /** Vorlage und Werte, damit enqueueMail angepasste Vorlagen anwenden kann. */
  template?: { key: MailTemplateKey; vars: Record<string, string> }
}

export function appUrl(path = '') {
  const base = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
  return `${base}${path}`
}

function compose(key: MailTemplateKey, vars: Record<string, string>): MailContent {
  return { ...renderMail(defaultTemplate(key), vars, DEFAULT_MAIL_LAYOUT), template: { key, vars } }
}

type RequestRef = { id: string; number: number; title: string }
type OrderRef = { order?: OrderSnapshot | null; totalCents?: number | null; deliveryMethod?: 'pickup' | 'house_post' }

/** Zusammenfassung der gewählten Optionen und des Preises, falls der Auftrag aus dem Wizard kommt. */
function orderSummary(r: OrderRef) {
  if (!r.order) return ''
  const rows = describeOrder(r.order).map(([label, value]) => `${label}: ${value}`)
  if (r.totalCents != null) rows.push(`Preis: ${formatMoney(r.totalCents)}`)
  return rows.join('\n')
}

function requestVars(r: RequestRef & { actorName?: string }) {
  return {
    auftrag: `${formatRequestNumber(r.number)} ${r.title}`,
    nummer: formatRequestNumber(r.number),
    titel: r.title,
    link: appUrl(`/auftraege/${r.id}`),
    akteur: r.actorName ?? '',
  }
}

export function requestCreatedMail(
  r: RequestRef & OrderRef & { organisationName: string | null; actorName: string },
): MailContent {
  const kunde = r.organisationName ? `${r.actorName} (${r.organisationName})` : r.actorName
  return compose('request_created', { ...requestVars(r), kunde, zusammenfassung: orderSummary(r) })
}

/** Was der Kunde beim jeweiligen Status erfährt (Lastenheft Abschnitt 7). */
const STATUS_TEXT: Partial<Record<RequestStatus, string>> = {
  confirmed:
    'Die Druckerei hat Ihren Auftrag angenommen. Damit ist der Auftrag verbindlich; wir melden uns, sobald er fertig ist.',
  on_hold: 'Wir haben eine Rückfrage zu Ihrem Auftrag. Bitte antworten Sie im Drucktool.',
  completed: 'Ihr Auftrag ist fertig und liegt zur Abholung im Regal der Druckerei bereit.',
  rejected: 'Leider können wir Ihren Auftrag nicht annehmen.',
  cancelled: 'Der Auftrag wurde storniert.',
  submitted: 'Der Auftrag liegt wieder bei der Druckerei.',
}

const COMPLETED_HOUSE_POST = 'Ihr Auftrag ist fertig und geht mit der nächsten Hauspost an die angegebene Adresse.'

export function statusChangedMail(
  r: RequestRef &
    OrderRef & { actorName: string; from: RequestStatus; to: RequestStatus; note?: string | null; forStaff?: boolean },
): MailContent {
  // Die Erklärtexte richten sich an Kunden; beobachtende Mitarbeiter bekommen nur den Wechsel.
  const statusText = r.forStaff
    ? ''
    : r.to === 'completed' && r.deliveryMethod === 'house_post'
      ? COMPLETED_HOUSE_POST
      : (STATUS_TEXT[r.to] ?? '')
  return compose('status_changed', {
    ...requestVars(r),
    alterStatus: STATUS_LABELS[r.from],
    neuerStatus: STATUS_LABELS[r.to],
    statusText,
    notiz: r.note ?? '',
  })
}

export function requestReceivedMail(r: RequestRef & OrderRef): MailContent {
  return compose('request_received', { ...requestVars(r), zusammenfassung: orderSummary(r) })
}

export function changeProposedMail(
  r: RequestRef & { actorName: string; reason: string; before: OrderRef; after: OrderRef },
): MailContent {
  const preisAenderung =
    r.before.totalCents != null && r.after.totalCents != null && r.before.totalCents !== r.after.totalCents
      ? `Der Preis ändert sich von ${formatMoney(r.before.totalCents)} auf ${formatMoney(r.after.totalCents)}.`
      : ''
  return compose('change_proposed', {
    ...requestVars(r),
    grund: r.reason,
    preisAenderung,
    zusammenfassung: orderSummary(r.after),
  })
}

export function changeAnsweredMail(r: RequestRef & { actorName: string; accepted: boolean }): MailContent {
  return compose(r.accepted ? 'change_accepted' : 'change_rejected', requestVars(r))
}

export function promisedDateMail(r: RequestRef & { actorName: string; date: string | null }): MailContent {
  return r.date
    ? compose('promised_date_set', { ...requestVars(r), termin: formatDate(r.date) })
    : compose('promised_date_removed', requestVars(r))
}

export function commentMail(
  r: RequestRef & { actorName: string; body: string; internal: boolean; attachmentNames?: string[] },
): MailContent {
  const files = r.attachmentNames ?? []
  return compose('comment', {
    ...requestVars(r),
    art: r.internal ? 'Interne Notiz' : 'Neue Nachricht',
    artText: r.internal ? 'eine interne Notiz' : 'eine Nachricht',
    nachricht: r.body,
    anhaenge: files.length ? `Anhänge: ${files.join(', ')}` : '',
  })
}

export function mentionMail(r: RequestRef & { actorName: string; body: string; internal: boolean }): MailContent {
  return compose('mention', {
    ...requestVars(r),
    artText: r.internal ? 'einer internen Notiz' : 'einer Nachricht',
    nachricht: r.body,
  })
}

export function assignedMail(r: RequestRef & { actorName: string }): MailContent {
  return compose('assigned', requestVars(r))
}

export function registrationReceivedMail(u: { name: string; email: string; organisationName: string }): MailContent {
  return compose('registration_received', {
    name: u.name,
    email: u.email,
    organisation: u.organisationName,
    link: appUrl('/admin/freigaben'),
  })
}

export function registrationApprovedMail(u: { name: string }): MailContent {
  return compose('registration_approved', { name: u.name, link: appUrl('/login') })
}

export function registrationRejectedMail(u: { name: string }): MailContent {
  return compose('registration_rejected', { name: u.name })
}

export function loginLinkMail(link: string, minutes: number): MailContent {
  return compose('login_link', { link, minuten: String(minutes) })
}
