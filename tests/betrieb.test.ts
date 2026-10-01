import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMailTransport, redirectMail } from '~/server/mail/transport.server'
import { getAppInfo } from '~/server/app-info'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('Mail-Umleitung', () => {
  const mail = { to: 'kunde@example.com', subject: 'Auftrag bestätigt', text: 't', html: 'h' }

  it('ändert ohne MAIL_REDIRECT_TO nichts', () => {
    expect(redirectMail(mail, undefined)).toBe(mail)
    expect(redirectMail(mail, ' ')).toBe(mail)
  })

  it('schickt alles an die Testadresse und nennt den Empfänger im Betreff', () => {
    expect(redirectMail(mail, 'test@fsmb.de')).toEqual({
      ...mail,
      to: 'test@fsmb.de',
      subject: '[Test, an kunde@example.com] Auftrag bestätigt',
    })
  })

  it('wird vom Transport angewendet', async () => {
    vi.stubEnv('SMTP_URL', '')
    vi.stubEnv('MAIL_REDIRECT_TO', 'test@fsmb.de')
    const output: string[] = []
    const capture = (chunk: unknown) => {
      output.push(String(chunk))
      return true
    }
    vi.spyOn(console, 'log').mockImplementation(capture)
    vi.spyOn(process.stdout, 'write').mockImplementation(capture)
    await createMailTransport().send(mail)
    expect(output.join('')).toContain('test@fsmb.de')
    expect(output.join('')).not.toContain('an kunde@example.com:')
  })
})

describe('getAppInfo', () => {
  it('liest Version, Commit und Umgebung', () => {
    vi.stubEnv('APP_VERSION', 'v1.2.0')
    vi.stubEnv('GIT_COMMIT', '0123456789abcdef0123')
    vi.stubEnv('APP_ENVIRONMENT', 'staging')
    expect(getAppInfo()).toEqual({ version: 'v1.2.0', commit: '0123456789ab', environment: 'staging' })
  })

  it('hat sinnvolle Standardwerte', () => {
    vi.stubEnv('APP_VERSION', '')
    vi.stubEnv('GIT_COMMIT', 'unknown')
    vi.stubEnv('APP_ENVIRONMENT', 'quatsch')
    vi.stubEnv('NODE_ENV', 'production')
    expect(getAppInfo()).toEqual({ version: 'dev', commit: null, environment: 'production' })
  })
})
