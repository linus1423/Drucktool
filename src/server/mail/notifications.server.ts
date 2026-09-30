// Legt fest, wer bei welchem Ereignis eine E-Mail bekommt.
// Grundregeln: Der Auslöser selbst bekommt nie eine Mail, und nur aktive Benutzer mit
// eingeschalteten Benachrichtigungen werden angeschrieben.
import { and, eq, inArray, ne } from 'drizzle-orm'
import type { RequestStatus } from '~/lib/status'
import { schema, type Tx } from '../db/client.server'
import { enqueueMail } from './outbox.server'
import {
  assignedMail,
  commentMail,
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
    })
    .from(requests)
    .leftJoin(organisations, eq(organisations.id, requests.organisationId))
    .where(eq(requests.id, requestId))
  if (!row) throw new Error('Anfrage nicht gefunden')
  return row
}

/** Der Kunde, der den Auftrag angelegt hat. */
async function customerRecipients(tx: Tx, createdById: string, excludeId: string | null) {
  const rows = await tx
    .select({ email: users.email })
    .from(users)
    .where(
      and(
        eq(users.id, createdById),
        eq(users.role, 'customer'),
        eq(users.status, 'active'),
        eq(users.emailNotifications, true),
        excludeId ? ne(users.id, excludeId) : undefined,
      ),
    )
  return rows.map((r) => r.email)
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
    await enqueueMail(tx, await customerRecipients(tx, request.createdById, null), requestReceivedMail(request))
  }
}

export async function notifyStatusChanged(
  tx: Tx,
  actor: Actor,
  input: { requestId: string; from: RequestStatus; to: RequestStatus; note?: string | null },
) {
  const request = await loadRequest(tx, input.requestId)
  const content = statusChangedMail({ ...request, ...input, actorName: await actorName(tx, actor.id) })
  // Mitarbeiter informieren den Kunden, Kunden informieren die Druckerei.
  const recipients = isStaff(actor)
    ? await customerRecipients(tx, request.createdById, actor.id)
    : await staffRecipients(tx, request.assigneeId, actor.id)
  await enqueueMail(tx, recipients, content)
}

export async function notifyComment(tx: Tx, actor: Actor, input: { requestId: string; body: string; internal: boolean }) {
  const request = await loadRequest(tx, input.requestId)
  const content = commentMail({ ...request, ...input, actorName: await actorName(tx, actor.id) })
  let recipients: string[]
  if (input.internal) {
    // Interne Notizen gehen nur an den Zuständigen, nie an Kunden.
    recipients = request.assigneeId ? await staffRecipients(tx, request.assigneeId, actor.id) : []
  } else if (isStaff(actor)) {
    recipients = await customerRecipients(tx, request.createdById, actor.id)
  } else {
    recipients = await staffRecipients(tx, request.assigneeId, actor.id)
  }
  await enqueueMail(tx, recipients, content)
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
