import nodemailer, { type Transporter } from 'nodemailer'
import { logger } from '../log.server'

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

type Mail = Parameters<MailTransport['send']>[0]

/**
 * Auf dem Testsystem (MAIL_REDIRECT_TO gesetzt) gehen alle Mails an diese Adresse statt an die echten Empfänger.
 * Der eigentliche Empfänger steht im Betreff.
 */
export function redirectMail(mail: Mail, redirectTo: string | undefined): Mail {
  const target = redirectTo?.trim()
  if (!target) return mail
  return { ...mail, to: target, subject: `[Test, an ${mail.to}] ${mail.subject}` }
}

/** Transport mit Mail-Umleitung aus MAIL_REDIRECT_TO (siehe redirectMail). */
export function createMailTransport(): MailTransport {
  const transport = createSmtpTransport()
  const redirectTo = process.env.MAIL_REDIRECT_TO
  return { ...transport, send: (mail) => transport.send(redirectMail(mail, redirectTo)) }
}

/**
 * SMTP_URL z. B. smtps://user:pass@mail.example.com:465 oder smtp://user:pass@host:587.
 * Ohne SMTP_URL werden E-Mails nur ins Log geschrieben (Entwicklung).
 */
function createSmtpTransport(): MailTransport {
  const url = process.env.SMTP_URL
  const from = process.env.MAIL_FROM ?? 'Drucktool <noreply@localhost>'
  if (!url) {
    return {
      dryRun: true,
      send: async (mail) => {
        logger.info('E-Mail nicht verschickt (kein SMTP_URL gesetzt)', { to: mail.to, subject: mail.subject })
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
