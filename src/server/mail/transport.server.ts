import nodemailer, { type Transporter } from 'nodemailer'

export type OutgoingMail = {
  to: string
  subject: string
  text: string
  html: string
  /** Anzeigename und Antwortadresse aus dem E-Mail-Layout der Verwaltung (Issue #89). */
  senderName?: string
  replyTo?: string
}

export type MailTransport = {
  send: (mail: OutgoingMail) => Promise<void>
  /** true, wenn kein SMTP-Server konfiguriert ist und Mails nur protokolliert werden. */
  dryRun: boolean
}

/**
 * SMTP_URL z. B. smtps://user:pass@mail.example.com:465 oder smtp://user:pass@host:587.
 * Ohne SMTP_URL werden E-Mails nur ins Log geschrieben (Entwicklung).
 */
export function createMailTransport(): MailTransport {
  const url = process.env.SMTP_URL
  const from = process.env.MAIL_FROM ?? 'Drucktool <noreply@localhost>'
  if (!url) {
    return {
      dryRun: true,
      send: async (mail) => {
        console.log(`[mail] (kein SMTP_URL gesetzt) an ${mail.to}: ${mail.subject}`)
      },
    }
  }
  const transporter: Transporter = nodemailer.createTransport(url)
  return {
    dryRun: false,
    send: async ({ senderName, replyTo, ...mail }) => {
      await transporter.sendMail({ from: fromWithName(from, senderName), replyTo: replyTo || undefined, ...mail })
    },
  }
}

/** Ersetzt den Anzeigenamen in MAIL_FROM; die Adresse bleibt, weil der SMTP-Server sie meist vorgibt. */
export function fromWithName(from: string, name: string | undefined) {
  if (!name?.trim()) return from
  const address = from.match(/<([^>]+)>/)?.[1] ?? from.trim()
  return `"${name.trim().replace(/["\\\r\n]/g, '')}" <${address}>`
}
