import nodemailer, { type Transporter } from 'nodemailer'

export type MailTransport = {
  send: (mail: { to: string; subject: string; text: string; html: string }) => Promise<void>
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
        console.log(`[mail] (kein SMTP_URL gesetzt) an ${mail.to}: ${mail.subject}`)
      },
    }
  }
  const transporter: Transporter = nodemailer.createTransport(url)
  return {
    dryRun: false,
    send: async (mail) => {
      await transporter.sendMail({ from, ...mail })
    },
  }
}
