import { afterAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { BILLING } from './fixtures'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

describe.skipIf(!url)('Datenschutz (Integration)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const { anonymizeUser, exportUserData, ANONYMOUS_NAME } = await import('~/server/privacy/privacy.server')
  const { createUser } = await import('~/server/admin/admin.server')
  const { authenticateWithPassword } = await import('~/server/auth/login.server')
  const { hashPassword } = await import('~/server/auth/password.server')
  const { issueLoginLink, redeemLoginLink } = await import('~/server/auth/magic-link.server')
  const { testUpload } = await import('./order-fixture')
  const { purgeSessionIps, purgeRejectedRegistrations } = await import('~/server/maintenance/cleanup.server')
  type Principal = import('~/server/requests/requests.server').Principal
  const stamp = Date.now()
  const email = (name: string) => `${name}-${stamp}@privacy.test`
  const db = getDb()

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  async function principal(role: Principal['role']): Promise<Principal> {
    const [u] = await db
      .insert(schema.users)
      .values({ email: email(`${role}-${Math.random()}`), lastName: `Chef ${role}`, role, status: 'active' })
      .returning()
    return { id: u!.id, role }
  }

  /** Kunde mit allem, was das Tool zu einer Person speichern kann. */
  async function fullCustomer(name: string) {
    const address = email(name)
    const [org] = await db
      .insert(schema.organisations)
      .values({ name: `Org ${name} ${stamp}`, status: 'active' })
      .returning()
    const [user] = await db
      .insert(schema.users)
      .values({
        email: address,
        lastName: `Erika ${name}`,
        role: 'customer',
        status: 'active',
        passwordHash: await hashPassword('richtig-12345'),
        billingAddress: BILLING,
        deliveryAddress: { recipient: 'Erika', department: '', building: 'MW', room: '1234', note: '' },
        lastLoginAt: new Date(),
      })
      .returning()
    const id = user!.id
    await db.insert(schema.organisationMembers).values({ userId: id, organisationId: org!.id })
    await db.insert(schema.organisationRequests).values({ userId: id, name: 'Lehrstuhl Erika', details: 'Raum 1234' })
    await db
      .insert(schema.sessions)
      .values({
        id: `s-${name}-${stamp}`,
        userId: id,
        expiresAt: new Date(Date.now() + 60_000),
        ip: '10.9.9.9',
        userAgent: 'Firefox',
      })
    await db.insert(schema.oidcAccounts).values({ userId: id, issuer: 'https://idp.test', subject: `sub-${name}-${stamp}` })
    await db
      .insert(schema.loginTokens)
      .values({ id: `t-${name}-${stamp}`, email: address, expiresAt: new Date(Date.now() + 60_000) })
    await db.insert(schema.emailOutbox).values({ to: address, subject: 'Hallo', text: 'Hallo Erika', html: '<p>Hallo Erika</p>' })
    const [request] = await db
      .insert(schema.requests)
      .values({ title: `Abschlussarbeit ${name}`, createdById: id, billingAddress: BILLING })
      .returning()
    await db.insert(schema.requestComments).values({ requestId: request!.id, authorId: id, body: 'Bitte bis Freitag' })
    const principal = { id, role: 'customer' as const }
    const attached = await testUpload(principal)
    await db.update(schema.requestFiles).set({ requestId: request!.id }).where(eq(schema.requestFiles.id, attached.id))
    const loose = await testUpload(principal)
    // Ein fehlgeschlagener Login mit dieser Adresse landet mit E-Mail im Audit-Log.
    await expect(authenticateWithPassword(address, 'falsch')).rejects.toThrow('falsch')
    return { id, address, request: request!, attached, loose }
  }

  it('entfernt alle personenbezogenen Daten aus users und sessions, Aufträge bleiben', async () => {
    const superadmin = await principal('superadmin')
    const c = await fullCustomer('anna')
    await anonymizeUser(superadmin, c.id)

    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, c.id))
    expect(user).toMatchObject({
      name: ANONYMOUS_NAME,
      email: `geloescht-${c.id}@anonym.invalid`,
      passwordHash: null,
      status: 'disabled',
      billingAddress: null,
      deliveryAddress: null,
      lastLoginAt: null,
    })
    expect(user!.anonymizedAt).toBeInstanceOf(Date)
    expect(await db.select().from(schema.organisationMembers).where(eq(schema.organisationMembers.userId, c.id))).toEqual([])
    expect(await db.select().from(schema.organisationRequests).where(eq(schema.organisationRequests.userId, c.id))).toEqual([])
    expect(JSON.stringify(user)).not.toMatch(/anna|Erika|Boltzmann/i)
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.userId, c.id))).toHaveLength(0)
    expect(await db.select().from(schema.oidcAccounts).where(eq(schema.oidcAccounts.userId, c.id))).toHaveLength(0)
    expect(await db.select().from(schema.loginTokens).where(eq(schema.loginTokens.email, c.address))).toHaveLength(0)
    expect(await db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, c.address))).toHaveLength(0)

    // Aufträge, Kommentare und Dateien am Auftrag bleiben; lose Uploads verschwinden.
    const [request] = await db.select().from(schema.requests).where(eq(schema.requests.id, c.request.id))
    expect(request!.createdById).toBe(c.id)
    expect(await db.select().from(schema.requestComments).where(eq(schema.requestComments.authorId, c.id))).toHaveLength(1)
    const files = await db.select().from(schema.requestFiles).where(eq(schema.requestFiles.ownerId, c.id))
    expect(files.map((f) => f.id)).toEqual([c.attached.id])

    // Im Audit-Log stehen weder Name noch E-Mail-Adresse mehr.
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(sql`${schema.auditLog.targetId} = ${c.id} or ${schema.auditLog.data}->>'email' = ${c.address}`)
    expect(audit.map((a) => a.action)).toContain('user.anonymized')
    expect(JSON.stringify(audit)).not.toContain(c.address)
  })

  it('sperrt das Konto und gibt die E-Mail-Adresse wieder frei', async () => {
    const superadmin = await principal('superadmin')
    const c = await fullCustomer('bert')
    await anonymizeUser(superadmin, c.id)

    await expect(authenticateWithPassword(c.address, 'richtig-12345')).rejects.toThrow('falsch')
    // Ein neuer Anmeldelink legt ein neues Konto an, das alte bleibt anonym.
    const token = await issueLoginLink(c.address, null)
    const login = await redeemLoginLink(token!)
    expect(login.isNew).toBe(true)
    expect(login.userId).not.toBe(c.id)
    // Auch über die Benutzerverwaltung ist die Adresse frei.
    await db.delete(schema.users).where(eq(schema.users.id, login.userId))
    await expect(
      createUser(superadmin, { firstName: 'Bert', lastName: 'Neu', email: c.address, role: 'customer', organisationIds: [], password: '' }),
    ).resolves.toHaveProperty('id')
  })

  it('verweigert Selbst-Anonymisierung, Admins für Admins und doppelte Läufe', async () => {
    const admin = await principal('admin')
    const otherAdmin = await principal('admin')
    await expect(anonymizeUser(admin, admin.id)).rejects.toThrow('eigenes Konto')
    await expect(anonymizeUser(admin, otherAdmin.id)).rejects.toThrow('Superadmin')
    const c = await fullCustomer('carl')
    await anonymizeUser(admin, c.id)
    await expect(anonymizeUser(admin, c.id)).rejects.toThrow('bereits anonymisiert')
  })

  it('exportiert alle gespeicherten Daten ohne Passwort-Hash', async () => {
    const admin = await principal('admin')
    const c = await fullCustomer('dora')
    const data = await exportUserData(admin, c.id)
    expect(data.account).toMatchObject({ email: c.address, name: 'Erika dora', hasPassword: true, billingAddress: BILLING })
    expect(data.sessions[0]).toMatchObject({ ip: '10.9.9.9', userAgent: 'Firefox' })
    expect(data.oidcAccounts).toHaveLength(1)
    expect(data.organisations.map((o) => o.name)).toEqual([`Org dora ${stamp}`])
    expect(data.organisationRequests).toMatchObject([{ name: 'Lehrstuhl Erika', details: 'Raum 1234', status: 'open' }])
    expect(data.requests.map((r) => r.title)).toEqual(['Abschlussarbeit dora'])
    expect(data.comments.map((m) => m.body)).toEqual(['Bitte bis Freitag'])
    expect(data.files).toHaveLength(2)
    expect(data.emails.map((m) => m.subject)).toEqual(['Hallo'])
    expect(data.auditLog.map((a) => a.action)).toContain('login.failed')
    expect(JSON.stringify(data)).not.toMatch(/scrypt|passwordHash/)

    const [entry] = await db
      .select()
      .from(schema.auditLog)
      .where(sql`${schema.auditLog.action} = 'user.exported' and ${schema.auditLog.targetId} = ${c.id}`)
    expect(entry!.actorId).toBe(admin.id)
  })

  it('löscht IP-Adressen alter Sitzungen nach der Frist', async () => {
    const c = await fullCustomer('emil')
    await db.insert(schema.sessions).values({
      id: `alt-emil-${stamp}`,
      userId: c.id,
      expiresAt: new Date(Date.now() + 60_000),
      ip: '10.8.8.8',
      createdAt: new Date(Date.now() - 40 * 24 * 60 * 60_000),
    })
    expect(await purgeSessionIps(db, 0)).toBe(0)
    await purgeSessionIps(db, 30)
    const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, c.id))
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.ip]))
    expect(byId[`alt-emil-${stamp}`]).toBeNull()
    expect(byId[`s-emil-${stamp}`]).toBe('10.9.9.9')
  })

  it('löscht abgelehnte Registrierungen nach der Frist', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60_000)
    const [org] = await db
      .insert(schema.organisations)
      .values({ name: `Abgelehnt ${stamp}`, status: 'disabled' })
      .returning()
    const [rejectedOld] = await db
      .insert(schema.users)
      .values({
        email: email('alt'),
        lastName: 'Alt',
        role: 'customer',
        status: 'rejected',
        reviewedAt: old,
      })
      .returning()
    await db.insert(schema.organisationMembers).values({ userId: rejectedOld!.id, organisationId: org!.id })
    const [rejectedNew] = await db
      .insert(schema.users)
      .values({ email: email('neu'), lastName: 'Neu', role: 'customer', status: 'rejected', reviewedAt: new Date() })
      .returning()
    const [withRequest] = await db
      .insert(schema.users)
      .values({ email: email('auftrag'), lastName: 'Auftrag', role: 'customer', status: 'rejected', reviewedAt: old })
      .returning()
    await db.insert(schema.requests).values({ title: 'Alt', createdById: withRequest!.id })
    await db.insert(schema.auditLog).values({
      action: 'registration.rejected',
      targetType: 'user',
      targetId: rejectedOld!.id,
      after: { name: 'Alt', email: email('alt'), status: 'rejected' },
    })

    expect(await purgeRejectedRegistrations(db, 30)).toBeGreaterThanOrEqual(1)
    const left = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`${schema.users.id} in (${rejectedOld!.id}, ${rejectedNew!.id}, ${withRequest!.id})`)
    expect(left.map((u) => u.id).sort()).toEqual([rejectedNew!.id, withRequest!.id].sort())
    expect(await db.select().from(schema.organisations).where(eq(schema.organisations.id, org!.id))).toHaveLength(0)
    const [entry] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, rejectedOld!.id))
    expect(entry!.after).toEqual({ status: 'rejected' })
    // Ein zweiter Lauf findet nichts mehr.
    expect(await purgeRejectedRegistrations(db, 30)).toBe(0)
  })
})
