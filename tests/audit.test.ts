import { afterAll, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

describe.skipIf(!url)('Audit-Log (Integration)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const admin = await import('~/server/admin/admin.server')
  const { listAuditLog } = await import('~/server/audit/audit.server')
  const { authenticateWithPassword } = await import('~/server/auth/login.server')
  const { hashPassword } = await import('~/server/auth/password.server')
  const { issueLoginLink, redeemLoginLink } = await import('~/server/auth/magic-link.server')
  const { purgeAuditLog } = await import('~/server/maintenance/cleanup.server')
  type Principal = import('~/server/requests/requests.server').Principal
  const stamp = Date.now()
  const email = (name: string) => `${name}-${stamp}@audit.test`

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  async function principal(role: Principal['role']): Promise<Principal> {
    const [u] = await getDb()
      .insert(schema.users)
      .values({ email: email(`${role}-${Math.random()}`), lastName: role, role, status: 'active' })
      .returning()
    return { id: u!.id, role }
  }

  async function entriesFor(targetId: string) {
    return getDb().select().from(schema.auditLog).where(eq(schema.auditLog.targetId, targetId)).orderBy(schema.auditLog.createdAt)
  }

  it('protokolliert Freigabe und Ablehnung von Registrierungen', async () => {
    const superadmin = await principal('superadmin')
    const db = getDb()
    const [org] = await db
      .insert(schema.organisations)
      .values({ name: `Audit ${stamp}`, status: 'pending' })
      .returning()
    const [anna] = await db
      .insert(schema.users)
      .values({ email: email('anna'), lastName: 'Anna', role: 'customer', status: 'pending' })
      .returning()
    await db.insert(schema.organisationMembers).values({ userId: anna!.id, organisationId: org!.id })
    const [bert] = await db
      .insert(schema.users)
      .values({ email: email('bert'), lastName: 'Bert', role: 'customer', status: 'pending' })
      .returning()

    await admin.approveRegistration(superadmin, { userId: anna!.id, existingOrganisationId: null })
    await admin.rejectRegistration(superadmin, bert!.id)

    const [approved] = await entriesFor(anna!.id)
    expect(approved).toMatchObject({
      action: 'registration.approved',
      actorId: superadmin.id,
      organisationId: org!.id,
      before: { status: 'pending' },
      after: { status: 'active' },
    })
    const [rejected] = await entriesFor(bert!.id)
    expect(rejected).toMatchObject({ action: 'registration.rejected', after: { status: 'rejected' } })
  })

  it('protokolliert Benutzer ohne Passwörter oder Hashes', async () => {
    const superadmin = await principal('superadmin')
    const created = await admin.createUser(superadmin, {
      firstName: '',
      lastName: 'Clara',
      email: email('clara'),
      role: 'staff',
      organisationIds: [],
      password: 'geheimes-passwort-1',
    })
    await admin.updateUser(superadmin, {
      id: created.id,
      firstName: 'Clara',
      lastName: 'Neu',
      email: email('clara'),
      role: 'admin',
      status: 'active',
      organisationIds: [],
      password: 'noch-geheimer-2',
    })
    const entries = await entriesFor(created.id)
    expect(entries.map((e) => e.action)).toEqual(['user.created', 'user.updated'])
    expect(entries[1]).toMatchObject({
      before: { firstName: '', lastName: 'Clara', role: 'staff' },
      after: { firstName: 'Clara', lastName: 'Neu', role: 'admin' },
      data: { passwordChanged: true, sessionsRevoked: true },
    })
    const raw = JSON.stringify(entries)
    expect(raw).not.toContain('geheim')
    expect(raw).not.toContain('scrypt')
    expect(raw).not.toContain('passwordHash')
  })

  it('schreibt den Eintrag in derselben Transaktion wie die Änderung', async () => {
    const admin1 = await principal('admin')
    // Ein Admin darf keinen Superadmin anlegen: weder Benutzer noch Protokolleintrag entstehen.
    await expect(
      admin.createUser(admin1, { firstName: '', lastName: 'X', email: email('verboten'), role: 'superadmin', organisationIds: [], password: '' }),
    ).rejects.toThrow('Superadmin')
    // Doppelte Adresse: die Transaktion bricht ab, es bleibt kein Eintrag zurück.
    await expect(
      admin.createUser(admin1, { firstName: '', lastName: 'Y', email: email('clara'), role: 'staff', organisationIds: [], password: '' }),
    ).rejects.toThrow('vergeben')
    const rows = await getDb()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.actorId, admin1.id)))
    expect(rows).toHaveLength(0)
  })

  it('protokolliert Organisationen', async () => {
    const admin1 = await principal('admin')
    const base = { name: `Lehrstuhl ${stamp}`, email: '', phone: '', street: '', zip: '', city: '', country: 'de', vatId: '' }
    const { id } = await admin.saveOrganisation(admin1, { ...base, status: 'active' })
    await admin.saveOrganisation(admin1, { ...base, id, status: 'disabled' })
    const entries = await entriesFor(id)
    expect(entries.map((e) => e.action)).toEqual(['organisation.created', 'organisation.updated'])
    expect(entries[1]).toMatchObject({ before: { status: 'active' }, after: { status: 'disabled' } })
  })

  it('protokolliert erfolgreiche und fehlgeschlagene Anmeldungen', async () => {
    const address = email('login')
    const [user] = await getDb()
      .insert(schema.users)
      .values({
        email: address,
        lastName: 'Login',
        role: 'customer',
        status: 'active',
        passwordHash: await hashPassword('richtig-123'),
      })
      .returning()
    await expect(authenticateWithPassword(address, 'falsches-passwort')).rejects.toThrow('falsch')
    await authenticateWithPassword(address, 'richtig-123')
    const token = await issueLoginLink(address, null)
    await redeemLoginLink(token!)

    const entries = await entriesFor(user!.id)
    expect(entries.map((e) => [e.action, e.data.method])).toEqual([
      ['login.failed', 'password'],
      ['login.succeeded', 'password'],
      ['login.succeeded', 'link'],
    ])
    // Bei Fehlversuchen ist das Konto nur Ziel, nicht Akteur.
    expect(entries[0]).toMatchObject({ actorId: null, data: { reason: 'wrong_credentials', email: address } })
    expect(entries[1]!.actorId).toBe(user!.id)
    expect(JSON.stringify(entries)).not.toContain('falsches-passwort')
  })

  it('filtert nach Benutzer, Organisation, Aktion und Zeitraum', async () => {
    const superadmin = await principal('superadmin')
    const [org] = await getDb()
      .insert(schema.organisations)
      .values({ name: `Filter ${stamp}`, status: 'active' })
      .returning()
    const created = await admin.createUser(superadmin, {
      firstName: '',
      lastName: 'Dora',
      email: email('dora'),
      role: 'customer',
      organisationIds: [org!.id],
      password: '',
    })

    const byUser = await listAuditLog({ userId: created.id })
    expect(byUser.entries.map((e) => e.action)).toEqual(['user.created'])
    expect(byUser.entries[0]).toMatchObject({ targetUserName: 'Dora', organisationName: `Filter ${stamp}` })
    // Auch der Akteur findet seine eigenen Aktionen.
    expect((await listAuditLog({ userId: superadmin.id })).entries).toHaveLength(1)
    expect((await listAuditLog({ organisationId: org!.id })).entries).toHaveLength(1)
    expect((await listAuditLog({ userId: created.id, action: 'user.updated' })).entries).toHaveLength(0)

    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' })
    expect((await listAuditLog({ userId: created.id, from: today, to: today })).entries).toHaveLength(1)
    expect((await listAuditLog({ userId: created.id, to: '2020-01-01' })).entries).toHaveLength(0)
  })

  it('löscht Einträge nach der Aufbewahrungsdauer', async () => {
    const actor = await principal('admin')
    const [old] = await getDb()
      .insert(schema.auditLog)
      .values({
        actorId: actor.id,
        action: 'user.updated',
        targetType: 'user',
        targetId: actor.id,
        createdAt: sql`now() - interval '400 days'`,
      })
      .returning()
    await getDb()
      .insert(schema.auditLog)
      .values({ actorId: actor.id, action: 'user.updated', targetType: 'user', targetId: actor.id })
    expect(await purgeAuditLog(getDb(), 0)).toBe(0)
    expect(await purgeAuditLog(getDb(), 365)).toBeGreaterThanOrEqual(1)
    const left = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.actorId, actor.id))
    expect(left).toHaveLength(1)
    expect(left[0]!.id).not.toBe(old!.id)
  })
})
