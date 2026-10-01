// Legt fest, wer bei welchem Ereignis eine E-Mail bekommt.
// Grundregeln: Der Auslöser selbst bekommt nie eine Mail, und nur aktive Benutzer mit
// eingeschalteten Benachrichtigungen werden angeschrieben.
import { and, eq, inArray, ne, or } from 'drizzle-orm'
import type { RequestStatus } from '~/lib/status'
import { schema, type Tx } from '../db/client.server'
import { enqueueMail } from './outbox.server'
import { mutedIds, watcherIds } from '../requests/watchers.server'
import {
  assignedMail,
  changeAnsweredMail,
  changeProposedMail,
  commentMail,
  mentionMail,
  promisedDateMail,
  registrationApprovedMail,
  registrationReceivedMail,
  registrationRejectedMail,
  requestCreatedMail,
  requestReceivedMail,
  statusChangedMail,
} from './templates'

const { users, requests, organisations } = schema
const STAFF_ROLES = ['staff', 'admin', 'superadmin'] as const

type Actor = { id: string; role: 'superadmin' | 'admin' | 'staff' | 'customer' }

function isStaff(actor: Actor) {
  return actor.role !== 'customer'
}

async function actorName(tx: Tx, actorId: string) {
  const [row] = await tx.select({ name: users.name }).from(users).where(eq(users.id, actorId))
  return row?.name ?? 'Jemand'
}

async function loadRequest(tx: Tx, requestId: string) {
  const [row] = await tx
    .select({
      id: requests.id,
      number: requests.number,
      title: requests.title,
      createdById: requests.createdById,
      assigneeId: requests.assigneeId,
      organisationName: organisations.name,
      order: requests.order,
      totalCents: requests.totalCents,
      deliveryMethod: requests.deliveryMethod,
    })
    .from(requests)
    .leftJoin(organisations, eq(organisations.id, requests.organisationId))
    .where(eq(requests.id, requestId))
  if (!row) throw new Error('Auftrag nicht gefunden')
  return row
}

/** Der Kunde, der den Auftrag angelegt hat, sofern er das Beobachten nicht abgeschaltet hat. */
async function customerRecipients(tx: Tx, request: { id: string; createdById: string }, excludeId: string | null) {
  if ((await mutedIds(tx, request.id)).has(request.createdById)) return []
  const rows = await tx
    .select({ email: users.email })
    .from(users)
    .where(
      and(
        eq(users.id, request.createdById),
        eq(users.role, 'customer'),
        eq(users.status, 'active'),
        eq(users.emailNotifications, true),
        excludeId ? ne(users.id, excludeId) : undefined,
      ),
    )
  return rows.map((r) => r.email)
}

type WatchedRequest = { id: string; createdById: string; assigneeId: string | null }

/**
 * Beobachter des Auftrags (Issue #13), getrennt nach Kunden und Mitarbeitern, weil beide unterschiedliche
 * Mails bekommen. Solange niemand zuständig ist, erfahren bei Aktionen des Kunden alle Mitarbeiter davon.
 */
async function watcherRecipients(
  tx: Tx,
  actor: Actor,
  request: WatchedRequest,
  opts: { staffOnly?: boolean; exclude?: string[] } = {},
) {
  const ids = await watcherIds(tx, request)
  const muted = await mutedIds(tx, request.id)
  const everyStaff = !isStaff(actor) && !request.assigneeId
  if (ids.size === 0 && !everyStaff) return { customers: [], staff: [] }
  const rows = await tx
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(
      and(
        or(ids.size ? inArray(users.id, [...ids]) : undefined, everyStaff ? inArray(users.role, STAFF_ROLES) : undefined),
        opts.staffOnly ? inArray(users.role, STAFF_ROLES) : undefined,
        eq(users.status, 'active'),
        eq(users.emailNotifications, true),
        ne(users.id, actor.id),
      ),
    )
  const skip = new Set([...muted, ...(opts.exclude ?? [])])
  const wanted = rows.filter((r) => !skip.has(r.id))
  return {
    customers: wanted.filter((r) => r.role === 'customer').map((r) => r.email),
    staff: wanted.filter((r) => r.role !== 'customer').map((r) => r.email),
  }
}

/** Der zuständige Mitarbeiter, oder alle Mitarbeiter, solange niemand zugewiesen ist. */
async function staffRecipients(tx: Tx, assigneeId: string | null, excludeId: string) {
  const rows = await tx
    .select({ email: users.email })
    .from(users)
    .where(
      and(
        assigneeId ? eq(users.id, assigneeId) : inArray(users.role, STAFF_ROLES),
        eq(users.status, 'active'),
        eq(users.emailNotifications, true),
        ne(users.id, excludeId),
      ),
    )
  return rows.map((r) => r.email)
}

export async function notifyRequestCreated(tx: Tx, actor: Actor, requestId: string) {
  const request = await loadRequest(tx, requestId)
  await enqueueMail(
    tx,
    await staffRecipients(tx, request.assigneeId, actor.id),
    requestCreatedMail({ ...request, actorName: await actorName(tx, actor.id) }),
  )
  // Eingangsbestätigung an den Kunden (Lastenheft 7: "Auftrag eingereicht").
  if (!isStaff(actor)) {
    await enqueueMail(tx, await customerRecipients(tx, request, null), requestReceivedMail(request))
  }
}

export async function notifyStatusChanged(
  tx: Tx,
  actor: Actor,
  input: { requestId: string; from: RequestStatus; to: RequestStatus; note?: string | null },
) {
  const request = await loadRequest(tx, input.requestId)
  const mail = { ...request, ...input, actorName: await actorName(tx, actor.id) }
  // Alle Beobachter außer dem Auslöser; ohne Zuständigen bei Kundenaktionen alle Mitarbeiter.
  const recipients = await watcherRecipients(tx, actor, request)
  await enqueueMail(tx, recipients.customers, statusChangedMail(mail))
  await enqueueMail(tx, recipients.staff, statusChangedMail({ ...mail, forStaff: true }))
}

// Ein Vorschlag braucht die Zustimmung des Kunden; die Mail geht deshalb auch an Mitarbeiter, die Aufträge
// für sich selbst angelegt haben.
export async function notifyChangeProposed(tx: Tx, actor: Actor, input: { requestId: string; reason: string }) {
  const request = await loadRequest(tx, input.requestId)
  const [row] = await tx.select({ proposal: requests.proposal }).from(requests).where(eq(requests.id, input.requestId))
  const p = row?.proposal
  if (!p) return
  const recipients = await tx
    .select({ email: users.email })
    .from(users)
    .where(
      and(
        eq(users.id, request.createdById),
        eq(users.status, 'active'),
        eq(users.emailNotifications, true),
        ne(users.id, actor.id),
      ),
    )
  await enqueueMail(
    tx,
    recipients.map((r) => r.email),
    changeProposedMail({
      ...request,
      actorName: await actorName(tx, actor.id),
      reason: input.reason,
      before: request,
      after: { order: p.order, totalCents: p.totalCents },
    }),
  )
}

/** Antwort des Kunden an den Mitarbeiter, der den Vorschlag gemacht hat. */
export async function notifyChangeAnswered(
  tx: Tx,
  actor: Actor,
  input: { requestId: string; accepted: boolean; proposedById: string },
) {
  const request = await loadRequest(tx, input.requestId)
  const rows = await tx
    .select({ email: users.email })
    .from(users)
    .where(
      and(
        eq(users.id, input.proposedById),
        eq(users.status, 'active'),
        eq(users.emailNotifications, true),
        ne(users.id, actor.id),
      ),
    )
  await enqueueMail(
    tx,
    rows.map((r) => r.email),
    changeAnsweredMail({ ...request, actorName: await actorName(tx, actor.id), accepted: input.accepted }),
  )
}

export async function notifyPromisedDate(tx: Tx, actor: Actor, input: { requestId: string; date: string | null }) {
  const request = await loadRequest(tx, input.requestId)
  await enqueueMail(
    tx,
    await customerRecipients(tx, request, actor.id),
    promisedDateMail({ ...request, actorName: await actorName(tx, actor.id), date: input.date }),
  )
}

export async function notifyComment(
  tx: Tx,
  actor: Actor,
  input: { requestId: string; body: string; internal: boolean; attachmentNames?: string[]; mentionedIds?: string[] },
) {
  const request = await loadRequest(tx, input.requestId)
  const name = await actorName(tx, actor.id)
  const mentioned = input.mentionedIds ?? []
  // Erwähnte bekommen eine eigene Mail statt der allgemeinen Benachrichtigung.
  if (mentioned.length) {
    const rows = await tx
      .select({ email: users.email })
      .from(users)
      .where(
        and(
          inArray(users.id, mentioned),
          inArray(users.role, STAFF_ROLES),
          eq(users.status, 'active'),
          eq(users.emailNotifications, true),
          ne(users.id, actor.id),
        ),
      )
    await enqueueMail(
      tx,
      rows.map((r) => r.email),
      mentionMail({ ...request, actorName: name, body: input.body, internal: input.internal }),
    )
  }
  // Interne Notizen gehen nie an Kunden, auch nicht an beobachtende.
  const recipients = await watcherRecipients(tx, actor, request, { staffOnly: input.internal, exclude: mentioned })
  await enqueueMail(tx, [...recipients.customers, ...recipients.staff], commentMail({ ...request, ...input, actorName: name }))
}

export async function notifyAssigned(tx: Tx, actor: Actor, input: { requestId: string; assigneeId: string | null }) {
  if (!input.assigneeId || input.assigneeId === actor.id) return
  const request = await loadRequest(tx, input.requestId)
  const recipients = await staffRecipients(tx, input.assigneeId, actor.id)
  await enqueueMail(tx, recipients, assignedMail({ ...request, actorName: await actorName(tx, actor.id) }))
}

export async function notifyRegistrationReceived(tx: Tx, user: { name: string; email: string; organisationName: string }) {
  const superadmins = await tx
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.role, 'superadmin'), eq(users.status, 'active'), eq(users.emailNotifications, true)))
  await enqueueMail(
    tx,
    superadmins.map((s) => s.email),
    registrationReceivedMail(user),
  )
}

// Freigabe und Ablehnung sind Kontoinformationen und gehen unabhängig von der Einstellung raus.
export async function notifyRegistrationDecision(tx: Tx, user: { name: string; email: string }, approved: boolean) {
  await enqueueMail(tx, [user.email], approved ? registrationApprovedMail(user) : registrationRejectedMail(user))
}
