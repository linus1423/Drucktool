import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { BILLING } from './fixtures'
import { orderInput } from './order-fixture'
import { DRAFT_VERSION, draftStorageKey, loadDraft, parseStoredDraft, type StoredDraft } from '~/lib/order-draft'

const stored: StoredDraft = {
  version: DRAFT_VERSION,
  step: 4,
  organisationId: '',
  mainFileId: '00000000-0000-4000-8000-000000000001',
  coverFileId: null,
  manualPages: '',
  formatId: 'a4',
  customWidth: '',
  customHeight: '',
  bindingId: 'loose',
  duplex: true,
  paperId: 'p80',
  coverEnabled: false,
  coverPaperId: '',
  coverFromMain: 'front',
  coverColorId: '',
  coverBackColorId: '',
  borderless: false,
  copies: '3',
  title: 'Skript',
  notes: 'Bitte sorgfältig',
  delivery: 'house_post',
  deliveryAddress: { recipient: 'Erika', department: 'LS Druck', building: '', room: '', note: '' },
  offer: false,
  customerEmail: '',
  customerFirstName: '',
  customerLastName: '',
  priceOverride: null,
  priceReason: '',
}

describe('Entwurf im Browser (Issue #175)', () => {
  it('trennt Benutzer sowie Bestellung und Angebot', () => {
    const keys = new Set([
      draftStorageKey('a', 'order'),
      draftStorageKey('a', 'offer'),
      draftStorageKey('b', 'order'),
      draftStorageKey('b', 'offer'),
    ])
    expect(keys.size).toBe(4)
  })

  it('liest einen gespeicherten Entwurf zurück', () => {
    expect(parseStoredDraft(JSON.stringify(stored))).toEqual(stored)
  })

  it('verwirft Kaputtes, Fremdes und alte Versionen', () => {
    expect(parseStoredDraft(null)).toBeNull()
    expect(parseStoredDraft('{kaputt')).toBeNull()
    expect(parseStoredDraft(JSON.stringify({ ...stored, version: DRAFT_VERSION + 1 }))).toBeNull()
    expect(parseStoredDraft(JSON.stringify({ ...stored, delivery: 'drohne' }))).toBeNull()
    expect(parseStoredDraft(JSON.stringify({ ...stored, mainFileId: '../etc/passwd' }))).toBeNull()
  })

  it('läuft ohne Browser (Server-Rendering) ohne Fehler', () => {
    expect(loadDraft(draftStorageKey('a', 'order'))).toBeNull()
  })
})

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url
const uploads = await mkdtemp(path.join(tmpdir(), 'drucktool-draft-'))
process.env.UPLOAD_DIR = uploads

describe.skipIf(!url)('Dateien eines wiederhergestellten Entwurfs (Issue #175)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const { createRequest } = await import('~/server/requests/requests.server')
  const { createUpload, draftFiles } = await import('~/server/files/files.server')
  type Principal = import('~/server/requests/requests.server').Principal
  let customer: Principal
  let other: Principal

  const upload = (user: Principal, role: 'main' | 'cover', filename = 'datei.pdf') =>
    createUpload(user, { role, filename, mimeType: 'image/png', body: Readable.from([Buffer.from('PNG')]) })

  beforeAll(async () => {
    const stamp = Date.now()
    const rows = await getDb()
      .insert(schema.users)
      .values([
        { email: `d-kunde-${stamp}@test`, lastName: 'Kundin', role: 'customer', status: 'active', billingAddress: BILLING },
        { email: `d-fremd-${stamp}@test`, lastName: 'Fremd', role: 'customer', status: 'active', billingAddress: BILLING },
      ])
      .returning()
    customer = { id: rows[0]!.id, role: 'customer' }
    other = { id: rows[1]!.id, role: 'customer' }
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
    await rm(uploads, { recursive: true, force: true })
  })

  it('gibt eigene, noch nicht abgeschickte Uploads zurück und datiert sie frisch', async () => {
    const main = await upload(customer, 'main', 'innen.pdf')
    const cover = await upload(customer, 'cover', 'deckblatt.pdf')
    const old = new Date(Date.now() - 20 * 60 * 60 * 1000)
    await getDb().update(schema.requestFiles).set({ createdAt: old }).where(eq(schema.requestFiles.id, main.id))

    const files = await draftFiles(customer, { main: main.id, cover: cover.id })
    expect(files.main?.filename).toBe('innen.pdf')
    expect(files.cover?.filename).toBe('deckblatt.pdf')
    expect(new Date(files.main!.createdAt).getTime()).toBeGreaterThan(old.getTime())
  })

  it('lässt fremde, falsch zugeordnete und schon abgeschickte Dateien weg', async () => {
    const foreign = await upload(other, 'main')
    expect(await draftFiles(customer, { main: foreign.id, cover: null })).toEqual({ main: null, cover: null })

    const cover = await upload(customer, 'cover')
    expect(await draftFiles(customer, { main: cover.id, cover: null })).toEqual({ main: null, cover: null })

    const input = await orderInput(customer)
    const submitted = await createRequest(customer, input)
    expect(await draftFiles(customer, { main: input.mainFileId, cover: null })).toEqual({ main: null, cover: null })
    expect(submitted.id).toBeTruthy()

    expect(await draftFiles(customer, { main: '00000000-0000-4000-8000-000000000000', cover: null })).toEqual({
      main: null,
      cover: null,
    })
    expect(await draftFiles(customer, { main: null, cover: null })).toEqual({ main: null, cover: null })
  })
})
