// E-Mail-Vorlagen als Bausteine mit Platzhaltern (Issue #89). Reine Funktionen, die Server (Versand) und
// Oberfläche (Editor mit Vorschau) gemeinsam nutzen. Admins können Betreff und Bausteine jeder Vorlage
// überschreiben oder auf eigenes HTML umschalten; ohne Änderung gelten die Standardtexte hier.
import { z } from 'zod'

export type MailContent = { subject: string; text: string; html: string }

export const MAIL_BLOCK_KINDS = ['p', 'quote', 'button'] as const

export const mailBlockSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('p'), text: z.string().max(5000) }),
  z.object({ kind: z.literal('quote'), text: z.string().max(5000) }),
  z.object({ kind: z.literal('button'), label: z.string().max(200), href: z.string().max(500) }),
])
export type MailBlock = z.infer<typeof mailBlockSchema>

export const mailLayoutSchema = z.object({
  /** Anzeigename des Absenders; die Adresse selbst kommt aus MAIL_FROM. */
  senderName: z.string().trim().max(100),
  replyTo: z.union([z.literal(''), z.email('Bitte eine gültige E-Mail-Adresse angeben')]),
  header: z.string().trim().max(100),
  signature: z.string().trim().max(1000),
  footer: z.string().trim().max(1000),
})
export type MailLayout = z.infer<typeof mailLayoutSchema>

export const DEFAULT_MAIL_LAYOUT: MailLayout = {
  senderName: '',
  replyTo: '',
  header: 'Drucktool',
  signature: '',
  footer: 'Diese Nachricht wurde automatisch verschickt. Benachrichtigungen können Sie im Profil abschalten.',
}

export const storedTemplateSchema = z.object({
  subject: z.string().trim().min(1, 'Betreff fehlt').max(300),
  mode: z.enum(['blocks', 'html']),
  blocks: z.array(mailBlockSchema).max(50),
  html: z.string().max(100_000),
})
export type StoredTemplate = z.infer<typeof storedTemplateSchema>

type TemplateDef = {
  label: string
  description: string
  audience: 'Kunden' | 'Mitarbeiter' | 'Kunden und Mitarbeiter'
  variables: Record<string, string>
  subject: string
  blocks: MailBlock[]
  /** Beispielwerte für die Vorschau im Editor. */
  sample: Record<string, string>
}

const REQUEST_VARS = {
  auftrag: 'Nummer und Titel, z. B. „#26100001 Skript“',
  nummer: 'Auftragsnummer',
  titel: 'Titel des Auftrags',
  link: 'Link zum Auftrag',
  akteur: 'Wer die Aktion ausgelöst hat',
}
const REQUEST_SAMPLE = {
  auftrag: '#26100001 Skript Analysis I',
  nummer: '#26100001',
  titel: 'Skript Analysis I',
  link: 'https://druck.example.com/auftraege/beispiel',
  akteur: 'Erika Muster',
}
const SUMMARY_SAMPLE =
  'Format: A4\nBindung: Leimbindung\nSeiten: 120 Seiten, doppelseitig\nPapier: Standardpapier 80 g/m²\nPreis: 104,80 €'
const OPEN: MailBlock = { kind: 'button', label: 'Auftrag öffnen', href: '{{link}}' }

export const MAIL_TEMPLATES = {
  request_received: {
    label: 'Auftrag eingereicht (an Kunden)',
    description: 'Bestätigt dem Kunden den Eingang. Der Auftrag ist noch nicht verbindlich.',
    audience: 'Kunden',
    variables: { ...REQUEST_VARS, zusammenfassung: 'Gewählte Optionen und Preis' },
    subject: 'Auftrag eingereicht: {{auftrag}}',
    blocks: [
      { kind: 'p', text: 'Wir haben Ihren Auftrag {{auftrag}} erhalten.' },
      { kind: 'quote', text: '{{zusammenfassung}}' },
      {
        kind: 'p',
        text: 'Verbindlich wird er erst, wenn ein Mitarbeiter der Druckerei ihn bestätigt. Darüber informieren wir Sie per E-Mail.',
      },
      OPEN,
    ],
    sample: { ...REQUEST_SAMPLE, zusammenfassung: SUMMARY_SAMPLE },
  },
  request_created: {
    label: 'Neuer Auftrag (an Mitarbeiter)',
    description: 'Meldet der Druckerei einen neu eingereichten Auftrag.',
    audience: 'Mitarbeiter',
    variables: { ...REQUEST_VARS, kunde: 'Kunde, ggf. mit Organisation', zusammenfassung: 'Gewählte Optionen und Preis' },
    subject: 'Neuer Auftrag {{auftrag}}',
    blocks: [
      { kind: 'p', text: '{{kunde}} hat einen neuen Auftrag eingereicht: {{auftrag}}.' },
      { kind: 'quote', text: '{{zusammenfassung}}' },
      OPEN,
    ],
    sample: { ...REQUEST_SAMPLE, kunde: 'Erika Muster (Lehrstuhl für Drucktechnik)', zusammenfassung: SUMMARY_SAMPLE },
  },
  offer_created: {
    label: 'Angebot der Druckerei (an Kunden)',
    description:
      'Ein Mitarbeiter hat einen Auftrag für den Kunden angelegt, z. B. nach einem Besuch oder einer Mail (Issue #165).',
    audience: 'Kunden',
    variables: {
      ...REQUEST_VARS,
      zusammenfassung: 'Angebotene Optionen und Preis',
      email: 'E-Mail-Adresse des Kunden, mit der er sich anmeldet',
    },
    subject: 'Ihr Angebot: {{auftrag}}',
    blocks: [
      { kind: 'p', text: '{{akteur}} hat für Sie das Angebot {{auftrag}} erstellt:' },
      { kind: 'quote', text: '{{zusammenfassung}}' },
      {
        kind: 'p',
        text: 'Bitte melden Sie sich mit {{email}} im Drucktool an, hinterlegen Sie Ihre Rechnungsadresse und nehmen Sie das Angebot an. Erst dann drucken wir. Sie können das Angebot dort auch ablehnen.',
      },
      { kind: 'button', label: 'Angebot ansehen', href: '{{link}}' },
    ],
    sample: { ...REQUEST_SAMPLE, akteur: 'Max Druck', zusammenfassung: SUMMARY_SAMPLE, email: 'erika@example.com' },
  },
  status_changed: {
    label: 'Status geändert',
    description:
      'Geht bei jedem Statuswechsel an Kunden und beobachtende Mitarbeiter. Der Erklärtext je Status steht in {{statusText}}.',
    audience: 'Kunden und Mitarbeiter',
    variables: {
      ...REQUEST_VARS,
      alterStatus: 'Bisheriger Status',
      neuerStatus: 'Neuer Status',
      statusText: 'Erklärung für Kunden, z. B. dass der Auftrag fertig ist (leer bei Mitarbeitern)',
      notiz: 'Begründung oder Rückfrage, falls angegeben',
    },
    subject: '{{auftrag}}: {{neuerStatus}}',
    blocks: [
      { kind: 'p', text: '{{auftrag}}: {{alterStatus}} → {{neuerStatus}}.' },
      { kind: 'p', text: '{{statusText}}' },
      { kind: 'quote', text: '{{notiz}}' },
      { kind: 'p', text: 'Geändert von {{akteur}}.' },
      OPEN,
    ],
    sample: {
      ...REQUEST_SAMPLE,
      alterStatus: 'Bestätigt',
      neuerStatus: 'Fertig',
      statusText: 'Ihr Auftrag ist fertig und liegt zur Abholung im Regal der Druckerei bereit.',
      notiz: '',
    },
  },
  change_proposed: {
    label: 'Änderungsvorschlag (an Kunden)',
    description: 'Die Druckerei schlägt eine Änderung vor, der Kunde muss zustimmen.',
    audience: 'Kunden',
    variables: {
      ...REQUEST_VARS,
      grund: 'Begründung der Druckerei',
      preisAenderung: 'Satz zur Preisänderung, leer wenn der Preis gleich bleibt',
      zusammenfassung: 'Neuer Stand mit Optionen und Preis',
    },
    subject: 'Änderungsvorschlag zu {{auftrag}}',
    blocks: [
      { kind: 'p', text: '{{akteur}} schlägt eine Änderung an Ihrem Auftrag {{auftrag}} vor:' },
      { kind: 'quote', text: '{{grund}}' },
      { kind: 'p', text: '{{preisAenderung}}' },
      { kind: 'p', text: 'Neuer Stand:' },
      { kind: 'quote', text: '{{zusammenfassung}}' },
      {
        kind: 'p',
        text: 'Die Änderung gilt erst, wenn Sie zustimmen. Bitte nehmen Sie den Vorschlag im Drucktool an oder lehnen Sie ihn ab. Sie können auch auf diese Mail antworten; die Druckerei trägt Ihre Antwort dann ein.',
      },
      OPEN,
    ],
    sample: {
      ...REQUEST_SAMPLE,
      akteur: 'Max Druck',
      grund: 'Laut Telefonat 30 statt 20 Exemplare.',
      preisAenderung: 'Der Preis ändert sich von 84,80 € auf 104,80 €.',
      zusammenfassung: SUMMARY_SAMPLE,
    },
  },
  change_accepted: {
    label: 'Änderung angenommen (an Mitarbeiter)',
    description: 'Der Kunde hat einem Änderungsvorschlag zugestimmt.',
    audience: 'Mitarbeiter',
    variables: REQUEST_VARS,
    subject: 'Änderung angenommen: {{auftrag}}',
    blocks: [{ kind: 'p', text: '{{akteur}} hat dem Änderungsvorschlag zu {{auftrag}} zugestimmt. Der neue Stand gilt.' }, OPEN],
    sample: REQUEST_SAMPLE,
  },
  change_rejected: {
    label: 'Änderung abgelehnt (an Mitarbeiter)',
    description: 'Der Kunde hat einen Änderungsvorschlag abgelehnt.',
    audience: 'Mitarbeiter',
    variables: REQUEST_VARS,
    subject: 'Änderung abgelehnt: {{auftrag}}',
    blocks: [
      {
        kind: 'p',
        text: '{{akteur}} hat den Änderungsvorschlag zu {{auftrag}} abgelehnt. Der bisherige Stand gilt weiter, der Auftrag steht auf „Rückfrage“.',
      },
      OPEN,
    ],
    sample: REQUEST_SAMPLE,
  },
  change_recorded_accepted: {
    label: 'Zustimmung eingetragen (an Kunden)',
    description: 'Der Kunde hat per Mail oder Telefon zugestimmt, ein Mitarbeiter hat das im Drucktool eingetragen.',
    audience: 'Kunden',
    variables: { ...REQUEST_VARS, vermerk: 'Vermerk des Mitarbeiters', zusammenfassung: 'Neuer Stand mit Optionen und Preis' },
    subject: 'Änderung übernommen: {{auftrag}}',
    blocks: [
      { kind: 'p', text: '{{akteur}} hat Ihre Zustimmung zum Änderungsvorschlag für {{auftrag}} eingetragen:' },
      { kind: 'quote', text: '{{vermerk}}' },
      { kind: 'p', text: 'Damit gilt der neue Stand:' },
      { kind: 'quote', text: '{{zusammenfassung}}' },
      { kind: 'p', text: 'Falls das nicht stimmt, antworten Sie bitte im Drucktool.' },
      OPEN,
    ],
    sample: {
      ...REQUEST_SAMPLE,
      akteur: 'Max Druck',
      vermerk: 'Zustimmung per Mail am 01.10.2026',
      zusammenfassung: SUMMARY_SAMPLE,
    },
  },
  change_recorded_rejected: {
    label: 'Ablehnung eingetragen (an Kunden)',
    description: 'Der Kunde hat per Mail oder Telefon abgelehnt, ein Mitarbeiter hat das im Drucktool eingetragen.',
    audience: 'Kunden',
    variables: {
      ...REQUEST_VARS,
      vermerk: 'Vermerk des Mitarbeiters',
      zusammenfassung: 'Bisheriger Stand mit Optionen und Preis',
    },
    subject: 'Änderung verworfen: {{auftrag}}',
    blocks: [
      { kind: 'p', text: '{{akteur}} hat Ihre Ablehnung des Änderungsvorschlags für {{auftrag}} eingetragen:' },
      { kind: 'quote', text: '{{vermerk}}' },
      { kind: 'p', text: 'Es bleibt beim bisherigen Stand:' },
      { kind: 'quote', text: '{{zusammenfassung}}' },
      OPEN,
    ],
    sample: {
      ...REQUEST_SAMPLE,
      akteur: 'Max Druck',
      vermerk: 'Ablehnung per Telefon am 01.10.2026',
      zusammenfassung: SUMMARY_SAMPLE,
    },
  },
  promised_date_set: {
    label: 'Termin zugesagt (an Kunden)',
    description: 'Die Druckerei sagt einen Termin zu oder ändert ihn.',
    audience: 'Kunden',
    variables: { ...REQUEST_VARS, termin: 'Zugesagter Termin, z. B. 15.10.2026' },
    subject: 'Termin für {{auftrag}}',
    blocks: [{ kind: 'p', text: 'Die Druckerei hat für {{auftrag}} einen Termin zugesagt: {{termin}}.' }, OPEN],
    sample: { ...REQUEST_SAMPLE, termin: '15.10.2026' },
  },
  promised_date_removed: {
    label: 'Termin aufgehoben (an Kunden)',
    description: 'Ein zugesagter Termin wurde entfernt.',
    audience: 'Kunden',
    variables: REQUEST_VARS,
    subject: 'Termin für {{auftrag}}',
    blocks: [
      { kind: 'p', text: 'Der zugesagte Termin für {{auftrag}} wurde aufgehoben. Wir melden uns mit einem neuen Termin.' },
      OPEN,
    ],
    sample: REQUEST_SAMPLE,
  },
  comment: {
    label: 'Neue Nachricht',
    description: 'Neue Nachricht oder interne Notiz an einem Auftrag.',
    audience: 'Kunden und Mitarbeiter',
    variables: {
      ...REQUEST_VARS,
      art: '„Neue Nachricht“ oder „Interne Notiz“',
      artText: '„eine Nachricht“ oder „eine interne Notiz“',
      nachricht: 'Text der Nachricht',
      anhaenge: '„Anhänge: …“, leer ohne Anhänge',
    },
    subject: '{{art}} zu {{auftrag}}',
    blocks: [
      { kind: 'p', text: '{{akteur}} hat {{artText}} zu {{auftrag}} geschrieben:' },
      { kind: 'quote', text: '{{nachricht}}' },
      { kind: 'p', text: '{{anhaenge}}' },
      OPEN,
    ],
    sample: {
      ...REQUEST_SAMPLE,
      art: 'Neue Nachricht',
      artText: 'eine Nachricht',
      nachricht: 'Bitte mit Deckblatt in Blau.',
      anhaenge: 'Anhänge: deckblatt.pdf',
    },
  },
  mention: {
    label: 'Erwähnung (an Mitarbeiter)',
    description: 'Ein Mitarbeiter wurde mit @Name erwähnt.',
    audience: 'Mitarbeiter',
    variables: { ...REQUEST_VARS, artText: '„einer Nachricht“ oder „einer internen Notiz“', nachricht: 'Text der Nachricht' },
    subject: '{{akteur}} hat Sie erwähnt: {{auftrag}}',
    blocks: [
      { kind: 'p', text: '{{akteur}} hat Sie in {{artText}} zu {{auftrag}} erwähnt:' },
      { kind: 'quote', text: '{{nachricht}}' },
      { kind: 'p', text: 'Sie beobachten den Auftrag jetzt und bekommen weitere Nachrichten dazu.' },
      OPEN,
    ],
    sample: { ...REQUEST_SAMPLE, artText: 'einer internen Notiz', nachricht: '@Max Druck bitte heute noch drucken.' },
  },
  assigned: {
    label: 'Zugewiesen (an Mitarbeiter)',
    description: 'Ein Auftrag wurde einem Mitarbeiter zugewiesen.',
    audience: 'Mitarbeiter',
    variables: REQUEST_VARS,
    subject: 'Ihnen zugewiesen: {{auftrag}}',
    blocks: [{ kind: 'p', text: '{{akteur}} hat Ihnen den Auftrag {{auftrag}} zugewiesen.' }, OPEN],
    sample: REQUEST_SAMPLE,
  },
  registration_received: {
    label: 'Neue Registrierung (an Admins)',
    description: 'Jemand hat sich registriert und wartet auf Freigabe.',
    audience: 'Mitarbeiter',
    variables: { name: 'Name', email: 'E-Mail-Adresse', organisation: 'Organisation', link: 'Link zu den Freigaben' },
    subject: 'Neue Registrierung: {{organisation}}',
    blocks: [
      { kind: 'p', text: '{{name}} <{{email}}> hat sich für {{organisation}} registriert und wartet auf Freigabe.' },
      { kind: 'button', label: 'Registrierung prüfen', href: '{{link}}' },
    ],
    sample: {
      name: 'Erika Muster',
      email: 'erika@example.com',
      organisation: 'Lehrstuhl für Drucktechnik',
      link: 'https://druck.example.com/admin/freigaben',
    },
  },
  registration_approved: {
    label: 'Konto freigegeben (an Kunden)',
    description: 'Eine Registrierung wurde freigegeben.',
    audience: 'Kunden',
    variables: { name: 'Name', link: 'Link zur Anmeldung' },
    subject: 'Ihr Konto wurde freigegeben',
    blocks: [
      { kind: 'p', text: 'Hallo {{name}},' },
      { kind: 'p', text: 'Ihr Konto im Drucktool wurde freigegeben. Sie können sich jetzt anmelden und Aufträge aufgeben.' },
      { kind: 'button', label: 'Zur Anmeldung', href: '{{link}}' },
    ],
    sample: { name: 'Erika Muster', link: 'https://druck.example.com/login' },
  },
  registration_rejected: {
    label: 'Registrierung abgelehnt (an Kunden)',
    description: 'Eine Registrierung wurde abgelehnt.',
    audience: 'Kunden',
    variables: { name: 'Name' },
    subject: 'Ihre Registrierung',
    blocks: [
      { kind: 'p', text: 'Hallo {{name}},' },
      {
        kind: 'p',
        text: 'Ihre Registrierung im Drucktool konnten wir leider nicht freigeben. Bei Fragen wenden Sie sich bitte direkt an uns.',
      },
    ],
    sample: { name: 'Erika Muster' },
  },
  organisation_requested: {
    label: 'Organisation angefragt (an Mitarbeiter)',
    description: 'Ein Kunde möchte einer Organisation zugeordnet werden (Issue #68).',
    audience: 'Mitarbeiter',
    variables: {
      kunde: 'Name des Kunden',
      email: 'E-Mail-Adresse des Kunden',
      organisation: 'Angefragte Organisation',
      angaben: 'Weitere Angaben des Kunden, falls vorhanden',
      link: 'Link zu den Organisationsanfragen',
    },
    subject: 'Organisation angefragt: {{organisation}}',
    blocks: [
      { kind: 'p', text: '{{kunde}} <{{email}}> möchte der Organisation „{{organisation}}“ zugeordnet werden.' },
      { kind: 'quote', text: '{{angaben}}' },
      { kind: 'button', label: 'Anfrage bearbeiten', href: '{{link}}' },
    ],
    sample: {
      kunde: 'Erika Muster',
      email: 'erika@example.com',
      organisation: 'Lehrstuhl für Drucktechnik',
      angaben: 'Kostenstelle 4711',
      link: 'https://druck.example.com/organisationsanfragen',
    },
  },
  organisation_assigned: {
    label: 'Organisation zugeordnet (an Kunden)',
    description: 'Eine Organisationsanfrage wurde angenommen.',
    audience: 'Kunden',
    variables: {
      name: 'Name',
      angefragt: 'Angefragte Organisation',
      organisation: 'Zugeordnete Organisation',
      link: 'Link zum Profil',
    },
    subject: 'Organisation zugeordnet: {{organisation}}',
    blocks: [
      { kind: 'p', text: 'Hallo {{name}},' },
      {
        kind: 'p',
        text: 'Ihre Anfrage zu „{{angefragt}}“ wurde bearbeitet: Sie gehören jetzt zur Organisation „{{organisation}}“ und können sie bei neuen Aufträgen auswählen.',
      },
      { kind: 'button', label: 'Zum Profil', href: '{{link}}' },
    ],
    sample: {
      name: 'Erika Muster',
      angefragt: 'Lehrstuhl Drucktechnik',
      organisation: 'Lehrstuhl für Drucktechnik',
      link: 'https://druck.example.com/profil',
    },
  },
  organisation_rejected: {
    label: 'Organisationsanfrage abgelehnt (an Kunden)',
    description: 'Eine Organisationsanfrage wurde abgelehnt.',
    audience: 'Kunden',
    variables: { name: 'Name', angefragt: 'Angefragte Organisation', notiz: 'Begründung, falls angegeben' },
    subject: 'Ihre Anfrage zu einer Organisation',
    blocks: [
      { kind: 'p', text: 'Hallo {{name}},' },
      { kind: 'p', text: 'Ihre Anfrage zu „{{angefragt}}“ konnten wir leider nicht annehmen.' },
      { kind: 'quote', text: '{{notiz}}' },
      { kind: 'p', text: 'Aufträge können Sie weiterhin ohne Organisation aufgeben.' },
    ],
    sample: { name: 'Erika Muster', angefragt: 'Lehrstuhl Drucktechnik', notiz: 'Bitte die genaue Bezeichnung angeben.' },
  },
  login_link: {
    label: 'Anmeldelink',
    description: 'Link zum Anmelden ohne Passwort.',
    audience: 'Kunden und Mitarbeiter',
    variables: { link: 'Anmeldelink', minuten: 'Gültigkeit in Minuten' },
    subject: 'Ihr Anmeldelink für das Drucktool',
    blocks: [
      { kind: 'p', text: 'Hallo,' },
      {
        kind: 'p',
        text: 'mit dem folgenden Link melden Sie sich im Drucktool an. Er ist {{minuten}} Minuten gültig und funktioniert nur einmal.',
      },
      { kind: 'button', label: 'Jetzt anmelden', href: '{{link}}' },
      { kind: 'p', text: 'Wenn Sie keinen Link angefordert haben, können Sie diese E-Mail ignorieren.' },
    ],
    sample: { link: 'https://druck.example.com/anmelden?token=beispiel', minuten: '30' },
  },
} satisfies Record<string, TemplateDef>

export type MailTemplateKey = keyof typeof MAIL_TEMPLATES
export const MAIL_TEMPLATE_KEYS = Object.keys(MAIL_TEMPLATES) as MailTemplateKey[]
export const mailTemplateKeySchema = z.enum(MAIL_TEMPLATE_KEYS as [MailTemplateKey, ...MailTemplateKey[]])

export function defaultTemplate(key: MailTemplateKey): StoredTemplate {
  const def = MAIL_TEMPLATES[key]
  return { subject: def.subject, mode: 'blocks', blocks: def.blocks, html: '' }
}

export function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z]+)\s*\}\}/g

/** Ersetzt {{name}} durch den Wert; unbekannte Platzhalter werden leer. */
export function fill(text: string, vars: Record<string, string>, transform: (v: string) => string = (v) => v) {
  return text.replace(PLACEHOLDER, (_, name: string) => transform(vars[name] ?? ''))
}

/** Ein Baustein, dessen Platzhalter alle leer sind, entfällt (z. B. keine Notiz beim Statuswechsel). */
function isEmpty(block: MailBlock, vars: Record<string, string>) {
  const source = block.kind === 'button' ? block.href : block.text
  const names = [...source.matchAll(PLACEHOLDER)].map((m) => m[1]!)
  if (block.kind === 'button') return !fill(block.href, vars).trim()
  return names.length > 0 && names.every((n) => !(vars[n] ?? '').trim()) && !source.replace(PLACEHOLDER, '').trim()
}

/** Platzhalter, die im Text vorkommen, aber für die Vorlage nicht definiert sind. */
export function unknownPlaceholders(key: MailTemplateKey, t: StoredTemplate) {
  const known = new Set(Object.keys(MAIL_TEMPLATES[key].variables))
  const sources = [
    t.subject,
    ...(t.mode === 'html' ? [t.html] : t.blocks.flatMap((b) => (b.kind === 'button' ? [b.label, b.href] : [b.text]))),
  ]
  return [...new Set(sources.flatMap((s) => [...s.matchAll(PLACEHOLDER)].map((m) => m[1]!)))].filter((n) => !known.has(n))
}

/** HTML grob in Text umwandeln, für die Textfassung von Vorlagen im HTML-Modus. */
export function htmlToText(html: string) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2: $1')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function wrapHtml(body: string, layout: MailLayout) {
  const header = layout.header
    ? `<p style="margin:0 0 16px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#64748b">${escapeHtml(layout.header)}</p>\n`
    : ''
  const signature = layout.signature
    ? `\n<p style="margin:24px 0 0;font-size:13px;color:#475569">${escapeHtml(layout.signature).replace(/\n/g, '<br>')}</p>`
    : ''
  const footer = layout.footer
    ? `\n<p style="max-width:560px;margin:16px auto 0;font-size:12px;color:#64748b">${escapeHtml(layout.footer).replace(/\n/g, '<br>')}</p>`
    : ''
  return `<!doctype html>
<html lang="de"><body style="margin:0;padding:24px;background:#f8fafc;font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#0f172a">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:24px">
${header}${body}${signature}
</div>${footer}
</body></html>`
}

function textWithSignature(parts: string[], layout: MailLayout) {
  return [...parts, ...(layout.signature ? ['', '-- ', layout.signature] : [])].join('\n\n')
}

/** Baut Betreff, Text- und HTML-Fassung aus einer Vorlage und den Werten der Platzhalter. */
export function renderMail(
  t: StoredTemplate,
  vars: Record<string, string>,
  layout: MailLayout = DEFAULT_MAIL_LAYOUT,
): MailContent {
  // Zeilenumbrüche im Betreff würden den Mail-Header brechen.
  const subject = fill(t.subject, vars)
    .replace(/[\r\n]+/g, ' ')
    .trim()
  if (t.mode === 'html') {
    const body = fill(t.html, vars, escapeHtml)
    return { subject, text: textWithSignature([htmlToText(body)], layout), html: wrapHtml(body, layout) }
  }
  const blocks = t.blocks.filter((b) => !isEmpty(b, vars))
  const text = blocks.map((b) => {
    if (b.kind === 'p') return fill(b.text, vars)
    if (b.kind === 'quote') {
      return fill(b.text, vars)
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')
    }
    return `${fill(b.label, vars)}: ${fill(b.href, vars)}`
  })
  const body = blocks.map((b) => blockHtml(b, vars, safeHref(fill(b.kind === 'button' ? b.href : '', vars)))).join('\n')
  return { subject, text: textWithSignature(text, layout), html: wrapHtml(body, layout) }
}

function blockHtml(b: MailBlock, vars: Record<string, string>, href: string) {
  if (b.kind === 'p') return `<p style="margin:0 0 16px">${fill(escapeHtml(b.text), vars, escapeHtml).replace(/\n/g, '<br>')}</p>`
  if (b.kind === 'quote') {
    return `<blockquote style="margin:0 0 16px;padding:8px 12px;border-left:3px solid #cbd5e1;color:#334155;white-space:pre-wrap">${fill(escapeHtml(b.text), vars, escapeHtml)}</blockquote>`
  }
  return `<p style="margin:24px 0"><a href="${escapeHtml(href)}" style="background:#0f172a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">${fill(escapeHtml(b.label), vars, escapeHtml)}</a></p>`
}

/** Bausteine als HTML mit unveränderten Platzhaltern, als Startpunkt beim Umschalten auf den HTML-Modus. */
export function blocksToHtml(blocks: MailBlock[]) {
  const keep = (text: string) => text.replace(PLACEHOLDER, (_, name: string) => `\uE000${name}\uE001`)
  const restore = (html: string) => html.replace(/\uE000([a-zA-Z]+)\uE001/g, '{{$1}}')
  return blocks
    .map((b) => {
      if (b.kind === 'button') return restore(blockHtml({ ...b, label: keep(b.label) }, {}, keep(b.href)))
      return restore(blockHtml({ ...b, text: keep(b.text) }, {}, ''))
    })
    .join('\n')
}

/** Nur http(s)- und mailto-Links in Buttons, damit keine javascript:-Links entstehen. */
function safeHref(href: string) {
  return /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : '#'
}
