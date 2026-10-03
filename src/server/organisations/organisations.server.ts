// Zugehörigkeit von Kunden zu Organisationen und Organisationsanfragen.
// Organisationen sind optional; ein Kunde kann keiner, einer oder mehreren angehören.
import { and, asc, count, desc, eq, inArray, notInArray } from 'drizzle-orm'
import { z } from 'zod'
import { suggestOrganisations } from '~/lib/organisation-match'
import { organisationSchema } from '~/lib/validation'
import { writeAudit } from '../audit/audit.server'
import { getDb, schema, type Tx } from '../db/client.server'
import { notifyOrganisationRequestDecision, notifyOrganisationRequested } from '../mail/notifications.server'
import type { Principal } from '../requests/requests.server'

const { users, organisations, organisationMembers, organisationRequests } = schema

/** So viele offene Anfragen darf ein Kunde gleichzeitig haben. */
export const MAX_OPEN_ORGANISATION_REQUESTS = 3

type Db = ReturnType<typeof getDb> | Tx

/** Organisationen eines Benutzers; mit onlyActive nur die, für die er bestellen kann. */
export async function listMemberships(db: Db, userId: string, { onlyActive = false } = {}) {
  return db
    .select({
      id: organisations.id,
      name: organisations.name,
      status: organisations.status,
      isAdmin: organisationMembers.isAdmin,
      isSvk: organisations.isSvk,
    })
    .from(organisationMembers)
    .innerJoin(organisations, eq(organisations.id, organisationMembers.organisationId))
    .where(and(eq(organisationMembers.userId, userId), onlyActive ? eq(organisations.status, 'active') : undefined))
    .orderBy(asc(organisations.name))
}

/** Prüft, ob der Kunde für diese Organisation bestellen darf (Mitglied und Organisation aktiv). */
export async function isActiveMember(db: Db, userId: string, organisationId: string) {
  const [row] = await db
    .select({ id: organisations.id })
    .from(organisationMembers)
    .innerJoin(organisations, eq(organisations.id, organisationMembers.organisationId))
    .where(
      and(
        eq(organisationMembers.userId, userId),
        eq(organisationMembers.organisationId, organisationId),
        eq(organisations.status, 'active'),
      ),
    )
  return !!row
}

/** Ersetzt die Organisationen eines Benutzers durch die angegebenen. */
export async function setMemberships(tx: Tx, userId: string, organisationIds: string[]) {
  const ids = [...new Set(organisationIds)]
  if (ids.length > 0) {
    const found = await tx.select({ id: organisations.id }).from(organisations).where(inArray(organisations.id, ids))
    if (found.length !== ids.length) throw new Error('Organisation nicht gefunden')
  }
  // Nur Änderungen schreiben, damit bestehende Mitgliedschaften ihr Verwalter-Kennzeichen behalten.
  await tx
    .delete(organisationMembers)
    .where(
      and(
        eq(organisationMembers.userId, userId),
        ids.length > 0 ? notInArray(organisationMembers.organisationId, ids) : undefined,
      ),
    )
  if (ids.length > 0) {
    await tx
      .insert(organisationMembers)
      .values(ids.map((organisationId) => ({ userId, organisationId })))
      .onConflictDoNothing()
  }
}

async function addMembership(tx: Tx, userId: string, organisationId: string) {
  await tx.insert(organisationMembers).values({ userId, organisationId }).onConflictDoNothing()
}

// ---------------------------------------------------------------------------
// Anfragen durch Kunden
// ---------------------------------------------------------------------------

// Alle Stammdaten einer Organisation, damit die Druckerei sie ohne Rückfrage anlegen kann (Issue #176).
const organisationFieldsSchema = organisationSchema.omit({ status: true, isSvk: true }).partial().required({ name: true })

export const organisationRequestSchema = organisationFieldsSchema.extend({
  details: z.string().trim().max(2000, 'Die Angaben sind zu lang'),
})

/** Leere Felder als null speichern, wie bei den Organisationen selbst. */
function organisationFields(input: z.infer<typeof organisationFieldsSchema>) {
  const blank = (v: string | undefined) => v || null
  return {
    name: input.name,
    email: blank(input.email),
    phone: blank(input.phone),
    street: blank(input.street),
    zip: blank(input.zip),
    city: blank(input.city),
    country: (input.country || 'DE').toUpperCase(),
    vatId: blank(input.vatId),
    costCenter: blank(input.costCenter),
  }
}

export async function requestOrganisation(user: Principal, input: z.input<typeof organisationRequestSchema>) {
  const data = organisationRequestSchema.parse(input)
  return getDb().transaction(async (tx) => {
    // Sperre auf den Benutzer, damit parallele Anfragen das Limit nicht umgehen.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for('update')
    const [open] = await tx
      .select({ n: count() })
      .from(organisationRequests)
      .where(and(eq(organisationRequests.userId, user.id), eq(organisationRequests.status, 'open')))
    if ((open?.n ?? 0) >= MAX_OPEN_ORGANISATION_REQUESTS) {
      throw new Error('Sie haben bereits mehrere offene Anfragen. Bitte warten Sie, bis die Druckerei sie bearbeitet hat.')
    }
    const [row] = await tx
      .insert(organisationRequests)
      .values({ userId: user.id, ...organisationFields(data), details: data.details })
      .returning({ id: organisationRequests.id })
    await notifyOrganisationRequested(tx, user, { ...organisationFields(data), details: data.details })
    return row!
  })
}

/** Die letzten Anfragen eines Kunden für sein Profil. */
export async function listMyOrganisationRequests(userId: string) {
  return getDb()
    .select({
      id: organisationRequests.id,
      name: organisationRequests.name,
      status: organisationRequests.status,
      note: organisationRequests.note,
      organisationName: organisations.name,
      createdAt: organisationRequests.createdAt,
    })
    .from(organisationRequests)
    .leftJoin(organisations, eq(organisations.id, organisationRequests.organisationId))
    .where(eq(organisationRequests.userId, userId))
    .orderBy(desc(organisationRequests.createdAt))
    .limit(10)
}

/** Zieht eine eigene, noch offene Anfrage zurück. */
export async function withdrawOrganisationRequest(user: Principal, id: string) {
  const rows = await getDb()
    .delete(organisationRequests)
    .where(
      and(eq(organisationRequests.id, id), eq(organisationRequests.userId, user.id), eq(organisationRequests.status, 'open')),
    )
    .returning({ id: organisationRequests.id })
  if (rows.length === 0) throw new Error('Die Anfrage wurde bereits bearbeitet')
}

// ---------------------------------------------------------------------------
// Bearbeitung durch Mitarbeiter
// ---------------------------------------------------------------------------

export async function listOpenOrganisationRequests() {
  const [rows, active] = await Promise.all([
    getDb()
      .select({
        id: organisationRequests.id,
        name: organisationRequests.name,
        email: organisationRequests.email,
        phone: organisationRequests.phone,
        street: organisationRequests.street,
        zip: organisationRequests.zip,
        city: organisationRequests.city,
        country: organisationRequests.country,
        vatId: organisationRequests.vatId,
        costCenter: organisationRequests.costCenter,
        details: organisationRequests.details,
        createdAt: organisationRequests.createdAt,
        userId: users.id,
        userName: users.name,
        userEmail: users.email,
      })
      .from(organisationRequests)
      .innerJoin(users, eq(users.id, organisationRequests.userId))
      .where(eq(organisationRequests.status, 'open'))
      .orderBy(asc(organisationRequests.createdAt)),
    getDb()
      .select({
        id: organisations.id,
        name: organisations.name,
        email: organisations.email,
        street: organisations.street,
        zip: organisations.zip,
        city: organisations.city,
        vatId: organisations.vatId,
        costCenter: organisations.costCenter,
      })
      .from(organisations)
      .where(eq(organisations.status, 'active')),
  ])
  // Die naheliegendsten Organisationen für die Zuordnung (Issue #176).
  return rows.map((r) => ({ ...r, suggestions: suggestOrganisations(r, active) }))
}

export const resolveOrganisationRequestSchema = z.discriminatedUnion('action', [
  // Kunden einer bestehenden Organisation zuordnen.
  z.object({ id: z.uuid(), action: z.literal('assign'), organisationId: z.uuid() }),
  // Aus der Anfrage eine neue Organisation anlegen; die Angaben können noch korrigiert werden.
  organisationFieldsSchema.extend({
    id: z.uuid(),
    action: z.literal('create'),
    isSvk: z.boolean().optional(),
  }),
  z.object({ id: z.uuid(), action: z.literal('reject'), note: z.string().trim().max(2000) }),
])

export async function resolveOrganisationRequest(actor: Principal, input: z.infer<typeof resolveOrganisationRequestSchema>) {
  if (actor.role === 'customer') throw new Error('Keine Berechtigung')
  return getDb().transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(organisationRequests)
      .where(and(eq(organisationRequests.id, input.id), eq(organisationRequests.status, 'open')))
      .for('update')
    if (!request) throw new Error('Die Anfrage wurde bereits bearbeitet')
    const [customer] = await tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, request.userId))
    if (!customer) throw new Error('Benutzer nicht gefunden')

    const reviewed = { reviewedById: actor.id, reviewedAt: new Date() }
    if (input.action === 'reject') {
      await tx
        .update(organisationRequests)
        .set({ ...reviewed, status: 'rejected', note: input.note || null })
        .where(eq(organisationRequests.id, request.id))
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'organisation_request.rejected',
        targetType: 'user',
        targetId: request.userId,
        data: { requested: request.name },
      })
      await notifyOrganisationRequestDecision(tx, customer, { requested: request.name, organisation: null, note: input.note })
      return { organisationId: null }
    }

    let organisation: { id: string; name: string }
    if (input.action === 'assign') {
      const [target] = await tx
        .select({ id: organisations.id, name: organisations.name })
        .from(organisations)
        .where(and(eq(organisations.id, input.organisationId), eq(organisations.status, 'active')))
      if (!target) throw new Error('Die gewählte Organisation ist nicht aktiv')
      organisation = target
    } else {
      const [created] = await tx
        .insert(organisations)
        .values({ ...organisationFields(input), isSvk: input.isSvk ?? false, status: 'active' })
        .returning({ id: organisations.id, name: organisations.name, status: organisations.status })
      organisation = created!
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'organisation.created',
        targetType: 'organisation',
        targetId: created!.id,
        organisationId: created!.id,
        after: { name: created!.name, status: created!.status },
        data: { fromRequest: true },
      })
    }
    await addMembership(tx, request.userId, organisation.id)
    await tx
      .update(organisationRequests)
      .set({ ...reviewed, status: 'approved', organisationId: organisation.id })
      .where(eq(organisationRequests.id, request.id))
    await writeAudit(tx, {
      actorId: actor.id,
      action: 'organisation_request.approved',
      targetType: 'user',
      targetId: request.userId,
      organisationId: organisation.id,
      data: { requested: request.name, created: input.action === 'create' },
    })
    await notifyOrganisationRequestDecision(tx, customer, {
      requested: request.name,
      organisation: organisation.name,
      note: null,
    })
    return { organisationId: organisation.id }
  })
}
