import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { SMTPServer } from 'smtp-server'
import { commentMail, statusChangedMail } from '~/server/mail/templates'
import { BILLING } from './fixtures'
import { retryDelayMs } from '~/server/mail/worker.server'

describe('E-Mail-Vorlagen', () => {
  const ref = { id: 'abc', number: 1001, title: 'Flyer <b>A5</b>', actorName: 'Max' }

  it('maskiert HTML aus Benutzereingaben', () => {
    const mail = commentMail({ ...ref, body: '<script>alert(1)</script>', internal: false })
    expect(mail.html).not.toContain('<script>')
    expect(mail.html).toContain('&lt;script&gt;')
    expect(mail.text).toContain('> <script>alert(1)</script>')
  })

  it('erklärt die Bestätigung und verlinkt den Auftrag', () => {
    process.env.APP_URL = 'https://druck.example.com/'
    const mail = statusChangedMail({ ...ref, from: 'submitted', to: 'confirmed' })
    expect(mail.subject).toBe('#1001 Flyer <b>A5</b>: Bestätigt')
    expect(mail.text).toContain('verbindlich')
    expect(mail.text).toContain('https://druck.example.com/anfragen/abc')
  })

  it('wartet bei Fehlern immer länger, höchstens zwei Stunden', () => {
    expect(retryDelayMs(1)).toBe(60_000)
    expect(retryDelayMs(3)).toBe(4 * 60_000)
    expect(retryDelayMs(20)).toBe(2 * 60 * 60_000)
  })
})

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

describe.skipIf(!url)('Benachrichtigungen (Integration)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const { addComment, assignRequest, changeStatus, createRequest, setInternalStatus } = await import(
    '~/server/requests/requests.server'
  )
  const { processOutbox } = await import('~/server/mail/worker.server')
  const { createMailTransport } = await import('~/server/mail/transport.server')
  type Principal = import('~/server/requests/requests.server').Principal

  const stamp = Date.now()
  const email = (name: string) => `${name}-${stamp}@test.example`
  let staff: Principal
  let staff2: Principal
  let customer: Principal
  let org: string

  async function outboxFor(requestNumber: number) {
    const rows = await getDb().select().from(schema.emailOutbox)
    return rows.filter((r) => r.subject.includes(`#${requestNumber}`)).map((r) => r.to).sort()
  }

  beforeAll(async () => {
    const db = getDb()
    // Nur die Benutzer dieses Tests sollen Mails bekommen.
    await db.update(schema.users).set({ emailNotifications: false })
    const [o] = await db.insert(schema.organisations).values({ name: 'Mail GmbH', status: 'active' }).returning()
    org = o!.id
    const rows = await db
      .insert(schema.users)
      .values([
        { email: email('staff'), name: 'Staff', role: 'staff', status: 'active' },
        { email: email('staff2'), name: 'Staff 2', role: 'staff', status: 'active' },
        { email: email('kunde'), name: 'Kunde', role: 'customer', status: 'active', organisationId: org, billingAddress: BILLING },
        { email: email('kollege'), name: 'Kollege', role: 'customer', status: 'active', organisationId: org },
        { email: email('stumm'), name: 'Stumm', role: 'customer', status: 'active', organisationId: org, emailNotifications: false },
      ])
      .returning()
    staff = { id: rows[0]!.id, role: 'staff', organisationId: null }
    staff2 = { id: rows[1]!.id, role: 'staff', organisationId: null }
    customer = { id: rows[2]!.id, role: 'customer', organisationId: org }
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  const input = { title: 'Plakate', description: '', quantity: 10, desiredDate: null }

  it('informiert bei neuen Aufträgen alle Mitarbeiter und bestätigt dem Kunden den Eingang', async () => {
    const { number } = await createRequest(customer, input)
    expect(await outboxFor(number)).toEqual([email('kunde'), email('staff'), email('staff2')])
    const rows = await getDb().select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, email('kunde')))
    expect(rows.some((r) => r.subject.startsWith('Auftrag eingereicht'))).toBe(true)
  })

  it('schreibt bei Statuswechseln durch Mitarbeiter nur den Ersteller an', async () => {
    const { id, number } = await createRequest(customer, input)
    await getDb().delete(schema.emailOutbox)
    await changeStatus(staff, { id, version: 1, to: 'confirmed', note: 'Passt.' })
    // Kollegen derselben Organisation bekommen keine Mail.
    expect(await outboxFor(number)).toEqual([email('kunde')])
  })

  it('schreibt nach einer Zuweisung nur noch den Zuständigen an', async () => {
    const { id, number } = await createRequest(customer, input)
    await assignRequest(staff, { id, version: 1, assigneeId: staff2.id })
    await getDb().delete(schema.emailOutbox)
    await addComment(customer, { id, body: 'Frage', internal: false })
    expect(await outboxFor(number)).toEqual([email('staff2')])
  })

  it('verschickt interne Notizen nie an Kunden', async () => {
    const { id, number } = await createRequest(customer, input)
    await assignRequest(staff, { id, version: 1, assigneeId: staff2.id })
    await getDb().delete(schema.emailOutbox)
    await addComment(staff, { id, body: 'intern', internal: true })
    expect(await outboxFor(number)).toEqual([email('staff2')])
  })

  it('schickt bei internen Unterstatus keine Mail an Kunden', async () => {
    const { id, number } = await createRequest(customer, input)
    await changeStatus(staff, { id, version: 1, to: 'confirmed' })
    await getDb().delete(schema.emailOutbox)
    await setInternalStatus(staff, { id, version: 2, internalStatus: 'problem' })
    expect(await outboxFor(number)).toEqual([])
  })

  it('legt bei einem Konflikt keine Mail ab', async () => {
    const { id, number } = await createRequest(customer, input)
    await changeStatus(staff, { id, version: 1, to: 'confirmed' })
    await getDb().delete(schema.emailOutbox)
    await expect(changeStatus(staff, { id, version: 1, to: 'rejected' })).rejects.toThrow()
    expect(await outboxFor(number)).toEqual([])
  })

  it('verschickt über SMTP und plant bei Fehlern einen neuen Versuch', async () => {
    const received: string[] = []
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onRcptTo(address, _session, cb) {
        if (address.address.startsWith('kaputt')) return cb(new Error('Postfach existiert nicht'))
        cb()
      },
      onData(stream, session, cb) {
        stream.resume()
        stream.on('end', () => {
          received.push(...session.envelope.rcptTo.map((r) => r.address))
          cb()
        })
      },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.server.address() as { port: number }).port
    process.env.SMTP_URL = `smtp://127.0.0.1:${port}`
    try {
      const db = getDb()
      await db.delete(schema.emailOutbox)
      const content = { subject: 'Test', text: 'Hallo', html: '<p>Hallo</p>' }
      await db.insert(schema.emailOutbox).values([
        { to: 'ok@test.example', ...content },
        { to: 'kaputt@test.example', ...content },
      ])
      expect(await processOutbox(db, createMailTransport())).toBe(2)
      expect(received).toEqual(['ok@test.example'])

      const rows = await db.select().from(schema.emailOutbox)
      const ok = rows.find((r) => r.to === 'ok@test.example')!
      const failed = rows.find((r) => r.to === 'kaputt@test.example')!
      expect(ok.status).toBe('sent')
      expect(failed.status).toBe('pending')
      expect(failed.attempts).toBe(1)
      expect(failed.lastError).toContain('Postfach')
      expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now())
      // Noch nicht fällig: nichts zu tun.
      expect(await processOutbox(db, createMailTransport())).toBe(0)
      await db.update(schema.emailOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(schema.emailOutbox.id, failed.id))
      expect(await processOutbox(db, createMailTransport())).toBe(1)
    } finally {
      delete process.env.SMTP_URL
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
