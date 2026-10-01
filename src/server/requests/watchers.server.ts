// Beobachter und Erwähnungen (Issue #13).
// Ersteller und Zuständiger beobachten automatisch; jeder kann das pro Auftrag an- und abschalten.
// Mitarbeiter können zusätzlich fremde Aufträge beobachten und sich gegenseitig per @Name erwähnen.
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { isStaffRole } from '~/lib/roles'
import { schema, type Tx } from '../db/client.server'

const { requestWatchers, users } = schema
const STAFF_ROLES = ['staff', 'admin', 'superadmin'] as const

type RequestRef = { id: string; createdById: string; assigneeId: string | null }

/** IDs aller Benutzer, die den Auftrag gerade beobachten. */
export async function watcherIds(tx: Tx, request: RequestRef) {
  const rows = await tx
    .select({ userId: requestWatchers.userId, muted: requestWatchers.muted })
    .from(requestWatchers)
    .where(eq(requestWatchers.requestId, request.id))
  const ids = new Set([request.createdById, ...(request.assigneeId ? [request.assigneeId] : [])])
  for (const r of rows) if (!r.muted) ids.add(r.userId)
  for (const r of rows) if (r.muted) ids.delete(r.userId)
  return ids
}

/** IDs der Benutzer, die das Beobachten dieses Auftrags ausdrücklich abgeschaltet haben. */
export async function mutedIds(tx: Tx, requestId: string) {
  const rows = await tx
    .select({ userId: requestWatchers.userId })
    .from(requestWatchers)
    .where(and(eq(requestWatchers.requestId, requestId), eq(requestWatchers.muted, true)))
  return new Set(rows.map((r) => r.userId))
}

export async function setWatching(tx: Tx, requestId: string, userId: string, watching: boolean) {
  await tx
    .insert(requestWatchers)
    .values({ requestId, userId, muted: !watching })
    .onConflictDoUpdate({ target: [requestWatchers.requestId, requestWatchers.userId], set: { muted: !watching } })
}

/** Fügt Beobachter hinzu, z. B. Erwähnte. Ein früheres Abschalten wird dabei aufgehoben. */
export async function addWatchers(tx: Tx, requestId: string, userIds: string[]) {
  for (const userId of new Set(userIds)) await setWatching(tx, requestId, userId, true)
}

/** Wer neu zuständig wird, beobachtet wieder, auch wenn er es früher abgeschaltet hatte. */
export async function clearMute(tx: Tx, requestId: string, userId: string) {
  await tx
    .delete(requestWatchers)
    .where(and(eq(requestWatchers.requestId, requestId), eq(requestWatchers.userId, userId), eq(requestWatchers.muted, true)))
}

/** Beobachter mit Namen für die Detailseite (nur Mitarbeiter sehen die Liste). */
export async function listWatchers(tx: Tx, request: RequestRef) {
  const ids = [...(await watcherIds(tx, request))]
  if (ids.length === 0) return []
  return tx
    .select({ id: users.id, name: users.name, isStaff: sql<boolean>`${users.role} <> 'customer'` })
    .from(users)
    .where(inArray(users.id, ids))
    .orderBy(asc(users.name))
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Findet @Name-Erwähnungen aktiver Mitarbeiter. Längere Namen gewinnen, damit "@Anna Maier" nicht
 * zusätzlich "@Anna" erwähnt. Groß- und Kleinschreibung spielt keine Rolle.
 */
export function findMentions(body: string, staff: { id: string; name: string }[]) {
  const found = new Set<string>()
  let rest = body
  for (const s of [...staff].sort((a, b) => b.name.length - a.name.length)) {
    const name = s.name.trim()
    if (!name) continue
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'giu')
    if (pattern.test(rest)) {
      found.add(s.id)
      rest = rest.replace(pattern, '$1')
    }
  }
  return [...found]
}

/** Erwähnungen gibt es nur unter Mitarbeitern; Kunden können niemanden erwähnen. */
export async function resolveMentions(
  tx: Tx,
  author: { id: string; role: 'superadmin' | 'admin' | 'staff' | 'customer' },
  body: string,
) {
  if (!isStaffRole(author.role) || !body.includes('@')) return []
  const staff = await tx
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.status, 'active'), inArray(users.role, STAFF_ROLES)))
  return findMentions(body, staff).filter((id) => id !== author.id)
}

/** Bedingung für die Ansicht "Für mich": Aufträge, die der Benutzer beobachtet. */
export function watchedBy(userId: string, requests: typeof schema.requests) {
  return sql`(
    (${requests.createdById} = ${userId} or ${requests.assigneeId} = ${userId}
      or exists (select 1 from ${requestWatchers} w where w.request_id = ${requests.id} and w.user_id = ${userId} and not w.muted))
    and not exists (select 1 from ${requestWatchers} w where w.request_id = ${requests.id} and w.user_id = ${userId} and w.muted)
  )`
}
