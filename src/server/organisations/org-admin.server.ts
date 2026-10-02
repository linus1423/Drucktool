// Kunden verwalten ihre Organisation selbst (Issue #12): Verwalter laden Kollegen per Link ein, entfernen Mitglieder,
// pflegen Stammdaten und Kostenstelle und sehen alle Aufträge der Organisation. Jede Funktion prüft selbst, ob der
// Aufrufer Verwalter genau dieser, aktiven Organisation ist.
import { createHash, randomBytes } from 'node:crypto'
import { and, asc, count, eq, gt, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { organisationDetailsSchema } from '~/lib/validation'
import { writeAudit } from '../audit/audit.server'
import { getDb, schema, type Tx } from '../db/client.server'
import type { Principal } from '../requests/requests.server'

const { users, organisations, organisationMembers, organisationInvites } = schema

type Db = ReturnType<typeof getDb> | Tx

export const INVITE_VALID_DAYS = 14
export const MAX_OPEN_INVITES = 20

const NO_PERMISSION = 'Keine Berechtigung'
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** Organisationen, die der Benutzer verwaltet (nur aktive), als Abfrage für Unterabfragen. */
export function managedOrganisationIds(db: Db, userId: string, organisationId?: string) {
  return db
    .select({ id: organisationMembers.organisationId })
    .from(organisationMembers)
    .innerJoin(organisations, eq(organisations.id, organisationMembers.organisationId))
    .where(
      and(
        eq(organisationMembers.userId, userId),
        eq(organisationMembers.isAdmin, true),
        eq(organisations.status, 'active'),
        organisationId ? eq(organisationMembers.organisationId, organisationId) : undefined,
      ),
    )
}

/** Name und ID der verwalteten Organisationen, etwa für den Filter der Auftragsliste. */
export async function listManagedOrganisations(user: Principal) {
  if (user.role !== 'customer') return []
  return getDb()
    .select({ id: organisations.id, name: organisations.name })
    .from(organisationMembers)
    .innerJoin(organisations, eq(organisations.id, organisationMembers.organisationId))
    .where(
      and(eq(organisationMembers.userId, user.id), eq(organisationMembers.isAdmin, true), eq(organisations.status, 'active')),
    )
    .orderBy(asc(organisations.name))
}

async function assertOrgAdmin(db: Db, user: Principal, organisationId: string) {
  if (user.role !== 'customer') throw new Error(NO_PERMISSION)
  const [row] = await managedOrganisationIds(db, user.id, organisationId)
  if (!row) throw new Error(NO_PERMISSION)
}

/** Verwaltungsansicht: Stammdaten, Mitglieder und offene Einladungen. */
export async function getManagedOrganisation(user: Principal, organisationId: string) {
  const db = getDb()
  await assertOrgAdmin(db, user, organisationId)
  const [org] = await db
    .select({
      id: organisations.id,
      name: organisations.name,
      email: organisations.email,
      phone: organisations.phone,
      street: organisations.street,
      zip: organisations.zip,
      city: organisations.city,
      country: organisations.country,
      vatId: organisations.vatId,
      costCenter: organisations.costCenter,
      updatedAt: organisations.updatedAt,
    })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
  const members = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      isAdmin: organisationMembers.isAdmin,
      since: organisationMembers.createdAt,
    })
    .from(organisationMembers)
    .innerJoin(users, eq(users.id, organisationMembers.userId))
    .where(eq(organisationMembers.organisationId, organisationId))
    .orderBy(asc(users.name))
  const creator = schema.users
  const invites = await db
    .select({
      id: organisationInvites.id,
      createdAt: organisationInvites.createdAt,
      expiresAt: organisationInvites.expiresAt,
      createdByName: creator.name,
    })
    .from(organisationInvites)
    .leftJoin(creator, eq(creator.id, organisationInvites.createdById))
    .where(openInvites(organisationId))
    .orderBy(asc(organisationInvites.createdAt))
  return { ...org!, members, invites, me: user.id }
}

function openInvites(organisationId: string) {
  return and(
    eq(organisationInvites.organisationId, organisationId),
    isNull(organisationInvites.usedAt),
    gt(organisationInvites.expiresAt, new Date()),
  )
}

/** Neuer Einladungslink. Das Token kommt nur hier einmal zurück, gespeichert wird der Hash. */
export async function createInvite(user: Principal, organisationId: string) {
  return getDb().transaction(async (tx) => {
    await assertOrgAdmin(tx, user, organisationId)
    // Sperre auf die Organisation, damit parallele Aufrufe das Limit nicht umgehen.
    await tx.select({ id: organisations.id }).from(organisations).where(eq(organisations.id, organisationId)).for('update')
    const [open] = await tx.select({ n: count() }).from(organisationInvites).where(openInvites(organisationId))
    if ((open?.n ?? 0) >= MAX_OPEN_INVITES) {
      throw new Error('Es gibt schon viele offene Einladungen. Bitte widerrufen Sie zuerst nicht benötigte.')
    }
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + INVITE_VALID_DAYS * 24 * 60 * 60 * 1000)
    const [invite] = await tx
      .insert(organisationInvites)
      .values({ organisationId, tokenHash: hashToken(token), createdById: user.id, expiresAt })
      .returning({ id: organisationInvites.id })
    await writeAudit(tx, {
      actorId: user.id,
      action: 'organisation.invite_created',
      targetType: 'organisation',
      targetId: organisationId,
      organisationId,
      data: { inviteId: invite!.id },
    })
    return { token, expiresAt }
  })
}

export async function revokeInvite(user: Principal, input: { organisationId: string; inviteId: string }) {
  return getDb().transaction(async (tx) => {
    await assertOrgAdmin(tx, user, input.organisationId)
    const rows = await tx
      .delete(organisationInvites)
      .where(
        and(
          eq(organisationInvites.id, input.inviteId),
          eq(organisationInvites.organisationId, input.organisationId),
          isNull(organisationInvites.usedAt),
        ),
      )
      .returning({ id: organisationInvites.id })
    if (!rows.length) throw new Error('Die Einladung wurde bereits verwendet oder widerrufen.')
    await writeAudit(tx, {
      actorId: user.id,
      action: 'organisation.invite_revoked',
      targetType: 'organisation',
      targetId: input.organisationId,
      organisationId: input.organisationId,
      data: { inviteId: input.inviteId },
    })
  })
}

const INVALID_INVITE = 'Diese Einladung ist ungültig, abgelaufen oder wurde schon verwendet.'

async function findInvite(db: Db, token: string, lock = false) {
  const query = db
    .select({ invite: organisationInvites, organisationName: organisations.name, organisationStatus: organisations.status })
    .from(organisationInvites)
    .innerJoin(organisations, eq(organisations.id, organisationInvites.organisationId))
    .where(eq(organisationInvites.tokenHash, hashToken(token)))
  const [row] = lock ? await query.for('update', { of: organisationInvites }) : await query
  if (!row || row.invite.usedAt || row.invite.expiresAt <= new Date() || row.organisationStatus !== 'active') return null
  return row
}

/** Für die Einladungsseite: Name der Organisation und ob der Benutzer schon Mitglied ist. */
export async function describeInvite(user: Principal, token: string) {
  const db = getDb()
  const row = await findInvite(db, token)
  if (!row) return { valid: false as const, message: INVALID_INVITE }
  const [member] = await db
    .select({ userId: organisationMembers.userId })
    .from(organisationMembers)
    .where(and(eq(organisationMembers.organisationId, row.invite.organisationId), eq(organisationMembers.userId, user.id)))
  return {
    valid: true as const,
    organisationId: row.invite.organisationId,
    organisationName: row.organisationName,
    alreadyMember: !!member,
    canJoin: user.role === 'customer',
  }
}

/** Nimmt eine Einladung an. Nur Kunden; der Link ist danach verbraucht. */
export async function acceptInvite(user: Principal, token: string) {
  if (user.role !== 'customer') throw new Error('Mitarbeiter der Druckerei können keiner Kunden-Organisation beitreten.')
  return getDb().transaction(async (tx) => {
    const row = await findInvite(tx, token, true)
    if (!row) throw new Error(INVALID_INVITE)
    const organisationId = row.invite.organisationId
    await tx.insert(organisationMembers).values({ userId: user.id, organisationId }).onConflictDoNothing()
    await tx
      .update(organisationInvites)
      .set({ usedAt: new Date(), usedById: user.id })
      .where(eq(organisationInvites.id, row.invite.id))
    await writeAudit(tx, {
      actorId: user.id,
      action: 'organisation.member_joined',
      targetType: 'organisation',
      targetId: organisationId,
      organisationId,
      data: { inviteId: row.invite.id },
    })
    return { organisationId, organisationName: row.organisationName }
  })
}

async function adminCount(tx: Tx, organisationId: string) {
  const [row] = await tx
    .select({ n: count() })
    .from(organisationMembers)
    .where(and(eq(organisationMembers.organisationId, organisationId), eq(organisationMembers.isAdmin, true)))
  return row?.n ?? 0
}

async function lockMember(tx: Tx, organisationId: string, userId: string) {
  // Alle Mitgliedschaften der Organisation sperren, damit „mindestens ein Verwalter“ auch parallel hält.
  const rows = await tx
    .select({ userId: organisationMembers.userId, isAdmin: organisationMembers.isAdmin })
    .from(organisationMembers)
    .where(eq(organisationMembers.organisationId, organisationId))
    .for('update')
  const member = rows.find((r) => r.userId === userId)
  if (!member) throw new Error('Diese Person ist kein Mitglied der Organisation.')
  return member
}

const LAST_ADMIN = 'Die Organisation braucht mindestens einen Verwalter. Bitte ernennen Sie zuerst jemand anderen.'

export const memberActionSchema = z.object({ organisationId: z.uuid(), userId: z.uuid() })

/** Entfernt ein Mitglied. Eigene Aufträge des Mitglieds bleiben bestehen und der Organisation zugeordnet. */
export async function removeMember(user: Principal, input: z.infer<typeof memberActionSchema>) {
  return getDb().transaction(async (tx) => {
    await assertOrgAdmin(tx, user, input.organisationId)
    const member = await lockMember(tx, input.organisationId, input.userId)
    if (member.isAdmin && (await adminCount(tx, input.organisationId)) <= 1) throw new Error(LAST_ADMIN)
    await tx
      .delete(organisationMembers)
      .where(and(eq(organisationMembers.organisationId, input.organisationId), eq(organisationMembers.userId, input.userId)))
    await writeAudit(tx, {
      actorId: user.id,
      action: 'organisation.member_removed',
      targetType: 'user',
      targetId: input.userId,
      organisationId: input.organisationId,
    })
  })
}

export const setMemberAdminSchema = memberActionSchema.extend({ isAdmin: z.boolean() })

export async function setMemberAdmin(user: Principal, input: z.infer<typeof setMemberAdminSchema>) {
  return getDb().transaction(async (tx) => {
    await assertOrgAdmin(tx, user, input.organisationId)
    const member = await lockMember(tx, input.organisationId, input.userId)
    if (member.isAdmin === input.isAdmin) return
    if (!input.isAdmin && (await adminCount(tx, input.organisationId)) <= 1) throw new Error(LAST_ADMIN)
    await setAdminFlag(tx, input.organisationId, input.userId, input.isAdmin)
    await writeAudit(tx, {
      actorId: user.id,
      action: 'organisation.admin_changed',
      targetType: 'user',
      targetId: input.userId,
      organisationId: input.organisationId,
      before: { isAdmin: member.isAdmin },
      after: { isAdmin: input.isAdmin },
    })
  })
}

export async function setAdminFlag(tx: Tx, organisationId: string, userId: string, isAdmin: boolean) {
  await tx
    .update(organisationMembers)
    .set({ isAdmin })
    .where(and(eq(organisationMembers.organisationId, organisationId), eq(organisationMembers.userId, userId)))
}

/** Mitglied verlässt die Organisation selbst. Der letzte Verwalter muss die Aufgabe vorher abgeben. */
export async function leaveOrganisation(user: Principal, organisationId: string) {
  return getDb().transaction(async (tx) => {
    const member = await lockMember(tx, organisationId, user.id)
    if (member.isAdmin && (await adminCount(tx, organisationId)) <= 1) {
      const [others] = await tx
        .select({ n: count() })
        .from(organisationMembers)
        .where(eq(organisationMembers.organisationId, organisationId))
      if ((others?.n ?? 0) > 1) throw new Error(LAST_ADMIN)
    }
    await tx
      .delete(organisationMembers)
      .where(and(eq(organisationMembers.organisationId, organisationId), eq(organisationMembers.userId, user.id)))
    await writeAudit(tx, {
      actorId: user.id,
      action: 'organisation.member_removed',
      targetType: 'user',
      targetId: user.id,
      organisationId,
      data: { left: true },
    })
  })
}

export const organisationDetailsInputSchema = organisationDetailsSchema.extend({ organisationId: z.uuid() })

const DETAIL_FIELDS = ['email', 'phone', 'street', 'zip', 'city', 'country', 'vatId', 'costCenter'] as const

/** Stammdaten pflegen. Den Namen ändert weiterhin nur die Druckerei. */
export async function updateOrganisationDetails(user: Principal, input: z.infer<typeof organisationDetailsInputSchema>) {
  return getDb().transaction(async (tx) => {
    await assertOrgAdmin(tx, user, input.organisationId)
    const [before] = await tx.select().from(organisations).where(eq(organisations.id, input.organisationId)).for('update')
    const values = {
      email: input.email || null,
      phone: input.phone || null,
      street: input.street || null,
      zip: input.zip || null,
      city: input.city || null,
      country: input.country.toUpperCase(),
      vatId: input.vatId || null,
      costCenter: input.costCenter || null,
    }
    await tx
      .update(organisations)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(organisations.id, input.organisationId))
    await writeAudit(tx, {
      actorId: user.id,
      action: 'organisation.updated',
      targetType: 'organisation',
      targetId: input.organisationId,
      organisationId: input.organisationId,
      before: Object.fromEntries(DETAIL_FIELDS.map((k) => [k, before?.[k] ?? null])),
      after: values,
      data: { byOrganisationAdmin: true },
    })
  })
}
