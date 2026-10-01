// E-Mail-Vorlagen. Reine Funktionen ohne Datenbankzugriff, damit sie testbar bleiben.
import { formatDate, formatMoney, formatRequestNumber } from '~/lib/format'
import { describeOrder, type OrderSnapshot } from '~/lib/snapshot'
import { STATUS_LABELS, type RequestStatus } from '~/lib/status'

export type MailContent = { subject: string; text: string; html: string }

export function appUrl(path = '') {
  const base = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
  return `${base}${path}`
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

type Block = { kind: 'p'; text: string } | { kind: 'quote'; text: string } | { kind: 'button'; label: string; href: string }

/** Baut Text- und HTML-Fassung aus denselben Bausteinen. */
function compose(subject: string, blocks: Block[]): MailContent {
  const text = [
    ...blocks.map((b) =>
      b.kind === 'p'
        ? b.text
        : b.kind === 'quote'
          ? b.text
              .split('\n')
              .map((l) => `> ${l}`)
              .join('\n')
          : `${b.label}: ${b.href}`,
    ),
    '',
    '-- ',
    'Diese Nachricht wurde automatisch vom Drucktool verschickt.',
  ].join('\n\n')

  const body = blocks
    .map((b) => {
      if (b.kind === 'p') return `<p style="margin:0 0 16px">${escapeHtml(b.text).replace(/\n/g, '<br>')}</p>`
      if (b.kind === 'quote') {
        return `<blockquote style="margin:0 0 16px;padding:8px 12px;border-left:3px solid #cbd5e1;color:#334155;white-space:pre-wrap">${escapeHtml(b.text)}</blockquote>`
      }
      return `<p style="margin:24px 0"><a href="${escapeHtml(b.href)}" style="background:#0f172a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(b.label)}</a></p>`
    })
    .join('\n')

  const html = `<!doctype html>
<html lang="de"><body style="margin:0;padding:24px;background:#f8fafc;font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#0f172a">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:24px">
<p style="margin:0 0 16px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#64748b">Drucktool</p>
${body}
</div>
<p style="max-width:560px;margin:16px auto 0;font-size:12px;color:#64748b">Diese Nachricht wurde automatisch verschickt. Benachrichtigungen können Sie im Profil abschalten.</p>
</body></html>`

  return { subject, text, html }
}

type RequestRef = { id: string; number: number; title: string }
type OrderRef = { order?: OrderSnapshot | null; totalCents?: number | null; deliveryMethod?: 'pickup' | 'house_post' }

/** Zusammenfassung der gewählten Optionen und des Preises, falls der Auftrag aus dem Wizard kommt. */
function orderSummary(r: OrderRef): Block[] {
  if (!r.order) return []
  const rows = describeOrder(r.order).map(([label, value]) => `${label}: ${value}`)
  if (r.totalCents != null) rows.push(`Preis: ${formatMoney(r.totalCents)}`)
  return [{ kind: 'quote', text: rows.join('\n') }]
}

function requestLabel(r: RequestRef) {
  return `${formatRequestNumber(r.number)} ${r.title}`
}

function requestButton(r: RequestRef): Block {
  return { kind: 'button', label: 'Auftrag öffnen', href: appUrl(`/auftraege/${r.id}`) }
}

export function requestCreatedMail(
  r: RequestRef & OrderRef & { organisationName: string | null; actorName: string },
): MailContent {
  const who = r.organisationName ? `${r.actorName} (${r.organisationName})` : r.actorName
  return compose(`Neuer Auftrag ${requestLabel(r)}`, [
    { kind: 'p', text: `${who} hat einen neuen Auftrag eingereicht: ${requestLabel(r)}.` },
    ...orderSummary(r),
    requestButton(r),
  ])
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
  const blocks: Block[] = [{ kind: 'p', text: `${requestLabel(r)}: ${STATUS_LABELS[r.from]} → ${STATUS_LABELS[r.to]}.` }]
  // Die Erklärtexte richten sich an Kunden; beobachtende Mitarbeiter bekommen nur den Wechsel.
  const text = r.forStaff
    ? null
    : r.to === 'completed' && r.deliveryMethod === 'house_post'
      ? COMPLETED_HOUSE_POST
      : STATUS_TEXT[r.to]
  if (text) blocks.push({ kind: 'p', text })
  if (r.note) blocks.push({ kind: 'quote', text: r.note })
  blocks.push({ kind: 'p', text: `Geändert von ${r.actorName}.` }, requestButton(r))
  return compose(`${requestLabel(r)}: ${STATUS_LABELS[r.to]}`, blocks)
}

export function requestReceivedMail(r: RequestRef & OrderRef): MailContent {
  return compose(`Auftrag eingereicht: ${requestLabel(r)}`, [
    { kind: 'p', text: `Wir haben Ihren Auftrag ${requestLabel(r)} erhalten.` },
    ...orderSummary(r),
    {
      kind: 'p',
      text: 'Verbindlich wird er erst, wenn ein Mitarbeiter der Druckerei ihn bestätigt. Darüber informieren wir Sie per E-Mail.',
    },
    requestButton(r),
  ])
}

export function changeProposedMail(
  r: RequestRef & { actorName: string; reason: string; before: OrderRef; after: OrderRef },
): MailContent {
  const price =
    r.before.totalCents != null && r.after.totalCents != null && r.before.totalCents !== r.after.totalCents
      ? `Der Preis ändert sich von ${formatMoney(r.before.totalCents)} auf ${formatMoney(r.after.totalCents)}.`
      : null
  return compose(`Änderungsvorschlag zu ${requestLabel(r)}`, [
    { kind: 'p', text: `${r.actorName} schlägt eine Änderung an Ihrem Auftrag ${requestLabel(r)} vor:` },
    { kind: 'quote', text: r.reason },
    ...(price ? [{ kind: 'p', text: price } as Block] : []),
    { kind: 'p', text: 'Neuer Stand:' },
    ...orderSummary(r.after),
    {
      kind: 'p',
      text: 'Die Änderung gilt erst, wenn Sie zustimmen. Bitte nehmen Sie den Vorschlag im Drucktool an oder lehnen Sie ihn ab.',
    },
    requestButton(r),
  ])
}

export function changeAnsweredMail(r: RequestRef & { actorName: string; accepted: boolean }): MailContent {
  return compose(`Änderung ${r.accepted ? 'angenommen' : 'abgelehnt'}: ${requestLabel(r)}`, [
    {
      kind: 'p',
      text: r.accepted
        ? `${r.actorName} hat dem Änderungsvorschlag zu ${requestLabel(r)} zugestimmt. Der neue Stand gilt.`
        : `${r.actorName} hat den Änderungsvorschlag zu ${requestLabel(r)} abgelehnt. Der bisherige Stand gilt weiter, der Auftrag steht auf „Rückfrage“.`,
    },
    requestButton(r),
  ])
}

export function promisedDateMail(r: RequestRef & { actorName: string; date: string | null }): MailContent {
  const text = r.date
    ? `Die Druckerei hat für ${requestLabel(r)} einen Termin zugesagt: ${formatDate(r.date)}.`
    : `Der zugesagte Termin für ${requestLabel(r)} wurde aufgehoben. Wir melden uns mit einem neuen Termin.`
  return compose(`Termin für ${requestLabel(r)}`, [{ kind: 'p', text }, requestButton(r)])
}

export function commentMail(
  r: RequestRef & { actorName: string; body: string; internal: boolean; attachmentNames?: string[] },
): MailContent {
  const files = r.attachmentNames ?? []
  return compose(`${r.internal ? 'Interne Notiz' : 'Neue Nachricht'} zu ${requestLabel(r)}`, [
    {
      kind: 'p',
      text: `${r.actorName} hat ${r.internal ? 'eine interne Notiz' : 'eine Nachricht'} zu ${requestLabel(r)} geschrieben:`,
    },
    ...(r.body ? [{ kind: 'quote', text: r.body } as Block] : []),
    ...(files.length ? [{ kind: 'p', text: `Anhänge: ${files.join(', ')}` } as Block] : []),
    requestButton(r),
  ])
}

export function mentionMail(r: RequestRef & { actorName: string; body: string; internal: boolean }): MailContent {
  return compose(`${r.actorName} hat Sie erwähnt: ${requestLabel(r)}`, [
    {
      kind: 'p',
      text: `${r.actorName} hat Sie in ${r.internal ? 'einer internen Notiz' : 'einer Nachricht'} zu ${requestLabel(r)} erwähnt:`,
    },
    { kind: 'quote', text: r.body },
    { kind: 'p', text: 'Sie beobachten den Auftrag jetzt und bekommen weitere Nachrichten dazu.' },
    requestButton(r),
  ])
}

export function assignedMail(r: RequestRef & { actorName: string }): MailContent {
  return compose(`Ihnen zugewiesen: ${requestLabel(r)}`, [
    { kind: 'p', text: `${r.actorName} hat Ihnen den Auftrag ${requestLabel(r)} zugewiesen.` },
    requestButton(r),
  ])
}

export function registrationReceivedMail(u: { name: string; email: string; organisationName: string }): MailContent {
  return compose(`Neue Registrierung: ${u.organisationName}`, [
    { kind: 'p', text: `${u.name} <${u.email}> hat sich für ${u.organisationName} registriert und wartet auf Freigabe.` },
    { kind: 'button', label: 'Registrierung prüfen', href: appUrl('/admin/freigaben') },
  ])
}

export function organisationRequestedMail(r: {
  customerName: string
  customerEmail: string
  name: string
  details: string
}): MailContent {
  return compose(`Organisation angefragt: ${r.name}`, [
    { kind: 'p', text: `${r.customerName} <${r.customerEmail}> möchte der Organisation „${r.name}“ zugeordnet werden.` },
    ...(r.details ? [{ kind: 'quote' as const, text: r.details }] : []),
    { kind: 'button', label: 'Anfrage bearbeiten', href: appUrl('/organisationsanfragen') },
  ])
}

export function organisationRequestDecisionMail(r: {
  name: string
  requested: string
  organisation: string | null
  note: string | null
}): MailContent {
  if (r.organisation) {
    return compose(`Organisation zugeordnet: ${r.organisation}`, [
      { kind: 'p', text: `Hallo ${r.name},` },
      {
        kind: 'p',
        text: `Ihre Anfrage zu „${r.requested}“ wurde bearbeitet: Sie gehören jetzt zur Organisation „${r.organisation}“ und können sie bei neuen Aufträgen auswählen.`,
      },
      { kind: 'button', label: 'Zum Profil', href: appUrl('/profil') },
    ])
  }
  return compose('Ihre Anfrage zu einer Organisation', [
    { kind: 'p', text: `Hallo ${r.name},` },
    { kind: 'p', text: `Ihre Anfrage zu „${r.requested}“ konnten wir leider nicht annehmen.` },
    ...(r.note ? [{ kind: 'quote' as const, text: r.note }] : []),
    { kind: 'p', text: 'Aufträge können Sie weiterhin ohne Organisation aufgeben.' },
  ])
}

export function registrationApprovedMail(u: { name: string }): MailContent {
  return compose('Ihr Konto wurde freigegeben', [
    { kind: 'p', text: `Hallo ${u.name},` },
    { kind: 'p', text: 'Ihr Konto im Drucktool wurde freigegeben. Sie können sich jetzt anmelden und Aufträge aufgeben.' },
    { kind: 'button', label: 'Zur Anmeldung', href: appUrl('/login') },
  ])
}

export function registrationRejectedMail(u: { name: string }): MailContent {
  return compose('Ihre Registrierung', [
    { kind: 'p', text: `Hallo ${u.name},` },
    {
      kind: 'p',
      text: 'Ihre Registrierung im Drucktool konnten wir leider nicht freigeben. Bei Fragen wenden Sie sich bitte direkt an uns.',
    },
  ])
}

export function loginLinkMail(link: string, minutes: number): MailContent {
  return compose('Ihr Anmeldelink für das Drucktool', [
    { kind: 'p', text: 'Hallo,' },
    {
      kind: 'p',
      text: `mit dem folgenden Link melden Sie sich im Drucktool an. Er ist ${minutes} Minuten gültig und funktioniert nur einmal.`,
    },
    { kind: 'button', label: 'Jetzt anmelden', href: link },
    { kind: 'p', text: 'Wenn Sie keinen Link angefordert haben, können Sie diese E-Mail ignorieren.' },
  ])
}
