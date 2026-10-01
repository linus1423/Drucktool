import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  bindingUpdateSchema,
  coverColorSchema,
  formatUpdateSchema,
  paperSchema,
  pricingSchema,
  textsSchema,
  type CatalogTexts,
  type Pricing,
} from '~/lib/catalog'
import type { JsonObject } from '~/lib/json'
import { getDb, schema, type Tx } from '../db/client.server'
import type { Principal } from '../requests/requests.server'
import { DEFAULT_DEADLINE_SETTINGS, deadlineSettingsSchema, type DeadlineSettings } from '~/lib/deadlines'

const { formats, bindings, formatBindings, papers, coverColors, paperCoverColors, settings, catalogChanges, users } = schema

type Db = ReturnType<typeof getDb> | Tx

async function readSetting<T>(db: Db, key: string, parse: (v: unknown) => T): Promise<T> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key))
  if (!row) throw new Error(`Einstellung "${key}" fehlt`)
  return parse(row.value)
}

export function getPricing(db: Db = getDb()): Promise<Pricing> {
  return readSetting(db, 'pricing', (v) => pricingSchema.parse(v))
}

export function getTexts(db: Db = getDb()): Promise<CatalogTexts> {
  return readSetting(db, 'texts', (v) => textsSchema.parse(v))
}

/** Schwellwerte für „wartet lange“; fehlt die Einstellung, gelten die Standardwerte. */
export async function getDeadlineSettings(db: Db = getDb()): Promise<DeadlineSettings> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'deadlines'))
  const parsed = deadlineSettingsSchema.safeParse(row?.value)
  return parsed.success ? parsed.data : DEFAULT_DEADLINE_SETTINGS
}

/** Vollständiger Katalog. Mit onlyAvailable nur, was Kunden gerade wählen dürfen. */
export async function getCatalog(options: { onlyAvailable?: boolean } = {}, db: Db = getDb()) {
  const only = options.onlyAvailable
  const [f, b, fb, p, c, pc, pricing, texts] = await Promise.all([
    db
      .select()
      .from(formats)
      .where(only ? eq(formats.available, true) : undefined)
      .orderBy(asc(formats.sortOrder)),
    db
      .select()
      .from(bindings)
      .where(only ? eq(bindings.available, true) : undefined)
      .orderBy(asc(bindings.sortOrder)),
    db.select().from(formatBindings),
    db
      .select()
      .from(papers)
      .where(only ? eq(papers.available, true) : undefined)
      .orderBy(asc(papers.sortOrder), asc(papers.name)),
    db
      .select()
      .from(coverColors)
      .where(only ? eq(coverColors.available, true) : undefined)
      .orderBy(asc(coverColors.sortOrder)),
    db.select().from(paperCoverColors),
    getPricing(db),
    getTexts(db),
  ])
  return {
    formats: f,
    bindings: b,
    formatBindings: fb,
    papers: p,
    coverColors: c,
    paperCoverColors: pc,
    pricing,
    texts,
  }
}

export type Catalog = Awaited<ReturnType<typeof getCatalog>>

function snapshot(value: object | null | undefined): JsonObject | null {
  return value ? (JSON.parse(JSON.stringify(value)) as JsonObject) : null
}

async function logChange(
  tx: Tx,
  actor: Principal,
  entity: string,
  entityId: string,
  before: object | null,
  after: object | null,
) {
  await tx
    .insert(catalogChanges)
    .values({ actorId: actor.id, entity, entityId, before: snapshot(before), after: snapshot(after) })
}

export async function updateFormat(actor: Principal, input: z.infer<typeof formatUpdateSchema>) {
  await getDb().transaction(async (tx) => {
    const [before] = await tx.select().from(formats).where(eq(formats.id, input.id)).for('update')
    if (!before) throw new Error('Format nicht gefunden')
    const { id, ...values } = input
    const [after] = await tx.update(formats).set(values).where(eq(formats.id, id)).returning()
    await logChange(tx, actor, 'format', id, before, after!)
  })
}

export async function updateBinding(actor: Principal, input: z.infer<typeof bindingUpdateSchema>) {
  await getDb().transaction(async (tx) => {
    const [before] = await tx.select().from(bindings).where(eq(bindings.id, input.id)).for('update')
    if (!before) throw new Error('Bindung nicht gefunden')
    const { id, ...values } = input
    const [after] = await tx.update(bindings).set(values).where(eq(bindings.id, id)).returning()
    await logChange(tx, actor, 'binding', id, before, after!)
  })
}

export const formatBindingSchema = z.object({ formatId: z.string(), bindingId: z.string(), allowed: z.boolean() })

export async function setFormatBinding(actor: Principal, input: z.infer<typeof formatBindingSchema>) {
  await getDb().transaction(async (tx) => {
    const where = and(eq(formatBindings.formatId, input.formatId), eq(formatBindings.bindingId, input.bindingId))
    const [existing] = await tx.select().from(formatBindings).where(where)
    if (input.allowed === !!existing) return
    if (input.allowed) await tx.insert(formatBindings).values({ formatId: input.formatId, bindingId: input.bindingId })
    else await tx.delete(formatBindings).where(where)
    await logChange(
      tx,
      actor,
      'format_binding',
      `${input.formatId}/${input.bindingId}`,
      existing ?? null,
      input.allowed ? input : null,
    )
  })
}

export async function savePaper(actor: Principal, input: z.infer<typeof paperSchema>) {
  if (input.forPlotter && input.priceA0Cents == null && input.priceA1Cents == null && input.priceA2Cents == null) {
    throw new Error('Plotterpapier braucht mindestens einen Preis für A0, A1 oder A2')
  }
  if ((input.forCover || input.forInner) && input.priceA3Cents == null) {
    throw new Error('Papier für den normalen Drucker braucht einen Preis pro A3-Bogen')
  }
  return getDb().transaction(async (tx) => {
    const { id, ...values } = input
    if (id) {
      const [before] = await tx.select().from(papers).where(eq(papers.id, id)).for('update')
      if (!before) throw new Error('Papier nicht gefunden')
      const [after] = await tx
        .update(papers)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(papers.id, id))
        .returning()
      await logChange(tx, actor, 'paper', id, before, after!)
      return { id }
    }
    const [created] = await tx.insert(papers).values(values).returning()
    await logChange(tx, actor, 'paper', created!.id, null, created!)
    return { id: created!.id }
  })
}

export const paperCoverColorSchema = z.object({ paperId: z.uuid(), coverColorId: z.uuid(), allowed: z.boolean() })

/** Schaltet eine Coverfarbe für ein Deckblattpapier frei oder nimmt sie weg. */
export async function setPaperCoverColor(actor: Principal, input: z.infer<typeof paperCoverColorSchema>) {
  await getDb().transaction(async (tx) => {
    const where = and(eq(paperCoverColors.paperId, input.paperId), eq(paperCoverColors.coverColorId, input.coverColorId))
    const [existing] = await tx.select().from(paperCoverColors).where(where)
    if (input.allowed === !!existing) return
    if (input.allowed) {
      const [paper] = await tx.select({ id: papers.id }).from(papers).where(eq(papers.id, input.paperId))
      if (!paper) throw new Error('Papier nicht gefunden')
      const [color] = await tx.select({ id: coverColors.id }).from(coverColors).where(eq(coverColors.id, input.coverColorId))
      if (!color) throw new Error('Coverfarbe nicht gefunden')
      await tx.insert(paperCoverColors).values({ paperId: input.paperId, coverColorId: input.coverColorId })
    } else await tx.delete(paperCoverColors).where(where)
    await logChange(
      tx,
      actor,
      'paper_cover_color',
      `${input.paperId}/${input.coverColorId}`,
      existing ?? null,
      input.allowed ? { paperId: input.paperId, coverColorId: input.coverColorId } : null,
    )
  })
}

export async function saveCoverColor(actor: Principal, input: z.infer<typeof coverColorSchema>) {
  return getDb().transaction(async (tx) => {
    const { id, ...values } = input
    if (id) {
      const [before] = await tx.select().from(coverColors).where(eq(coverColors.id, id)).for('update')
      if (!before) throw new Error('Coverfarbe nicht gefunden')
      const [after] = await tx.update(coverColors).set(values).where(eq(coverColors.id, id)).returning()
      await logChange(tx, actor, 'cover_color', id, before, after!)
      return { id }
    }
    const [created] = await tx.insert(coverColors).values(values).returning()
    await logChange(tx, actor, 'cover_color', created!.id, null, created!)
    return { id: created!.id }
  })
}

async function saveSetting(actor: Principal, key: string, value: JsonObject) {
  await getDb().transaction(async (tx) => {
    const [before] = await tx.select().from(settings).where(eq(settings.key, key)).for('update')
    await tx
      .insert(settings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
    await logChange(tx, actor, 'settings', key, (before?.value as object) ?? null, value)
  })
}

export async function savePricing(actor: Principal, input: Pricing) {
  await saveSetting(actor, 'pricing', input)
}

export async function saveTexts(actor: Principal, input: CatalogTexts) {
  await saveSetting(actor, 'texts', input)
}

export async function saveDeadlineSettings(actor: Principal, input: DeadlineSettings) {
  await saveSetting(actor, 'deadlines', input)
}

export async function listCatalogChanges(limit = 100) {
  return getDb()
    .select({
      id: catalogChanges.id,
      entity: catalogChanges.entity,
      entityId: catalogChanges.entityId,
      before: catalogChanges.before,
      after: catalogChanges.after,
      createdAt: catalogChanges.createdAt,
      actorName: users.name,
    })
    .from(catalogChanges)
    .leftJoin(users, eq(users.id, catalogChanges.actorId))
    .orderBy(desc(catalogChanges.createdAt))
    .limit(limit)
}
