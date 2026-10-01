import { afterAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { pricingSchema, type PaperInput } from '~/lib/catalog'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

const { getDb, schema } = await import('~/server/db/client.server')
const catalog = await import('~/server/catalog/catalog.server')
type Principal = import('~/server/requests/requests.server').Principal

async function admin(): Promise<Principal> {
  const [u] = await getDb()
    .insert(schema.users)
    .values({ email: `admin-${Date.now()}-${Math.random()}@test`, lastName: 'Admin', role: 'admin', status: 'active' })
    .returning()
  return { id: u!.id, role: 'admin' }
}

async function changesFor(entityId: string) {
  return getDb().select().from(schema.catalogChanges).where(eq(schema.catalogChanges.entityId, entityId))
}

const paper = (overrides: Partial<PaperInput> = {}): PaperInput => ({
  name: `Testpapier ${Math.random()}`,
  grammage: 120,
  priceA3Cents: 5,
  priceSra3Cents: null,
  priceA0Cents: null,
  priceA1Cents: null,
  priceA2Cents: null,
  forCover: false,
  forInner: true,
  forPlotter: false,
  maxFormatId: null,
  sheetSizes: [],
  available: true,
  helpText: '',
  sortOrder: 50,
  ...overrides,
})

describe.skipIf(!url)('Katalog (Integration)', () => {
  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  it('enthält die Matrix aus dem Lastenheft', async () => {
    const c = await catalog.getCatalog()
    const allowed = (formatId: string) =>
      c.formatBindings
        .filter((fb) => fb.formatId === formatId)
        .map((fb) => fb.bindingId)
        .sort()
    expect(allowed('A4')).toHaveLength(8)
    expect(allowed('A0')).toEqual(['loose'])
    expect(c.formats.find((f) => f.id === 'A1')?.allowsDuplex).toBe(false)
    expect(c.bindings.find((b) => b.id === 'glue')).toMatchObject({ priceCents: 200, setupFeeCents: 700, trimmed: true })
    expect(pricingSchema.parse(c.pricing)).toEqual(c.pricing)
  })

  it('protokolliert Änderungen an Formaten, Bindungen und Matrix', async () => {
    const actor = await admin()
    const c = await catalog.getCatalog()
    const a6 = c.formats.find((f) => f.id === 'A6')!
    await catalog.updateFormat(actor, { ...a6, helpText: 'Neuer Hilfetext' })
    const tape = c.bindings.find((b) => b.id === 'tape')!
    await catalog.updateBinding(actor, { ...tape, priceCents: 250 })
    await catalog.setFormatBinding(actor, { formatId: 'A5', bindingId: 'glue', allowed: false })
    await catalog.setFormatBinding(actor, { formatId: 'A5', bindingId: 'glue', allowed: false })

    const [formatChange] = await changesFor('A6')
    expect(formatChange).toMatchObject({ entity: 'format', actorId: actor.id })
    expect((formatChange!.after as { helpText: string }).helpText).toBe('Neuer Hilfetext')
    const [bindingChange] = await changesFor('tape')
    expect((bindingChange!.before as { priceCents: number }).priceCents).toBe(200)
    expect((bindingChange!.after as { priceCents: number }).priceCents).toBe(250)
    // Die zweite, wirkungslose Änderung erzeugt keinen Eintrag.
    expect(await changesFor('A5/glue')).toHaveLength(1)
    const after = await catalog.getCatalog()
    expect(after.formatBindings.some((fb) => fb.formatId === 'A5' && fb.bindingId === 'glue')).toBe(false)
  })

  it('prüft Papierpreise und blendet nicht verfügbares Papier für Kunden aus', async () => {
    const actor = await admin()
    await expect(catalog.savePaper(actor, paper({ priceA3Cents: null }))).rejects.toThrow('A3-Bogen')
    await expect(catalog.savePaper(actor, paper({ forInner: false, forPlotter: true }))).rejects.toThrow('Plotterpapier')

    const input = paper()
    const { id } = await catalog.savePaper(actor, input)
    expect((await catalog.getCatalog({ onlyAvailable: true })).papers.some((p) => p.id === id)).toBe(true)
    await catalog.savePaper(actor, { ...input, id, available: false })
    expect((await catalog.getCatalog({ onlyAvailable: true })).papers.some((p) => p.id === id)).toBe(false)
    expect((await catalog.getCatalog()).papers.some((p) => p.id === id)).toBe(true)
    expect(await changesFor(id)).toHaveLength(2)
  })

  it('ordnet Coverfarben Deckblattpapieren zu und prüft sie beim Bestellen', async () => {
    const before = await catalog.getCatalog()
    // Die Migration gibt jedem vorhandenen Deckblattpapier alle Farben, damit sich nichts ändert.
    const karton = before.papers.find((p) => p.name === 'Karton')!
    const kartonColors = before.paperCoverColors.filter((pc) => pc.paperId === karton.id).map((pc) => pc.coverColorId)
    expect(kartonColors.length).toBeGreaterThanOrEqual(5)
    expect(before.paperCoverColors.some((pc) => pc.paperId === before.papers.find((p) => !p.forCover)!.id)).toBe(false)

    const actor = await admin()
    const { id: paperId } = await catalog.savePaper(actor, paper({ forCover: true, forInner: false, grammage: 250 }))
    const white = before.coverColors.find((c) => c.name === 'Weiß')!
    const blue = before.coverColors.find((c) => c.name === 'Dunkelblau')!
    await catalog.setPaperCoverColor(actor, { paperId, coverColorId: white.id, allowed: true })
    await catalog.setPaperCoverColor(actor, { paperId, coverColorId: white.id, allowed: true })
    expect(await changesFor(`${paperId}/${white.id}`)).toHaveLength(1)

    const { calculatePrice } = await import('~/lib/pricing')
    const c = await catalog.getCatalog({ onlyAvailable: true })
    const spec = {
      formatId: 'A4',
      customWidthMm: null,
      customHeightMm: null,
      bindingId: 'plastic_comb',
      duplex: false,
      paperId: c.papers.find((p) => p.name === 'Standardpapier')!.id,
      coverPaperId: paperId,
      coverPages: 1,
      coverFromMainFile: null,
      coverColorId: white.id,
      coverBackColorId: null,
      borderless: false,
      copies: 1,
      pages: 4,
      delivery: 'pickup' as const,
    }
    expect(calculatePrice(c, spec).ok).toBe(true)
    const rejected = calculatePrice(c, { ...spec, coverColorId: blue.id })
    expect(rejected.ok ? [] : rejected.errors).toEqual([`Dunkelblau gibt es nicht auf ${c.papers.find((p) => p.id === paperId)!.name} 250 g/m².`])

    await catalog.setPaperCoverColor(actor, { paperId, coverColorId: white.id, allowed: false })
    expect((await catalog.getCatalog()).paperCoverColors.some((pc) => pc.paperId === paperId)).toBe(false)
    expect(await changesFor(`${paperId}/${white.id}`)).toHaveLength(2)
  })

  it('speichert Preise mit altem und neuem Stand', async () => {
    const actor = await admin()
    const before = await catalog.getPricing()
    await catalog.savePricing(actor, { ...before, minimumOrderCents: 150 })
    expect((await catalog.getPricing()).minimumOrderCents).toBe(150)
    const rows = await changesFor('pricing')
    const last = rows.at(-1)!
    expect((last.before as { minimumOrderCents: number }).minimumOrderCents).toBe(before.minimumOrderCents)
    expect((last.after as { minimumOrderCents: number }).minimumOrderCents).toBe(150)
  })
})
