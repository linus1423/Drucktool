import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

// Die Module lesen DATABASE_URL beim ersten Zugriff, deshalb dynamisch importieren.
const { getDb, schema } = await import('~/server/db/client.server')
const orgs = await import('~/server/organisations/organisations.server')
const { createUser, getOrganisation, listOrganisations, listUsers, updateUser } = await import('~/server/admin/admin.server')
type Principal = import('~/server/requests/requests.server').Principal

describe.skipIf(!url)('Organisationen und Organisationsanfragen (Issue #68)', () => {
  const stamp = Date.now()
  const email = (name: string) => `${name}-${stamp}@org.test`
  let staff: Principal
  let admin: Principal
  let customer: Principal

  async function user(name: string, role: Principal['role']): Promise<Principal> {
    const [u] = await getDb()
      .insert(schema.users)
      .values({ email: email(name), lastName: name, role, status: 'active' })
      .returning()
    return { id: u!.id, role }
  }

  async function mailsTo(address: string) {
    return getDb().select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, address))
  }

  async function membershipsOf(userId: string) {
    return (await orgs.listMemberships(getDb(), userId)).map((m) => m.name)
  }

  beforeAll(async () => {
    // Nur die Benutzer dieses Tests sollen Mails bekommen.
    await getDb().update(schema.users).set({ emailNotifications: false })
    staff = await user('staff', 'staff')
    admin = await user('admin', 'admin')
    customer = await user('kunde', 'customer')
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  it('lässt Admins Kunden keiner, einer oder mehreren Organisationen zuordnen', async () => {
    const [a, b] = await getDb()
      .insert(schema.organisations)
      .values([
        { name: `Lehrstuhl A ${stamp}`, status: 'active' },
        { name: `Lehrstuhl B ${stamp}`, status: 'active' },
      ])
      .returning()
    const created = await createUser(admin, {
      firstName: '',
      lastName: 'Mehrfach',
      email: email('mehrfach'),
      role: 'customer',
      organisationIds: [a!.id, b!.id],
      password: '',
    })
    expect(await membershipsOf(created.id)).toEqual([a!.name, b!.name])
    const row = (await listUsers()).find((u) => u.id === created.id)!
    expect(row.organisationNames).toBe(`${a!.name}, ${b!.name}`)
    expect((await getOrganisation(a!.id)).members.map((m) => m.id)).toEqual([created.id])
    expect((await listOrganisations()).find((o) => o.id === b!.id)?.memberCount).toBe(1)

    const base = {
      id: created.id,
      firstName: '',
      lastName: 'Mehrfach',
      email: email('mehrfach'),
      status: 'active' as const,
      password: '',
    }
    await updateUser(admin, { ...base, role: 'customer', organisationIds: [b!.id] })
    expect(await membershipsOf(created.id)).toEqual([b!.name])
    await updateUser(admin, { ...base, role: 'customer', organisationIds: [] })
    expect(await membershipsOf(created.id)).toEqual([])
    // Auch Mitarbeiter können einer Organisation angehören (Issue #164).
    await updateUser(admin, { ...base, role: 'staff', organisationIds: [a!.id] })
    expect(await membershipsOf(created.id)).toEqual([a!.name])
  })

  it('ordnet einen Kunden nach seiner Anfrage einer bestehenden Organisation zu', async () => {
    const [existing] = await getDb()
      .insert(schema.organisations)
      .values({ name: `Bestand ${stamp}`, status: 'active' })
      .returning()
    const { id } = await orgs.requestOrganisation(customer, { name: 'Bestand', details: 'Raum 12' })
    // Die Mitarbeiter erfahren davon per Mail.
    const toStaff = await mailsTo(email('staff'))
    expect(toStaff.map((m) => m.subject)).toContain('Organisation angefragt: Bestand')
    expect(toStaff.find((m) => m.subject.includes('Bestand'))?.text).toContain('> Raum 12')
    expect((await orgs.listOpenOrganisationRequests()).map((r) => r.id)).toContain(id)

    await orgs.resolveOrganisationRequest(staff, { id, action: 'assign', organisationId: existing!.id })
    expect(await membershipsOf(customer.id)).toContain(existing!.name)
    expect((await orgs.listOpenOrganisationRequests()).map((r) => r.id)).not.toContain(id)
    const [mine] = await orgs.listMyOrganisationRequests(customer.id)
    expect(mine).toMatchObject({ id, status: 'approved', organisationName: existing!.name })
    expect((await mailsTo(email('kunde'))).map((m) => m.subject)).toContain(`Organisation zugeordnet: ${existing!.name}`)
    await expect(orgs.resolveOrganisationRequest(staff, { id, action: 'reject', note: '' })).rejects.toThrow('bereits bearbeitet')

    const [audit] = await getDb()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'organisation_request.approved'), eq(schema.auditLog.targetId, customer.id)))
    expect(audit).toMatchObject({ actorId: staff.id, organisationId: existing!.id })
  })

  it('legt aus einer Anfrage eine neue Organisation an', async () => {
    const { id } = await orgs.requestOrganisation(customer, { name: 'Fachschaft', details: '' })
    const { organisationId } = await orgs.resolveOrganisationRequest(staff, {
      id,
      action: 'create',
      name: `Fachschaft Maschinenbau ${stamp}`,
    })
    const [created] = await getDb().select().from(schema.organisations).where(eq(schema.organisations.id, organisationId!))
    expect(created).toMatchObject({ name: `Fachschaft Maschinenbau ${stamp}`, status: 'active' })
    // Der Kunde gehört jetzt mehreren Organisationen an.
    expect(await membershipsOf(customer.id)).toEqual([`Bestand ${stamp}`, `Fachschaft Maschinenbau ${stamp}`])
    expect(await orgs.isActiveMember(getDb(), customer.id, organisationId!)).toBe(true)
  })

  it('fragt alle Stammdaten ab und schlägt die naheliegendste Organisation vor (Issue #176)', async () => {
    const [existing] = await getDb()
      .insert(schema.organisations)
      .values({ name: `Lehrstuhl für Drucktechnik ${stamp}`, costCenter: `KS-${stamp}`, status: 'active' })
      .returning()
    const { id } = await orgs.requestOrganisation(customer, {
      name: `Lehrstuhl fuer Drucktechnik ${stamp}`,
      email: 'sekretariat@druck.test',
      phone: '089 123',
      street: 'Boltzmannstraße 15',
      zip: '85748',
      city: 'Garching',
      country: 'de',
      vatId: '',
      costCenter: `KS-${stamp}`,
      details: 'Ansprechpartnerin Frau Muster',
    })
    const [stored] = await getDb().select().from(schema.organisationRequests).where(eq(schema.organisationRequests.id, id))
    expect(stored).toMatchObject({ street: 'Boltzmannstraße 15', zip: '85748', country: 'DE', vatId: null })
    const mail = (await mailsTo(email('staff'))).find((m) => m.subject.includes('Lehrstuhl fuer Drucktechnik'))
    expect(mail?.text).toContain('Boltzmannstraße 15, 85748 Garching')
    expect(mail?.text).toContain(`Kostenstelle: KS-${stamp}`)

    const open = (await orgs.listOpenOrganisationRequests()).find((r) => r.id === id)
    expect(open).toMatchObject({ city: 'Garching', costCenter: `KS-${stamp}` })
    expect(open?.suggestions[0]).toMatchObject({ id: existing!.id, score: 1 })

    // Beim Anlegen werden die korrigierten Stammdaten übernommen.
    const { organisationId } = await orgs.resolveOrganisationRequest(staff, {
      id,
      action: 'create',
      name: `Lehrstuhl für Drucktechnik Garching ${stamp}`,
      email: 'sekretariat@druck.test',
      phone: '089 123',
      street: 'Boltzmannstraße 15',
      zip: '85748',
      city: 'Garching',
      country: 'DE',
      vatId: '',
      costCenter: `KS-${stamp}`,
    })
    const [created] = await getDb().select().from(schema.organisations).where(eq(schema.organisations.id, organisationId!))
    expect(created).toMatchObject({
      city: 'Garching',
      zip: '85748',
      email: 'sekretariat@druck.test',
      vatId: null,
      status: 'active',
    })
  })

  it('lehnt Anfragen mit Begründung ab', async () => {
    const before = await membershipsOf(customer.id)
    const { id } = await orgs.requestOrganisation(customer, { name: 'Unbekannt', details: '' })
    await orgs.resolveOrganisationRequest(staff, { id, action: 'reject', note: 'Bitte die Kostenstelle angeben.' })
    expect(await membershipsOf(customer.id)).toEqual(before)
    const mail = (await mailsTo(email('kunde'))).find((m) => m.subject === 'Ihre Anfrage zu einer Organisation')
    expect(mail?.text).toContain('> Bitte die Kostenstelle angeben.')
  })

  it('begrenzt offene Anfragen und erlaubt das Zurückziehen', async () => {
    const other = await user('viel', 'customer')
    const ids = []
    for (let i = 0; i < orgs.MAX_OPEN_ORGANISATION_REQUESTS; i++) {
      ids.push((await orgs.requestOrganisation(other, { name: `Org ${i}`, details: '' })).id)
    }
    await expect(orgs.requestOrganisation(other, { name: 'Zu viel', details: '' })).rejects.toThrow('mehrere offene')
    // Fremde Anfragen lassen sich nicht zurückziehen.
    await expect(orgs.withdrawOrganisationRequest(customer, ids[0]!)).rejects.toThrow('bereits bearbeitet')
    await orgs.withdrawOrganisationRequest(other, ids[0]!)
    await expect(orgs.requestOrganisation(other, { name: 'Jetzt geht es', details: '' })).resolves.toHaveProperty('id')
  })

  it('lässt nur Mitarbeiter über Anfragen entscheiden', async () => {
    const { id } = await orgs.requestOrganisation(customer, { name: 'Y', details: '' })
    await expect(orgs.resolveOrganisationRequest(customer, { id, action: 'reject', note: '' })).rejects.toThrow(
      'Keine Berechtigung',
    )
    const [disabled] = await getDb()
      .insert(schema.organisations)
      .values({ name: `Inaktiv ${stamp}`, status: 'disabled' })
      .returning()
    await expect(orgs.resolveOrganisationRequest(staff, { id, action: 'assign', organisationId: disabled!.id })).rejects.toThrow(
      'nicht aktiv',
    )
  })
})
