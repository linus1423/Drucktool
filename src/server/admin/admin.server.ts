import { and, asc, count, eq, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { USER_ROLES, USER_STATUSES, type UserRole } from '~/lib/roles'
import { emailSchema, organisationSchema, passwordSchema } from '~/lib/validation'
import { getDb, schema, type Tx } from '../db/client.server'
import { hashPassword } from '../auth/password.server'
import { notifyRegistrationDecision } from '../mail/notifications.server'
import { auditSnapshot, writeAudit } from '../audit/audit.server'
import type { Principal } from '../requests/requests.server'

const { users, organisations, requests, sessions } = schema

// Felder, die im Audit-Log festgehalten werden (keine Passwörter oder Hashes).
const USER_AUDIT_FIELDS = ['name', 'email', 'role', 'status', 'organisationId'] as const
const ORG_AUDIT_FIELDS = ['name', 'email', 'phone', 'street', 'zip', 'city', 'country', 'vatId', 'status'] as const

// ---------------------------------------------------------------------------
// Freigabe von Registrierungen (nur Superadmin)
// ---------------------------------------------------------------------------

export async function listPendingRegistrations() {
  return getDb()
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      createdAt: users.createdAt,
      organisationId: organisations.id,
      organisationName: organisations.name,
      organisationStatus: organisations.status,
      street: organisations.street,
      zip: organisations.zip,
      city: organisations.city,
      phone: organisations.phone,
    })
    .from(users)
    .leftJoin(organisations, eq(organisations.id, users.organisationId))
    .where(eq(users.status, 'pending'))
    .orderBy(asc(users.createdAt))
}

export const approveSchema = z.object({
  userId: z.uuid(),
  // Optional: Benutzer einer bestehenden Organisation zuordnen statt die neue freizugeben.
  existingOrganisationId: z.uuid().nullable(),
})

export async function approveRegistration(actor: Principal, input: z.infer<typeof approveSchema>) {
  await getDb().transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, input.userId), eq(users.status, 'pending')))
      .for('update')
    if (!user) throw new Error('Die Registrierung wurde bereits bearbeitet')

    let organisationId = user.organisationId
    if (input.existingOrganisationId) {
      const [target] = await tx
        .select({ id: organisations.id })
        .from(organisations)
        .where(and(eq(organisations.id, input.existingOrganisationId), eq(organisations.status, 'active')))
      if (!target) throw new Error('Die gewählte Organisation ist nicht aktiv')
      organisationId = target.id
    }
    await tx
      .update(users)
      .set({ status: 'active', organisationId, reviewedById: actor.id, reviewedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id))
    await writeAudit(tx, {
      actorId: actor.id,
      action: 'registration.approved',
      targetType: 'user',
      targetId: user.id,
      organisationId,
      before: auditSnapshot(user, USER_AUDIT_FIELDS),
      after: auditSnapshot({ ...user, status: 'active', organisationId }, USER_AUDIT_FIELDS),
      data: input.existingOrganisationId ? { existingOrganisation: true } : {},
    })

    if (user.organisationId && user.organisationId !== organisationId) {
      await deleteOrganisationIfUnused(tx, user.organisationId)
    } else if (organisationId) {
      await tx
        .update(organisations)
        .set({ status: 'active', updatedAt: new Date() })
        .where(and(eq(organisations.id, organisationId), eq(organisations.status, 'pending')))
    }
    await notifyRegistrationDecision(tx, user, true)
  })
}

export async function rejectRegistration(actor: Principal, userId: string) {
  await getDb().transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, userId), eq(users.status, 'pending')))
      .for('update')
    if (!user) throw new Error('Die Registrierung wurde bereits bearbeitet')
    await tx
      .update(users)
      .set({ status: 'rejected', reviewedById: actor.id, reviewedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id))
    await writeAudit(tx, {
      actorId: actor.id,
      action: 'registration.rejected',
      targetType: 'user',
      targetId: user.id,
      organisationId: user.organisationId,
      before: auditSnapshot(user, USER_AUDIT_FIELDS),
      after: auditSnapshot({ ...user, status: 'rejected' }, USER_AUDIT_FIELDS),
    })
    if (user.organisationId) {
      await tx
        .update(organisations)
        .set({ status: 'disabled', updatedAt: new Date() })
        .where(and(eq(organisations.id, user.organisationId), eq(organisations.status, 'pending')))
    }
    await notifyRegistrationDecision(tx, user, false)
  })
}

async function deleteOrganisationIfUnused(tx: Tx, organisationId: string) {
  const [org] = await tx
    .select({ status: organisations.status })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
  if (org?.status !== 'pending') return
  const [members] = await tx.select({ n: count() }).from(users).where(eq(users.organisationId, organisationId))
  const [reqs] = await tx.select({ n: count() }).from(requests).where(eq(requests.organisationId, organisationId))
  if ((members?.n ?? 0) === 0 && (reqs?.n ?? 0) === 0) {
    await tx.delete(organisations).where(eq(organisations.id, organisationId))
  }
}

// ---------------------------------------------------------------------------
// Organisationen (Admin)
// ---------------------------------------------------------------------------

export async function listOrganisations() {
  const memberCount = getDb()
    .select({ organisationId: users.organisationId, n: count().as('member_count') })
    .from(users)
    .groupBy(users.organisationId)
    .as('member_counts')
  const requestCount = getDb()
    .select({ organisationId: requests.organisationId, n: count().as('request_count') })
    .from(requests)
    .groupBy(requests.organisationId)
    .as('request_counts')

  return getDb()
    .select({
      id: organisations.id,
      name: organisations.name,
      email: organisations.email,
      city: organisations.city,
      status: organisations.status,
      createdAt: organisations.createdAt,
      memberCount: sql<number>`coalesce(${memberCount.n}, 0)::int`,
      requestCount: sql<number>`coalesce(${requestCount.n}, 0)::int`,
    })
    .from(organisations)
    .leftJoin(memberCount, eq(memberCount.organisationId, organisations.id))
    .leftJoin(requestCount, eq(requestCount.organisationId, organisations.id))
    .orderBy(asc(organisations.name))
}

export async function listActiveOrganisations() {
  return getDb()
    .select({ id: organisations.id, name: organisations.name })
    .from(organisations)
    .where(eq(organisations.status, 'active'))
    .orderBy(asc(organisations.name))
}

export async function getOrganisation(id: string) {
  const db = getDb()
  const [org] = await db.select().from(organisations).where(eq(organisations.id, id))
  if (!org) throw new Error('Organisation nicht gefunden')
  const members = await db
    .select({ id: users.id, name: users.name, email: users.email, status: users.status })
    .from(users)
    .where(eq(users.organisationId, id))
    .orderBy(asc(users.name))
  return { ...org, members }
}

export const saveOrganisationSchema = organisationSchema.extend({ id: z.uuid().optional() })

export async function saveOrganisation(actor: Principal, input: z.infer<typeof saveOrganisationSchema>) {
  const values = {
    name: input.name,
    email: input.email || null,
    phone: input.phone || null,
    street: input.street || null,
    zip: input.zip || null,
    city: input.city || null,
    country: input.country.toUpperCase(),
    vatId: input.vatId || null,
    status: input.status,
  }
  return getDb().transaction(async (tx) => {
    if (input.id) {
      const [before] = await tx.select().from(organisations).where(eq(organisations.id, input.id)).for('update')
      if (!before) throw new Error('Organisation nicht gefunden')
      const [row] = await tx
        .update(organisations)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(organisations.id, input.id))
        .returning()
      if (input.status === 'disabled') {
        // Mitglieder einer deaktivierten Organisation werden abgemeldet.
        await tx.execute(
          sql`delete from ${sessions} where ${sessions.userId} in (select ${users.id} from ${users} where ${users.organisationId} = ${input.id})`,
        )
      }
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'organisation.updated',
        targetType: 'organisation',
        targetId: input.id,
        organisationId: input.id,
        before: auditSnapshot(before, ORG_AUDIT_FIELDS),
        after: auditSnapshot(row, ORG_AUDIT_FIELDS),
      })
      return { id: row!.id }
    }
    const [row] = await tx.insert(organisations).values(values).returning()
    await writeAudit(tx, {
      actorId: actor.id,
      action: 'organisation.created',
      targetType: 'organisation',
      targetId: row!.id,
      organisationId: row!.id,
      after: auditSnapshot(row, ORG_AUDIT_FIELDS),
    })
    return { id: row!.id }
  })
}

// ---------------------------------------------------------------------------
// Benutzer (Admin)
// ---------------------------------------------------------------------------

export async function listUsers() {
  return getDb()
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      status: users.status,
      organisationId: users.organisationId,
      organisationName: organisations.name,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(organisations, eq(organisations.id, users.organisationId))
    .orderBy(asc(users.name))
}

/** Nur ein Superadmin darf Admins und Superadmins anlegen oder verändern. */
function assertMayManageRole(actor: Principal, role: UserRole) {
  if ((role === 'admin' || role === 'superadmin') && actor.role !== 'superadmin') {
    throw new Error('Nur ein Superadmin darf Administratoren verwalten')
  }
}

const userFields = {
  name: z.string().trim().min(1, 'Name ist erforderlich').max(200),
  email: emailSchema,
  role: z.enum(USER_ROLES),
  organisationId: z.uuid().nullable(),
}

// Ohne Passwort meldet sich die Person per Anmeldelink oder Single Sign-on an.
export const createUserSchema = z.object({ ...userFields, password: z.union([z.literal(''), passwordSchema]) })

export async function createUser(actor: Principal, input: z.infer<typeof createUserSchema>) {
  assertMayManageRole(actor, input.role)
  const organisationId = input.role === 'customer' ? input.organisationId : null
  const passwordHash = input.password ? await hashPassword(input.password) : null
  return getDb().transaction(async (tx) => {
    const [taken] = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${input.email}`)
    if (taken) throw new Error('Diese E-Mail-Adresse ist bereits vergeben')
    const [row] = await tx
      .insert(users)
      .values({
        name: input.name,
        email: input.email,
        role: input.role,
        organisationId,
        passwordHash,
        status: 'active',
        reviewedById: actor.id,
        reviewedAt: new Date(),
      })
      .returning()
    await writeAudit(tx, {
      actorId: actor.id,
      action: 'user.created',
      targetType: 'user',
      targetId: row!.id,
      organisationId,
      after: auditSnapshot(row, USER_AUDIT_FIELDS),
      data: { passwordSet: !!passwordHash },
    })
    return { id: row!.id }
  })
}

export const updateUserSchema = z.object({
  id: z.uuid(),
  ...userFields,
  status: z.enum(USER_STATUSES),
  password: z.union([z.literal(''), passwordSchema]),
})

export async function updateUser(actor: Principal, input: z.infer<typeof updateUserSchema>) {
  const passwordHash = input.password ? await hashPassword(input.password) : null
  await getDb().transaction(async (tx) => {
    const [current] = await tx.select().from(users).where(eq(users.id, input.id)).for('update')
    if (!current) throw new Error('Benutzer nicht gefunden')
    assertMayManageRole(actor, current.role)
    assertMayManageRole(actor, input.role)
    // Registrierungen gibt nur der Superadmin frei, auch nicht auf dem Umweg über die Benutzerverwaltung.
    if (current.status === 'pending' && input.status !== 'pending' && actor.role !== 'superadmin') {
      throw new Error('Registrierungen kann nur ein Superadmin freigeben')
    }
    if (current.id === actor.id && (input.role !== current.role || input.status !== current.status)) {
      throw new Error('Sie können Ihre eigene Rolle und Ihren Status nicht ändern')
    }
    if (current.role === 'superadmin' && (input.role !== 'superadmin' || input.status !== 'active')) {
      const [others] = await tx
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.role, 'superadmin'), eq(users.status, 'active'), ne(users.id, current.id)))
      if ((others?.n ?? 0) === 0) throw new Error('Der letzte aktive Superadmin kann nicht entfernt werden')
    }
    const organisationId = input.role === 'customer' ? input.organisationId : null

    if (input.email !== current.email.toLowerCase()) {
      const [taken] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(sql`lower(${users.email}) = ${input.email}`, ne(users.id, current.id)))
      if (taken) throw new Error('Diese E-Mail-Adresse ist bereits vergeben')
    }

    const [updated] = await tx
      .update(users)
      .set({
        name: input.name,
        email: input.email,
        role: input.role,
        status: input.status,
        organisationId,
        ...(passwordHash ? { passwordHash } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, current.id))
      .returning()

    // Bei geänderten Rechten oder Passwort alte Sitzungen beenden.
    const privilegesChanged =
      input.role !== current.role || input.status !== current.status || organisationId !== current.organisationId
    const sessionsRevoked = (privilegesChanged || !!passwordHash) && current.id !== actor.id
    if (sessionsRevoked) {
      await tx.delete(sessions).where(eq(sessions.userId, current.id))
    }
    await writeAudit(tx, {
      actorId: actor.id,
      action: 'user.updated',
      targetType: 'user',
      targetId: current.id,
      organisationId: organisationId ?? current.organisationId,
      before: auditSnapshot(current, USER_AUDIT_FIELDS),
      after: auditSnapshot(updated, USER_AUDIT_FIELDS),
      // Nur, dass ein Passwort gesetzt wurde, nie das Passwort selbst.
      data: { passwordChanged: !!passwordHash, sessionsRevoked },
    })
  })
}
