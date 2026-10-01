import { afterAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

describe.skipIf(!url)('Anmeldung per E-Mail-Link (Integration)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const { issueLoginLink, redeemLoginLink, isDomainAllowed } = await import('~/server/auth/magic-link.server')
  const stamp = Date.now()
  const email = (name: string) => `${name}-${stamp}@link.test`

  afterAll(async () => {
    delete process.env.CUSTOMER_EMAIL_DOMAINS
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  async function userByEmail(address: string) {
    const [row] = await getDb().select().from(schema.users).where(sql`lower(${schema.users.email}) = ${address}`)
    return row
  }

  it('legt beim ersten Link ein aktives Kundenkonto ohne Organisation an', async () => {
    const token = await issueLoginLink(email('neu'), '/auftraege/neu')
    expect(token).toBeTruthy()
    const mails = await getDb().select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, email('neu')))
    expect(mails).toHaveLength(1)
    expect(mails[0]!.text).toContain(`/anmelden?token=${token}`)

    const result = await redeemLoginLink(token!)
    expect(result).toMatchObject({ redirect: '/auftraege/neu', isNew: true })
    expect(await userByEmail(email('neu'))).toMatchObject({
      role: 'customer',
      status: 'active',
      organisationId: null,
      passwordHash: null,
    })
  })

  it('lässt jeden Link nur einmal zu', async () => {
    const token = await issueLoginLink(email('einmal'), null)
    await redeemLoginLink(token!)
    await expect(redeemLoginLink(token!)).rejects.toThrow('ungültig')
    await expect(redeemLoginLink('erfunden-erfunden-erfunden')).rejects.toThrow('ungültig')
  })

  it('lässt abgelaufene Links nicht zu', async () => {
    const token = await issueLoginLink(email('alt'), null)
    await getDb()
      .update(schema.loginTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.loginTokens.email, email('alt')))
    await expect(redeemLoginLink(token!)).rejects.toThrow('abgelaufen')
  })

  it('aktiviert wartende Kunden, lässt gesperrte aber nicht herein', async () => {
    await getDb()
      .insert(schema.users)
      .values([
        { email: email('wartet'), lastName: 'Wartet', role: 'customer', status: 'pending' },
        { email: email('gesperrt'), lastName: 'Gesperrt', role: 'customer', status: 'disabled' },
      ])
    const token = await issueLoginLink(email('wartet'), null)
    await redeemLoginLink(token!)
    expect((await userByEmail(email('wartet')))!.status).toBe('active')

    // Gesperrte bekommen keinen Link; die Antwort nach außen bleibt dieselbe.
    expect(await issueLoginLink(email('gesperrt'), null)).toBeNull()
    const mails = await getDb().select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, email('gesperrt')))
    expect(mails).toHaveLength(0)
  })

  it('beschränkt neue Konten auf erlaubte Domains', async () => {
    expect(isDomainAllowed('a@tum.de', ['tum.de'])).toBe(true)
    expect(isDomainAllowed('a@mytum.de', ['tum.de'])).toBe(false)
    expect(isDomainAllowed('a@in.tum.de', ['tum.de'])).toBe(true)
    expect(isDomainAllowed('a@example.com', [])).toBe(true)

    process.env.CUSTOMER_EMAIL_DOMAINS = 'tum.de'
    await expect(issueLoginLink(email('fremd'), null)).rejects.toThrow('@tum.de')
    // Bestehende Konten dürfen sich weiter anmelden.
    expect(await issueLoginLink(email('neu'), null)).toBeTruthy()
    delete process.env.CUSTOMER_EMAIL_DOMAINS
  })
})
