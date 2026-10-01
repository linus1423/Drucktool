import { afterAll, describe, expect, it } from 'vitest'
import { eq, like, sql } from 'drizzle-orm'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

const { accountBlockMs } = await import('~/server/auth/rate-limit.server')

describe('Wartezeit nach Fehlversuchen', () => {
  it('beginnt beim fünften Fehlversuch und verdoppelt sich bis höchstens eine Stunde', () => {
    expect(accountBlockMs(4)).toBe(0)
    expect(accountBlockMs(5)).toBe(60_000)
    expect(accountBlockMs(6)).toBe(120_000)
    expect(accountBlockMs(8)).toBe(8 * 60_000)
    expect(accountBlockMs(30)).toBe(60 * 60_000)
  })
})

describe.skipIf(!url)('Rate-Limits in PostgreSQL (Integration)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const { hitRateLimit, accountBlockedMs, recordLoginFailure } = await import('~/server/auth/rate-limit.server')
  const { authenticateWithPassword } = await import('~/server/auth/login.server')
  const { hashPassword } = await import('~/server/auth/password.server')
  const { purgeExpired } = await import('~/server/maintenance/cleanup.server')
  const stamp = Date.now()
  const email = (name: string) => `${name}-${stamp}@limit.test`

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  async function expireWindow(prefix: string) {
    await getDb()
      .update(schema.rateLimits)
      .set({ windowEndsAt: sql`now() - interval '1 second'`, blockedUntil: null })
      .where(like(schema.rateLimits.key, `${prefix}:%`))
  }

  it('begrenzt Versuche pro IP im Zeitfenster und beginnt danach von vorn', async () => {
    const ip = `10.0.0.${stamp % 250}`
    for (let i = 0; i < 3; i++) expect(await hitRateLimit('test-ip', ip, 3, 60_000)).toBe(true)
    expect(await hitRateLimit('test-ip', ip, 3, 60_000)).toBe(false)
    // Andere IPs sind davon unabhängig.
    expect(await hitRateLimit('test-ip', `${ip}1`, 3, 60_000)).toBe(true)

    await expireWindow('test-ip')
    expect(await hitRateLimit('test-ip', ip, 3, 60_000)).toBe(true)
  })

  it('speichert weder IP- noch E-Mail-Adressen im Klartext', async () => {
    await hitRateLimit('test-klartext', 'geheim@limit.test', 3, 60_000)
    const rows = await getDb().select().from(schema.rateLimits).where(like(schema.rateLimits.key, 'test-klartext:%'))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.key).not.toContain('geheim')
  })

  it('sperrt ein Konto nach fünf Fehlversuchen, egal von welcher IP', async () => {
    const address = email('sperre')
    await getDb()
      .insert(schema.users)
      .values({
        email: address,
        name: 'Sperre',
        role: 'customer',
        status: 'active',
        passwordHash: await hashPassword('richtig-123'),
      })

    // Fehlversuche kommen von wechselnden IPs; gezählt wird pro Konto.
    for (let i = 0; i < 5; i++) {
      await expect(authenticateWithPassword(address, `falsch-${i}`)).rejects.toThrow('falsch')
    }
    expect(await accountBlockedMs(address)).toBeGreaterThan(50_000)
    // Auch das richtige Passwort hilft während der Sperre nicht.
    await expect(authenticateWithPassword(address, 'richtig-123')).rejects.toThrow('Zu viele Fehlversuche')
  })

  it('verdoppelt die Wartezeit bei weiteren Fehlversuchen', async () => {
    const address = email('doppelt')
    for (let i = 0; i < 5; i++) await recordLoginFailure(address)
    const first = await accountBlockedMs(address)
    expect(await recordLoginFailure(address)).toBe(6)
    const second = await accountBlockedMs(address)
    expect(second).toBeGreaterThan(first)
    expect(second).toBeLessThanOrEqual(120_000)
  })

  it('setzt den Zähler nach erfolgreicher Anmeldung zurück', async () => {
    const address = email('reset')
    await getDb()
      .insert(schema.users)
      .values({
        email: address,
        name: 'Reset',
        role: 'customer',
        status: 'active',
        passwordHash: await hashPassword('richtig-123'),
      })
    for (let i = 0; i < 4; i++) {
      await expect(authenticateWithPassword(address, 'falsch')).rejects.toThrow('falsch')
    }
    expect((await authenticateWithPassword(address, 'richtig-123')).email).toBe(address)
    // Nach dem Zurücksetzen sperrt erst der fünfte neue Fehlversuch.
    for (let i = 0; i < 4; i++) {
      await expect(authenticateWithPassword(address, 'falsch')).rejects.toThrow('falsch')
    }
    expect(await accountBlockedMs(address)).toBe(0)
  })

  it('zählt auch unbekannte Adressen, damit die Sperre nichts verrät', async () => {
    const address = email('unbekannt')
    for (let i = 0; i < 5; i++) {
      await expect(authenticateWithPassword(address, 'egal')).rejects.toThrow('falsch')
    }
    await expect(authenticateWithPassword(address, 'egal')).rejects.toThrow('Zu viele Fehlversuche')
  })

  it('räumt abgelaufene Sitzungen, Anmeldelinks und Zähler auf', async () => {
    const db = getDb()
    const [user] = await db
      .insert(schema.users)
      .values({ email: email('aufraeumen'), name: 'Aufräumen', role: 'customer', status: 'active' })
      .returning()
    await db.insert(schema.sessions).values([
      { id: `alt-${stamp}`, userId: user!.id, expiresAt: new Date(Date.now() - 1000), ip: '10.1.1.1' },
      { id: `neu-${stamp}`, userId: user!.id, expiresAt: new Date(Date.now() + 60_000), ip: '10.1.1.2' },
    ])
    await db.insert(schema.loginTokens).values([
      { id: `alt-${stamp}`, email: email('aufraeumen'), expiresAt: new Date(Date.now() - 1000) },
      { id: `neu-${stamp}`, email: email('aufraeumen'), expiresAt: new Date(Date.now() + 60_000) },
    ])
    await hitRateLimit('test-aufraeumen', 'a', 1, 60_000)
    await hitRateLimit('test-aufraeumen', 'b', 1, 60_000)
    await db
      .update(schema.rateLimits)
      .set({ windowEndsAt: sql`now() - interval '1 second'` })
      .where(like(schema.rateLimits.key, 'test-aufraeumen:%'))
    // Gesperrte Konten bleiben gesperrt, auch wenn das Zählfenster vorbei ist.
    await db
      .update(schema.rateLimits)
      .set({ blockedUntil: sql`now() + interval '1 minute'` })
      .where(sql`${schema.rateLimits.key} = (select min(key) from rate_limits where key like 'test-aufraeumen:%')`)

    const result = await purgeExpired(db)
    expect(result.sessions).toBeGreaterThanOrEqual(1)
    const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, user!.id))
    expect(sessions.map((s) => s.id)).toEqual([`neu-${stamp}`])
    const tokens = await db
      .select()
      .from(schema.loginTokens)
      .where(eq(schema.loginTokens.email, email('aufraeumen')))
    expect(tokens.map((t) => t.id)).toEqual([`neu-${stamp}`])
    const limits = await db.select().from(schema.rateLimits).where(like(schema.rateLimits.key, 'test-aufraeumen:%'))
    expect(limits).toHaveLength(1)

    // Ein zweiter Lauf (z. B. ein weiterer Worker) findet nichts mehr und stört nicht.
    const again = await purgeExpired(db)
    expect(again.sessions).toBe(0)
    expect(again.loginTokens).toBe(0)
  })
})
