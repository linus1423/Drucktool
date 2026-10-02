// Skriptenverwaltung der SVK (Issue #59). Die SVK ist eine Organisation mit Kennzeichen „SVK“; ihre Mitglieder legen
// Skripte als dauerhafte Vorlagen an und bestellen sie über den normalen Wizard nach. Jede Nachbestellung ist ein
// gewöhnlicher Auftrag der SVK-Organisation; fertige Aufträge erhöhen den Bestand des Skripts.
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { isStaffRole } from '~/lib/roles'
import { OPEN_STATUSES } from '~/lib/status'
import { getDb, schema, type Tx } from '../db/client.server'
import type { Principal } from '../requests/requests.server'

const { scripts, requests, organisations, organisationMembers } = schema

type Db = ReturnType<typeof getDb> | Tx

const NO_PERMISSION = 'Keine Berechtigung'

/** Aktive SVK-Organisationen, in denen der Benutzer Mitglied ist. */
export function svkOrganisations(db: Db, userId: string) {
  return db
    .select({ id: organisations.id, name: organisations.name })
    .from(organisationMembers)
    .innerJoin(organisations, eq(organisations.id, organisationMembers.organisationId))
    .where(and(eq(organisationMembers.userId, userId), eq(organisations.isSvk, true), eq(organisations.status, 'active')))
    .orderBy(asc(organisations.name))
}

/** Nur die IDs, für Unterabfragen. */
export function svkOrganisationIds(db: Db, userId: string) {
  return db
    .select({ id: organisations.id })
    .from(organisationMembers)
    .innerJoin(organisations, eq(organisations.id, organisationMembers.organisationId))
    .where(and(eq(organisationMembers.userId, userId), eq(organisations.isSvk, true), eq(organisations.status, 'active')))
}

async function assertSvkMember(db: Db, user: Principal, organisationId: string) {
  if (user.role !== 'customer') throw new Error(NO_PERMISSION)
  const orgs = await svkOrganisations(db, user.id)
  if (!orgs.some((o) => o.id === organisationId)) throw new Error(NO_PERMISSION)
}

/** Skript laden, das der Benutzer nachbestellen darf (Mitglied der SVK-Organisation des Skripts). */
export async function scriptForOrder(db: Db, user: Principal, scriptId: string) {
  const [script] = await db.select().from(scripts).where(eq(scripts.id, scriptId))
  if (!script) throw new Error('Skript nicht gefunden')
  await assertSvkMember(db, user, script.organisationId)
  if (script.archived) throw new Error('Das Skript ist archiviert.')
  return script
}

/** Für den Wizard: Titel und SVK des Skripts, für das bestellt wird. */
export async function describeScriptForOrder(user: Principal, scriptId: string) {
  const db = getDb()
  const script = await scriptForOrder(db, user, scriptId)
  const [org] = await db
    .select({ name: organisations.name })
    .from(organisations)
    .where(eq(organisations.id, script.organisationId))
  return {
    id: script.id,
    title: script.title,
    semester: script.semester,
    organisationId: script.organisationId,
    organisationName: org?.name ?? '',
    templateRequestId: script.templateRequestId,
  }
}

export const scriptListSchema = z.object({
  semester: z.string().trim().max(50).optional(),
  archived: z.boolean().optional(),
})

/** Skripte samt Kennzahlen. Mitarbeiter sehen alle, SVK-Mitglieder die ihrer SVK. */
export async function listScripts(user: Principal, filter: z.infer<typeof scriptListSchema>) {
  const db = getDb()
  const staff = isStaffRole(user.role)
  const orgIds = staff ? null : (await svkOrganisations(db, user.id)).map((o) => o.id)
  if (orgIds && orgIds.length === 0) throw new Error(NO_PERMISSION)
  const open = sql.join(
    OPEN_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  )
  const rows = await db
    .select({
      id: scripts.id,
      title: scripts.title,
      lecturer: scripts.lecturer,
      semester: scripts.semester,
      stock: scripts.stock,
      notes: scripts.notes,
      archived: scripts.archived,
      organisationId: scripts.organisationId,
      organisationName: organisations.name,
      templateRequestId: scripts.templateRequestId,
      updatedAt: scripts.updatedAt,
      orders: sql<number>`(select count(*)::int from ${requests} r where r.script_id = ${scripts.id})`,
      openCopies: sql<number>`coalesce((select sum(r.quantity)::int from ${requests} r
        where r.script_id = ${scripts.id} and r.status in (${open})), 0)`,
      printedCopies: sql<number>`coalesce((select sum(r.quantity)::int from ${requests} r
        where r.script_id = ${scripts.id} and r.status = 'completed'), 0)`,
      lastOrder: sql<{ id: string; number: number; status: string; createdAt: string } | null>`(
        select json_build_object('id', r.id, 'number', r.number, 'status', r.status, 'createdAt', r.created_at)
        from ${requests} r where r.script_id = ${scripts.id} order by r.created_at desc limit 1)`,
    })
    .from(scripts)
    .innerJoin(organisations, eq(organisations.id, scripts.organisationId))
    .where(
      and(
        orgIds ? inArray(scripts.organisationId, orgIds) : undefined,
        filter.semester ? eq(scripts.semester, filter.semester) : undefined,
        eq(scripts.archived, filter.archived ?? false),
      ),
    )
    .orderBy(desc(scripts.semester), asc(scripts.title))
  const semesters = await db
    .selectDistinct({ semester: scripts.semester })
    .from(scripts)
    .where(orgIds ? inArray(scripts.organisationId, orgIds) : undefined)
    .orderBy(desc(scripts.semester))
  return {
    rows: rows.map((r) => ({
      ...r,
      lastOrder: r.lastOrder ? { ...r.lastOrder, createdAt: new Date(r.lastOrder.createdAt) } : null,
    })),
    semesters: semesters.map((s) => s.semester),
    canManage: !staff,
    organisations: staff ? [] : await svkOrganisations(db, user.id),
  }
}

const text = (max: number) => z.string().trim().max(max, 'Die Angabe ist zu lang')

export const scriptInputSchema = z.object({
  title: z.string().trim().min(1, 'Titel ist erforderlich').max(200, 'Der Titel ist zu lang'),
  lecturer: text(200),
  semester: z.string().trim().min(1, 'Semester ist erforderlich').max(50, 'Die Angabe ist zu lang'),
  stock: z.number().int().min(0).max(1_000_000),
  notes: text(2000),
})

export const createScriptSchema = scriptInputSchema.extend({ organisationId: z.uuid() })

/** Skriptenannahme: neues Skript ohne Vorlage. Die erste Bestellung über den Wizard wird zur Vorlage. */
export async function createScript(user: Principal, input: z.infer<typeof createScriptSchema>) {
  const db = getDb()
  await assertSvkMember(db, user, input.organisationId)
  const [row] = await db
    .insert(scripts)
    .values({ ...input, createdById: user.id })
    .returning({ id: scripts.id })
  return row!
}

export const updateScriptSchema = scriptInputSchema.extend({ id: z.uuid(), archived: z.boolean() })

export async function updateScript(user: Principal, input: z.infer<typeof updateScriptSchema>) {
  return getDb().transaction(async (tx) => {
    const [script] = await tx.select().from(scripts).where(eq(scripts.id, input.id)).for('update')
    if (!script) throw new Error('Skript nicht gefunden')
    await assertSvkMember(tx, user, script.organisationId)
    const { id, ...values } = input
    await tx
      .update(scripts)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(scripts.id, id))
  })
}

/** Aus einem Skript für ein neues Semester ein eigenes machen; Vorlage und Optionen bleiben. */
export async function copyScript(user: Principal, input: { id: string; semester: string }) {
  return getDb().transaction(async (tx) => {
    const [script] = await tx.select().from(scripts).where(eq(scripts.id, input.id))
    if (!script) throw new Error('Skript nicht gefunden')
    await assertSvkMember(tx, user, script.organisationId)
    const [row] = await tx
      .insert(scripts)
      .values({
        organisationId: script.organisationId,
        title: script.title,
        lecturer: script.lecturer,
        semester: input.semester,
        templateRequestId: script.templateRequestId,
        notes: script.notes,
        createdById: user.id,
      })
      .returning({ id: scripts.id })
    return row!
  })
}

/** Beim Anlegen eines Auftrags für ein Skript: Auftrag gehört der SVK, das Skript übernimmt ihn als neue Vorlage. */
export async function linkOrderToScript(tx: Tx, scriptId: string, requestId: string) {
  await tx.update(scripts).set({ templateRequestId: requestId, updatedAt: new Date() }).where(eq(scripts.id, scriptId))
}

/** Ein fertiger Auftrag erhöht den Bestand des Skripts um die gedruckten Exemplare. */
export async function addPrintedCopies(tx: Tx, scriptId: string, copies: number) {
  await tx
    .update(scripts)
    .set({ stock: sql`${scripts.stock} + ${copies}`, updatedAt: new Date() })
    .where(eq(scripts.id, scriptId))
}

/** Darf der Benutzer diesen Auftrag als Vorlage des Skripts verwenden, auch wenn ein Kollege ihn angelegt hat? */
export async function isScriptTemplate(db: Db, user: Principal, scriptId: string, requestId: string) {
  const script = await scriptForOrder(db, user, scriptId)
  return script.templateRequestId === requestId
}
