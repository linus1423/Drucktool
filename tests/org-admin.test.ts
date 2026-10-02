import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { BILLING } from './fixtures'
import { placeOrder } from './order-fixture'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

describe.skipIf(!url)('Verwalter von Organisationen (Issue #12)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const orgAdmin = await import('~/server/organisations/org-admin.server')
  const { setMemberships } = await import('~/server/organisations/organisations.server')
  const { setOrganisationAdmin } = await import('~/server/admin/admin.server')
  const { addComment, changeStatus, getRequestDetail, listRequests, markRequestRead } =
    await import('~/server/requests/requests.server')
  const { fileForDownload } = await import('~/server/files/files.server')
  type Principal = import('~/server/requests/requests.server').Principal

  const stamp = Date.now()
  let chef: Principal
  let kollege: Principal
  let neu: Principal
  let fremd: Principal
  let staff: Principal
  let admin: Principal
  let lehrstuhl: string
  let anderer: string

  async function user(name: string, role: Principal['role']): Promise<Principal> {
    const [u] = await getDb()
      .insert(schema.users)
      .values({ email: `${name}-${stamp}@orgadmin.test`, lastName: name, role, status: 'active', billingAddress: BILLING })
      .returning()
    return { id: u!.id, role }
  }

  async function member(organisationId: string, userId: string, isAdmin = false) {
    await getDb().insert(schema.organisationMembers).values({ organisationId, userId, isAdmin })
  }

  async function isMember(organisationId: string, userId: string) {
    const [row] = await getDb()
      .select()
      .from(schema.organisationMembers)
      .where(and(eq(schema.organisationMembers.organisationId, organisationId), eq(schema.organisationMembers.userId, userId)))
    return row ?? null
  }

  beforeAll(async () => {
    await getDb().update(schema.users).set({ emailNotifications: false })
    chef = await user('chef', 'customer')
    kollege = await user('kollege', 'customer')
    neu = await user('neu', 'customer')
    fremd = await user('fremd', 'customer')
    staff = await user('staff', 'staff')
    admin = await user('admin', 'admin')
    const [a, b] = await getDb()
      .insert(schema.organisations)
      .values([
        { name: `Lehrstuhl ${stamp}`, status: 'active' },
        { name: `Anderer ${stamp}`, status: 'active' },
      ])
      .returning()
    lehrstuhl = a!.id
    anderer = b!.id
    await member(lehrstuhl, chef.id, true)
    await member(lehrstuhl, kollege.id)
    await member(anderer, fremd.id, true)
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  it('lässt nur Verwalter der eigenen Organisation an die Verwaltung', async () => {
    const view = await orgAdmin.getManagedOrganisation(chef, lehrstuhl)
    expect(view.members.map((m) => m.id).sort()).toEqual([chef.id, kollege.id].sort())
    await expect(orgAdmin.getManagedOrganisation(kollege, lehrstuhl)).rejects.toThrow('Keine Berechtigung')
    await expect(orgAdmin.getManagedOrganisation(fremd, lehrstuhl)).rejects.toThrow('Keine Berechtigung')
    await expect(orgAdmin.getManagedOrganisation(chef, anderer)).rejects.toThrow('Keine Berechtigung')
    // Mitarbeiter verwalten über die Admin-Seiten, nicht hier.
    await expect(orgAdmin.getManagedOrganisation(staff, lehrstuhl)).rejects.toThrow('Keine Berechtigung')
    await expect(orgAdmin.createInvite(fremd, lehrstuhl)).rejects.toThrow('Keine Berechtigung')
    await expect(orgAdmin.removeMember(fremd, { organisationId: lehrstuhl, userId: kollege.id })).rejects.toThrow(
      'Keine Berechtigung',
    )
    await expect(orgAdmin.removeMember(chef, { organisationId: anderer, userId: fremd.id })).rejects.toThrow('Keine Berechtigung')
    await expect(
      orgAdmin.updateOrganisationDetails(chef, {
        organisationId: anderer,
        email: '',
        phone: '',
        street: '',
        zip: '',
        city: '',
        country: 'DE',
        vatId: '',
        costCenter: 'X',
      }),
    ).rejects.toThrow('Keine Berechtigung')
    expect(await orgAdmin.listManagedOrganisations(chef)).toEqual([{ id: lehrstuhl, name: `Lehrstuhl ${stamp}` }])
    expect(await orgAdmin.listManagedOrganisations(kollege)).toEqual([])
  })

  it('speichert Einladungen nur als Hash, befristet und einmalig', async () => {
    const { token, expiresAt } = await orgAdmin.createInvite(chef, lehrstuhl)
    const days = (expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    expect(days).toBeGreaterThan(13.9)
    expect(days).toBeLessThanOrEqual(14)
    const stored = await getDb()
      .select()
      .from(schema.organisationInvites)
      .where(eq(schema.organisationInvites.organisationId, lehrstuhl))
    expect(stored.some((i) => i.tokenHash === token)).toBe(false)
    expect(stored.some((i) => i.tokenHash === createHash('sha256').update(token).digest('hex'))).toBe(true)

    expect(await orgAdmin.describeInvite(neu, token)).toMatchObject({ valid: true, organisationId: lehrstuhl })
    await expect(orgAdmin.acceptInvite(staff, token)).rejects.toThrow('Mitarbeiter')
    await orgAdmin.acceptInvite(neu, token)
    expect(await isMember(lehrstuhl, neu.id)).toMatchObject({ isAdmin: false })
    // Ein zweites Mal geht nicht.
    await expect(orgAdmin.acceptInvite(fremd, token)).rejects.toThrow('ungültig')
    expect(await isMember(lehrstuhl, fremd.id)).toBeNull()
    expect((await orgAdmin.describeInvite(fremd, token)).valid).toBe(false)
    expect((await orgAdmin.describeInvite(fremd, 'gibt-es-nicht-gibt-es-nicht')).valid).toBe(false)
  })

  it('lehnt abgelaufene und widerrufene Einladungen ab', async () => {
    const expired = await orgAdmin.createInvite(chef, lehrstuhl)
    await getDb()
      .update(schema.organisationInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.organisationInvites.tokenHash, createHash('sha256').update(expired.token).digest('hex')))
    await expect(orgAdmin.acceptInvite(fremd, expired.token)).rejects.toThrow('abgelaufen')

    const revoked = await orgAdmin.createInvite(chef, lehrstuhl)
    const open = (await orgAdmin.getManagedOrganisation(chef, lehrstuhl)).invites
    expect(open).toHaveLength(1)
    // Fremde Verwalter widerrufen keine Einladungen dieser Organisation.
    await expect(orgAdmin.revokeInvite(fremd, { organisationId: lehrstuhl, inviteId: open[0]!.id })).rejects.toThrow(
      'Keine Berechtigung',
    )
    await expect(orgAdmin.revokeInvite(fremd, { organisationId: anderer, inviteId: open[0]!.id })).rejects.toThrow('widerrufen')
    await orgAdmin.revokeInvite(chef, { organisationId: lehrstuhl, inviteId: open[0]!.id })
    await expect(orgAdmin.acceptInvite(fremd, revoked.token)).rejects.toThrow('ungültig')
  })

  it('zeigt Verwaltern die Aufträge der Organisation, ändern darf nur der Besteller', async () => {
    const forOrg = await placeOrder(kollege, { title: `Für den Lehrstuhl ${stamp}`, organisationId: lehrstuhl })
    const privat = await placeOrder(kollege, { title: `Privat ${stamp}` })
    const own = await placeOrder(chef, { title: `Eigener ${stamp}` })

    const seen = (await listRequests(chef, { search: String(stamp) })).rows.map((r) => r.id)
    expect(seen).toContain(forOrg.id)
    expect(seen).toContain(own.id)
    expect(seen).not.toContain(privat.id)
    const filtered = (await listRequests(chef, { organisationId: lehrstuhl })).rows.map((r) => r.id)
    expect(filtered).toEqual([forOrg.id])
    // Fremde Verwalter und einfache Mitglieder sehen nichts davon.
    expect((await listRequests(fremd, { search: String(stamp) })).rows).toEqual([])
    expect((await listRequests(neu, { search: String(stamp) })).rows).toEqual([])
    await expect(getRequestDetail(fremd, forOrg.id)).rejects.toThrow('Auftrag nicht gefunden')

    const detail = await getRequestDetail(chef, forOrg.id)
    expect(detail.canAct).toBe(false)
    expect(detail.canEdit).toBe(false)
    expect(detail.transitions).toEqual([])
    expect((await getRequestDetail(kollege, forOrg.id)).canAct).toBe(true)
    await expect(getRequestDetail(chef, privat.id)).rejects.toThrow('Auftrag nicht gefunden')
    await markRequestRead(chef, { id: forOrg.id, at: new Date() })

    await expect(changeStatus(chef, { id: forOrg.id, version: 1, to: 'cancelled' })).rejects.toThrow('Auftrag nicht gefunden')
    await expect(addComment(chef, { id: forOrg.id, body: 'Hallo', internal: false, attachmentIds: [] })).rejects.toThrow(
      'Auftrag nicht gefunden',
    )

    const [file] = detail.files
    expect(await fileForDownload(chef, file!.id)).not.toBeNull()
    expect(await fileForDownload(fremd, file!.id)).toBeNull()
    expect(await fileForDownload(neu, file!.id)).toBeNull()

    // Eine deaktivierte Organisation verwaltet niemand mehr.
    await getDb().update(schema.organisations).set({ status: 'disabled' }).where(eq(schema.organisations.id, lehrstuhl))
    try {
      await expect(getRequestDetail(chef, forOrg.id)).rejects.toThrow('Auftrag nicht gefunden')
      expect(await fileForDownload(chef, file!.id)).toBeNull()
    } finally {
      await getDb().update(schema.organisations).set({ status: 'active' }).where(eq(schema.organisations.id, lehrstuhl))
    }
  })

  it('lässt immer mindestens einen Verwalter übrig', async () => {
    await expect(orgAdmin.removeMember(chef, { organisationId: lehrstuhl, userId: chef.id })).rejects.toThrow(
      'mindestens einen Verwalter',
    )
    await expect(orgAdmin.setMemberAdmin(chef, { organisationId: lehrstuhl, userId: chef.id, isAdmin: false })).rejects.toThrow(
      'mindestens einen Verwalter',
    )
    await orgAdmin.setMemberAdmin(chef, { organisationId: lehrstuhl, userId: kollege.id, isAdmin: true })
    await orgAdmin.setMemberAdmin(kollege, { organisationId: lehrstuhl, userId: chef.id, isAdmin: false })
    expect(await isMember(lehrstuhl, chef.id)).toMatchObject({ isAdmin: false })
    await expect(orgAdmin.getManagedOrganisation(chef, lehrstuhl)).rejects.toThrow('Keine Berechtigung')

    await orgAdmin.removeMember(kollege, { organisationId: lehrstuhl, userId: neu.id })
    expect(await isMember(lehrstuhl, neu.id)).toBeNull()
    await orgAdmin.leaveOrganisation(chef, lehrstuhl)
    expect(await isMember(lehrstuhl, chef.id)).toBeNull()
    const entries = await getDb()
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.organisationId, lehrstuhl))
    const actions = new Set(entries.map((e) => e.action))
    for (const action of [
      'organisation.invite_created',
      'organisation.invite_revoked',
      'organisation.member_joined',
      'organisation.member_removed',
      'organisation.admin_changed',
    ]) {
      expect(actions).toContain(action)
    }
  })

  it('pflegt Stammdaten und Kostenstelle, den Namen nicht', async () => {
    await orgAdmin.updateOrganisationDetails(fremd, {
      organisationId: anderer,
      email: 'sekretariat@lehrstuhl.test',
      phone: '',
      street: 'Arcisstraße 21',
      zip: '80333',
      city: 'München',
      country: 'de',
      vatId: '',
      costCenter: '4711-ABC',
    })
    const [row] = await getDb().select().from(schema.organisations).where(eq(schema.organisations.id, anderer))
    expect(row).toMatchObject({ costCenter: '4711-ABC', country: 'DE', city: 'München', name: `Anderer ${stamp}` })
  })

  it('erhält Verwalter, wenn die Druckerei Mitgliedschaften ändert', async () => {
    const extra = await getDb()
      .insert(schema.organisations)
      .values({ name: `Dritter ${stamp}`, status: 'active' })
      .returning()
    await getDb().transaction((tx) => setMemberships(tx, fremd.id, [anderer, extra[0]!.id]))
    expect(await isMember(anderer, fremd.id)).toMatchObject({ isAdmin: true })
    expect(await isMember(extra[0]!.id, fremd.id)).toMatchObject({ isAdmin: false })
    await getDb().transaction((tx) => setMemberships(tx, fremd.id, [anderer]))
    expect(await isMember(extra[0]!.id, fremd.id)).toBeNull()
    expect(await isMember(anderer, fremd.id)).toMatchObject({ isAdmin: true })

    // Die Druckerei ernennt Verwalter, auch ohne dass es schon einen gibt.
    await expect(
      setOrganisationAdmin(admin, { organisationId: extra[0]!.id, userId: kollege.id, isAdmin: true }),
    ).rejects.toThrow('kein Mitglied')
    await member(extra[0]!.id, kollege.id)
    await setOrganisationAdmin(admin, { organisationId: extra[0]!.id, userId: kollege.id, isAdmin: true })
    expect(await isMember(extra[0]!.id, kollege.id)).toMatchObject({ isAdmin: true })
  })
})
