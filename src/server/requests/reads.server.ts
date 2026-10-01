// Ungelesen-Markierung (Issue #18): Pro Benutzer und Auftrag merken wir, wann er ihn zuletzt angesehen hat.
// Ungelesen ist ein Auftrag, wenn danach jemand anderes etwas getan hat, das der Benutzer sehen darf.
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { isStaffRole } from '~/lib/roles'
import { getDb, schema } from '../db/client.server'

const { requests, requestReads, requestEvents, requestComments, settings } = schema

type Reader = { id: string; role: 'superadmin' | 'admin' | 'staff' | 'customer' }

/** Ab wann überhaupt etwas als ungelesen gilt: alles vor der Einführung zählt als gelesen. */
const baseline = sql`coalesce((select (${settings.value} ->> 'since')::timestamptz from ${settings} where ${settings.key} = 'unread_baseline'), '-infinity'::timestamptz)`

function lastRead(userId: string) {
  return sql`coalesce((select rr.read_at from ${requestReads} rr where rr.request_id = ${requests.id} and rr.user_id = ${userId}), ${baseline})`
}

/** SQL-Ausdruck für die Auftragsliste: gibt es Aktivität anderer seit dem letzten Öffnen? */
export function unreadExpression(user: Reader) {
  const staff = isStaffRole(user.role)
  const since = lastRead(user.id)
  return sql<boolean>`(
    exists (select 1 from ${requestEvents} e where e.request_id = ${requests.id}
      and e.actor_id is distinct from ${user.id} ${staff ? sql`` : sql`and not e.internal`} and e.created_at > ${since})
    or exists (select 1 from ${requestComments} c where c.request_id = ${requests.id}
      and c.author_id <> ${user.id} ${staff ? sql`` : sql`and not c.internal`} and c.created_at > ${since})
  )`
}

/** Zeitpunkt, ab dem Einträge im Detail als neu hervorgehoben werden. */
export async function readAtFor(userId: string, requestId: string) {
  const [row] = await getDb()
    .select({ at: sql<Date>`${lastRead(userId)}` })
    .from(requests)
    .where(eq(requests.id, requestId))
  const at = row?.at
  return at ? new Date(at) : null
}

export const markReadSchema = z.object({ id: z.uuid(), at: z.coerce.date() })

/**
 * Merkt sich, bis wann der Benutzer den Auftrag gesehen hat. `at` ist der Ladezeitpunkt der Detailseite,
 * damit Aktivität zwischen Laden und Markieren ungelesen bleibt. Ein Zeitpunkt in der Zukunft wird gekappt.
 */
export async function markRead(user: Reader, input: z.infer<typeof markReadSchema>, canSee: (id: string) => Promise<unknown>) {
  await canSee(input.id)
  const at = new Date(Math.min(input.at.getTime(), Date.now()))
  await getDb()
    .insert(requestReads)
    .values({ requestId: input.id, userId: user.id, readAt: at })
    .onConflictDoUpdate({
      target: [requestReads.requestId, requestReads.userId],
      set: { readAt: sql`greatest(${requestReads.readAt}, excluded.read_at)` },
    })
  return { ok: true }
}
