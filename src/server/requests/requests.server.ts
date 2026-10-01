import { createHash } from 'node:crypto'
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import { CONFLICT_MESSAGE } from '~/lib/errors'
import { isStaffRole } from '~/lib/roles'
import {
  INTERNAL_STATUSES,
  OPEN_STATUSES,
  REQUEST_STATUSES,
  TERMINAL_STATUSES,
  allowedTransitions,
  canTransition,
  hasInternalStatus,
  type RequestStatus,
} from '~/lib/status'
import { deliveryAddressSchema } from '~/lib/address'
import { MAX_COVER_PAGES, orderSpecSchema } from '~/lib/order'
import { calculatePrice } from '~/lib/pricing'
import { buildSnapshot } from '~/lib/snapshot'
import { applyPriceOverride, type ChangeProposal } from '~/lib/proposal'
import { getCatalog } from '../catalog/catalog.server'
import { claimFiles, listRequestFiles } from '../files/files.server'
import { getDb, schema, type Tx } from '../db/client.server'
import {
  notifyAssigned,
  notifyChangeAnswered,
  notifyChangeProposed,
  notifyComment,
  notifyRequestCreated,
  notifyStatusChanged,
} from '../mail/notifications.server'

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

export const LIST_SORTS = ['number', 'title', 'customer', 'status', 'total', 'created', 'updated'] as const
export const PAGE_SIZES = [25, 50, 100] as const

export const listFilterSchema = z.object({
  status: z.enum(REQUEST_STATUSES).optional(),
  open: z.boolean().optional(),
  done: z.boolean().optional(),
  assignedToMe: z.boolean().optional(),
  search: z.string().trim().max(200).optional(),
  // Nur für Mitarbeiter wirksam
  organisationId: z.uuid().optional(),
  /** Mitarbeiter-ID oder "none" für nicht zugewiesene Aufträge. */
  assigneeId: z.union([z.uuid(), z.literal('none')]).optional(),
  /** Angelegt ab bzw. bis einschließlich (YYYY-MM-DD, deutsche Zeit). */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  sort: z.enum(LIST_SORTS).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  page: z.number().int().min(1).max(100_000).optional(),
  pageSize: z
    .number()
    .int()
    .refine((n) => (PAGE_SIZES as readonly number[]).includes(n))
    .optional(),
})

export type ListFilter = z.infer<typeof listFilterSchema>

const creatorAlias = alias(users, 'creator')
const assigneeAlias = alias(users, 'assignee')

function listConditions(user: Principal, filter: ListFilter) {
  const staff = isStaffRole(user.role)
  const conditions: (SQL | undefined)[] = [visibilityFilter(user)]
  if (filter.status) conditions.push(eq(requests.status, filter.status))
  if (filter.open) conditions.push(inArray(requests.status, OPEN_STATUSES))
  if (filter.done) conditions.push(eq(requests.status, 'completed'))
  if (filter.assignedToMe) conditions.push(eq(requests.assigneeId, user.id))
  if (staff && filter.organisationId) conditions.push(eq(requests.organisationId, filter.organisationId))
  if (staff && filter.assigneeId) {
    conditions.push(filter.assigneeId === 'none' ? isNull(requests.assigneeId) : eq(requests.assigneeId, filter.assigneeId))
  }
  // Tagesgrenzen in deutscher Zeit, damit "bis 31.10." den ganzen Tag einschließt.
  if (filter.from) conditions.push(sql`${requests.createdAt} >= (${filter.from}::date)::timestamp at time zone 'Europe/Berlin'`)
  if (filter.to) {
    conditions.push(sql`${requests.createdAt} < (${filter.to}::date + 1)::timestamp at time zone 'Europe/Berlin'`)
  }
  if (filter.search) {
    const term = `%${filter.search.replace(/[%_\\]/g, '\\$&')}%`
    const asNumber = Number.parseInt(filter.search.replace(/^#/, ''), 10)
    conditions.push(
      or(
        ilike(requests.title, term),
        ilike(organisations.name, term),
        ilike(creatorAlias.name, term),
        staff ? ilike(creatorAlias.email, term) : undefined,
        Number.isFinite(asNumber) ? eq(requests.number, asNumber) : undefined,
      ),
    )
  }
  return and(...conditions)
}

function listOrder(filter: ListFilter) {
  const column = {
    number: requests.number,
    title: requests.title,
    customer: creatorAlias.name,
    status: requests.status,
    total: requests.totalCents,
    created: requests.createdAt,
    updated: requests.updatedAt,
  }[filter.sort ?? 'updated']
  const dir = filter.dir ?? (filter.sort === 'title' || filter.sort === 'customer' ? 'asc' : 'desc')
  // Die Nummer als zweites Kriterium hält die Reihenfolge über Seiten hinweg stabil.
  return dir === 'asc'
    ? [sql`${column} asc nulls last`, asc(requests.number)]
    : [sql`${column} desc nulls last`, desc(requests.number)]
}

function listSelection(user: Principal) {
  const staff = isStaffRole(user.role)
  return {
    id: requests.id,
    number: requests.number,
    title: requests.title,
    status: requests.status,
    internalStatus: staff ? requests.internalStatus : sql<null>`null`,
    quantity: requests.quantity,
    totalCents: requests.totalCents,
    deliveryMethod: requests.deliveryMethod,
    createdAt: requests.createdAt,
    updatedAt: requests.updatedAt,
    organisationName: organisations.name,
    creatorName: creatorAlias.name,
    creatorEmail: staff ? creatorAlias.email : sql<null>`null`,
    assigneeName: staff ? assigneeAlias.name : sql<null>`null`,
  }
}

function listRowsQuery(user: Principal) {
  return getDb()
    .select(listSelection(user))
    .from(requests)
    .leftJoin(organisations, eq(organisations.id, requests.organisationId))
    .innerJoin(creatorAlias, eq(creatorAlias.id, requests.createdById))
    .leftJoin(assigneeAlias, eq(assigneeAlias.id, requests.assigneeId))
    .$dynamic()
}

/** Eine Seite der Auftragsliste samt Gesamtzahl (Issue #15). */
export async function listRequests(user: Principal, filter: ListFilter) {
  const pageSize = filter.pageSize ?? 50
  const page = filter.page ?? 1
  const where = listConditions(user, filter)
  const [rows, [counted]] = await Promise.all([
    listRowsQuery(user)
      .where(where)
      .orderBy(...listOrder(filter))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(requests)
      .leftJoin(organisations, eq(organisations.id, requests.organisationId))
      .innerJoin(creatorAlias, eq(creatorAlias.id, requests.createdById))
      .where(where),
  ])
  return { rows, total: counted?.count ?? 0, page, pageSize }
}

export const EXPORT_LIMIT = 10_000

/** Alle Treffer der aktuellen Filter für den CSV-Export, höchstens EXPORT_LIMIT. */
export async function exportRequests(user: Principal, filter: ListFilter) {
  return listRowsQuery(user)
    .where(listConditions(user, filter))
    .orderBy(...listOrder(filter))
    .limit(EXPORT_LIMIT)
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
    proposal:
      r.proposal && !isStaff
        ? {
            ...r.proposal,
            proposedById: null,
            order: { ...r.proposal.order, price: { ...r.proposal.order.price, lines: [] }, pricing: null },
          }
        : r.proposal,
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
    // Solange ein Vorschlag offen ist, bleiben nur Stornieren und Ablehnen; der Rest läuft über den Vorschlag.
    transitions: allowedTransitions(r.status, actorOf(user)).filter((t) => !r.proposal || t === 'cancelled' || t === 'rejected'),
    canAnswerProposal: !!r.proposal && r.createdById === user.id,
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
    // Ein offener Änderungsvorschlag wird angenommen, abgelehnt oder zurückgezogen, nicht übergangen.
    // Stornieren und Ablehnen bleiben möglich und verwerfen den Vorschlag.
    const endsOrder = input.to === 'cancelled' || input.to === 'rejected'
    if (current.proposal && !endsOrder) {
      throw new Error(
        actorOf(user) === 'staff'
          ? 'Es gibt einen offenen Änderungsvorschlag. Bitte ihn zuerst zurückziehen oder die Antwort des Kunden abwarten.'
          : 'Bitte nehmen Sie den Änderungsvorschlag an oder lehnen Sie ihn ab.',
      )
    }

    const values: Partial<typeof requests.$inferInsert> = { status: input.to }
    if (endsOrder) values.proposal = null
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

export const proposeChangeSchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  spec: orderSpecSchema,
  deliveryAddress: deliveryAddressSchema.nullable(),
  /** Manuell gesetzter Gesamtpreis; null übernimmt den berechneten Preis. */
  priceOverrideCents: z.number().int().min(0).max(100_000_000).nullable(),
  /** Der berechnete Preis, den der Mitarbeiter gesehen hat. */
  expectedTotalCents: z.number().int().min(0),
  reason: z.string().trim().min(1, 'Bitte die Änderung für den Kunden begründen').max(5000),
})

/**
 * Mitarbeiter schlagen neue Optionen oder einen neuen Preis vor (Issue #50). Der Auftrag geht auf
 * „Rückfrage“; wirksam wird die Änderung erst mit der Zustimmung des Kunden.
 */
export async function proposeChange(user: Principal, input: z.infer<typeof proposeChangeSchema>) {
  if (!isStaffRole(user.role)) throw new Error('Keine Berechtigung')
  return getDb().transaction(async (tx) => {
    const current = await loadForUpdate(tx, user, input.id)
    if (current.version !== input.version) throw new Error(CONFLICT_MESSAGE)
    if (TERMINAL_STATUSES.has(current.status))
      throw new Error('Der Auftrag ist abgeschlossen und kann nicht mehr geändert werden')
    if (!current.order) throw new Error('Aufträge aus der Zeit vor dem Bestell-Wizard können nicht so geändert werden')

    const { spec } = input
    if (spec.delivery === 'house_post' && !input.deliveryAddress)
      throw new Error('Bitte die Lieferadresse für die Hauspost angeben.')
    const files = await listRequestFiles(input.id)
    if (spec.coverPaperId && !files.some((f) => f.role === 'cover')) {
      throw new Error('Zu diesem Auftrag gibt es keine Deckblatt-Datei. Ein Deckblatt kann nur mit Datei gewählt werden.')
    }

    const catalog = await getCatalog({ onlyAvailable: true }, tx)
    const priced = calculatePrice(catalog, spec)
    if (!priced.ok) throw new Error(priced.errors.join(' '))
    if (priced.price.totalCents !== input.expectedTotalCents) throw new Error(PRICE_CHANGED_MESSAGE)
    const price = applyPriceOverride(priced.price, input.priceOverrideCents, input.reason)

    const [me] = await tx.select({ name: users.name }).from(users).where(eq(users.id, user.id))
    const proposal: ChangeProposal = {
      order: buildSnapshot(spec, price, priced.order, catalog.pricing),
      totalCents: price.totalCents,
      deliveryAddress: spec.delivery === 'house_post' ? input.deliveryAddress : null,
      reason: input.reason,
      proposedById: user.id,
      proposedByName: me?.name ?? 'Druckerei',
      proposedAt: new Date().toISOString(),
      // Ein ersetzter Vorschlag behält das ursprüngliche Ziel.
      returnStatus: current.proposal?.returnStatus ?? (current.status === 'confirmed' ? 'confirmed' : 'submitted'),
    }
    const updated = await updateWithVersion(tx, input.id, input.version, { proposal, status: 'on_hold', internalStatus: null })
    await tx.insert(requestEvents).values({
      requestId: input.id,
      actorId: user.id,
      type: 'change_proposed',
      fromStatus: current.status,
      toStatus: 'on_hold',
      data: { totalCents: price.totalCents, previousTotalCents: current.totalCents, reason: input.reason },
    })
    await notifyChangeProposed(tx, user, { requestId: input.id, reason: input.reason })
    return { version: updated.version }
  })
}

export const answerChangeSchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  accept: z.boolean(),
})

/** Der Kunde nimmt den Vorschlag an (er wird wirksam) oder lehnt ihn ab (alles bleibt, wie es war). */
export async function answerChange(user: Principal, input: z.infer<typeof answerChangeSchema>) {
  return getDb().transaction(async (tx) => {
    const current = await loadForUpdate(tx, user, input.id)
    if (current.createdById !== user.id) throw new Error('Nur der Auftraggeber kann dem Vorschlag zustimmen')
    if (current.version !== input.version) throw new Error(CONFLICT_MESSAGE)
    const p = current.proposal
    if (!p) throw new Error('Es gibt keinen offenen Änderungsvorschlag')

    const values: Partial<typeof requests.$inferInsert> = input.accept
      ? {
          proposal: null,
          order: p.order,
          totalCents: p.totalCents,
          quantity: p.order.spec.copies,
          deliveryMethod: p.order.spec.delivery,
          deliveryAddress: p.deliveryAddress,
          status: p.returnStatus,
        }
      : { proposal: null }
    const updated = await updateWithVersion(tx, input.id, input.version, values)
    await tx.insert(requestEvents).values({
      requestId: input.id,
      actorId: user.id,
      type: input.accept ? 'change_accepted' : 'change_rejected',
      fromStatus: current.status,
      toStatus: updated.status,
      data: { totalCents: p.totalCents, previousTotalCents: current.totalCents },
    })
    await notifyChangeAnswered(tx, user, { requestId: input.id, accepted: input.accept, proposedById: p.proposedById })
    return { version: updated.version, status: updated.status }
  })
}

export const withdrawChangeSchema = z.object({ id: z.uuid(), version: z.number().int().positive() })

/** Mitarbeiter ziehen einen Vorschlag zurück; der Auftrag bleibt auf „Rückfrage“. */
export async function withdrawChange(user: Principal, input: z.infer<typeof withdrawChangeSchema>) {
  if (!isStaffRole(user.role)) throw new Error('Keine Berechtigung')
  return getDb().transaction(async (tx) => {
    const current = await loadForUpdate(tx, user, input.id)
    if (current.version !== input.version) throw new Error(CONFLICT_MESSAGE)
    if (!current.proposal) throw new Error('Es gibt keinen offenen Änderungsvorschlag')
    const updated = await updateWithVersion(tx, input.id, input.version, { proposal: null })
    await tx.insert(requestEvents).values({ requestId: input.id, actorId: user.id, type: 'change_withdrawn' })
    return { version: updated.version }
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
