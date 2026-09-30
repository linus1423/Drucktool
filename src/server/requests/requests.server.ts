import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import { CONFLICT_MESSAGE } from '~/lib/errors'
import { isStaffRole } from '~/lib/roles'
import { REQUEST_STATUSES, allowedTransitions, canTransition, TERMINAL_STATUSES, type RequestStatus } from '~/lib/status'
import { requestInputSchema } from '~/lib/validation'
import { getDb, schema, type Tx } from '../db/client.server'

/** Minimale Sicht auf den handelnden Benutzer, unabhängig von der HTTP-Session. */
export type Principal = {
  id: string
  role: 'superadmin' | 'admin' | 'staff' | 'customer'
  organisationId: string | null
}

const { requests, requestComments, requestEvents, users, organisations } = schema

function actorOf(user: Principal) {
  return isStaffRole(user.role) ? ('staff' as const) : ('customer' as const)
}

function notFound(): never {
  throw new Error('Anfrage nicht gefunden')
}

/** Filter, der Kunden auf die Anfragen ihrer eigenen Organisation beschränkt. */
function visibilityFilter(user: Principal): SQL | undefined {
  if (isStaffRole(user.role)) return undefined
  if (!user.organisationId) return sql`false`
  return eq(requests.organisationId, user.organisationId)
}

async function loadForUpdate(tx: Tx, user: Principal, id: string) {
  const [row] = await tx
    .select()
    .from(requests)
    .where(and(eq(requests.id, id), visibilityFilter(user)))
    .limit(1)
  return row ?? notFound()
}

/**
 * Schreibt eine Änderung nur, wenn die Version noch der erwarteten entspricht
 * (Optimistic Locking). Sonst hat jemand anderes die Anfrage inzwischen geändert.
 */
async function updateWithVersion(
  tx: Tx,
  id: string,
  expectedVersion: number,
  values: Partial<typeof requests.$inferInsert>,
) {
  const rows = await tx
    .update(requests)
    .set({ ...values, version: sql`${requests.version} + 1`, updatedAt: new Date() })
    .where(and(eq(requests.id, id), eq(requests.version, expectedVersion)))
    .returning()
  if (rows.length === 0) throw new Error(CONFLICT_MESSAGE)
  return rows[0]!
}

export const listFilterSchema = z.object({
  status: z.enum(REQUEST_STATUSES).optional(),
  open: z.boolean().optional(),
  assignedToMe: z.boolean().optional(),
  search: z.string().trim().max(200).optional(),
})

export async function listRequests(user: Principal, filter: z.infer<typeof listFilterSchema>) {
  const assignee = alias(users, 'assignee')
  const conditions: (SQL | undefined)[] = [visibilityFilter(user)]
  if (filter.status) conditions.push(eq(requests.status, filter.status))
  if (filter.open) {
    conditions.push(sql`${requests.status} not in ('completed', 'rejected', 'cancelled')`)
  }
  if (filter.assignedToMe) conditions.push(eq(requests.assigneeId, user.id))
  if (filter.search) {
    const term = `%${filter.search.replace(/[%_\\]/g, '\\$&')}%`
    const asNumber = Number.parseInt(filter.search.replace(/^#/, ''), 10)
    conditions.push(
      or(
        ilike(requests.title, term),
        ilike(organisations.name, term),
        Number.isFinite(asNumber) ? eq(requests.number, asNumber) : undefined,
      ),
    )
  }

  return getDb()
    .select({
      id: requests.id,
      number: requests.number,
      title: requests.title,
      status: requests.status,
      quantity: requests.quantity,
      desiredDate: requests.desiredDate,
      createdAt: requests.createdAt,
      updatedAt: requests.updatedAt,
      organisationName: organisations.name,
      assigneeName: assignee.name,
    })
    .from(requests)
    .innerJoin(organisations, eq(organisations.id, requests.organisationId))
    .leftJoin(assignee, eq(assignee.id, requests.assigneeId))
    .where(and(...conditions))
    .orderBy(desc(requests.updatedAt))
    .limit(500)
}

export async function getRequestDetail(user: Principal, id: string) {
  const db = getDb()
  const isStaff = isStaffRole(user.role)
  const creator = alias(users, 'creator')
  const assignee = alias(users, 'assignee')

  const [found] = await db
    .select({
      request: requests,
      organisationName: organisations.name,
      creatorName: creator.name,
      assigneeName: assignee.name,
    })
    .from(requests)
    .innerJoin(organisations, eq(organisations.id, requests.organisationId))
    .innerJoin(creator, eq(creator.id, requests.createdById))
    .leftJoin(assignee, eq(assignee.id, requests.assigneeId))
    .where(and(eq(requests.id, id), visibilityFilter(user)))
    .limit(1)
  if (!found) throw new Error('Anfrage nicht gefunden')

  const comments = await db
    .select({
      id: requestComments.id,
      body: requestComments.body,
      internal: requestComments.internal,
      createdAt: requestComments.createdAt,
      authorName: users.name,
      authorIsStaff: sql<boolean>`${users.role} <> 'customer'`,
    })
    .from(requestComments)
    .innerJoin(users, eq(users.id, requestComments.authorId))
    .where(and(eq(requestComments.requestId, id), isStaff ? undefined : eq(requestComments.internal, false)))
    .orderBy(asc(requestComments.createdAt))

  const events = await db
    .select({
      id: requestEvents.id,
      type: requestEvents.type,
      fromStatus: requestEvents.fromStatus,
      toStatus: requestEvents.toStatus,
      data: requestEvents.data,
      createdAt: requestEvents.createdAt,
      actorName: users.name,
    })
    .from(requestEvents)
    .leftJoin(users, eq(users.id, requestEvents.actorId))
    .where(and(eq(requestEvents.requestId, id), isStaff ? undefined : eq(requestEvents.internal, false)))
    .orderBy(asc(requestEvents.createdAt))

  const r = found.request
  return {
    ...r,
    organisationName: found.organisationName,
    creatorName: found.creatorName,
    // Die Zuständigkeit ist eine interne Information.
    assigneeId: isStaff ? r.assigneeId : null,
    assigneeName: isStaff ? found.assigneeName : null,
    comments,
    events,
    transitions: allowedTransitions(r.status, actorOf(user)),
    canEdit: canEditRequest(user, r.status),
  }
}

function canEditRequest(user: Principal, status: RequestStatus) {
  if (isStaffRole(user.role)) return !TERMINAL_STATUSES.has(status)
  return status === 'new' || status === 'on_hold'
}

export const createRequestSchema = requestInputSchema.extend({
  organisationId: z.uuid().optional(),
})

export async function createRequest(user: Principal, input: z.infer<typeof createRequestSchema>) {
  let organisationId: string
  if (isStaffRole(user.role)) {
    if (!input.organisationId) throw new Error('Bitte eine Organisation auswählen')
    organisationId = input.organisationId
  } else {
    if (!user.organisationId) throw new Error('Ihr Konto ist keiner Organisation zugeordnet')
    organisationId = user.organisationId
  }

  return getDb().transaction(async (tx) => {
    const [org] = await tx
      .select({ status: organisations.status })
      .from(organisations)
      .where(eq(organisations.id, organisationId))
    if (!org || org.status !== 'active') throw new Error('Die Organisation ist nicht aktiv')

    const [created] = await tx
      .insert(requests)
      .values({
        organisationId,
        createdById: user.id,
        title: input.title,
        description: input.description,
        quantity: input.quantity,
        desiredDate: input.desiredDate,
      })
      .returning({ id: requests.id, number: requests.number })
    await tx.insert(requestEvents).values({ requestId: created!.id, actorId: user.id, type: 'created', toStatus: 'new' })
    return created!
  })
}

export const updateRequestSchema = requestInputSchema.extend({
  id: z.uuid(),
  version: z.number().int().positive(),
})

export async function updateRequest(user: Principal, input: z.infer<typeof updateRequestSchema>) {
  return getDb().transaction(async (tx) => {
    const current = await loadForUpdate(tx, user, input.id)
    if (!canEditRequest(user, current.status)) {
      throw new Error('Die Anfrage kann in diesem Status nicht mehr bearbeitet werden')
    }
    const values = {
      title: input.title,
      description: input.description,
      quantity: input.quantity,
      desiredDate: input.desiredDate,
    }
    const changed = (Object.keys(values) as (keyof typeof values)[]).filter((k) => values[k] !== current[k])
    const updated = await updateWithVersion(tx, input.id, input.version, values)
    if (changed.length > 0) {
      await tx.insert(requestEvents).values({
        requestId: input.id,
        actorId: user.id,
        type: 'updated',
        data: { fields: changed },
      })
    }
    return { version: updated.version }
  })
}

export const changeStatusSchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  to: z.enum(REQUEST_STATUSES),
  note: z.string().trim().max(5000).optional(),
  quoteAmountCents: z.number().int().nonnegative().max(1_000_000_000).optional(),
})

export async function changeStatus(user: Principal, input: z.infer<typeof changeStatusSchema>) {
  return getDb().transaction(async (tx) => {
    const current = await loadForUpdate(tx, user, input.id)
    // Die Version wird vor der Übergangsprüfung verglichen: Wer eine veraltete
    // Ansicht hat, bekommt einen Konflikt statt einer irreführenden Fehlermeldung.
    if (current.version !== input.version) throw new Error(CONFLICT_MESSAGE)
    if (!canTransition(current.status, input.to, actorOf(user))) {
      throw new Error('Dieser Statuswechsel ist nicht erlaubt')
    }

    const values: Partial<typeof requests.$inferInsert> = { status: input.to }
    if (input.to === 'quoted') {
      if (input.quoteAmountCents === undefined) throw new Error('Bitte einen Angebotspreis angeben')
      values.quoteAmountCents = input.quoteAmountCents
      values.quoteNote = input.note || null
    }

    const updated = await updateWithVersion(tx, input.id, input.version, values)
    await tx.insert(requestEvents).values({
      requestId: input.id,
      actorId: user.id,
      type: 'status_changed',
      fromStatus: current.status,
      toStatus: input.to,
      data: input.to === 'quoted' ? { quoteAmountCents: input.quoteAmountCents ?? null } : {},
    })
    if (input.note && input.to !== 'quoted') {
      await tx.insert(requestComments).values({ requestId: input.id, authorId: user.id, body: input.note })
    }
    return { version: updated.version, status: updated.status }
  })
}

export const assignSchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  assigneeId: z.uuid().nullable(),
})

export async function assignRequest(user: Principal, input: z.infer<typeof assignSchema>) {
  if (!isStaffRole(user.role)) throw new Error('Keine Berechtigung')
  return getDb().transaction(async (tx) => {
    const current = await loadForUpdate(tx, user, input.id)
    let assigneeName: string | null = null
    if (input.assigneeId) {
      const [assignee] = await tx
        .select({ name: users.name })
        .from(users)
        .where(
          and(
            eq(users.id, input.assigneeId),
            eq(users.status, 'active'),
            inArray(users.role, ['staff', 'admin', 'superadmin']),
          ),
        )
      if (!assignee) throw new Error('Mitarbeiter nicht gefunden')
      assigneeName = assignee.name
    }
    const updated = await updateWithVersion(tx, input.id, input.version, { assigneeId: input.assigneeId })
    if (current.assigneeId !== input.assigneeId) {
      await tx.insert(requestEvents).values({
        requestId: input.id,
        actorId: user.id,
        type: 'assigned',
        internal: true,
        data: { assigneeId: input.assigneeId, assigneeName },
      })
    }
    return { version: updated.version }
  })
}

export const addCommentSchema = z.object({
  id: z.uuid(),
  body: z.string().trim().min(1, 'Bitte einen Kommentar eingeben').max(10_000),
  internal: z.boolean().default(false),
})

export async function addComment(user: Principal, input: z.infer<typeof addCommentSchema>) {
  const internal = isStaffRole(user.role) ? input.internal : false
  return getDb().transaction(async (tx) => {
    // Kommentare hängen nur an, deshalb ohne Versionsprüfung; die Sichtbarkeit wird trotzdem geprüft.
    await loadForUpdate(tx, user, input.id)
    const [comment] = await tx
      .insert(requestComments)
      .values({ requestId: input.id, authorId: user.id, body: input.body, internal })
      .returning({ id: requestComments.id })
    await tx.update(requests).set({ updatedAt: new Date() }).where(eq(requests.id, input.id))
    return comment!
  })
}

export async function listAssignableStaff() {
  return getDb()
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.status, 'active'), inArray(users.role, ['staff', 'admin', 'superadmin'])))
    .orderBy(asc(users.name))
}
