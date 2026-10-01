import { and, desc, eq, gte, lt, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { getRequestIP } from '@tanstack/react-start/server'
import { z } from 'zod'
import { AUDIT_ACTIONS, type AuditAction } from '~/lib/audit'
import type { JsonObject } from '~/lib/json'
import { getDb, schema, type Tx } from '../db/client.server'

type Db = ReturnType<typeof getDb> | Tx
const { auditLog, users, organisations } = schema

// Diese Felder landen nie im Protokoll, auch nicht versehentlich über einen Snapshot.
const SECRET_FIELDS = new Set(['passwordHash', 'password'])

export type AuditEntry = {
  actorId: string | null
  action: AuditAction
  targetType: 'user' | 'organisation' | 'mail_template'
  targetId: string | null
  organisationId?: string | null
  before?: object | null
  after?: object | null
  data?: JsonObject
}

/** Kopie als JSON ohne Geheimnisse; mit fields nur die genannten Felder. */
export function auditSnapshot(value: object | null | undefined, fields?: readonly string[]): JsonObject | null {
  if (!value) return null
  const entries = Object.entries(value).filter(([k]) => !SECRET_FIELDS.has(k) && (!fields || fields.includes(k)))
  return JSON.parse(JSON.stringify(Object.fromEntries(entries))) as JsonObject
}

function currentIp(): string | null {
  try {
    return getRequestIP({ xForwardedFor: process.env.TRUST_PROXY === 'true' }) ?? null
  } catch {
    // Außerhalb eines Requests (Tests, Skripte) gibt es keine IP.
    return null
  }
}

/** Schreibt einen Eintrag. Für Admin-Aktionen mit der Transaktion der Änderung aufrufen. */
export async function writeAudit(db: Db, entry: AuditEntry) {
  await db.insert(auditLog).values({
    actorId: entry.actorId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    organisationId: entry.organisationId ?? null,
    before: auditSnapshot(entry.before),
    after: auditSnapshot(entry.after),
    data: auditSnapshot(entry.data) ?? {},
    ip: currentIp(),
  })
}

/** Protokolliert eine Anmeldung. Fehler beim Schreiben dürfen die Anmeldung nicht verhindern. */
export async function auditLogin(
  outcome: 'succeeded' | 'failed',
  details: { userId: string | null; method: 'password' | 'link' | 'oidc'; email?: string | null; reason?: string },
  db: Db = getDb(),
) {
  try {
    await writeAudit(db, {
      // Bei Fehlversuchen ist unklar, wer es war; das Konto steht dann nur als Ziel da.
      actorId: outcome === 'succeeded' ? details.userId : null,
      action: outcome === 'succeeded' ? 'login.succeeded' : 'login.failed',
      targetType: 'user',
      targetId: details.userId,
      data: {
        method: details.method,
        ...(details.email ? { email: details.email } : {}),
        ...(details.reason ? { reason: details.reason } : {}),
      },
    })
  } catch (error) {
    console.error('[audit] Anmeldung konnte nicht protokolliert werden', error)
  }
}

export const AUDIT_PAGE_SIZE = 50

export const auditFilterSchema = z.object({
  userId: z.uuid().optional(),
  organisationId: z.uuid().optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  // Datum im Format JJJJ-MM-TT, jeweils einschließlich.
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.number().int().min(0).max(10_000).default(0),
})
export type AuditFilter = z.input<typeof auditFilterSchema>

export async function listAuditLog(input: AuditFilter) {
  const filter = auditFilterSchema.parse(input)
  const actor = alias(users, 'audit_actor')
  const target = alias(users, 'audit_target')
  const conditions: (SQL | undefined)[] = []
  if (filter.userId) {
    conditions.push(
      or(eq(auditLog.actorId, filter.userId), and(eq(auditLog.targetType, 'user'), eq(auditLog.targetId, filter.userId))),
    )
  }
  if (filter.organisationId) {
    conditions.push(
      or(
        eq(auditLog.organisationId, filter.organisationId),
        and(eq(auditLog.targetType, 'organisation'), eq(auditLog.targetId, filter.organisationId)),
      ),
    )
  }
  if (filter.action) conditions.push(eq(auditLog.action, filter.action))
  // Tagesgrenzen in deutscher Zeit, wie in der Oberfläche angezeigt.
  if (filter.from) conditions.push(gte(auditLog.createdAt, sql`(${filter.from}::date)::timestamp at time zone 'Europe/Berlin'`))
  if (filter.to) conditions.push(lt(auditLog.createdAt, sql`(${filter.to}::date + 1)::timestamp at time zone 'Europe/Berlin'`))

  const rows = await getDb()
    .select({
      id: auditLog.id,
      createdAt: auditLog.createdAt,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      before: auditLog.before,
      after: auditLog.after,
      data: auditLog.data,
      ip: auditLog.ip,
      actorId: auditLog.actorId,
      actorName: actor.name,
      targetUserName: target.name,
      targetUserEmail: target.email,
      organisationName: organisations.name,
    })
    .from(auditLog)
    .leftJoin(actor, eq(actor.id, auditLog.actorId))
    .leftJoin(target, and(eq(auditLog.targetType, 'user'), eq(sql`${target.id}::text`, auditLog.targetId)))
    .leftJoin(
      organisations,
      sql`${organisations.id} = coalesce(${auditLog.organisationId}, case when ${auditLog.targetType} = 'organisation' then ${auditLog.targetId}::uuid end)`,
    )
    .where(and(...conditions))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(AUDIT_PAGE_SIZE + 1)
    .offset(filter.page * AUDIT_PAGE_SIZE)

  return { entries: rows.slice(0, AUDIT_PAGE_SIZE), hasMore: rows.length > AUDIT_PAGE_SIZE }
}
