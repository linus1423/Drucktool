import { createHash } from 'node:crypto'
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import { CONFLICT_MESSAGE } from '~/lib/errors'
import { isStaffRole } from '~/lib/roles'
import {
  INTERNAL_STATUSES,
  OPEN_STATUSES,
  REQUEST_STATUSES,
  allowedTransitions,
  canTransition,
  hasInternalStatus,
  type RequestStatus,
} from '~/lib/status'
import { deliveryAddressSchema } from '~/lib/address'
import { MAX_COVER_PAGES, orderSpecSchema } from '~/lib/order'
import { calculatePrice } from '~/lib/pricing'
import { buildSnapshot } from '~/lib/snapshot'
import { getCatalog } from '../catalog/catalog.server'
import { claimFiles, listRequestFiles } from '../files/files.server'
import { getDb, schema, type Tx } from '../db/client.server'
import { notifyAssigned, notifyComment, notifyRequestCreated, notifyStatusChanged } from '../mail/notifications.server'

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
  throw new Error('Auftrag nicht gefunden')
}

/** Kunden sehen nur ihre eigenen Aufträge (Lastenheft: Organisationen sind optional). */
function visibilityFilter(user: Principal): SQL | undefined {
  if (isStaffRole(user.role)) return undefined
  return eq(requests.createdById, user.id)
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
async function updateWithVersion(tx: Tx, id: string, expectedVersion: number, values: Partial<typeof requests.$inferInsert>) {
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
  done: z.boolean().optional(),
  assignedToMe: z.boolean().optional(),
  search: z.string().trim().max(200).optional(),
})

export async function listRequests(user: Principal, filter: z.infer<typeof listFilterSchema>) {
  const assignee = alias(users, 'assignee')
  const creator = alias(users, 'creator')
  const conditions: (SQL | undefined)[] = [visibilityFilter(user)]
  if (filter.status) conditions.push(eq(requests.status, filter.status))
  if (filter.open) conditions.push(inArray(requests.status, OPEN_STATUSES))
  if (filter.done) conditions.push(eq(requests.status, 'completed'))
  if (filter.assignedToMe) conditions.push(eq(requests.assigneeId, user.id))
  if (filter.search) {
    const term = `%${filter.search.replace(/[%_\\]/g, '\\$&')}%`
    const asNumber = Number.parseInt(filter.search.replace(/^#/, ''), 10)
    conditions.push(
      or(
        ilike(requests.title, term),
        ilike(organisations.name, term),
        ilike(creator.name, term),
        ilike(creator.email, term),
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
      internalStatus: isStaffRole(user.role) ? requests.internalStatus : sql<null>`null`,
      quantity: requests.quantity,
      totalCents: requests.totalCents,
      deliveryMethod: requests.deliveryMethod,
      createdAt: requests.createdAt,
      updatedAt: requests.updatedAt,
      organisationName: organisations.name,
      creatorName: creator.name,
      assigneeName: assignee.name,
    })
    .from(requests)
    .leftJoin(organisations, eq(organisations.id, requests.organisationId))
    .innerJoin(creator, eq(creator.id, requests.createdById))
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
  const confirmer = alias(users, 'confirmer')

  const [found] = await db
    .select({
      request: requests,
      organisationName: organisations.name,
      creatorName: creator.name,
      creatorEmail: creator.email,
      assigneeName: assignee.name,
      confirmedByName: confirmer.name,
    })
    .from(requests)
    .leftJoin(organisations, eq(organisations.id, requests.organisationId))
    .innerJoin(creator, eq(creator.id, requests.createdById))
    .leftJoin(assignee, eq(assignee.id, requests.assigneeId))
    .leftJoin(confirmer, eq(confirmer.id, requests.confirmedById))
    .where(and(eq(requests.id, id), visibilityFilter(user)))
    .limit(1)
  if (!found) throw new Error('Auftrag nicht gefunden')

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
  const files = await listRequestFiles(id)
  return {
    ...r,
    // Kunden sehen nur Druck- und Lieferkosten, nicht den internen Rechenweg (Lastenheft Schritt 7).
    order: r.order && !isStaff ? { ...r.order, price: { ...r.order.price, lines: [] }, pricing: null } : r.order,
    files,
    organisationName: found.organisationName,
    creatorName: found.creatorName,
    creatorEmail: isStaff ? found.creatorEmail : null,
    // Die Zuständigkeit ist eine interne Information.
    assigneeId: isStaff ? r.assigneeId : null,
    assigneeName: isStaff ? found.assigneeName : null,
    internalStatus: isStaff ? r.internalStatus : null,
    confirmedByName: found.confirmedByName,
    comments,
    events,
    transitions: allowedTransitions(r.status, actorOf(user)),
    canEdit: canEditRequest(user, r.status),
  }
}

function canEditRequest(user: Principal, status: RequestStatus) {
  if (isStaffRole(user.role)) return OPEN_STATUSES.includes(status)
  return status === 'submitted' || status === 'on_hold'
}

export const createRequestSchema = z.object({
  title: z.string().trim().min(1, 'Titel ist erforderlich').max(200, 'Der Titel ist zu lang'),
  notes: z.string().trim().max(10_000, 'Die Bemerkungen sind zu lang'),
  spec: orderSpecSchema,
  mainFileId: z.uuid('Bitte die Druckdatei hochladen'),
  coverFileId: z.uuid().nullable(),
  deliveryAddress: deliveryAddressSchema.nullable(),
  acceptTerms: z.literal(true, 'Bitte stimmen Sie den Auftragsbedingungen zu.'),
  /** Der Preis, den der Kunde gesehen hat. Weicht der Server ab, wird nicht abgeschickt. */
  expectedTotalCents: z.number().int().min(0),
  organisationId: z.uuid().optional(),
})

export const PRICE_CHANGED_MESSAGE =
  'Der Preis hat sich inzwischen geändert. Bitte prüfen Sie den neuen Preis und senden Sie den Auftrag erneut ab.'

export function termsVersion(terms: string) {
  return createHash('sha256').update(terms).digest('hex').slice(0, 12)
}

/** Verbindliches Absenden aus dem Wizard (Lastenheft Schritt 8). */
export async function createRequest(user: Principal, input: z.infer<typeof createRequestSchema>) {
  return getDb().transaction(async (tx) => {
    const [me] = await tx
      .select({ billingAddress: users.billingAddress, organisationId: users.organisationId })
      .from(users)
      .where(eq(users.id, user.id))
    // Lastenheft 3.1: Die Rechnungsadresse muss vor dem ersten Auftrag hinterlegt sein.
    if (!isStaffRole(user.role) && !me?.billingAddress) {
      throw new Error('Bitte hinterlegen Sie zuerst eine Rechnungsadresse in Ihrem Profil.')
    }
    const organisationId = isStaffRole(user.role) ? (input.organisationId ?? null) : (me?.organisationId ?? null)
    if (organisationId) {
      const [org] = await tx
        .select({ status: organisations.status })
        .from(organisations)
        .where(eq(organisations.id, organisationId))
      if (!org || org.status !== 'active') throw new Error('Die Organisation ist nicht aktiv')
    }

    const { spec } = input
    if (spec.delivery === 'house_post' && !input.deliveryAddress) {
      throw new Error('Bitte die Lieferadresse für die Hauspost angeben.')
    }
    if (!!spec.coverPaperId !== !!input.coverFileId) {
      throw new Error(spec.coverPaperId ? 'Bitte die Datei für das Deckblatt hochladen.' : 'Ein Deckblatt ist nicht ausgewählt.')
    }

    // Preis mit dem aktuellen Katalog neu berechnen; der Browser-Wert ist nur die Vorschau.
    const catalog = await getCatalog({ onlyAvailable: true }, tx)
    const priced = calculatePrice(catalog, spec)
    if (!priced.ok) throw new Error(priced.errors.join(' '))
    if (priced.price.totalCents !== input.expectedTotalCents) throw new Error(PRICE_CHANGED_MESSAGE)

    const [created] = await tx
      .insert(requests)
      .values({
        organisationId,
        createdById: user.id,
        billingAddress: me?.billingAddress ?? null,
        title: input.title,
        description: input.notes,
        quantity: spec.copies,
        order: buildSnapshot(spec, priced.price, priced.order, catalog.pricing),
        totalCents: priced.price.totalCents,
        deliveryMethod: spec.delivery,
        deliveryAddress: spec.delivery === 'house_post' ? input.deliveryAddress : null,
        termsAcceptedAt: new Date(),
        termsVersion: termsVersion(catalog.texts.terms),
      })
      .returning({ id: requests.id, number: requests.number })

    const files = await claimFiles(tx, user, created!.id, { main: input.mainFileId, cover: input.coverFileId })
    // Lesbare PDFs geben die Seitenzahl vor; nur bei unlesbaren Dateien zählt die Angabe des Kunden.
    if (files.main.pageCount != null && files.main.pageCount !== spec.pages) {
      throw new Error(`Die Seitenzahl passt nicht zur Datei (${files.main.pageCount} Seiten).`)
    }
    if (files.cover?.pageCount != null && files.cover.pageCount !== spec.coverPages) {
      throw new Error(
        files.cover.pageCount > MAX_COVER_PAGES
          ? `Die Deckblatt-Datei darf höchstens ${MAX_COVER_PAGES} Seiten haben (vorne und hinten).`
          : `Die Seitenzahl passt nicht zur Deckblatt-Datei (${files.cover.pageCount} Seiten).`,
      )
    }

    await tx.insert(requestEvents).values({ requestId: created!.id, actorId: user.id, type: 'created', toStatus: 'submitted' })
    await notifyRequestCreated(tx, user, created!.id)
    return created!
  })
}

export const updateRequestSchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  title: z.string().trim().min(1, 'Titel ist erforderlich').max(200, 'Der Titel ist zu lang'),
  notes: z.string().trim().max(10_000, 'Die Bemerkungen sind zu lang'),
})

/** Titel und Bemerkungen. Optionen und Preis ändern Mitarbeiter gesondert (Issue #50). */
export async function updateRequest(user: Principal, input: z.infer<typeof updateRequestSchema>) {
  return getDb().transaction(async (tx) => {
    const current = await loadForUpdate(tx, user, input.id)
    if (!canEditRequest(user, current.status)) {
      throw new Error('Der Auftrag kann in diesem Status nicht mehr bearbeitet werden')
    }
    const values = { title: input.title, description: input.notes }
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
    if (input.to === 'on_hold' && !input.note) throw new Error('Bitte die Rückfrage an den Kunden formulieren')

    const values: Partial<typeof requests.$inferInsert> = { status: input.to }
    // Der interne Unterstatus gilt nur, solange der Auftrag bestätigt ist.
    if (!hasInternalStatus(input.to)) values.internalStatus = null
    if (input.to === 'confirmed' && !current.confirmedAt) {
      values.confirmedById = user.id
      values.confirmedAt = new Date()
    }

    const updated = await updateWithVersion(tx, input.id, input.version, values)
    await tx.insert(requestEvents).values({
      requestId: input.id,
      actorId: user.id,
      type: 'status_changed',
      fromStatus: current.status,
      toStatus: input.to,
    })
    if (input.note) {
      await tx.insert(requestComments).values({ requestId: input.id, authorId: user.id, body: input.note })
    }
    await notifyStatusChanged(tx, user, { requestId: input.id, from: current.status, to: input.to, note: input.note })
    return { version: updated.version, status: updated.status }
  })
}

export const internalStatusSchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  internalStatus: z.enum(INTERNAL_STATUSES).nullable(),
})

/** Interner Unterstatus ("In Bearbeitung", "Problem"). Kunden sehen ihn nie und bekommen keine Mail. */
export async function setInternalStatus(user: Principal, input: z.infer<typeof internalStatusSchema>) {
  if (!isStaffRole(user.role)) throw new Error('Keine Berechtigung')
  return getDb().transaction(async (tx) => {
    const current = await loadForUpdate(tx, user, input.id)
    if (current.version !== input.version) throw new Error(CONFLICT_MESSAGE)
    if (!hasInternalStatus(current.status)) {
      throw new Error('Einen internen Status gibt es nur bei bestätigten Aufträgen')
    }
    const updated = await updateWithVersion(tx, input.id, input.version, { internalStatus: input.internalStatus })
    if (current.internalStatus !== input.internalStatus) {
      await tx.insert(requestEvents).values({
        requestId: input.id,
        actorId: user.id,
        type: 'internal_status_changed',
        internal: true,
        data: { from: current.internalStatus, to: input.internalStatus },
      })
    }
    return { version: updated.version }
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
          and(eq(users.id, input.assigneeId), eq(users.status, 'active'), inArray(users.role, ['staff', 'admin', 'superadmin'])),
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
    await notifyAssigned(tx, user, { requestId: input.id, assigneeId: input.assigneeId })
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
    await notifyComment(tx, user, { requestId: input.id, body: input.body, internal })
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
