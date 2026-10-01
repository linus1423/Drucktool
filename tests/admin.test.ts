import { afterAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

const { getDb, schema } = await import('~/server/db/client.server')
const { approveRegistration, rejectRegistration, updateUser } = await import('~/server/admin/admin.server')
type Principal = import('~/server/requests/requests.server').Principal

async function pendingRegistration(name: string) {
  const db = getDb()
  const [org] = await db.insert(schema.organisations).values({ name: `${name} GmbH`, status: 'pending' }).returning()
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${name}-${Date.now()}@test`, name, role: 'customer', status: 'pending' })
    .returning()
  await db.insert(schema.organisationMembers).values({ userId: user!.id, organisationId: org!.id })
  return { org: org!, user: user! }
}

async function principal(role: Principal['role']): Promise<Principal> {
  const [u] = await getDb()
    .insert(schema.users)
    .values({ email: `${role}-${Date.now()}-${Math.random()}@test`, name: role, role, status: 'active' })
    .returning()
  return { id: u!.id, role }
}

describe.skipIf(!url)('Freigabe von Registrierungen (Integration)', () => {
  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  it('aktiviert Benutzer und neue Organisation', async () => {
    const superadmin = await principal('superadmin')
    const { org, user } = await pendingRegistration('Anna')
    await approveRegistration(superadmin, { userId: user.id, existingOrganisationId: null })
    const [u] = await getDb().select().from(schema.users).where(eq(schema.users.id, user.id))
    const [o] = await getDb().select().from(schema.organisations).where(eq(schema.organisations.id, org.id))
    expect(u!.status).toBe('active')
    expect(u!.reviewedById).toBe(superadmin.id)
    expect(o!.status).toBe('active')
    await expect(approveRegistration(superadmin, { userId: user.id, existingOrganisationId: null })).rejects.toThrow(
      'bereits bearbeitet',
    )
  })

  it('ordnet einer bestehenden Organisation zu und verwirft die neue', async () => {
    const superadmin = await principal('superadmin')
    const [existing] = await getDb().insert(schema.organisations).values({ name: 'Bestand AG', status: 'active' }).returning()
    const { org, user } = await pendingRegistration('Ben')
    await approveRegistration(superadmin, { userId: user.id, existingOrganisationId: existing!.id })
    const members = await getDb()
      .select()
      .from(schema.organisationMembers)
      .where(eq(schema.organisationMembers.userId, user.id))
    expect(members.map((m) => m.organisationId)).toEqual([existing!.id])
    const leftover = await getDb().select().from(schema.organisations).where(eq(schema.organisations.id, org.id))
    expect(leftover).toHaveLength(0)
  })

  it('sperrt abgelehnte Registrierungen', async () => {
    const superadmin = await principal('superadmin')
    const { org, user } = await pendingRegistration('Carla')
    await rejectRegistration(superadmin, user.id)
    const [u] = await getDb().select().from(schema.users).where(eq(schema.users.id, user.id))
    const [o] = await getDb().select().from(schema.organisations).where(eq(schema.organisations.id, org.id))
    expect(u!.status).toBe('rejected')
    expect(o!.status).toBe('disabled')
  })

  it('lässt Admins Registrierungen nicht über die Benutzerverwaltung freigeben', async () => {
    const admin = await principal('admin')
    const { org, user } = await pendingRegistration('Dora')
    await expect(
      updateUser(admin, {
        id: user.id,
        name: user.name,
        email: user.email,
        role: 'customer',
        organisationIds: [org.id],
        status: 'active',
        password: '',
      }),
    ).rejects.toThrow('nur ein Superadmin')
  })

  it('lässt Admins keine Administratoren anlegen oder ändern', async () => {
    const admin = await principal('admin')
    const otherAdmin = await principal('admin')
    await expect(
      updateUser(admin, {
        id: otherAdmin.id,
        name: 'x',
        email: `x-${Date.now()}@test`,
        role: 'staff',
        organisationIds: [],
        status: 'active',
        password: '',
      }),
    ).rejects.toThrow('Nur ein Superadmin')
  })
})
