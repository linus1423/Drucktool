// Legt in Integrationstests einen Auftrag wie über den Wizard an.
// Erst importieren, nachdem DATABASE_URL gesetzt ist.
import { randomUUID } from 'node:crypto'
import type { OrderSpec } from '~/lib/order'
import { calculatePrice } from '~/lib/pricing'

type Principal = import('~/server/requests/requests.server').Principal

export async function testUpload(user: Principal, role: 'main' | 'cover' = 'main', pageCount: number | null = 4) {
  const { getDb, schema } = await import('~/server/db/client.server')
  const [file] = await getDb()
    .insert(schema.requestFiles)
    .values({
      ownerId: user.id,
      role,
      filename: 'test.pdf',
      sizeBytes: 1000,
      mimeType: 'application/pdf',
      sha256: 'test',
      storageKey: `test/${randomUUID()}`,
      pdfStatus: pageCount == null ? 'unreadable' : 'ok',
      pageCount,
    })
    .returning()
  return file!
}

export async function orderInput(user: Principal, overrides: { title?: string; notes?: string; spec?: Partial<OrderSpec> } = {}) {
  const { getCatalog } = await import('~/server/catalog/catalog.server')
  const catalog = await getCatalog({ onlyAvailable: true })
  const paper = catalog.papers.find((p) => p.name === 'Standardpapier')!
  const spec: OrderSpec = {
    formatId: 'A4',
    customWidthMm: null,
    customHeightMm: null,
    bindingId: 'loose',
    duplex: false,
    paperId: paper.id,
    coverPaperId: null,
    coverPages: null,
    coverColorId: null,
    coverBackColorId: null,
    borderless: false,
    copies: 10,
    pages: 4,
    delivery: 'pickup',
    ...overrides.spec,
  }
  const file = await testUpload(user, 'main', spec.pages)
  const priced = calculatePrice(catalog, spec)
  if (!priced.ok) throw new Error(priced.errors.join(' '))
  return {
    title: overrides.title ?? 'Skript',
    notes: overrides.notes ?? '',
    spec,
    mainFileId: file.id,
    coverFileId: null,
    deliveryAddress: null,
    acceptTerms: true as const,
    expectedTotalCents: priced.price.totalCents,
  }
}

export async function placeOrder(user: Principal, overrides: Parameters<typeof orderInput>[1] = {}) {
  const { createRequest } = await import('~/server/requests/requests.server')
  return createRequest(user, await orderInput(user, overrides))
}
