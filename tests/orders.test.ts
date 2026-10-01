import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { PDFDocument, degrees } from 'pdf-lib'
import { BILLING } from './fixtures'
import { orderInput, placeOrder, testUpload } from './order-fixture'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url
const uploads = await mkdtemp(path.join(tmpdir(), 'drucktool-uploads-'))
process.env.UPLOAD_DIR = uploads

const { getDb, schema } = await import('~/server/db/client.server')
const { createRequest, getRequestDetail, PRICE_CHANGED_MESSAGE } = await import('~/server/requests/requests.server')
const { savePricing, getPricing } = await import('~/server/catalog/catalog.server')
const { cleanupOrphans, createUpload, fileForDownload } = await import('~/server/files/files.server')
const { analysePdf } = await import('~/server/files/pdf.server')
const { storeStream, UploadTooLargeError } = await import('~/server/files/storage.server')
type Principal = import('~/server/requests/requests.server').Principal

async function samplePdf() {
  const doc = await PDFDocument.create()
  doc.addPage([419.53, 595.28]) // A5 hoch
  doc.addPage([419.53, 595.28])
  doc.addPage([595.28, 419.53]).setRotation(degrees(90)) // quer angelegt, gedreht
  return Buffer.from(await doc.save())
}

describe.skipIf(!url)('Aufträge aus dem Wizard (Integration)', () => {
  let customer: Principal
  let other: Principal
  let staff: Principal

  beforeAll(async () => {
    const stamp = Date.now()
    const rows = await getDb()
      .insert(schema.users)
      .values([
        { email: `w-kunde-${stamp}@test`, lastName: 'Kundin', role: 'customer', status: 'active', billingAddress: BILLING },
        { email: `w-fremd-${stamp}@test`, lastName: 'Fremd', role: 'customer', status: 'active', billingAddress: BILLING },
        { email: `w-staff-${stamp}@test`, lastName: 'Staff', role: 'staff', status: 'active' },
      ])
      .returning()
    customer = { id: rows[0]!.id, role: 'customer', organisationId: null }
    other = { id: rows[1]!.id, role: 'customer', organisationId: null }
    staff = { id: rows[2]!.id, role: 'staff', organisationId: null }
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
    await rm(uploads, { recursive: true, force: true })
  })

  it('friert Preis und Katalogwerte beim Absenden ein', async () => {
    const input = await orderInput(customer, { spec: { pages: 10, copies: 3 } })
    const { id } = await createRequest(customer, input)
    const before = await getRequestDetail(staff, id)
    expect(before.totalCents).toBe(input.expectedTotalCents)
    expect(before.quantity).toBe(3)
    expect(before.order?.price.lines.map((l) => l.key)).toContain('print')
    expect(before.termsAcceptedAt).toBeInstanceOf(Date)
    expect(before.termsVersion).toMatch(/^[0-9a-f]{12}$/)
    expect(before.files.map((f) => f.role)).toEqual(['main'])

    const pricing = await getPricing()
    await savePricing(staff, { ...pricing, printA4Cents: pricing.printA4Cents + 50 })
    const after = await getRequestDetail(staff, id)
    expect(after.totalCents).toBe(before.totalCents)
    expect(after.order).toEqual(before.order)
    await savePricing(staff, pricing)
  })

  it('lehnt ab, wenn sich der Preis seit der Vorschau geändert hat', async () => {
    const input = await orderInput(customer)
    await expect(createRequest(customer, { ...input, expectedTotalCents: input.expectedTotalCents + 1 })).rejects.toThrow(
      PRICE_CHANGED_MESSAGE,
    )
  })

  it('nimmt die Seitenzahl aus der Datei, bei unlesbaren Dateien die Angabe des Kunden', async () => {
    const input = await orderInput(customer, { spec: { pages: 4 } })
    const wrong = await orderInput(customer, { spec: { pages: 5 } })
    await expect(createRequest(customer, { ...wrong, mainFileId: input.mainFileId })).rejects.toThrow('4 Seiten')
    // Die Transaktion wurde zurückgerollt, die Datei ist weiter frei.
    const [file] = await getDb().select().from(schema.requestFiles).where(eq(schema.requestFiles.id, input.mainFileId))
    expect(file!.requestId).toBeNull()

    const unreadable = await testUpload(customer, 'main', null)
    await expect(createRequest(customer, { ...wrong, mainFileId: unreadable.id })).resolves.toBeTruthy()
  })

  it('verwendet nur eigene, unbenutzte Uploads', async () => {
    const input = await orderInput(customer)
    await expect(createRequest(other, input)).rejects.toThrow('nicht gefunden')
    await createRequest(customer, input)
    await expect(createRequest(customer, input)).rejects.toThrow('nicht gefunden')
  })

  it('zeigt Kunden nur Druck- und Lieferkosten', async () => {
    const { id } = await placeOrder(customer, { spec: { delivery: 'house_post' } }).catch(() => ({ id: '' }))
    expect(id).toBe('') // Hauspost ohne Adresse geht nicht
    const input = await orderInput(customer, { spec: { delivery: 'house_post' } })
    const address = { recipient: 'Lehrstuhl X', department: '', building: 'MW', room: '1001', note: '' }
    const created = await createRequest(customer, { ...input, deliveryAddress: address })
    const forCustomer = await getRequestDetail(customer, created.id)
    expect(forCustomer.order?.price.lines).toEqual([])
    expect(forCustomer.order?.price.printCents).toBeGreaterThan(0)
    expect(forCustomer.deliveryMethod).toBe('house_post')
    expect(forCustomer.deliveryAddress).toEqual(address)
    expect((await getRequestDetail(staff, created.id)).order?.price.lines.length).toBeGreaterThan(0)
  })

  it('verlangt die Deckblatt-Datei passend zum Deckblatt', async () => {
    const input = await orderInput(customer, { spec: { bindingId: 'plastic_comb' } })
    const card = (await getDb().select().from(schema.papers)).find((p) => p.name === 'Karton')!
    const spec = { ...input.spec, coverPaperId: card.id, coverPages: 1 }
    const { calculatePrice } = await import('~/lib/pricing')
    const { getCatalog } = await import('~/server/catalog/catalog.server')
    const priced = calculatePrice(await getCatalog({ onlyAvailable: true }), spec)
    if (!priced.ok) throw new Error(priced.errors.join())
    const withSpec = { ...input, spec, expectedTotalCents: priced.price.totalCents }
    await expect(createRequest(customer, withSpec)).rejects.toThrow('Deckblatt hochladen')
    const wrongCount = await testUpload(customer, 'cover', 3)
    await expect(createRequest(customer, { ...withSpec, coverFileId: wrongCount.id })).rejects.toThrow(
      'Seitenzahl passt nicht',
    )
    const goodCover = await testUpload(customer, 'cover', 1)
    const created = await createRequest(customer, { ...withSpec, coverFileId: goodCover.id })
    const detail = await getRequestDetail(customer, created.id)
    expect(detail.files.map((f) => f.role).sort()).toEqual(['cover', 'main'])
  })

  it('nimmt Deckblatt-Dateien mit beliebig vielen Seiten zum selben Preis an', async () => {
    const card = (await getDb().select().from(schema.papers)).find((p) => p.name === 'Karton')!
    const { calculatePrice } = await import('~/lib/pricing')
    const { getCatalog } = await import('~/server/catalog/catalog.server')
    const catalog = await getCatalog({ onlyAvailable: true })
    const totals: number[] = []
    // null: unlesbare Deckblatt-Datei ohne Seitenzahl.
    for (const pages of [1, 2, 5, null]) {
      const input = await orderInput(customer, { spec: { bindingId: 'plastic_comb' } })
      const spec = { ...input.spec, coverPaperId: card.id, coverPages: pages }
      const priced = calculatePrice(catalog, spec)
      if (!priced.ok) throw new Error(priced.errors.join())
      totals.push(priced.price.totalCents)
      const cover = await testUpload(customer, 'cover', pages)
      const expectedTotalCents = priced.price.totalCents
      await createRequest(customer, { ...input, spec, coverFileId: cover.id, expectedTotalCents })
    }
    expect(new Set(totals).size).toBe(1)
  })

  it('nimmt das Deckblatt ohne eigene Datei aus der Druckdatei', async () => {
    const card = (await getDb().select().from(schema.papers)).find((p) => p.name === 'Karton')!
    const input = await orderInput(customer, {
      spec: { bindingId: 'plastic_comb', pages: 6, coverPaperId: card.id, coverFromMainFile: 'frontBack' },
    })
    const cover = await testUpload(customer, 'cover', 2)
    await expect(createRequest(customer, { ...input, coverFileId: cover.id })).rejects.toThrow('nicht aus der Druckdatei')
    const created = await createRequest(customer, input)
    const detail = await getRequestDetail(staff, created.id)
    expect(detail.files.map((f) => f.role)).toEqual(['main'])
    const { describeOrder } = await import('~/lib/snapshot')
    expect(describeOrder(detail.order!)).toContainEqual([
      'Deckblatt-Datei',
      'keine separate Datei, aus der Druckdatei: vorne Seiten 1–2, hinten Seiten 5–6',
    ])
    expect(describeOrder(detail.order!)).toContainEqual(['Deckblatt', 'Karton 300 g/m², vorne und hinten'])
  })

  it('liefert Dateien nur an Berechtigte aus', async () => {
    const pending = await testUpload(customer)
    expect(await fileForDownload(customer, pending.id)).toBeTruthy()
    expect(await fileForDownload(other, pending.id)).toBeNull()
    const input = await orderInput(customer)
    await createRequest(customer, input)
    expect(await fileForDownload(customer, input.mainFileId)).toBeTruthy()
    expect(await fileForDownload(staff, input.mainFileId)).toBeTruthy()
    expect(await fileForDownload(other, input.mainFileId)).toBeNull()
  })

  it('räumt nicht abgeschickte Uploads nach einem Tag auf', async () => {
    const orphan = await testUpload(customer)
    await getDb()
      .update(schema.requestFiles)
      .set({ createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000) })
      .where(eq(schema.requestFiles.id, orphan.id))
    expect(await cleanupOrphans()).toBeGreaterThanOrEqual(1)
    expect(await getDb().select().from(schema.requestFiles).where(eq(schema.requestFiles.id, orphan.id))).toEqual([])
  })

  it('speichert Uploads und liest Seitenzahl und Format', async () => {
    const file = await createUpload(customer, {
      role: 'main',
      filename: '../../geheim/Skript.pdf',
      mimeType: 'application/pdf',
      body: Readable.from([await samplePdf()]),
    })
    expect(file).toMatchObject({ filename: 'Skript.pdf', pdfStatus: 'ok', pageCount: 3, pageWidthMm: 148, pageHeightMm: 210 })
    expect(file.mixedPageSizes).toBe(false)
  })

  it('nimmt kaputte PDFs und andere Dateien trotzdem an', async () => {
    const broken = (await samplePdf()).subarray(0, 200)
    const a = await createUpload(customer, {
      role: 'main',
      filename: 'kaputt.pdf',
      mimeType: 'application/pdf',
      body: Readable.from([broken]),
    })
    expect(a).toMatchObject({ pdfStatus: 'unreadable', pageCount: null })
    const b = await createUpload(customer, {
      role: 'main',
      filename: 'bild.png',
      mimeType: 'image/png',
      body: Readable.from([Buffer.from('PNG')]),
    })
    expect(b).toMatchObject({ pdfStatus: 'not_pdf', pageCount: null })
  })

  it('bricht zu große Uploads ab und hinterlässt keine Reste', async () => {
    await expect(storeStream(Readable.from([Buffer.alloc(2048)]), 1024)).rejects.toBeInstanceOf(UploadTooLargeError)
    const leftovers = (await readdir(uploads, { recursive: true })).filter((n) => String(n).endsWith('.part'))
    expect(leftovers).toEqual([])
  })

  it('erkennt gemischte Seitengrößen', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([595.28, 841.89])
    doc.addPage([419.53, 595.28])
    const file = path.join(uploads, 'gemischt.pdf')
    const bytes = await doc.save()
    await writeFile(file, bytes)
    expect(await analysePdf(file, bytes.length)).toMatchObject({ pageCount: 2, mixedPageSizes: true, pageWidthMm: 210 })
  })
})
