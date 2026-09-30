// E-Mail-Vorlagen. Reine Funktionen ohne Datenbankzugriff, damit sie testbar bleiben.
import { formatMoney, formatRequestNumber } from '~/lib/format'
import { STATUS_LABELS, type RequestStatus } from '~/lib/status'

export type MailContent = { subject: string; text: string; html: string }

export function appUrl(path = '') {
  const base = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
  return `${base}${path}`
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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

function requestLabel(r: RequestRef) {
  return `${formatRequestNumber(r.number)} ${r.title}`
}

function requestButton(r: RequestRef): Block {
  return { kind: 'button', label: 'Anfrage öffnen', href: appUrl(`/anfragen/${r.id}`) }
}

export function requestCreatedMail(r: RequestRef & { organisationName: string | null; actorName: string }): MailContent {
  const who = r.organisationName ? `${r.actorName} (${r.organisationName})` : r.actorName
  return compose(`Neue Anfrage ${requestLabel(r)}`, [
    { kind: 'p', text: `${who} hat eine neue Anfrage gestellt: ${requestLabel(r)}.` },
    requestButton(r),
  ])
}

export function statusChangedMail(
  r: RequestRef & {
    actorName: string
    from: RequestStatus
    to: RequestStatus
    note?: string | null
    quoteAmountCents?: number | null
  },
): MailContent {
  const blocks: Block[] = [
    {
      kind: 'p',
      text: `Der Status Ihrer Anfrage ${requestLabel(r)} hat sich geändert: ${STATUS_LABELS[r.from]} → ${STATUS_LABELS[r.to]}.`,
    },
  ]
  if (r.to === 'quoted' && r.quoteAmountCents != null) {
    blocks.push({ kind: 'p', text: `Angebotspreis: ${formatMoney(r.quoteAmountCents)} (netto). Bitte nehmen Sie das Angebot im Drucktool an oder lehnen Sie es ab.` })
  }
  if (r.to === 'on_hold') blocks.push({ kind: 'p', text: 'Wir haben eine Rückfrage an Sie.' })
  if (r.note) blocks.push({ kind: 'quote', text: r.note })
  blocks.push({ kind: 'p', text: `Geändert von ${r.actorName}.` }, requestButton(r))
  return compose(`${requestLabel(r)}: ${STATUS_LABELS[r.to]}`, blocks)
}

export function commentMail(r: RequestRef & { actorName: string; body: string; internal: boolean }): MailContent {
  return compose(`${r.internal ? 'Interne Notiz' : 'Neue Nachricht'} zu ${requestLabel(r)}`, [
    { kind: 'p', text: `${r.actorName} hat ${r.internal ? 'eine interne Notiz' : 'eine Nachricht'} zu ${requestLabel(r)} geschrieben:` },
    { kind: 'quote', text: r.body },
    requestButton(r),
  ])
}

export function assignedMail(r: RequestRef & { actorName: string }): MailContent {
  return compose(`Ihnen zugewiesen: ${requestLabel(r)}`, [
    { kind: 'p', text: `${r.actorName} hat Ihnen die Anfrage ${requestLabel(r)} zugewiesen.` },
    requestButton(r),
  ])
}

export function registrationReceivedMail(u: { name: string; email: string; organisationName: string }): MailContent {
  return compose(`Neue Registrierung: ${u.organisationName}`, [
    { kind: 'p', text: `${u.name} <${u.email}> hat sich für ${u.organisationName} registriert und wartet auf Freigabe.` },
    { kind: 'button', label: 'Registrierung prüfen', href: appUrl('/admin/freigaben') },
  ])
}

export function registrationApprovedMail(u: { name: string }): MailContent {
  return compose('Ihr Konto wurde freigegeben', [
    { kind: 'p', text: `Hallo ${u.name},` },
    { kind: 'p', text: 'Ihr Konto im Drucktool wurde freigegeben. Sie können sich jetzt anmelden und Anfragen stellen.' },
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
    { kind: 'p', text: `mit dem folgenden Link melden Sie sich im Drucktool an. Er ist ${minutes} Minuten gültig und funktioniert nur einmal.` },
    { kind: 'button', label: 'Jetzt anmelden', href: link },
    { kind: 'p', text: 'Wenn Sie keinen Link angefordert haben, können Sie diese E-Mail ignorieren.' },
  ])
}
