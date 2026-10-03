// Skriptenverwaltung der SVK (Issue #59). Die SVK ist eine Organisation mit Kennzeichen „SVK“; ihre Mitglieder legen
// Skripte als dauerhafte Vorlagen an und bestellen sie über den normalen Wizard nach. Jede Nachbestellung ist ein
// gewöhnlicher Auftrag der SVK-Organisation; fertige Aufträge erhöhen den Bestand des Skripts.
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { isAdminRole, isStaffRole } from '~/lib/roles'
import { OPEN_STATUSES } from '~/lib/status'
import { getDb, schema, type Tx } from '../db/client.server'
import type { Principal } from '../requests/requests.server'

const { scripts, requests, organisations, organisationMembers, users } = schema

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

// Auch Mitarbeiter können Mitglied einer SVK sein (Issue #164).
async function assertSvkMember(db: Db, user: Principal, organisationId: string) {
  const orgs = await svkOrganisations(db, user.id)
  if (!orgs.some((o) => o.id === organisationId)) throw new Error(NO_PERMISSION)
}

/** Admins immer, Mitarbeiter mit Freigabe in der Benutzerverwaltung (Issue #158). */
export async function staffMayManageScripts(db: Db, user: Principal) {
  if (isAdminRole(user.role)) return true
  if (user.role !== 'staff') return false
  const [row] = await db.select({ allowed: users.canManageScripts }).from(users).where(eq(users.id, user.id))
  return row?.allowed ?? false
}

/** Alle aktiven SVKs, für Mitarbeiter, die Skripte verwalten. */
function allSvkOrganisations(db: Db) {
  return db
    .select({ id: organisations.id, name: organisations.name })
    .from(organisations)
    .where(and(eq(organisations.isSvk, true), eq(organisations.status, 'active')))
    .orderBy(asc(organisations.name))
}

/** Skripte verwalten (anlegen, bearbeiten, kopieren): SVK-Mitglieder ihre, freigegebene Mitarbeiter alle. */
async function assertMayManage(db: Db, user: Principal, organisationId: string) {
  if (!isStaffRole(user.role) || !(await staffMayManageScripts(db, user))) return assertSvkMember(db, user, organisationId)
  const orgs = await allSvkOrganisations(db)
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

/** Skripte samt Kennzahlen. Mitarbeiter sehen alle, SVK-Mitglieder die ihrer SVK. Verwalten: siehe assertMayManage. */
export async function listScripts(user: Principal, filter: z.infer<typeof scriptListSchema>) {
  const db = getDb()
  const staff = isStaffRole(user.role)
  // Auch Mitarbeiter können Mitglied einer SVK sein (Issue #164) und bestellen dann wie Kunden für sie nach.
  const memberOf = await svkOrganisations(db, user.id)
  const memberIds = new Set(memberOf.map((o) => o.id))
  const orgIds = staff ? null : [...memberIds]
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
  const manageAll = staff && (await staffMayManageScripts(db, user))
  return {
    rows: rows.map((r) => ({
      ...r,
      lastOrder: r.lastOrder ? { ...r.lastOrder, createdAt: new Date(r.lastOrder.createdAt) } : null,
      canManage: manageAll || memberIds.has(r.organisationId),
      /** Nachbestellt wird über den Wizard als Auftrag der SVK, das können nur ihre Mitglieder. */
      canOrder: memberIds.has(r.organisationId),
    })),
    semesters: semesters.map((s) => s.semester),
    canManage: manageAll || memberOf.length > 0,
    /** Mitarbeiter sehen Skripte aller SVKs und brauchen deren Namen. */
    showOrganisation: staff,
    organisations: manageAll ? await allSvkOrganisations(db) : memberOf,
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
  await assertMayManage(db, user, input.organisationId)
  const [row] = await db
    .insert(scripts)
    .values({ ...input, createdById: user.id })
    .returning({ id: scripts.id })
  return row!
}

export const updateScriptSchema = scriptInputSchema.extend({
  id: z.uuid(),
  archived: z.boolean(),
  /** Bestand, den das Formular beim Öffnen angezeigt hat. Fertige Aufträge erhöhen ihn inzwischen vielleicht (Issue #136). */
  previousStock: z.number().int().min(0),
})

export async function updateScript(user: Principal, input: z.infer<typeof updateScriptSchema>) {
  return getDb().transaction(async (tx) => {
    const [script] = await tx.select().from(scripts).where(eq(scripts.id, input.id)).for('update')
    if (!script) throw new Error('Skript nicht gefunden')
    await assertMayManage(tx, user, script.organisationId)
    const { id, previousStock, stock, ...values } = input
    // Unveränderter Bestand im Formular: den aktuellen behalten, statt ihn mit dem alten Stand zu überschreiben.
    const stockChanged = stock !== previousStock
    if (stockChanged && script.stock !== previousStock) {
      throw new Error(
        `Der Bestand hat sich inzwischen geändert (jetzt ${script.stock} Exemplare). Bitte die Seite neu laden und erneut eintragen.`,
      )
    }
    await tx
      .update(scripts)
      .set({ ...values, ...(stockChanged ? { stock } : {}), updatedAt: new Date() })
      .where(eq(scripts.id, id))
  })
}

/** Aus einem Skript für ein neues Semester ein eigenes machen; Vorlage und Optionen bleiben. */
export async function copyScript(user: Principal, input: { id: string; semester: string }) {
  return getDb().transaction(async (tx) => {
    const [script] = await tx.select().from(scripts).where(eq(scripts.id, input.id))
    if (!script) throw new Error('Skript nicht gefunden')
    await assertMayManage(tx, user, script.organisationId)
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
