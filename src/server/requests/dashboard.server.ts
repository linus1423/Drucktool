// Startseite mit Kennzahlen (Issue #17). Alles wird aus den Aufträgen und ihrer Historie berechnet,
// nichts wird doppelt gespeichert. Kunden sehen ausschließlich ihre eigenen Aufträge.
import { and, asc, count, eq, gte, inArray, isNotNull, notInArray, or, sql, type SQL } from 'drizzle-orm'
import { berlinToday } from '~/lib/deadlines'
import { isStaffRole } from '~/lib/roles'
import { OPEN_STATUSES, type InternalStatus, type RequestStatus } from '~/lib/status'
import { getDb, schema } from '../db/client.server'
import type { Principal } from './requests.server'

const { requests, requestEvents } = schema

/** Monate in der Monatsübersicht und Zeitraum für die Verteilungen. */
export const DASHBOARD_MONTHS = 12
/** Zeitraum für die Durchlaufzeit. */
export const THROUGHPUT_DAYS = 90
const TOP = 8

const berlinMonth = (column: unknown) => sql<string>`to_char(${column} at time zone 'Europe/Berlin', 'YYYY-MM')`

/** Die letzten `n` Monate als "YYYY-MM", ältester zuerst. */
export function lastMonths(n: number, today = berlinToday()) {
  const [y, m] = today.split('-').map(Number) as [number, number]
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1))
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  })
}

export async function getDashboard(user: Principal) {
  return isStaffRole(user.role) ? staffDashboard(user) : customerDashboard(user)
}

async function staffDashboard(user: Principal) {
  const db = getDb()
  const open = inArray(requests.status, OPEN_STATUSES)
  const months = lastMonths(DASHBOARD_MONTHS)
  const since = sql`(${`${months[0]}-01`}::date)::timestamp at time zone 'Europe/Berlin'`
  const yesterday = sql`(${berlinToday()}::date - 1)::timestamp at time zone 'Europe/Berlin'`
  const completion = and(eq(requestEvents.type, 'status_changed'), eq(requestEvents.toStatus, 'completed'))

  const [byStatusRows, [counters], [throughput], created, completed, formats, bindings, papers] = await Promise.all([
    db
      .select({ status: requests.status, internalStatus: requests.internalStatus, n: count() })
      .from(requests)
      .where(open)
      .groupBy(requests.status, requests.internalStatus),
    db
      .select({
        mine: sql<number>`count(*) filter (where ${requests.assigneeId} = ${user.id})::int`,
        unassigned: sql<number>`count(*) filter (where ${requests.assigneeId} is null)::int`,
        proposals: sql<number>`count(*) filter (where ${requests.proposal} is not null)::int`,
        newSinceYesterday: sql<number>`count(*) filter (where ${requests.createdAt} >= ${yesterday})::int`,
      })
      .from(requests)
      .where(open),
    db
      .select({
        count: count(),
        medianDays: sql<
          number | null
        >`percentile_cont(0.5) within group (order by extract(epoch from ${requestEvents.createdAt} - ${requests.createdAt}) / 86400)`,
        avgDays: sql<number | null>`avg(extract(epoch from ${requestEvents.createdAt} - ${requests.createdAt}) / 86400)`,
      })
      .from(requestEvents)
      .innerJoin(requests, eq(requests.id, requestEvents.requestId))
      .where(and(completion, sql`${requestEvents.createdAt} > now() - make_interval(days => ${THROUGHPUT_DAYS})`)),
    db
      .select({ month: berlinMonth(requests.createdAt), n: count() })
      .from(requests)
      .where(gte(requests.createdAt, since))
      .groupBy(sql`1`),
    db
      .select({
        month: berlinMonth(requestEvents.createdAt),
        n: sql<number>`count(distinct ${requests.id})::int`,
        cents: sql<number>`coalesce(sum(${requests.totalCents}), 0)::int`,
      })
      .from(requestEvents)
      .innerJoin(requests, eq(requests.id, requestEvents.requestId))
      .where(and(completion, gte(requestEvents.createdAt, since)))
      .groupBy(sql`1`),
    distribution(sql`${requests.order}->'format'->>'label'`, since),
    distribution(sql`${requests.order}->'binding'->>'label'`, since),
    distribution(
      sql`(${requests.order}->'paper'->>'name') || ' ' || (${requests.order}->'paper'->>'grammage') || ' g/m²'`,
      since,
    ),
  ])

  const byStatus = OPEN_STATUSES.map((status) => {
    const rows = byStatusRows.filter((r) => r.status === status)
    return {
      status,
      count: rows.reduce((sum, r) => sum + r.n, 0),
      internal: rows
        .filter((r) => r.internalStatus)
        .map((r) => ({ internalStatus: r.internalStatus as InternalStatus, count: r.n })),
    }
  })
  const createdBy = new Map(created.map((r) => [r.month, r.n]))
  const completedBy = new Map(completed.map((r) => [r.month, r]))

  return {
    kind: 'staff' as const,
    byStatus,
    counters: counters!,
    throughput: {
      days: THROUGHPUT_DAYS,
      count: throughput!.count,
      medianDays: throughput!.medianDays === null ? null : Number(throughput!.medianDays),
      avgDays: throughput!.avgDays === null ? null : Number(throughput!.avgDays),
    },
    months: months.map((month) => ({
      month,
      created: createdBy.get(month) ?? 0,
      completed: completedBy.get(month)?.n ?? 0,
      revenueCents: completedBy.get(month)?.cents ?? 0,
    })),
    distribution: { formats, bindings, papers },
  }
}

/** Häufigste Werte im Zeitraum, ohne abgelehnte und stornierte Aufträge, mit Anzahl Exemplare. */
function distribution(label: SQL, since: SQL) {
  return getDb()
    .select({
      label: sql<string>`${label}`,
      orders: count(),
      copies: sql<number>`coalesce(sum((${requests.order}->'spec'->>'copies')::int), 0)::int`,
    })
    .from(requests)
    .where(
      and(
        isNotNull(requests.order),
        notInArray(requests.status, ['rejected', 'cancelled']),
        gte(requests.createdAt, since),
        sql`${label} is not null`,
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`2 desc`, sql`1`)
    .limit(TOP)
}

async function customerDashboard(user: Principal) {
  const db = getDb()
  const mine = and(eq(requests.createdById, user.id), inArray(requests.status, OPEN_STATUSES))
  const [byStatusRows, waiting] = await Promise.all([
    db.select({ status: requests.status, n: count() }).from(requests).where(mine).groupBy(requests.status),
    db
      .select({
        id: requests.id,
        number: requests.number,
        title: requests.title,
        status: requests.status,
        hasProposal: sql<boolean>`${requests.proposal} is not null`,
      })
      .from(requests)
      .where(and(mine, or(eq(requests.status, 'on_hold'), isNotNull(requests.proposal))))
      .orderBy(asc(requests.statusChangedAt))
      .limit(50),
  ])
  return {
    kind: 'customer' as const,
    byStatus: OPEN_STATUSES.map((status: RequestStatus) => ({
      status,
      count: byStatusRows.find((r) => r.status === status)?.n ?? 0,
    })),
    waiting,
  }
}
