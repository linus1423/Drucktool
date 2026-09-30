import nodemailer, { type Transporter } from 'nodemailer'

export type MailTransport = {
  send: (mail: { to: string; subject: string; text: string; html: string }) => Promise<void>
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
    send: async (mail) => {
      await transporter.sendMail({ from, ...mail })
    },
  }
}
